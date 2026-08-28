import { GAMEPAD_AXES, GAMEPAD_BUTTONS, buttonPressed, DEFAULT_DEAD_ZONE as GAMEPAD_DEAD_ZONE, gamepadHasActivity, pickGamepad, readDpad, readStick } from './emulators/gamepad-mapping.js?v=murals-5';
const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x090611, .026);
const camera = new THREE.PerspectiveCamera(72, innerWidth/innerHeight, .1, 100);
camera.position.set(0, 1.65, 11);
const playerPosition = new THREE.Vector3(0, 1.65, 11), followOffset = new THREE.Vector3(), cameraTarget = new THREE.Vector3(), lookDirection = new THREE.Vector3(), movementVector = new THREE.Vector3(), correctionTarget = new THREE.Vector3(), upAxis = new THREE.Vector3(0,1,0);
// Deliberately not lowPowerDevice: that flags any four-core machine, including
// desktops, and this gate is about the download rather than the hardware. A
// GameCube image averages a gigabyte, which is roughly fourteen minutes on a
// phone connection and a serious dent in a metered plan.
const isMobileDevice=navigator.userAgentData?.mobile===true
  ||(matchMedia('(pointer: coarse)').matches&&matchMedia('(max-width: 900px)').matches);
const lowPowerDevice=matchMedia('(max-width: 900px)').matches||(navigator.deviceMemory&&navigator.deviceMemory<=4)||(navigator.hardwareConcurrency&&navigator.hardwareConcurrency<=4);
/**
 * How much resolution the scene is drawn at, as a multiple of CSS pixels.
 *
 * The ceiling used to be .75 on anything under 900px wide, which is every
 * phone. On a handset reporting devicePixelRatio 3 that is a quarter of the
 * native resolution in each direction — a sixteenth of the pixels — and it
 * looked exactly like that. Screen width is not a measure of how fast a GPU
 * is; the controller below finds the level the device can actually hold, so
 * the ceiling only has to be a level worth reaching.
 *
 * The floor is the more important number: it is what a phone looks like on a
 * bad day, and .5 was a thirty-sixth of native.
 */
const pixelRatioCap=1;
const pixelRatioFloor=lowPowerDevice ? .75 : .6;
const renderScaleCeiling=()=>Math.min(devicePixelRatio,pixelRatioCap);
let currentPixelRatio=Math.min(devicePixelRatio,pixelRatioCap);
const renderer = new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance'}); renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(currentPixelRatio); renderer.shadowMap.enabled=false; renderer.domElement.id='arcade-canvas'; document.body.appendChild(renderer.domElement);
// Matches the pre-Phase-11 prompt radius, measured from the player's eye
// height to the cabinet group origin.
const CABINET_PROMPT_RANGE = 2.25;
// The same bounds the server enforces. Local prediction that allowed a step the
// server refuses would be corrected every frame, which the player reads as lag
// rather than as a wall. test/world-bounds.test.ts holds the copies together.
// One rectangle again. Every side room is the same size now, so the outer wall
// is a straight run on both sides and the Mega Man room no longer steps out
// past it — which is what the second rectangle existed to allow. A single box
// is also the only shape the two authoritative copies of this can state without
// drifting from it.
// The hall, half a metre inside the outer wall, and stopping short of the two
// doorways that are sealed by a bound rather than by collision: the tournament
// hall at the bottom and the top row at the top. The rooms off the side walls
// are gated by their own doorways instead, because three of them are open.
const WORLD_BOUNDS={minX:-42.7,maxX:42.7,minZ:-66.7,maxZ:33.1};
function clampToWorld(){
  playerPosition.x=Math.max(WORLD_BOUNDS.minX,Math.min(WORLD_BOUNDS.maxX,playerPosition.x));
  playerPosition.z=Math.max(WORLD_BOUNDS.minZ,Math.min(WORLD_BOUNDS.maxZ,playerPosition.z));
}
const clock = new THREE.Clock(), keys = {}, cabinets = [], cabinetsById = new Map(), raycaster = new THREE.Raycaster(), animatedMixers = [];
const mobileMove={x:0,y:0};
const gamepadMove={x:0,y:0},gamepadLook={x:0,y:0},gamepadDpad={x:0,y:0};
const gamepadButtonState=[];
let activeGamepadIndex=null,gamepadEngaged=false;
const mobileViewportQuery=matchMedia('(max-width: 720px)'),coarsePointerQuery=matchMedia('(hover: none) and (pointer: coarse)');
const mobileInputAvailable=()=>mobileViewportQuery.matches||coarsePointerQuery.matches||navigator.maxTouchPoints>0;
const syncMobileInputMode=()=>document.body.classList.toggle('mobile-input',mobileInputAvailable());
syncMobileInputMode();
mobileViewportQuery.addEventListener('change',syncMobileInputMode);
coarsePointerQuery.addEventListener('change',syncMobileInputMode);
const gameAssetBaseUrl=(window.ARCADE_RUNTIME?.gameAssetBaseUrl||'assets/games').replace(/\/+$/,'');
const gameAssetUrl=fileName=>`${gameAssetBaseUrl}/${fileName}`;
const biosAssetUrl=window.ARCADE_RUNTIME?.biosAssetUrl||'assets/bios/SCPH1001.BIN';
const gameCubeDspAssetUrl=window.ARCADE_RUNTIME?.gameCubeDspAssetUrl||gameAssetBaseUrl.replace(/\/games$/,'/bios/dsp_rom.bin');
let yaw=0,pitch=0, locked=false, activeCabinet=null, localAnimationState='idle', cameraMode='third-person', socialFollowProvider=null, emulatorRuntimeActive=false;
scene.add(new THREE.HemisphereLight(0x2b2440,0x0a0810,1.2));
const managedSceneLights=[];
// Callbacks run after movement resolves and before the draw call. Declared up
// here so scenery built anywhere in the file can register an animation.
const beforeRenderCallbacks=[];
const point = (color,x,y,z,intensity=6) => { const l=new THREE.PointLight(color,intensity,10,2);l.position.set(x,y,z);scene.add(l);managedSceneLights.push(l);return l };
// Muted teal instead of pure cyan, and a warm sodium pool at the back, so the
// room lights read as a side street at night rather than a neon grid.
point(0xff32b5,-5,3,2,5.4);point(0x2ea8c4,5,3,-4,5.4);point(0xff9a4d,0,3,-9,5.8);
// Nu-retro terrazzo floor. The pattern is generated into one small tiling
// canvas at startup, so the entire floor costs zero network bytes and renders
// as a single textured quad instead of the GridHelper line meshes it replaces.
function arcadeFloorTextures(){
  const SIZE=512,CELL=SIZE/4; // one canvas tile covers a 4m x 4m patch
  let seed=0x9e3779b9; // seeded so the speckle pattern is identical every session
  const rand=()=>{seed=seed+0x6d2b79f5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};
  const albedo=document.createElement('canvas');albedo.width=albedo.height=SIZE;
  const gloss=document.createElement('canvas');gloss.width=gloss.height=SIZE;
  const a=albedo.getContext('2d'),g=gloss.getContext('2d');
  a.fillStyle='#120e1e';a.fillRect(0,0,SIZE,SIZE);
  g.fillStyle='#6e6e6e';g.fillRect(0,0,SIZE,SIZE);
  // Each metre tile gets its own slightly different shade so the floor does
  // not read as one flat sheet of vinyl.
  for(let ty=0;ty<4;ty++)for(let tx=0;tx<4;tx++){a.fillStyle=`hsl(${252+rand()*16} 30% ${7+rand()*4}%)`;a.fillRect(tx*CELL,ty*CELL,CELL,CELL)}
  // Terrazzo flecks: reads as arcade carpet underfoot and as quiet texture
  // from across the room. The gloss map picks the same spots up so the flecks
  // catch the neon instead of looking painted on.
  // Mostly muted chips with a minority of saturated pops. An even mix of bright
  // colours reads as confetti rather than terrazzo.
  const fleckColors=['#6d6486','#8a7fa6','#574d70','#9a93ad'],accentColors=['#ff3cac','#29eee8','#ffb42e','#7836ff','#3ad07a'];
  for(let i=0;i<950;i++){
    const x=rand()*SIZE,y=rand()*SIZE,r=.55+rand()*1.7,accent=rand()<.28;
    a.globalAlpha=accent?.2+rand()*.28:.12+rand()*.24;
    a.fillStyle=accent?accentColors[(rand()*accentColors.length)|0]:fleckColors[(rand()*fleckColors.length)|0];
    a.beginPath();a.ellipse(x,y,r,r*(.55+rand()*.85),rand()*Math.PI,0,Math.PI*2);a.fill();
    g.globalAlpha=.32;g.fillStyle='#b4b4b4';g.beginPath();g.arc(x,y,r,0,Math.PI*2);g.fill();
  }
  a.globalAlpha=1;g.globalAlpha=1;
  // Inlaid metal seams replace the old wireframe grid: same retro floor plan,
  // but lit like a trim strip instead of a glowing vector line.
  for(let i=0;i<=4;i++){
    const p=i*CELL;
    a.fillStyle='#221a38';a.fillRect(p-1.5,0,3,SIZE);a.fillRect(0,p-1.5,SIZE,3);
    a.fillStyle='#493a72';a.fillRect(p-1.5,0,1,SIZE);a.fillRect(0,p-1.5,SIZE,1);
    g.fillStyle='#333333';g.fillRect(p-1.5,0,3,SIZE);g.fillRect(0,p-1.5,SIZE,3);
  }
  // A small inlay marks each seam crossing. Kept close to the seam value on
  // purpose: any brighter and the crossings line up into a second wireframe
  // grid, which is the look this floor is replacing.
  for(let iy=0;iy<=4;iy++)for(let ix=0;ix<=4;ix++){
    a.save();a.translate(ix*CELL,iy*CELL);a.rotate(Math.PI/4);
    a.fillStyle='#2a2544';a.fillRect(-4,-4,8,8);
    a.fillStyle='#3d4f6b';a.fillRect(-2,-2,4,4);
    a.restore();
  }
  const map=new THREE.CanvasTexture(albedo),roughnessMap=new THREE.CanvasTexture(gloss);
  const anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  for(const texture of [map,roughnessMap]){texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=anisotropy}
  map.colorSpace=THREE.SRGBColorSpace;
  return {map,roughnessMap};
}
const floorTextures=arcadeFloorTextures();
floorTextures.map.repeat.set(7,8.5);floorTextures.roughnessMap.repeat.set(7,8.5);
// The floor needs a small non-directional base value. With a dark albedo and
// high metalness it previously reflected almost nothing at some camera angles,
// making the mesh appear to clip out as the player looked across the room.
// The hall is two plates: the stretch between the two side columns, and the
// full-width band across the top of it where the prize counter stands. The
// band is what lets the outer rooms of the top row open onto the hall.
const hallFloorMaterial=new THREE.MeshStandardMaterial({map:floorTextures.map,roughnessMap:floorTextures.roughnessMap,emissive:0x10091c,emissiveIntensity:.42,roughness:.66,metalness:.14});
const floor = new THREE.Mesh(new THREE.PlaneGeometry(43.2,67.2),hallFloorMaterial);floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
const topBandFloor = new THREE.Mesh(new THREE.PlaneGeometry(86.4,16.8),hallFloorMaterial);topBandFloor.rotation.x=-Math.PI/2;topBandFloor.position.set(0,0,-42);topBandFloor.receiveShadow=true;scene.add(topBandFloor);
function box(w,h,d,color,x,y,z,emissive=0){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:emissive,roughness:.43,metalness:.65}));m.position.set(x,y,z);m.castShadow=true;scene.add(m);return m}
// Tokyo-noir ceiling. A real ceiling plane closes off what used to be an open
// black void, and the full-width cyan light bars are replaced by short recessed
// troffers, so the room reads as a low-lit game centre rather than an arena.
// Every fixture here is emissive geometry only: none of it adds a real light,
// so the ceiling costs nothing against the per-frame light budget.
const ceiling=new THREE.Mesh(new THREE.PlaneGeometry(86.4,117.6),new THREE.MeshStandardMaterial({color:0x0c0a15,roughness:.95,metalness:.06}));
ceiling.rotation.x=Math.PI/2;ceiling.position.set(0,5.08,-8.4);scene.add(ceiling);
const ceilingBeamMaterial=new THREE.MeshStandardMaterial({color:0x14111f,roughness:.7,metalness:.5});
const ceilingHousingMaterial=new THREE.MeshStandardMaterial({color:0x1b1730,roughness:.82,metalness:.3});
// Warm sodium diffusers carry the room. The magenta row is kept to one in three
// so the cool accents read as signage spill instead of arena striping.
const warmPanelMaterial=new THREE.MeshStandardMaterial({color:0xffcf9a,emissive:0xffb877,emissiveIntensity:.9,roughness:.55});
const coolPanelMaterial=new THREE.MeshStandardMaterial({color:0xffa8d6,emissive:0xff4fa8,emissiveIntensity:.6,roughness:.55});
const haloTexture=(()=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
  const c=canvas.getContext('2d'),gradient=c.createRadialGradient(64,64,0,64,64,64);
  gradient.addColorStop(0,'rgba(255,255,255,1)');gradient.addColorStop(.45,'rgba(255,255,255,.32)');gradient.addColorStop(1,'rgba(255,255,255,0)');
  c.fillStyle=gradient;c.fillRect(0,0,128,128);
  return new THREE.CanvasTexture(canvas);
})();
const warmHaloMaterial=new THREE.MeshBasicMaterial({map:haloTexture,color:0xffb877,transparent:true,opacity:.5,depthWrite:false,blending:THREE.AdditiveBlending});
const coolHaloMaterial=new THREE.MeshBasicMaterial({map:haloTexture,color:0xff4fa8,transparent:true,opacity:.34,depthWrite:false,blending:THREE.AdditiveBlending});
for(let z=-15;z<=15;z+=5)box(56,.26,.34,0x14111f,0,4.9,z,.04);
for(const [row,z] of [-12.5,-7.5,-2.5,2.5,7.5,12.5].entries()){
  const cool=row%3===1;
  for(const x of [-21,-9,0,9,21]){
    const housing=new THREE.Mesh(new THREE.BoxGeometry(3.6,.17,.52),ceilingHousingMaterial);housing.position.set(x,4.95,z);scene.add(housing);
    const panel=new THREE.Mesh(new THREE.PlaneGeometry(3.3,.34),cool?coolPanelMaterial:warmPanelMaterial);panel.rotation.x=Math.PI/2;panel.position.set(x,4.862,z);scene.add(panel);
    const halo=new THREE.Mesh(new THREE.PlaneGeometry(5.4,1.6),cool?coolHaloMaterial:warmHaloMaterial);halo.rotation.x=Math.PI/2;halo.position.set(x,4.84,z);scene.add(halo);
  }
}
// The galleries added beyond the original hall inherited a ceiling but no
// fixtures, so they read as unlit black boxes. Lay the same troffer grid into
// any room, and give each one its own pair of managed point lights: the cull
// keeps only the two nearest, so whichever room the player stands in is the one
// that is actually lit and the budget stays flat.
function lightRoom(centerX,centerZ,width,depth,accent=0xff9a4d){
  const columns=Math.max(1,Math.round(width/9)),rows=Math.max(1,Math.round(depth/5));
  for(let row=0;row<rows;row++){
    const z=centerZ-depth/2+depth*(row+.5)/rows,cool=row%3===1;
    for(let column=0;column<columns;column++){
      const x=centerX-width/2+width*(column+.5)/columns;
      const housing=new THREE.Mesh(new THREE.BoxGeometry(3.6,.17,.52),ceilingHousingMaterial);housing.position.set(x,4.95,z);scene.add(housing);
      const panel=new THREE.Mesh(new THREE.PlaneGeometry(3.3,.34),cool?coolPanelMaterial:warmPanelMaterial);panel.rotation.x=Math.PI/2;panel.position.set(x,4.862,z);scene.add(panel);
      const halo=new THREE.Mesh(new THREE.PlaneGeometry(5.4,1.6),cool?coolHaloMaterial:warmHaloMaterial);halo.rotation.x=Math.PI/2;halo.position.set(x,4.84,z);scene.add(halo);
    }
  }
  point(accent,centerX,3.1,centerZ-depth/4,5.2);
  point(accent,centerX,3.1,centerZ+depth/4,5.2);
}
// Exposed service duct and conduit down the main aisle. The broken silhouette
// is what stops the ceiling from reading as a flat lid.
const ductMaterial=new THREE.MeshStandardMaterial({color:0x191527,roughness:.5,metalness:.72});
for(const [ductX,radius] of [[-7.6,.2],[7.6,.14]]){
  const duct=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,29,10),ductMaterial);duct.rotation.x=Math.PI/2;duct.position.set(ductX,4.68,0);scene.add(duct);
  for(let z=-13;z<=13;z+=5){const strap=new THREE.Mesh(new THREE.BoxGeometry(.04,.3,.05),ceilingHousingMaterial);strap.position.set(ductX,4.84,z);scene.add(strap)}
}
// Pendant tubes over the centre aisle: the warm vertical accents a game centre
// hangs between the cabinets rows.
const pendantMaterial=new THREE.MeshStandardMaterial({color:0xffd9ae,emissive:0xffa860,emissiveIntensity:1.05,roughness:.4});
// Down the length of the hall, and in two more rows either side of the centre
// aisle. One row over 20 m of a 67 m hall was most of why the room read as an
// empty shed: there was nothing at all between the ceiling and the floor.
const pendantCordGeometry=new THREE.BoxGeometry(.02,.62,.02);
const pendantTubeGeometry=new THREE.CylinderGeometry(.075,.075,.46,10);
const pendantBloomGeometry=new THREE.SphereGeometry(.3,10,8);
const pendantBloomMaterial=new THREE.MeshBasicMaterial({color:0xffa860,transparent:true,opacity:.11,depthWrite:false,blending:THREE.AdditiveBlending});
for(const x of [-11.5,0,11.5]){
  for(let z=-31;z<=31;z+=6.2){
    const cord=new THREE.Mesh(pendantCordGeometry,ceilingHousingMaterial);cord.position.set(x,4.55,z);scene.add(cord);
    const tube=new THREE.Mesh(pendantTubeGeometry,pendantMaterial);tube.position.set(x,4.02,z);scene.add(tube);
    const bloom=new THREE.Mesh(pendantBloomGeometry,pendantBloomMaterial);bloom.position.set(x,4.02,z);scene.add(bloom);
  }
}
/**
 * The floor plan: one hall with a ring of rooms around it.
 *
 * A row of four across the top, four down each side, and the Multiplayer /
 * Tournament hall across the bottom. Every room is 21.6 x 16.8 m, which is the
 * size the side rooms already were, so the rooms that exist keep their contents
 * and only move outward with the wall they stand against.
 *
 * The hall is full width across the top — that band is where the prize counter
 * stands — and narrows between the two side columns below it, which is what
 * lets the outer rooms of the top row open onto the hall at all.
 */
const ROOM_SPAN=21.6,ROOM_DEPTH=16.8;
const SHELL_HALF_WIDTH=43.2,HALL_HALF_WIDTH=21.6,ANNEX_ROOM_CENTER_X=32.4,ANNEX_ROOM_WIDTH=ROOM_SPAN;
// Four rooms down each side. The first three are where PS2, PlayStation and
// Mega Man already stood, so those three rooms do not move along z at all.
const SIDE_ROOM_Z=[-25.2,-8.4,8.4,25.2];
/**
 * The doorways in the two partition walls.
 *
 * Four rooms open off each wall and every one of them is walkable: the only
 * room still shut is the Multiplayer / Tournament hall, which is behind the
 * hall's own front wall rather than either of these.
 */
const OPEN_DOOR_Z=[-25.2,-8,8,25.2];
const SIDE_COLUMN_MIN_Z=-33.6,SIDE_COLUMN_MAX_Z=33.6;
const TOP_BAND_MIN_Z=-50.4,NORTH_ROW_MIN_Z=-67.2;
const NORTH_ROOM_X=[-32.4,-10.8,10.8,32.4];
const TOURNAMENT_MIN_Z=SIDE_COLUMN_MAX_Z,TOURNAMENT_MAX_Z=50.4;
const MEGAMAN_ROOM_WEST_X=-SHELL_HALF_WIDTH,MEGAMAN_ROOM_CENTER_X=-ANNEX_ROOM_CENTER_X,MEGAMAN_ROOM_CENTER_Z=8.4,MEGAMAN_ROOM_WIDTH=ROOM_SPAN,MEGAMAN_ROOM_DEPTH=ROOM_DEPTH,MEGAMAN_ROOM_DOOR_Z=8;
// The outer wall runs the whole depth of the building on both sides.
const SHELL_DEPTH=TOURNAMENT_MAX_Z-NORTH_ROW_MIN_Z,SHELL_CENTER_Z=(TOURNAMENT_MAX_Z+NORTH_ROW_MIN_Z)/2;
box(.3,5,SHELL_DEPTH,0x180d31,-SHELL_HALF_WIDTH,2.5,SHELL_CENTER_Z);
box(.3,5,SHELL_DEPTH,0x180d31,SHELL_HALF_WIDTH,2.5,SHELL_CENTER_Z);
box(SHELL_HALF_WIDTH*2,5,.3,0x180d31,0,2.5,NORTH_ROW_MIN_Z);
box(SHELL_HALF_WIDTH*2,5,.3,0x180d31,0,2.5,TOURNAMENT_MAX_Z);
// The wall the prize counter stands against: the top row's front wall, with a
// doorway into each of its four rooms. The panelled centre span is the backdrop
// behind the counter, which is why it is the one segment kept decorative.
const rearPanelMaterial=new THREE.MeshStandardMaterial({color:0x17233a,emissive:0x08162b,emissiveIntensity:.5,roughness:.58,metalness:.38});
const rearWall=box(18.4,5,.3,0x15182a,0,2.5,TOP_BAND_MIN_Z,.18);rearWall.receiveShadow=true;
for(let x=-8;x<=8;x+=4){const panel=new THREE.Mesh(new THREE.BoxGeometry(3.82,4.62,.055),rearPanelMaterial);panel.position.set(x,2.42,TOP_BAND_MIN_Z+.18);panel.receiveShadow=true;scene.add(panel)}
box(18,.09,.08,0xd18a52,0,4.78,TOP_BAND_MIN_Z+.23,.85);box(18,.12,.08,0x251447,0,.1,TOP_BAND_MIN_Z+.23,.55);
for(const [centerX,width] of [[-38.6,9.2],[-21.6,18.4],[21.6,18.4],[38.6,9.2]])box(width,5,.3,0x15182a,centerX,2.5,TOP_BAND_MIN_Z,.18);
const NORTH_ROW_DIVIDER_X=[-HALL_HALF_WIDTH,0,HALL_HALF_WIDTH];
for(const dividerX of NORTH_ROW_DIVIDER_X)box(.3,5,ROOM_DEPTH,0x11182c,dividerX,2.5,(NORTH_ROW_MIN_Z+TOP_BAND_MIN_Z)/2,.06);
const gangsterPepeMount=new THREE.Group();
const gangsterPepeLight=new THREE.PointLight(0xb9f5ff,3,3.5,2);
const PLAYSTATION_WALL_X=-HALL_HALF_WIDTH,N64_WALL_X=HALL_HALF_WIDTH,PARTITION_WALL_HALF_THICKNESS=.18,PLAYABLE_ROOM_DOOR_Z=-8,CONSTRUCTION_ROOM_DOOR_Z=8,PS2_ROOM_CENTER_X=-ANNEX_ROOM_CENTER_X,PS2_ROOM_CENTER_Z=-25.2,PS2_ROOM_DOOR_Z=-16.8,PS2_ROOM_BACK_Z=-33.6,ROOM_DOOR_HALF_WIDTH=1.6,PLAYER_COLLISION_RADIUS=.34;
const PARTITION_WALL_SEGMENTS=[[-30.2,6.8],[-16.6,14],[0,12.8],[16.6,14],[30.2,6.8]];
function buildPartitionWall(wallX,accent){
  for(const [centerZ,depth] of PARTITION_WALL_SEGMENTS){
    const wall=box(PARTITION_WALL_HALF_THICKNESS*2,5,depth,0x111425,wallX,2.5,centerZ,.08);wall.receiveShadow=true;
    box(.42,.08,depth,accent,wallX,4.86,centerZ,.9);box(.42,.1,depth,0x251447,wallX,.08,centerZ,.45);
  }
}
// The console logos that hung on the two divider walls are gone: the rooms are
// being re-themed by title rather than by machine, so a PlayStation mark on the
// wall of a room that no longer holds PlayStation games named the wrong thing.
buildPartitionWall(PLAYSTATION_WALL_X,0xd18a52);
buildPartitionWall(N64_WALL_X,0x36f9f6);
// The old front-left expansion is now the MegaMan Room. Xbox remains behind
// its original barrier while PS2 keeps its dedicated rear gallery.
// Hazard signage, but lit rather than painted. The yellow and black tape read
// as builder's plastic against everything else in the room; this keeps the same
// warning language in the arcade's own palette.
function constructionTapeTexture(){
  const canvas=document.createElement('canvas');canvas.width=768;canvas.height=512;
  const c=canvas.getContext('2d');
  const backdrop=c.createLinearGradient(0,0,0,512);
  backdrop.addColorStop(0,'#0a0d16');backdrop.addColorStop(.5,'#111a2b');backdrop.addColorStop(1,'#080a12');
  c.fillStyle=backdrop;c.fillRect(0,0,768,512);
  // Thin glowing chevrons instead of solid painted stripes.
  c.save();c.strokeStyle='#2fd8ff';c.globalAlpha=.5;c.lineWidth=12;
  for(let x=-560;x<1200;x+=88){c.beginPath();c.moveTo(x,512);c.lineTo(x+300,0);c.stroke()}
  c.restore();
  // Scanlines give it the flatness of a projected panel.
  c.globalAlpha=.16;c.fillStyle='#000000';
  for(let y=0;y<512;y+=4)c.fillRect(0,y,768,2);
  c.globalAlpha=1;
  c.fillStyle='rgba(6,10,18,.82)';c.fillRect(0,186,768,140);
  c.strokeStyle='#2fd8ff';c.lineWidth=3;c.strokeRect(18,192,732,128);
  c.strokeStyle='#ffb877';c.lineWidth=1.5;c.strokeRect(26,200,716,112);
  c.fillStyle='#eaf7ff';c.font='700 62px Impact, "Arial Black", sans-serif';
  c.textAlign='center';c.textBaseline='middle';
  c.shadowColor='#2fd8ff';c.shadowBlur=22;c.fillText('SECTOR SEALED',384,244);
  c.shadowBlur=0;c.fillStyle='#ffb877';c.font='700 24px monospace';
  c.fillText('U N D E R   C O N S T R U C T I O N',384,296);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;return texture;
}
const constructionTexture=constructionTapeTexture(),constructionBarriers=[];
/**
 * A sealed doorway: the panel, its two posts and their beacons.
 *
 * `facing` is the direction a player stands to read it, so the panel turns to
 * meet them and the posts stand on their side of the opening. Every unfinished
 * room in the ring gets one, which is why this is a function now rather than
 * the same six lines written out per room.
 */
function sealDoorway(roomName,x,z,facing){
  const barrier=new THREE.Group();barrier.position.set(x,0,z);barrier.userData.roomName=roomName;
  const normal=new THREE.Vector3(Math.sin(facing),0,Math.cos(facing));
  const along=new THREE.Vector3(Math.cos(facing),0,-Math.sin(facing));
  const panel=new THREE.Mesh(new THREE.PlaneGeometry(3.1,2.65),new THREE.MeshBasicMaterial({map:constructionTexture,side:THREE.FrontSide}));
  panel.position.set(normal.x*.205,1.48,normal.z*.205);panel.rotation.y=facing;barrier.add(panel);
  for(const edge of [-1.56,1.56]){
    const post=new THREE.Mesh(new THREE.BoxGeometry(.22,3.05,.18),new THREE.MeshStandardMaterial({color:0x161616,emissive:0x4b3600,emissiveIntensity:.35,metalness:.78,roughness:.28}));
    post.position.set(along.x*edge+normal.x*.18,1.52,along.z*edge+normal.z*.18);barrier.add(post);
    const beacon=new THREE.PointLight(0xffb000,1.7,2.8,2);
    beacon.position.set(along.x*edge+normal.x*.38,2.9,along.z*edge+normal.z*.38);
    beacon.userData.accentLight=true;barrier.add(beacon);managedSceneLights.push(beacon);
  }
  scene.add(barrier);constructionBarriers.push(barrier);
  return barrier;
}
// Every doorway in the ring that leads somewhere unfinished. The three that
// are not here are PS2, PlayStation and Mega Man, which are open.
//
// The two rooms behind a bound rather than a doorway — the tournament hall and
// the top row — are sealed by WORLD_BOUNDS as well; the barrier is what tells
// the player why they stop.
const tournamentConstructionBarrier=sealDoorway('Multiplayer / Tournament',0,TOURNAMENT_MIN_Z-.25,Math.PI);
// Opaque wall lining for the expansion hallway. The original structural walls
// were so dark that they read as empty space; these inset panels make both
// sides visibly solid while keeping the openings around the partition ends.
const hallwayWallMaterial=new THREE.MeshStandardMaterial({color:0x17233a,emissive:0x071527,emissiveIntensity:.42,roughness:.62,metalness:.3});
const hallwaySeamMaterial=new THREE.MeshStandardMaterial({color:0x29466d,emissive:0x12345b,emissiveIntensity:.9,roughness:.38,metalness:.55});
for(const wallX of [-SHELL_HALF_WIDTH+.19,SHELL_HALF_WIDTH-.19]){
  // North of the divider the west shell is no longer here: the Mega Man room
  // steps out, and its own wall carries a mural instead of this panelling.
  const liningMaxZ=wallX<0?-1.7:11.9,seamMaxZ=wallX<0?-3.4:13.6,trimLength=wallX<0?16.8:27.35,trimZ=wallX<0?-8.4:0;
  // The inclusive end has to tolerate the accumulated step: three additions of
  // 3.4 land on -1.7000000000000002, which dropped the last panel on the west.
  for(let z=-11.9;z<=liningMaxZ+1e-6;z+=3.4){
    const panel=new THREE.Mesh(new THREE.BoxGeometry(.08,4.68,3.24),hallwayWallMaterial);
    panel.position.set(wallX,2.42,z);panel.receiveShadow=true;scene.add(panel);
  }
  for(let z=-13.6;z<=seamMaxZ;z+=3.4){
    const seam=new THREE.Mesh(new THREE.BoxGeometry(.095,4.68,.035),hallwaySeamMaterial);
    seam.position.set(wallX,2.42,z);scene.add(seam);
  }
  const baseTrim=new THREE.Mesh(new THREE.BoxGeometry(.11,.13,trimLength),new THREE.MeshStandardMaterial({color:0x182d4a,emissive:0x133b64,emissiveIntensity:1.05,metalness:.7,roughness:.22}));
  baseTrim.position.set(wallX,.12,trimZ);scene.add(baseTrim);
  const topTrim=new THREE.Mesh(new THREE.BoxGeometry(.11,.08,trimLength),new THREE.MeshStandardMaterial({color:0xd18a52,emissive:0xd18a52,emissiveIntensity:.8,metalness:.5,roughness:.2}));
  topTrim.position.set(wallX,4.77,trimZ);scene.add(topTrim);
}
// The expansion rooms reuse the main floor canvas at their own tiling rate and
// a cooler tint, so the second room costs one extra texture rather than a new
// pattern and two more GridHelper meshes.
const expansionFloorMaterial=(()=>{
  const map=floorTextures.map.clone(),roughnessMap=floorTextures.roughnessMap.clone();
  map.needsUpdate=roughnessMap.needsUpdate=true;
  map.repeat.set(3.5,8.5);roughnessMap.repeat.set(3.5,8.5);
  return new THREE.MeshStandardMaterial({map,roughnessMap,color:0x8fa8d8,emissive:0x0b1324,emissiveIntensity:.38,roughness:.7,metalness:.12});
})();
// The relocated MegaMan Room reuses the existing front-left floor and shell.
// Each mural fills one of its three solid walls; the east wall stays open at
// the hub doorway so players can walk straight in.
// Each mural is stretched to its wall rather than centred on it: the room is
// 21.3 m along its long walls and 16.5 m across, and a mural at the artwork's
// own aspect left a metre of bare wall at both ends of every one of them.
// Mood lighting taken from the murals themselves. Each image is sampled down to
// a coarse grid, the brightest cells of it — the white of a helmet, the blown
// highlight on a visor — become dim lights standing just off the wall, and every
// colour is pulled halfway to the room's accent so three different images light
// one room rather than three. They are ranked over the range they reach, so the
// three nearest the player are all that is ever drawn no matter how many a wall
// contributes.
// Standing well off the wall rather than against it: a light on the mural's
// own face only rims whatever stands in front of it, which is exactly what the
// statue line does. Out here the wall still reads as the source and the room
// in front of it is what gets lit.
const MURAL_MOOD_ACCENT=new THREE.Color(0x4aa8ff),MURAL_MOOD_MIN_LUMINANCE=.4,MURAL_MOOD_COLUMNS=16,MURAL_MOOD_ROWS=3,MURAL_MOOD_STANDOFF=2.6;
function addMuralMoodLights(texture,{center,normal,along,span,height,count=5}){
  const image=texture?.image;
  if(!image?.width||!image?.height)return;
  const canvas=document.createElement('canvas');canvas.width=MURAL_MOOD_COLUMNS;canvas.height=MURAL_MOOD_ROWS;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  if(!context)return;
  // Drawing the whole mural into a 16x3 canvas is the averaging step: each cell
  // is the mean colour of that patch of wall, which is what a bounce would be.
  context.drawImage(image,0,0,MURAL_MOOD_COLUMNS,MURAL_MOOD_ROWS);
  let pixels;
  try{pixels=context.getImageData(0,0,MURAL_MOOD_COLUMNS,MURAL_MOOD_ROWS).data}
  catch(error){console.warn('A mural could not be sampled for mood lighting.',error);return}
  const cells=[];
  for(let index=0;index<MURAL_MOOD_COLUMNS*MURAL_MOOD_ROWS;index+=1){
    const red=pixels[index*4]/255,green=pixels[index*4+1]/255,blue=pixels[index*4+2]/255;
    cells.push({column:index%MURAL_MOOD_COLUMNS,row:Math.floor(index/MURAL_MOOD_COLUMNS),red,green,blue,luminance:.2126*red+.7152*green+.0722*blue});
  }
  cells.sort((first,second)=>second.luminance-first.luminance);
  // Brightest first, but never two from the same stretch of wall: without the
  // spacing rule all five lights land inside one bright figure and the rest of
  // the mural stays dark.
  const spacing=MURAL_MOOD_COLUMNS/(count+1),chosen=[];
  for(const cell of cells){
    if(chosen.length>=count)break;
    if(cell.luminance<MURAL_MOOD_MIN_LUMINANCE)break;
    if(chosen.some(other=>Math.abs(other.column-cell.column)<spacing))continue;
    chosen.push(cell);
  }
  for(const cell of chosen){
    const offset=((cell.column+.5)/MURAL_MOOD_COLUMNS-.5)*span;
    const color=new THREE.Color(cell.red,cell.green,cell.blue).lerp(MURAL_MOOD_ACCENT,.5);
    const light=new THREE.PointLight(color,4.2+cell.luminance*3.2,16,2);
    light.position.set(center.x+along.x*offset+normal.x*MURAL_MOOD_STANDOFF,center.y+(.5-(cell.row+.5)/MURAL_MOOD_ROWS)*height,center.z+along.z*offset+normal.z*MURAL_MOOD_STANDOFF);
    light.userData.muralLight=true;
    scene.add(light);managedSceneLights.push(light);
  }
}
const MEGAMAN_MURAL_SPAN=21.3,MEGAMAN_SIDE_MURAL_SPAN=16.5,MEGAMAN_MURAL_HEIGHT=4.8;
/**
 * Hangs a side room's three murals and takes its mood lighting from them.
 *
 * Every room in the two side columns has the same three solid walls — one
 * across the far end, one across the near end, and one down the outer side —
 * so a themed room is three images and nothing else. The fourth wall is the
 * partition the doorway is cut into.
 *
 * This is the Mega Man room's own code with that room's numbers taken out of
 * it. It was written out by hand three times, which is two rooms' worth of
 * copying before the second themed room even existed.
 */
function themeRoom({centerX,centerZ,far,near,side}){
  const outward=Math.sign(centerX);
  const farZ=centerZ+MEGAMAN_ROOM_DEPTH/2,nearZ=centerZ-MEGAMAN_ROOM_DEPTH/2;
  const walls=[];
  // The insets differ by a few centimetres per wall because the backing panel
  // and the mural must not z-fight, and the far wall was tuned first.
  if(far)walls.push({file:far,span:MEGAMAN_MURAL_SPAN,sideWall:false,
    at:new THREE.Vector3(centerX,2.5,farZ-.26),backingAt:farZ-.19,rotation:Math.PI,
    normal:new THREE.Vector3(0,0,-1),along:new THREE.Vector3(-1,0,0),count:5});
  if(near)walls.push({file:near,span:MEGAMAN_MURAL_SPAN,sideWall:false,
    at:new THREE.Vector3(centerX,2.5,nearZ+.32),backingAt:nearZ+.19,rotation:0,
    normal:new THREE.Vector3(0,0,1),along:new THREE.Vector3(1,0,0),count:5});
  if(side)walls.push({file:side,span:MEGAMAN_SIDE_MURAL_SPAN,sideWall:true,
    at:new THREE.Vector3(outward*(SHELL_HALF_WIDTH-.32),2.5,centerZ),backingAt:outward*(SHELL_HALF_WIDTH-.19),
    rotation:outward*-Math.PI/2,normal:new THREE.Vector3(-outward,0,0),along:new THREE.Vector3(0,0,outward),count:4});
  for(const wall of walls){
    if(wall.sideWall)box(.08,5,wall.span,0x050711,wall.backingAt,2.5,centerZ,.12);
    else box(wall.span,5,.08,0x050711,centerX,2.5,wall.backingAt,.12);
    const texture=new THREE.TextureLoader().load(`assets/art/${wall.file}`,loaded=>addMuralMoodLights(loaded,{
      center:wall.at,normal:wall.normal,along:wall.along,span:wall.span,height:MEGAMAN_MURAL_HEIGHT,count:wall.count
    }));
    texture.colorSpace=THREE.SRGBColorSpace;
    texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
    const mural=new THREE.Mesh(new THREE.PlaneGeometry(wall.span,MEGAMAN_MURAL_HEIGHT),
      new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4}));
    mural.position.copy(wall.at);mural.rotation.y=wall.rotation;mural.renderOrder=4;scene.add(mural);
  }
}
themeRoom({
  centerX:MEGAMAN_ROOM_CENTER_X,centerZ:MEGAMAN_ROOM_CENTER_Z,
  far:'megaman-room-mural.webp?v=megaman-mural-1',
  near:'megaman-room-mural-3.webp?v=megaman-mural-3',
  side:'megaman-room-mural-2.webp?v=megaman-mural-2'
});
// The second themed room, from art supplied for it. Everything the Mega Man
// room needed by hand, this room gets in six lines.
themeRoom({
  centerX:MEGAMAN_ROOM_CENTER_X,centerZ:-8.4,
  far:'metal-gear-room-mural.webp?v=mgs-3',
  near:'metal-gear-room-mural-3.webp?v=mgs-3',
  side:'metal-gear-room-mural-2.webp?v=mgs-3'
});
// Metroid, across the hall in the east column. Each wall is a band from one of
// the three images supplied for it, cut to that wall's own aspect.
themeRoom({
  centerX:ANNEX_ROOM_CENTER_X,centerZ:-8.4,
  far:'metroid-room-mural.webp?v=metroid-1',
  near:'metroid-room-mural-3.webp?v=metroid-1',
  side:'metroid-room-mural-2.webp?v=metroid-1'
});
// Super Mario, in the west column behind Metal Gear.
themeRoom({
  centerX:MEGAMAN_ROOM_CENTER_X,centerZ:-25.2,
  far:'mario-room-mural.webp?v=mario-1',
  near:'mario-room-mural-3.webp?v=mario-1',
  side:'mario-room-mural-2.webp?v=mario-1'
});
// No light rig here: the ring already lays one into every side room, and a
// second in the same room is two rigs competing for the same light budget.
// The fourth mural is on the outside: the hub-facing span of the partition wall
// between the Mega Man doorway and the corner. Mega Man occupies the right of
// the image, and with the plane turned to face the hub its right edge lands
// against the doorway, so the blue runs north to the corner behind him. Sized to
// the 7.1 m wall segment at the image's own 907x527 aspect, so nothing stretches.
// Split at the doorway rather than hung beside it. Mega Man takes the wall on
// the right of the door as you face it from the hub, cropped from the artwork at
// its own aspect; the blue that was dead space behind him is stretched across
// the whole span on the far side. Read together they are one image the doorway
// happens to interrupt.
const MEGAMAN_HALL_MURAL_HEIGHT=4.8,MEGAMAN_HALL_MURAL_X=PLAYSTATION_WALL_X+.35;
const MEGAMAN_HALL_FIGURE_SPAN=4.6,MEGAMAN_HALL_FIGURE_CENTER_Z=4.1;
const MEGAMAN_HALL_GLOW_SPAN=7.1,MEGAMAN_HALL_GLOW_CENTER_Z=13.25;
function hallMural(file,span,centerZ){
  box(.08,5,span,0x050711,PLAYSTATION_WALL_X+.22,2.5,centerZ,.12);
  const texture=new THREE.TextureLoader().load(`assets/art/${file}?v=megaman-hall-2`);
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  const mural=new THREE.Mesh(new THREE.PlaneGeometry(span,MEGAMAN_HALL_MURAL_HEIGHT),new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4}));
  mural.position.set(MEGAMAN_HALL_MURAL_X,2.5,centerZ);mural.rotation.y=Math.PI/2;mural.renderOrder=4;scene.add(mural);
  return mural;
}
const megaManHallGlow=hallMural('megaman-hall-glow.webp',MEGAMAN_HALL_GLOW_SPAN,MEGAMAN_HALL_GLOW_CENTER_Z);
const megaManHallFigure=hallMural('megaman-hall-figure.webp',MEGAMAN_HALL_FIGURE_SPAN,MEGAMAN_HALL_FIGURE_CENTER_Z);
lightRoom(MEGAMAN_ROOM_CENTER_X,MEGAMAN_ROOM_CENTER_Z,MEGAMAN_ROOM_WIDTH,MEGAMAN_ROOM_DEPTH,0x4aa8ff);
// Each side annex is split into two near-square rooms. The rear pair contains
// the playable PlayStation and N64 galleries; the front pair remains available
// for future systems. PlayStation's rear wall has a centered doorway leading
// exclusively to the new PS2 room.
// Both side annexes are one width now, and each is split at z=0 into two rooms
// of the same size as every other room in the building. Both rear walls carry a
// doorway, because both now lead somewhere: PS2 behind PlayStation, GameCube
// behind Nintendo 64.
// The eight side rooms: one floor plate per column, the walls between the rooms
// in it, and a light rig per room. The rooms that already existed sit on the
// first three z slots, so none of their contents move along z.
const SIDE_COLUMN_DEPTH=SIDE_COLUMN_MAX_Z-SIDE_COLUMN_MIN_Z,SIDE_COLUMN_CENTER_Z=(SIDE_COLUMN_MAX_Z+SIDE_COLUMN_MIN_Z)/2;
const SIDE_ROOM_ACCENTS=[0xff5fae,0xd18a52,0x4aa8ff,0x7dff67];
for(const roomX of [-ANNEX_ROOM_CENTER_X,ANNEX_ROOM_CENTER_X]){
  const columnFloor=new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SPAN,SIDE_COLUMN_DEPTH),expansionFloorMaterial);
  columnFloor.rotation.x=-Math.PI/2;columnFloor.position.set(roomX,.002,SIDE_COLUMN_CENTER_Z);columnFloor.receiveShadow=true;scene.add(columnFloor);
  box(ROOM_SPAN,.12,SIDE_COLUMN_DEPTH,0x090b18,roomX,5.08,SIDE_COLUMN_CENTER_Z,.08);
  for(const wallZ of [SIDE_COLUMN_MIN_Z,-ROOM_DEPTH,0,ROOM_DEPTH,SIDE_COLUMN_MAX_Z]){
    const wall=box(ROOM_SPAN,5,.3,0x11182c,roomX,2.5,wallZ,.05);wall.receiveShadow=true;
  }
  SIDE_ROOM_Z.forEach((centerZ,index)=>{
    for(let z=centerZ-6;z<=centerZ+6;z+=4)box(ROOM_SPAN-.5,.035,.055,0x4e7ea8,roomX,4.65,z,.8);
    lightRoom(roomX,centerZ,ROOM_SPAN,ROOM_DEPTH,SIDE_ROOM_ACCENTS[index]);
  });
}
// The top row, and the full-width band of hall in front of it.
const NORTH_ROW_CENTER_Z=(NORTH_ROW_MIN_Z+TOP_BAND_MIN_Z)/2,TOP_BAND_CENTER_Z=(TOP_BAND_MIN_Z+SIDE_COLUMN_MIN_Z)/2;
const northRowFloor=new THREE.Mesh(new THREE.PlaneGeometry(SHELL_HALF_WIDTH*2,ROOM_DEPTH),expansionFloorMaterial);
northRowFloor.rotation.x=-Math.PI/2;northRowFloor.position.set(0,.002,NORTH_ROW_CENTER_Z);northRowFloor.receiveShadow=true;scene.add(northRowFloor);
box(SHELL_HALF_WIDTH*2,.12,ROOM_DEPTH,0x090b18,0,5.08,NORTH_ROW_CENTER_Z,.08);
NORTH_ROOM_X.forEach((centerX,index)=>lightRoom(centerX,NORTH_ROW_CENTER_Z,ROOM_SPAN,ROOM_DEPTH,SIDE_ROOM_ACCENTS[index]));
lightRoom(0,TOP_BAND_CENTER_Z,SHELL_HALF_WIDTH*2,ROOM_DEPTH,0xffb066);
// The hall. Its ceiling still carried the grid laid for the old 28 x 34 hub,
// which is a third of the floor it has to light now.
for(const bandZ of [-25.2,-8.4,8.4,25.2])lightRoom(0,bandZ,HALL_HALF_WIDTH*2,ROOM_DEPTH,bandZ<0?0xffb066:0x4aa8ff);
const GAMECUBE_ROOM_CENTER_X=ANNEX_ROOM_CENTER_X,GAMECUBE_ROOM_CENTER_Z=PS2_ROOM_CENTER_Z;
// The Multiplayer / Tournament room runs the full width of the building behind
// the hub, off the one doorway in the hub's front wall. It is sealed the way
// the Xbox room is: the space is built and lit so it reads through the barrier
// as a room rather than a black rectangle, and the world bound behind the
// barrier is what actually keeps players out.
const TOURNAMENT_ROOM_WIDTH=SHELL_HALF_WIDTH*2,TOURNAMENT_ROOM_DEPTH=ROOM_DEPTH,TOURNAMENT_ROOM_CENTER_Z=(TOURNAMENT_MIN_Z+TOURNAMENT_MAX_Z)/2,TOURNAMENT_ROOM_BACK_Z=TOURNAMENT_MAX_Z,TOURNAMENT_ROOM_DOOR_Z=TOURNAMENT_MIN_Z;
const tournamentFloorMaterial=(()=>{const map=floorTextures.map.clone(),roughnessMap=floorTextures.roughnessMap.clone();map.needsUpdate=roughnessMap.needsUpdate=true;map.repeat.set(14,3.5);roughnessMap.repeat.set(14,3.5);return new THREE.MeshStandardMaterial({map,roughnessMap,color:0x8fa8d8,emissive:0x0b1324,emissiveIntensity:.38,roughness:.7,metalness:.12})})();
const tournamentFloor=new THREE.Mesh(new THREE.PlaneGeometry(TOURNAMENT_ROOM_WIDTH,TOURNAMENT_ROOM_DEPTH),tournamentFloorMaterial);tournamentFloor.rotation.x=-Math.PI/2;tournamentFloor.position.set(0,.002,TOURNAMENT_ROOM_CENTER_Z);tournamentFloor.receiveShadow=true;scene.add(tournamentFloor);
const tournamentCeiling=box(TOURNAMENT_ROOM_WIDTH,.12,TOURNAMENT_ROOM_DEPTH,0x090b18,0,5.08,TOURNAMENT_ROOM_CENTER_Z,.08);tournamentCeiling.receiveShadow=true;
box(.3,5,TOURNAMENT_ROOM_DEPTH,0x11182c,-SHELL_HALF_WIDTH,2.5,TOURNAMENT_ROOM_CENTER_Z,.06);box(.3,5,TOURNAMENT_ROOM_DEPTH,0x11182c,SHELL_HALF_WIDTH,2.5,TOURNAMENT_ROOM_CENTER_Z,.06);
box(TOURNAMENT_ROOM_WIDTH,5,.3,0x11182c,0,2.5,TOURNAMENT_ROOM_BACK_Z,.06);
// The hub's front wall, either side of the one doorway. It reaches the
// partition walls rather than stopping short of them, which used to leave a two
// metre hole at each end that only the old room's narrower side walls covered.
for(const side of [-1,1])box(SHELL_HALF_WIDTH-ROOM_DOOR_HALF_WIDTH,5,.3,0x11182c,side*(SHELL_HALF_WIDTH+ROOM_DOOR_HALF_WIDTH)/2,2.5,TOURNAMENT_ROOM_DOOR_Z,.06);
for(let x=-40;x<=40;x+=4)box(3.82,.055,.06,0x4e7ea8,x,4.66,TOURNAMENT_ROOM_BACK_Z-.19,.75);
lightRoom(0,TOURNAMENT_ROOM_CENTER_Z,TOURNAMENT_ROOM_WIDTH,TOURNAMENT_ROOM_DEPTH,0xffb066);
const pudgyToyTexture=new THREE.TextureLoader().load('assets/art/pudgy-penguin-toy.webp?v=webp-2');
function crashArt(){
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;const c=canvas.getContext('2d');
  const sky=c.createLinearGradient(0,0,512,512);sky.addColorStop(0,'#e84c25');sky.addColorStop(.47,'#ffb12d');sky.addColorStop(1,'#451769');c.fillStyle=sky;c.fillRect(0,0,512,512);
  c.fillStyle='#44205e';for(let i=0;i<10;i++){c.save();c.translate(45+i*55,65+(i%2)*300);c.rotate(i*.55);c.fillRect(-12,-95,24,190);c.fillRect(-75,-17,150,34);c.restore()}
  c.fillStyle='#613717';c.fillRect(145,340,220,135);c.strokeStyle='#f7b735';c.lineWidth=12;c.strokeRect(145,340,220,135);c.beginPath();c.moveTo(145,340);c.lineTo(365,475);c.moveTo(365,340);c.lineTo(145,475);c.stroke();
  c.fillStyle='#f17426';c.beginPath();c.arc(258,220,112,0,Math.PI*2);c.fill();c.fillStyle='#f8d36b';c.beginPath();c.ellipse(258,265,72,54,0,0,Math.PI*2);c.fill();
  c.fillStyle='#2a164a';c.beginPath();c.moveTo(170,158);c.lineTo(127,54);c.lineTo(223,123);c.moveTo(345,158);c.lineTo(390,54);c.lineTo(292,123);c.fill();
  c.fillStyle='#fff7d6';c.beginPath();c.ellipse(215,210,30,38,0,0,Math.PI*2);c.ellipse(301,210,30,38,0,0,Math.PI*2);c.fill();c.fillStyle='#19112a';c.beginPath();c.arc(218,214,12,0,Math.PI*2);c.arc(298,214,12,0,Math.PI*2);c.fill();
  c.strokeStyle='#2b1637';c.lineWidth=12;c.beginPath();c.arc(258,270,36,.15,Math.PI-.15);c.stroke();c.fillStyle='#fff1c9';c.font='bold 46px sans-serif';c.textAlign='center';c.fillText('CRASH',256,68);
  return new THREE.CanvasTexture(canvas);
}
// Sleek cabinet shell. Every cabinet is the same size, so the geometry is built
// once here and shared by all of them rather than rebuilt per cabinet, which
// also drops the scene from roughly 300 cabinet geometries to about 20.
function roundedRectShape(width,height,radius){
  const w=width/2,h=height/2,r=Math.min(radius,w,h),shape=new THREE.Shape();
  shape.moveTo(-w+r,-h);shape.lineTo(w-r,-h);shape.absarc(w-r,-h+r,r,-Math.PI/2,0,false);
  shape.lineTo(w,h-r);shape.absarc(w-r,h-r,r,0,Math.PI/2,false);
  shape.lineTo(-w+r,h);shape.absarc(-w+r,h-r,r,Math.PI/2,Math.PI,false);
  shape.lineTo(-w,-h+r);shape.absarc(-w+r,-h+r,r,Math.PI,Math.PI*1.5,false);
  return shape;
}
// Extrudes a rounded profile along z and chamfers the front and back edges, so
// the silhouette has no hard 90 degree corner anywhere a player can see one.
function roundedSlab(width,height,depth,radius,bevel=.022){
  const geometry=new THREE.ExtrudeGeometry(roundedRectShape(width,height,radius),{depth:depth-bevel*2,bevelEnabled:true,bevelThickness:bevel,bevelSize:bevel,bevelSegments:2,curveSegments:5});
  geometry.translate(0,0,-(depth/2-bevel));geometry.computeVertexNormals();
  return geometry;
}
const cabinetGeometry={
  plinth:roundedSlab(1.78,.1,1.2,.05),
  body:roundedSlab(1.68,1.45,1.08,.1),
  bodyInset:roundedSlab(1.44,1.2,.02,.07,.008),
  head:roundedSlab(1.56,1.28,.78,.1),
  bezel:roundedSlab(1.44,1.06,.05,.07,.012),
  deck:roundedSlab(1.5,.12,.56,.045),
  lightRod:new THREE.CylinderGeometry(.016,.016,2.46,8),
  lightChannel:roundedSlab(.07,2.5,.05,.03,.01),
  screen:new THREE.PlaneGeometry(1.24,.84),
  glassSheen:new THREE.PlaneGeometry(1.42,1.04),
  gate:new THREE.CylinderGeometry(.14,.14,.032,18),
  gateRing:new THREE.TorusGeometry(.1,.012,8,20),
  stem:new THREE.CylinderGeometry(.018,.023,.115,10),
  stick:new THREE.SphereGeometry(.052,12,10),
  buttonWell:new THREE.CylinderGeometry(.075,.085,.025,16),
  button:new THREE.CylinderGeometry(.052,.052,.035,16),
  statusLight:new THREE.BoxGeometry(.18,.045,.035),
  deckLight:new THREE.BoxGeometry(1.22,.016,.03),
  marqueeWash:new THREE.BoxGeometry(1.5,.02,.03),
  railLong:new THREE.BoxGeometry(1.52,.02,.045),
  railSide:new THREE.BoxGeometry(.045,.02,.82)
};
// Designed marquee for every cabinet without licensed artwork. These used to be
// a line of monospace text on a flat plate, two thirds the height of the Crash
// and Gex marquees, so the rows never lined up. Drawn from the cabinet hue so
// each machine reads as its own product without copying anyone's box art.
const SYSTEM_MARQUEE_LABEL={psx:'PLAYSTATION',n64:'NINTENDO 64',snes:'SUPER NINTENDO',gamecube:'NINTENDO GAMECUBE',ps2:'PLAYSTATION 2',xbox:'XBOX'};
function cabinetMarqueeTexture(name,hue,system){
  const W=768,H=234,canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
  const c=canvas.getContext('2d');
  const tint=v=>'#'+new THREE.Color(hue).multiplyScalar(v).getHexString();
  const backdrop=c.createLinearGradient(0,0,0,H);
  backdrop.addColorStop(0,'#0a0912');backdrop.addColorStop(.5,tint(.18));backdrop.addColorStop(1,'#06050c');
  c.fillStyle=backdrop;c.fillRect(0,0,W,H);
  // Angled sheen, the way a lit acrylic marquee catches the ceiling lights.
  const sheen=c.createLinearGradient(0,H,W*.75,0);
  sheen.addColorStop(0,'rgba(255,255,255,0)');sheen.addColorStop(.48,'rgba(255,255,255,0)');
  sheen.addColorStop(.56,'rgba(255,255,255,.07)');sheen.addColorStop(.64,'rgba(255,255,255,0)');
  c.fillStyle=sheen;c.fillRect(0,0,W,H);
  c.strokeStyle=tint(.9);c.lineWidth=6;c.strokeRect(3,3,W-6,H-6);
  c.strokeStyle=tint(.35);c.lineWidth=2;c.strokeRect(14,14,W-28,H-28);
  const badge=SYSTEM_MARQUEE_LABEL[system];
  if(badge){c.fillStyle=tint(1.25);c.font='700 21px monospace';c.textAlign='center';c.textBaseline='middle';
    c.fillText(badge.split('').join(' '),W/2,46)}
  // Fit the title: one line if it will fit, otherwise split on the nearest space.
  const title=String(name).toUpperCase();
  const maxWidth=W-96;
  const widthAt=(text,size)=>{c.font='700 '+size+'px Impact, "Arial Black", sans-serif';return c.measureText(text).width};
  let lines=[title],size=64;
  while(size>26&&widthAt(title,size)>maxWidth)size-=2;
  if(widthAt(title,size)>maxWidth||title.length>22){
    const words=title.split(' ');let best=1,bestDelta=Infinity;
    for(let i=1;i<words.length;i++){const delta=Math.abs(words.slice(0,i).join(' ').length-words.slice(i).join(' ').length);
      if(delta<bestDelta){bestDelta=delta;best=i}}
    lines=[words.slice(0,best).join(' '),words.slice(best).join(' ')];
    size=52;while(size>20&&Math.max(widthAt(lines[0],size),widthAt(lines[1],size))>maxWidth)size-=2;
  }
  c.font='700 '+size+'px Impact, "Arial Black", sans-serif';
  c.textAlign='center';c.textBaseline='middle';
  const baseY=badge?H/2+26:H/2+8,step=size+8;
  lines.forEach((line,index)=>{
    const y=baseY+(index-(lines.length-1)/2)*step;
    c.shadowColor=tint(1.4);c.shadowBlur=18;c.fillStyle='#fdf6e6';c.fillText(line,W/2,y);
    c.shadowBlur=0;c.strokeStyle='rgba(6,5,12,.55)';c.lineWidth=1.5;c.strokeText(line,W/2,y);
  });
  c.fillStyle=tint(1.35);c.fillRect(28,H-22,W-56,5);
  const texture=new THREE.CanvasTexture(canvas);
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  return texture;
}
const cabinetGateMaterial=new THREE.MeshStandardMaterial({color:0x02040a,metalness:1,roughness:.08});
const cabinetStemMaterial=new THREE.MeshStandardMaterial({color:0xe0e5ef,metalness:1,roughness:.06});
const cabinetStickMaterial=new THREE.MeshStandardMaterial({color:0x111722,metalness:.55,roughness:.15});
const cabinetWellMaterial=new THREE.MeshStandardMaterial({color:0x03050b,metalness:1,roughness:.12});
// The four face buttons are the same four colours on every cabinet, so one
// material each is enough for the whole arcade.
const cabinetButtonLayout=[[.08,.58,0xff3cac],[.28,.58,0x36f9f6],[.08,.72,0xffb42e],[.28,.72,0x934dff]].map(([bx,bz,color])=>[bx,bz,new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.55,metalness:.45,roughness:.18})]);
// Materials with no per-cabinet tint are shared too. The hue-tinted ones and
// the status light stay per cabinet, because setCabinetState mutates them.
const cabinetShellMaterial=new THREE.MeshStandardMaterial({color:0x0f1220,roughness:.26,metalness:.82});
const cabinetHeadMaterial=new THREE.MeshStandardMaterial({color:0x131828,roughness:.2,metalness:.86});
const cabinetPlinthMaterial=new THREE.MeshStandardMaterial({color:0x0a0c16,roughness:.34,metalness:.7});
const cabinetBezelMaterial=new THREE.MeshStandardMaterial({color:0x04060d,roughness:.09,metalness:.95});
const cabinetDeckMaterial=new THREE.MeshStandardMaterial({color:0x0d1120,roughness:.2,metalness:.9});
const cabinetChannelMaterial=new THREE.MeshStandardMaterial({color:0x070910,roughness:.5,metalness:.6});
// A soft diagonal highlight sells the screen as glass without dimming it the
// way a real transparent panel in front of the canvas would.
const cabinetGlassMaterial=(()=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
  const c=canvas.getContext('2d'),gradient=c.createLinearGradient(0,128,128,0);
  gradient.addColorStop(0,'rgba(255,255,255,0)');gradient.addColorStop(.42,'rgba(255,255,255,0)');
  gradient.addColorStop(.55,'rgba(255,255,255,.5)');gradient.addColorStop(.68,'rgba(255,255,255,0)');
  gradient.addColorStop(1,'rgba(255,255,255,0)');
  c.fillStyle=gradient;c.fillRect(0,0,128,128);
  return new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(canvas),transparent:true,opacity:.13,depthWrite:false,blending:THREE.AdditiveBlending});
})();
function makeCabinet(id,name,x,z,hue,isCrash=false,isGex=false,system=''){
  const g=new THREE.Group();g.position.set(x,0,z);const shellColor=isCrash?0x542255:(isGex?0x123f37:hue);const secondaryAccent=isGex?0xff7024:hue;const dark=0x0c0f19;
  const plinth=new THREE.Mesh(cabinetGeometry.plinth,cabinetPlinthMaterial);plinth.position.y=.05;g.add(plinth);
  const underglowMat=new THREE.MeshBasicMaterial({color:hue,transparent:true,opacity:.62});
  for(const [railGeometry,px,pz] of [[cabinetGeometry.railLong,0,.52],[cabinetGeometry.railLong,0,-.52],[cabinetGeometry.railSide,.72,0],[cabinetGeometry.railSide,-.72,0]]){const rail=new THREE.Mesh(railGeometry,underglowMat);rail.position.set(px,.106,pz);g.add(rail)}
  const floorGlow=new THREE.PointLight(hue,1.15,2.2,2);floorGlow.position.set(0,.12,0);g.add(floorGlow);
  const lower=new THREE.Mesh(cabinetGeometry.body,cabinetShellMaterial);lower.position.set(0,.78,0);g.add(lower);
  const panelTint=new THREE.Color(shellColor).multiplyScalar(.2);
  const lowerInset=new THREE.Mesh(cabinetGeometry.bodyInset,new THREE.MeshStandardMaterial({color:panelTint,emissive:shellColor,emissiveIntensity:.05,roughness:.36,metalness:.8}));lowerInset.position.set(0,.79,.5405);g.add(lowerInset);
  const upper=new THREE.Mesh(cabinetGeometry.head,cabinetHeadMaterial);upper.position.set(0,2.05,-.05);upper.rotation.x=-.1;g.add(upper);
  const trimMat=new THREE.MeshStandardMaterial({color:hue,emissive:hue,emissiveIntensity:1.15,roughness:.3,metalness:.45});
  for(const sx of [-.795,.795]){
    const channel=new THREE.Mesh(cabinetGeometry.lightChannel,cabinetChannelMaterial);channel.position.set(sx,1.32,.529);g.add(channel);
    const rod=new THREE.Mesh(cabinetGeometry.lightRod,trimMat);rod.position.set(sx,1.32,.545);g.add(rod);
  }
  const art=isCrash?crashArt():null;
  const frontArtTexture=isCrash?new THREE.TextureLoader().load('assets/art/crash-bandicoot-front.webp?v=webp-2'):null;
  const sideArtTexture=isCrash?new THREE.TextureLoader().load('assets/art/crash-bandicoot-side.webp?v=webp-2'):null;
  const backArtTexture=isCrash?new THREE.TextureLoader().load('assets/art/crash-bandicoot-back.webp?v=webp-2'):null;
  const marqueeTexture=isCrash?new THREE.TextureLoader().load('assets/art/crash-bandicoot-marquee.webp?v=webp-2'):null;
  const gexMarqueeTexture=isGex?new THREE.TextureLoader().load('assets/art/gex-marquee.webp?v=webp-2'):null;
  const gexFrontTexture=isGex?new THREE.TextureLoader().load('assets/art/gex-front.webp?v=webp-2'):null;
  const gexSideTexture=isGex?new THREE.TextureLoader().load('assets/art/gex-side.webp?v=webp-2'):null;
  const gexBackTexture=isGex?new THREE.TextureLoader().load('assets/art/gex-back.webp?v=webp-2'):null;
  if(isCrash){
    const frontArt=new THREE.Mesh(new THREE.PlaneGeometry(1.04,1.04),new THREE.MeshBasicMaterial({map:frontArtTexture}));frontArt.position.set(0,.78,.558);g.add(frontArt);
    const artBorder=new THREE.Mesh(roundedSlab(1.14,1.14,.022,.05,.008),new THREE.MeshStandardMaterial({color:0xc98a3a,emissive:0xe65b27,emissiveIntensity:.5,roughness:.34,metalness:.7}));artBorder.position.set(0,.78,.542);g.add(artBorder);
    const backArt=new THREE.Mesh(new THREE.PlaneGeometry(1.38,.92),new THREE.MeshBasicMaterial({map:backArtTexture}));backArt.position.set(0,.88,-.548);backArt.rotation.y=Math.PI;g.add(backArt);
    const backBorder=new THREE.Mesh(roundedSlab(1.48,1.02,.022,.05,.008),new THREE.MeshStandardMaterial({color:0x2a7ea0,emissive:0x26c9ff,emissiveIntensity:.45,roughness:.34,metalness:.7}));backBorder.position.set(0,.88,-.542);g.add(backBorder);
    backArt.position.z=-.556;
    for(const side of [-1,1]){const sideArt=new THREE.Mesh(new THREE.PlaneGeometry(.9,1.66),new THREE.MeshBasicMaterial({map:sideArtTexture,side:THREE.DoubleSide}));sideArt.position.set(side*.846,1.12,-.05);sideArt.rotation.y=side*Math.PI/2;g.add(sideArt);}
  }
  if(isGex){
    const frontArt=new THREE.Mesh(new THREE.PlaneGeometry(1.05,1.16),new THREE.MeshBasicMaterial({map:gexFrontTexture}));frontArt.position.set(0,.79,.558);g.add(frontArt);
    const artBorder=new THREE.Mesh(roundedSlab(1.15,1.26,.022,.05,.008),new THREE.MeshStandardMaterial({color:0x5c8f36,emissive:0x8de548,emissiveIntensity:.48,roughness:.34,metalness:.7}));artBorder.position.set(0,.79,.542);g.add(artBorder);
    for(const side of [-1,1]){const sideArt=new THREE.Mesh(new THREE.PlaneGeometry(.7,1.58),new THREE.MeshBasicMaterial({map:gexSideTexture,side:THREE.DoubleSide}));sideArt.position.set(side*.846,1.05,-.05);sideArt.rotation.y=side*Math.PI/2;g.add(sideArt);}
    const backArt=new THREE.Mesh(new THREE.PlaneGeometry(1.05,1.16),new THREE.MeshBasicMaterial({map:gexBackTexture}));backArt.position.set(0,.79,-.558);backArt.rotation.y=Math.PI;g.add(backArt);
    const backBorder=new THREE.Mesh(roundedSlab(1.15,1.26,.022,.05,.008),new THREE.MeshStandardMaterial({color:0x62309e,emissive:0x9b43ff,emissiveIntensity:.45,roughness:.34,metalness:.7}));backBorder.position.set(0,.79,-.542);g.add(backBorder);
  }
  const bezel=new THREE.Mesh(cabinetGeometry.bezel,cabinetBezelMaterial);bezel.position.set(0,2.06,.35);bezel.rotation.x=-.1;g.add(bezel);
  const screen=new THREE.Mesh(cabinetGeometry.screen,new THREE.MeshBasicMaterial({color:0x050710}));screen.position.set(0,2.06,.38);screen.rotation.x=-.1;g.add(screen);
  const glassSheen=new THREE.Mesh(cabinetGeometry.glassSheen,cabinetGlassMaterial);glassSheen.position.set(0,2.06,.388);glassSheen.rotation.x=-.1;g.add(glassSheen);
  const deck=new THREE.Mesh(cabinetGeometry.deck,cabinetDeckMaterial);deck.position.set(0,1.4,.47);deck.rotation.x=.16;g.add(deck);
  const deckLight=new THREE.Mesh(cabinetGeometry.deckLight,new THREE.MeshStandardMaterial({color:secondaryAccent,emissive:secondaryAccent,emissiveIntensity:1.5}));deckLight.position.set(0,1.47,.72);deckLight.rotation.x=.16;g.add(deckLight);
  const glow=new THREE.PointLight(hue,3.4,3);glow.position.set(0,1.95,.8);g.add(glow);
  const joystickX=-.39;
  const controlSlot=new THREE.Group();g.add(controlSlot);
  const gate=new THREE.Mesh(cabinetGeometry.gate,cabinetGateMaterial);gate.position.set(joystickX,1.49,.64);controlSlot.add(gate);
  const gateRing=new THREE.Mesh(cabinetGeometry.gateRing,new THREE.MeshStandardMaterial({color:hue,emissive:hue,emissiveIntensity:.6,metalness:.7}));gateRing.rotation.x=Math.PI/2;gateRing.position.set(joystickX,1.51,.64);controlSlot.add(gateRing);
  const stem=new THREE.Mesh(cabinetGeometry.stem,cabinetStemMaterial);stem.position.set(joystickX,1.57,.64);controlSlot.add(stem);
  const stick=new THREE.Mesh(cabinetGeometry.stick,cabinetStickMaterial);stick.position.set(joystickX,1.65,.64);controlSlot.add(stick);
  for(const [bx,bz,buttonMaterial] of cabinetButtonLayout){
    const buttonWell=new THREE.Mesh(cabinetGeometry.buttonWell,cabinetWellMaterial);buttonWell.position.set(bx,1.49,bz);controlSlot.add(buttonWell);
    const button=new THREE.Mesh(cabinetGeometry.button,buttonMaterial);button.position.set(bx,1.522,bz);controlSlot.add(button);
  }
  let plate;
  if(isCrash){plate=new THREE.Mesh(new THREE.PlaneGeometry(1.54,.47),new THREE.MeshBasicMaterial({map:marqueeTexture}));plate.position.set(0,2.68,.43);}
  else if(isGex){plate=new THREE.Mesh(new THREE.PlaneGeometry(1.54,.47),new THREE.MeshBasicMaterial({map:gexMarqueeTexture}));plate.position.set(0,2.68,.43);}
  else {plate=new THREE.Mesh(new THREE.PlaneGeometry(1.54,.47),new THREE.MeshBasicMaterial({map:cabinetMarqueeTexture(name,hue,system)}));plate.position.set(0,2.68,.43);}
  plate.rotation.x=-.1;g.add(plate);
  const marqueeWash=new THREE.Mesh(cabinetGeometry.marqueeWash,trimMat);marqueeWash.position.set(0,2.44,.45);marqueeWash.rotation.x=-.1;g.add(marqueeWash);
  const statusMaterial=new THREE.MeshStandardMaterial({color:0x50ff9a,emissive:0x50ff9a,emissiveIntensity:2.4});
  const statusLight=new THREE.Mesh(cabinetGeometry.statusLight,statusMaterial);statusLight.position.set(.48,2.48,.43);statusLight.rotation.x=-.1;g.add(statusLight);
  scene.add(g);const cabinet={id,g,name,type:id.toUpperCase(),screen,hue,statusLight,controlSlot,controllerSystem:system,renderLights:[floorGlow,glow],status:'syncing',occupiedByDisplayName:null,enabled:true};cabinets.push(cabinet);cabinetsById.set(id,cabinet);indexCabinet(cabinet);
}
// Cabinet art keyed off the registry id. Crash and Gex keep their hand-made
// panels; every other hosted game gets a generated front and side panel, loaded
// lazily so none of it lands on first paint. A missing file simply leaves the
// cabinet in its plain finish.
const cabinetArtLoader=new THREE.TextureLoader();
const CABINET_ART_VERSION='?v=cabinet-art-1';
const CABINET_ART_SLUGS=new Set(["doom-64","glover","mega-man-64","metal-gear-solid","pikmin","pokemon-snap","silent-hill","spyro-year-of-the-dragon","star-fox-64","super-mario-64","super-mario-sunshine","super-smash-bros-melee","tony-hawks-pro-skater-2","twisted-metal-world-tour","wind-waker","zelda-ocarina-of-time","zelda-twilight-princess"]);
function applyCabinetArt(cabinet,slug){
  if(!cabinet||!slug||cabinet.artApplied)return;
  // Crash and Gex ship hand-made panels, so they are not in this set.
  if(!CABINET_ART_SLUGS.has(slug)){cabinet.artApplied=true;return;}
  cabinet.artApplied=true;
  const group=cabinet.g;
  const panel=(file,geometry,position,rotationY)=>{
    cabinetArtLoader.load('assets/art/cabinets/'+file+CABINET_ART_VERSION,texture=>{
      texture.colorSpace=THREE.SRGBColorSpace;
      texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
      const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide}));
      mesh.position.set(...position);if(rotationY)mesh.rotation.y=rotationY;
      group.add(mesh);
    },undefined,()=>{});
  };
  panel(slug+'-front.webp',new THREE.PlaneGeometry(1.12,1.22),[0,.79,.558],0);
  for(const side of [-1,1])panel(slug+'-side.webp',new THREE.PlaneGeometry(.78,1.62),[side*.847,1.06,-.05],side*Math.PI/2);
}
// Milestone 11.15: every cabinet the scene creates is registered with the
// spatial index, which the render loop queries instead of scanning.
function indexCabinet(cabinet){window.ARCADE_CABINET_SPATIAL_INDEX?.insert(cabinet.id,cabinet.g.position.x,cabinet.g.position.z,cabinet)}
function configureHostedCabinet(cabinetId){const game=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);if(!game)return;const hostedDiscs=game.discs?.map(disc=>({...disc,url:gameAssetUrl(disc.file)}));Object.assign(cabinets[cabinets.length-1],{artSlug:game.id,system:game.system,gameName:game.name,gameId:game.emulatorId,gameRegistryId:game.id,gameFileName:game.file,gameSizeBytes:game.sizeBytes,bootChunks:game.bootChunks??null,performanceNote:game.performanceNote??null,hostedGame:gameAssetUrl(game.file),hostedDiscs})}
// Classic arcade layout: one unbroken row facing into the room, backs against
// the wall that carries the PlayStation logo. This is the arrangement every
// room moves to, so the spacing constant is shared rather than repeated — 2.3 m
// against a 1.78 m plinth leaves a walk-up gap between machines.
const ARCADE_ROW_SPACING=2.3;
function arcadeRow(centerX,count,spacing=ARCADE_ROW_SPACING){
  return Array.from({length:count},(_,index)=>centerX+(index-(count-1)/2)*spacing);
}
/**
 * Every console game is out on the main floor while the rooms are re-themed.
 *
 * Two rows down the hall either side of the centre aisle, directly under the
 * pendant rows, each facing the aisle a player walks along. Twelve a side: the
 * PlayStation and PS2 sets to the west, Nintendo 64 and GameCube to the east.
 * The Mega Man room keeps its own machines — it is a finished room, not a pile
 * of loose cabinets.
 *
 * The rows sit 11.5 m out, which clears the chandelier's bollards at 4.55 m
 * and leaves both partition walls, and every doorway in them, ten metres clear.
 */
const FOYER_ROW_X=11.5,FOYER_ROW_SPACING=ARCADE_ROW_SPACING,FOYER_ROW_LENGTH=12;
function foyerRow(side){
  return Array.from({length:FOYER_ROW_LENGTH},(_,index)=>({
    x:side*FOYER_ROW_X,
    z:(index-(FOYER_ROW_LENGTH-1)/2)*FOYER_ROW_SPACING,
    rotation:side<0?Math.PI/2:-Math.PI/2
  }));
}
const FOYER_WEST=foyerRow(-1),FOYER_EAST=foyerRow(1);
const playstationRow=[
  ['silent-hill','SILENT HILL',0xc94c4c,false,false],
  ['pixel-rally',"TONY HAWK'S PRO SKATER 2",0x36f9f6,false,false],
  ['gex-enter-the-gecko','GEX: ENTER THE GECKO',0x8de548,false,true],
  ['crash-bandicoot','CRASH BANDICOOT',0xffa62e,true,false],
  ['dungeon-88','SPYRO - YEAR OF THE DRAGON',0x934dff,false,false],
  ['turbo-grid','TWISTED METAL WORLD TOUR',0xff3cac,false,false],
  ['metal-gear-solid','METAL GEAR SOLID',0x5d75d9,false,false]
];
playstationRow.forEach(([id,label,hue,isCrash,isGex],index)=>{
  const slot=FOYER_WEST[index];
  makeCabinet(id,label,slot.x,slot.z,hue,isCrash,isGex,'psx');
  cabinets[cabinets.length-1].g.rotation.y=slot.rotation;configureHostedCabinet(id);
});
// The row starts on the north wall — the one on your left as you walk in — and
// turns the corner onto the west wall rather than crowding ten machines onto
// one. Facing the north wall puts +x on your left, so it is laid out east to
// west and the series still reads left to right, with Mega Man X nearest the
// door and the line continuing round the corner rather than restarting.
//
// The order is the series order, and the PS2 machine takes its place in it
// between X6 and Mega Man 8. It is cabinet 08 because these ids are stable
// identities rather than positions: renumbering to match the new order would
// move every hosted game to a different cabinet for no gain. The two machines
// with no game yet are last, on the west wall.
const MEGAMAN_ROW_Z=15.2,MEGAMAN_ROW_START_X=-23.6,MEGAMAN_SIDE_ROW_X=-41.6,MEGAMAN_SIDE_ROW_START_Z=14.5,MEGAMAN_ISLAND_ROW_Z=9.6;
// The colours the ten cabinets on the floor already wear. Anything added after
// them takes the next colour in the cycle rather than no colour at all, which
// is what an index missing from a fixed map used to give it.
const megaManHues={1:0x42a5ff,2:0xff3cac,3:0x36f9f6,4:0xffb42e,5:0x7dff67,6:0x934dff,7:0xff4da6,8:0x36f9f6,9:0xffb42e,10:0x5d75d9};
const MEGAMAN_HUE_CYCLE=[0x42a5ff,0xff3cac,0x36f9f6,0xffb42e,0x7dff67,0x934dff,0xff4da6,0x5d75d9];
const megaManHue=index=>megaManHues[index]??MEGAMAN_HUE_CYCLE[(index-1)%MEGAMAN_HUE_CYCLE.length];
// The one cabinet whose system is not decided by a hosted game: it is being held
// for a PS2 title, and saying so is what gives the player the PS2 prompt rather
// than a PlayStation one.
const megaManSystems={8:'ps2'};
// Seats, in the order the room fills them: the wall you face on the way in,
// then round the corner onto the west wall, then a second row down the middle
// of the floor with an aisle between the two. The seat a cabinet takes is its
// position in MEGAMAN_CABINET_ORDER, so adding a game is adding an id to that
// list and a row to the registry — the geometry is not something anyone has to
// work out again, and there is room for eleven more before the runs are full.
const MEGAMAN_SEAT_RUNS=[
  {seats:8,x:MEGAMAN_ROW_START_X,z:MEGAMAN_ROW_Z,stepX:-ARCADE_ROW_SPACING,stepZ:0,rotation:Math.PI},
  {seats:5,x:MEGAMAN_SIDE_ROW_X,z:MEGAMAN_SIDE_ROW_START_Z,stepX:0,stepZ:-ARCADE_ROW_SPACING,rotation:Math.PI/2},
  {seats:8,x:MEGAMAN_ROW_START_X,z:MEGAMAN_ISLAND_ROW_Z,stepX:-ARCADE_ROW_SPACING,stepZ:0,rotation:Math.PI}
];
// The ids are stable identities rather than positions, which is why 8 sits
// between 6 and 7: renumbering to match the order would move every hosted game
// to a different cabinet for no gain.
const MEGAMAN_CABINET_ORDER=[1,2,3,4,5,6,8,7,9,10];
function megaManSeat(seat){
  let remaining=seat;
  for(const run of MEGAMAN_SEAT_RUNS){
    if(remaining<run.seats)return {x:run.x+run.stepX*remaining,z:run.z+run.stepZ*remaining,rotation:run.rotation};
    remaining-=run.seats;
  }
  return null;
}
const megaManCabinetLayout=MEGAMAN_CABINET_ORDER.map((index,seat)=>{
  const place=megaManSeat(seat);
  // A cabinet with nowhere to stand is left out rather than dropped at the
  // origin, where it would appear in the middle of the hub.
  if(!place)console.warn(`No seat left in the Mega Man room for cabinet ${index}.`);
  return place?[index,place.x,place.z,place.rotation]:null;
}).filter(Boolean);
for(const [index,x,z,rotation] of megaManCabinetLayout){
  const cabinetId=`megaman-cabinet-${String(index).padStart(2,'0')}`;
  const hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId),system=hosted?.system||megaManSystems[index]||'psx';
  const label=hosted?hosted.name.toUpperCase():`${system==='ps2'?'PS2':'PLAYSTATION'} // READY ${String(index).padStart(2,'0')}`;
  makeCabinet(cabinetId,label,x,z,megaManHue(index),false,false,system);
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system,gameName:hosted?.name||label,enabled:true,status:'available'});configureHostedCabinet(cabinetId);
}

// A line of the cast down the south wall, standing on the floor and facing the
// cabinets across the room, in the same series order the cabinets already read
// in. The models are a few megabytes and arrive on approach rather than at
// boot, so the room is walkable before they land.
const MEGAMAN_STATUE_Z=1.62,MEGAMAN_STATUE_HEIGHT=2.43,MEGAMAN_STATUE_MAX_SPAN=5.2,MEGAMAN_STATUE_RADIUS=.66;
// Five of the seven models dropped in. Two of them carry no textures and no
// colours — three white parts and nothing to paint them from — and an
// untextured figure under coloured light is a mannequin however it is dressed.
//
// The second number is how wide each model is per unit of its height, measured
// from the model itself. These are action poses, so at a shared height the
// widest is five times the width of the narrowest, and a line spaced evenly put
// one figure inside the next. They are placed narrowest first and packed by the
// width each actually occupies, so the spacing follows the scale instead of
// having to be re-tuned every time it changes.
const MEGAMAN_STATUES=[
  ['x8-zero',.38],
  ['x-fourth-armor',.96],
  ['zero-copy-x',1.29],
  ['exe4-alma',1.35],
  ['exe5-soul',1.89]
];
// The south wall, then round the corner onto the west wall below the cabinets.
const MEGAMAN_STATUE_GAP=.4;
const MEGAMAN_STATUE_RUNS=[
  {along:'x',from:-22.8,to:-42.9,fixed:MEGAMAN_STATUE_Z,rotation:0},
  {along:'z',from:11.4,to:2.4,fixed:-42,rotation:Math.PI/2}
];
function packMegaManStatues(){
  const widths=MEGAMAN_STATUES.map(([,aspect])=>aspect*MEGAMAN_STATUE_HEIGHT);
  // Centre what fits on the first wall, so a line shorter than the wall sits in
  // the middle of it rather than crowding the doorway end.
  const first=MEGAMAN_STATUE_RUNS[0],capacity=Math.abs(first.to-first.from);
  let used=0;
  for(const width of widths){
    const extended=used?used+MEGAMAN_STATUE_GAP+width:width;
    if(extended>capacity)break;
    used=extended;
  }
  const placed=[];
  let runIndex=0,cursor=first.from+Math.sign(first.to-first.from)*(capacity-used)/2;
  for(const [slug,aspect] of MEGAMAN_STATUES){
    const width=aspect*MEGAMAN_STATUE_HEIGHT;
    let run=MEGAMAN_STATUE_RUNS[runIndex];
    // A figure that will not fit in what is left of this wall starts the next
    // one rather than being squeezed in or quietly standing inside its
    // neighbour, which is what happened the last time the scale went up.
    while(run&&Math.abs(cursor-run.to)<width){
      runIndex+=1;run=MEGAMAN_STATUE_RUNS[runIndex];
      if(run)cursor=run.from;
    }
    if(!run){console.warn(`No wall left in the Mega Man room for the ${slug} statue.`);continue}
    const direction=Math.sign(run.to-run.from),centre=cursor+direction*width/2;
    placed.push({slug,x:run.along==='x'?centre:run.fixed,z:run.along==='x'?run.fixed:centre,rotation:run.rotation});
    cursor+=direction*(width+MEGAMAN_STATUE_GAP);
  }
  return placed;
}
const megaManStatueMounts=[];
for(const {slug,x,z,rotation} of packMegaManStatues()){
  const mount=new THREE.Group();mount.name=`megaman-statue-${slug}`;mount.position.set(x,0,z);mount.rotation.y=rotation;scene.add(mount);
  megaManStatueMounts.push({slug,mount,radius:MEGAMAN_STATUE_RADIUS});
}
async function installMegaManStatues(){
  let loader;
  try{loader=await getOptimizedGltfLoader()}catch(error){console.warn('Mega Man statue loader could not initialize.',error);return}
  for(const entry of megaManStatueMounts){
    const {slug,mount}=entry;
    loader.load(`assets/models/megaman/${slug}.optimized.glb?v=megaman-statues-1`,gltf=>{
      // Scaled by height rather than longest side: these are figures, and a
      // wide pose would otherwise stand shorter than the one beside it.
      const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
      // Height first, so the line reads as one gallery, but never past the span
      // it is allotted: a lunging pose scaled purely by height reaches into its
      // neighbour, and the widest of these is five times the width of the
      // narrowest at the same height.
      const scale=Math.min(MEGAMAN_STATUE_HEIGHT/Math.max(size.y,.001),MEGAMAN_STATUE_MAX_SPAN/Math.max(size.x,size.z,.001));
      model.scale.setScalar(scale);model.position.set(-center.x*scale,0,-center.z*scale);
      const scaled=new THREE.Box3().setFromObject(model);model.position.y-=scaled.min.y;
      // A statue is as solid as it is wide. One radius for all of them either
      // let a player walk through an outstretched arm or held them a metre off
      // a figure that is barely wider than its own shoulders.
      entry.radius=Math.min(1.15,Math.max(MEGAMAN_STATUE_RADIUS,(scaled.max.x-scaled.min.x)*.34));
      // Lit by the room and by the mural lights standing in front of the wall,
      // not by themselves: a figure that carries its own light has no shape.
      const materials=[];
      model.traverse(node=>{if(node.isMesh)for(const material of Array.isArray(node.material)?node.material:[node.material])if(material?.emissive)materials.push(material)});
      // Taking the shine off: these are lit entirely by the mural lights, and a
      // glossy figure under three coloured point lights is mostly highlights.
      for(const material of materials){material.roughness=Math.min(material.roughness??1,.62);material.needsUpdate=true}
      mount.add(model);
    },undefined,error=>console.warn(`Mega Man statue ${slug} could not load.`,error));
  }
}
// Cheap because it never runs outside the room: a player anywhere else fails
// the first comparison and pays two subtractions for the whole gallery.
function resolveStatueCollisions(previousX,previousZ){
  if(playerPosition.x>-15.2)return;
  for(const {mount,radius} of megaManStatueMounts){
    const dx=playerPosition.x-mount.position.x,dz=playerPosition.z-mount.position.z,distance=Math.hypot(dx,dz);
    if(distance>=radius)continue;
    // Never south. These stand against the south wall with barely a metre
    // behind them, and pushing radially put a player into that gap — where the
    // statue then pushed them back every time they tried to walk out of it. A
    // player trapped in scenery is worse than a player walking through it, so
    // the only ways out are the three that lead back into the room.
    const north=mount.position.z+radius-playerPosition.z;
    const west=playerPosition.x-(mount.position.x-radius);
    const east=mount.position.x+radius-playerPosition.x;
    if(north<=west&&north<=east)playerPosition.z=mount.position.z+radius;
    else if(west<=east)playerPosition.x=mount.position.x-radius;
    else playerPosition.x=mount.position.x+radius;
    // A player already wedged somewhere the push cannot resolve keeps the step
    // they came from rather than being moved somewhere they never chose.
    if(!Number.isFinite(playerPosition.x)||!Number.isFinite(playerPosition.z)){playerPosition.x=previousX;playerPosition.z=previousZ}
    return;
  }
}
const N64_HUES=[0x8b5cf6,0xff4da6,0x36f9f6,0xffb42e,0x7dff67,0xff3cac,0x42a5ff];
const n64CabinetLayout=N64_HUES.map((hue,index)=>[index+1,FOYER_EAST[index].x,FOYER_EAST[index].z,FOYER_EAST[index].rotation,hue]);
for(const [index,x,z,rotation,hue] of n64CabinetLayout){const cabinetId=`n64-cabinet-0${index}`,hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);makeCabinet(cabinetId,hosted?hosted.name.toUpperCase():`N64 // READY 0${index}`,x,z,hue,false,false,'n64');const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;configureHostedCabinet(cabinetId)}
// Five experimental GameCube cabinets sit inside their dedicated construction
// room, facing its doorway. Gecko remains available for later runtime work, but
// the cabinets cannot be reached while the room is blocked.
const gamecubeTitles=['THE LEGEND OF ZELDA: THE WIND WAKER','THE LEGEND OF ZELDA: TWILIGHT PRINCESS','PIKMIN','SUPER SMASH BROS. MELEE','SUPER MARIO SUNSHINE'];
const GAMECUBE_HUES=[0x8b5cf6,0x36f9f6,0xff4da6,0x7dff67,0xffb42e];
const gamecubeCabinetLayout=GAMECUBE_HUES.map((hue,index)=>[index+1,FOYER_EAST[7+index].x,FOYER_EAST[7+index].z,FOYER_EAST[7+index].rotation,hue]);
for(const [index,x,z,rotation,hue] of gamecubeCabinetLayout){
  const cabinetId=`gamecube-cabinet-0${index}`;
  makeCabinet(cabinetId,gamecubeTitles[index-1],x,z,hue,false,false,'gamecube');
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system:'gamecube',emulator:'gecko',gameName:gamecubeTitles[index-1],enabled:!isMobileDevice,status:isMobileDevice?'disabled':'available',disabledReason:isMobileDevice?'desktop-only':undefined});configureHostedCabinet(cabinetId);
}
const expansionCabinetColors=[0xff3cac,0x36f9f6,0xffb42e,0x934dff,0x7dff67];
const ps2RoomTitles=['GOD OF WAR','KINGDOM HEARTS','GRAND THEFT AUTO: SAN ANDREAS','DBZ TENKAICHI 3','PS2 // READY 05'];
const ps2CabinetLayout=Array.from({length:5},(_,index)=>[index+1,FOYER_WEST[7+index].x,FOYER_WEST[7+index].z,FOYER_WEST[7+index].rotation]);
for(const [index,x,z,rotation] of ps2CabinetLayout){
  const cabinetId=`psx-back-cabinet-0${index}`,hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);
  makeCabinet(cabinetId,ps2RoomTitles[index-1],x,z,expansionCabinetColors[index-1],false,false,'ps2');
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system:'ps2',gameName:hosted?.name||ps2RoomTitles[index-1],gameId:hosted?.emulatorId||26000+index,enabled:Boolean(hosted),status:hosted?'available':'disabled'});configureHostedCabinet(cabinetId);
}
const xboxCabinetLayout=[[1,41.4,3,-Math.PI/2],[2,41.4,8,-Math.PI/2],[3,41.4,13,-Math.PI/2],[4,29.4,15.2,Math.PI],[5,35.4,15.2,Math.PI]];
for(const [index,x,z,rotation] of xboxCabinetLayout){
  const cabinetId=`xbox-cabinet-0${index}`;
  makeCabinet(cabinetId,`XBOX // READY 0${index}`,x,z,expansionCabinetColors[5-index],false,false,'xbox');
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system:'xbox',gameName:`Xbox Cabinet ${index}`,enabled:false,status:'disabled'});
}
// The centre of the hall is deliberately empty. The couch ring and the round
// glass case that stood here made the middle of the arcade a thing to walk
// around rather than a place to walk through, and the floorplan puts the
// chandelier over open floor. Trench Pepe moved to the prize counter with it.
// The hub floor is a very large unbroken sheet. Lit inlays give it a centre and
// draw the eye toward each gallery doorway, which also makes the room easier to
// read as a space rather than an empty plane.
const inlayMaterial=new THREE.MeshBasicMaterial({color:0x4bd8ff,transparent:true,opacity:.42,depthWrite:false,blending:THREE.AdditiveBlending});
const inlayWarmMaterial=new THREE.MeshBasicMaterial({color:0x9fd8ff,transparent:true,opacity:.17,depthWrite:false,blending:THREE.AdditiveBlending});
for(const radius of [7.75,7.97]){
  const ring=new THREE.Mesh(new THREE.RingGeometry(radius,radius+.05,96),inlayMaterial);
  ring.rotation.x=-Math.PI/2;ring.position.y=.028;scene.add(ring);
}
// Runway strips from the hub toward each gallery mouth.
for(const [angle,length] of [[0,9.5],[Math.PI,9.5],[Math.PI/2,10.5],[-Math.PI/2,10.5]]){
  for(const offset of [-.55,.55]){
    const strip=new THREE.Mesh(new THREE.PlaneGeometry(.07,length),inlayWarmMaterial);
    strip.rotation.x=-Math.PI/2;strip.rotation.z=-angle;
    strip.position.set(Math.sin(angle)*(8.5+length/2)+Math.cos(angle)*offset,.026,Math.cos(angle)*(8.5+length/2)-Math.sin(angle)*offset);
    scene.add(strip);
  }
}
/**
 * A lit threshold at every doorway in the ring.
 *
 * The hall is 43 m across and 67 m long, and a room's doorway is a 3.2 m gap in
 * a dark wall — from the middle of the floor there was nothing to tell you a
 * room was there. A strip across the floor and a jamb either side reads as a
 * way in from right across the hall, and none of it is a light.
 */
const thresholdGlow=new THREE.MeshBasicMaterial({color:0x8ff0ff,transparent:true,opacity:.34,depthWrite:false,blending:THREE.AdditiveBlending});
const jambMaterial=new THREE.MeshStandardMaterial({color:0x16233d,emissive:0x2a7fb8,emissiveIntensity:1.35,roughness:.3,metalness:.55});
const jambGeometry=new THREE.BoxGeometry(.14,3.4,.14);
const thresholdGeometry=new THREE.PlaneGeometry(3.2,.9);
function lightThreshold(x,z,alongZ){
  const strip=new THREE.Mesh(thresholdGeometry,thresholdGlow);
  strip.rotation.x=-Math.PI/2;if(!alongZ)strip.rotation.z=Math.PI/2;
  strip.position.set(x,.03,z);scene.add(strip);
  for(const offset of [-1.72,1.72]){
    const jamb=new THREE.Mesh(jambGeometry,jambMaterial);
    jamb.position.set(x+(alongZ?offset:0),1.7,z+(alongZ?0:offset));scene.add(jamb);
  }
}
for(const doorZ of OPEN_DOOR_Z){
  lightThreshold(PLAYSTATION_WALL_X,doorZ,false);
  lightThreshold(N64_WALL_X,doorZ,false);
}
for(const doorX of NORTH_ROOM_X)lightThreshold(doorX,TOP_BAND_MIN_Z,true);
lightThreshold(0,TOURNAMENT_MIN_Z,true);
// The hub reads as a very large dark floor with nothing above eye level, so the
// lounge gets a centrepiece: counter-rotating light rings inside a soft beam
// dropping onto the display. All of it is emissive or additive geometry, so it
// adds nothing to the light budget.
const centrepiece=new THREE.Group();centrepiece.position.set(0,0,0);scene.add(centrepiece);
const beamTexture=(()=>{
  const canvas=document.createElement('canvas');canvas.width=8;canvas.height=128;
  const c=canvas.getContext('2d'),gradient=c.createLinearGradient(0,0,0,128);
  gradient.addColorStop(0,'rgba(255,255,255,0)');gradient.addColorStop(.35,'rgba(255,255,255,.5)');
  gradient.addColorStop(.78,'rgba(255,255,255,.16)');gradient.addColorStop(1,'rgba(255,255,255,0)');
  c.fillStyle=gradient;c.fillRect(0,0,8,128);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;return texture;
})();
const beam=new THREE.Mesh(new THREE.CylinderGeometry(2.15,1.35,3.3,40,1,true),new THREE.MeshBasicMaterial({map:beamTexture,color:0x7fe4ff,transparent:true,opacity:.13,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending}));
beam.position.y=3.25;centrepiece.add(beam);
// Faint ground ring so the beam lands on something.
const beamRing=new THREE.Mesh(new THREE.TorusGeometry(2.02,.035,8,64),new THREE.MeshBasicMaterial({color:0x7fe4ff,transparent:true,opacity:.55,depthWrite:false,blending:THREE.AdditiveBlending}));
beamRing.rotation.x=Math.PI/2;beamRing.position.y=.05;centrepiece.add(beamRing);
// A bright disc on the floor anchors the beam instead of letting it fade out.
const beamPool=new THREE.Mesh(new THREE.CircleGeometry(1.9,40),new THREE.MeshBasicMaterial({color:0x7fe4ff,transparent:true,opacity:.1,depthWrite:false,blending:THREE.AdditiveBlending}));
beamPool.rotation.x=-Math.PI/2;beamPool.position.y=.03;centrepiece.add(beamPool);
const haloRings=[];
for(const [radius,y,tube,color,speed,tilt] of [[2.35,3.05,.045,0x36f9f6,.16,.05],[3.05,3.7,.038,0xff4fa8,-.11,-.07],[3.75,4.32,.03,0xffb877,.075,.04]]){
  const ring=new THREE.Mesh(new THREE.TorusGeometry(radius,tube,8,72),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.9,blending:THREE.AdditiveBlending,depthWrite:false}));
  ring.rotation.x=Math.PI/2+tilt;ring.position.y=y;centrepiece.add(ring);
  haloRings.push({ring,speed});
}
// The floor under the chandelier. With the couch gone the beam landed on bare
// terrazzo, so the light now has something to land on: a medallion of counter-
// rotating rings, a ring of low bollards marking the edge of the pool, and slow
// motes drifting up through the beam. All of it is additive emissive geometry
// on shared materials — no lights, so none of it is charged against the budget
// the rooms are competing for.
const medallionMaterial=new THREE.MeshBasicMaterial({color:0x7fe4ff,transparent:true,opacity:.34,depthWrite:false,blending:THREE.AdditiveBlending});
const medallionWarmMaterial=new THREE.MeshBasicMaterial({color:0xffb877,transparent:true,opacity:.26,depthWrite:false,blending:THREE.AdditiveBlending});
const spinningFloorRings=[];
for(const [inner,thickness,segments,material] of [[3.15,.055,96,medallionMaterial],[3.62,.03,96,medallionWarmMaterial]]){
  const ring=new THREE.Mesh(new THREE.RingGeometry(inner,inner+thickness,segments),material);
  ring.rotation.x=-Math.PI/2;ring.position.y=.032;centrepiece.add(ring);
}
// Dashes rather than a continuous ring, so the rotation is legible.
for(const [radius,count,length,material,speed] of [[2.62,24,.19,medallionMaterial,.11],[4.18,32,.13,medallionWarmMaterial,-.07]]){
  const dashes=new THREE.Group();dashes.position.y=.034;centrepiece.add(dashes);
  for(let i=0;i<count;i++){
    const angle=i/count*Math.PI*2;
    const dash=new THREE.Mesh(new THREE.PlaneGeometry(.05,length),material);
    dash.rotation.x=-Math.PI/2;dash.rotation.z=-angle;
    dash.position.set(Math.cos(angle)*radius,0,Math.sin(angle)*radius);
    dashes.add(dash);
  }
  spinningFloorRings.push({ring:dashes,speed});
}
const bollardMaterial=new THREE.MeshStandardMaterial({color:0x1a2740,emissive:0x123c5e,emissiveIntensity:.9,metalness:.72,roughness:.24});
const bollardCapMaterial=new THREE.MeshBasicMaterial({color:0x8ff0ff,transparent:true,opacity:.85,blending:THREE.AdditiveBlending,depthWrite:false});
const bollardGeometry=new THREE.CylinderGeometry(.075,.1,.52,10);
const bollardCapGeometry=new THREE.SphereGeometry(.085,10,8);
for(let i=0;i<8;i++){
  const angle=i/8*Math.PI*2+Math.PI/8;
  const bollard=new THREE.Mesh(bollardGeometry,bollardMaterial);
  bollard.position.set(Math.cos(angle)*4.55,.26,Math.sin(angle)*4.55);centrepiece.add(bollard);
  const cap=new THREE.Mesh(bollardCapGeometry,bollardCapMaterial);
  cap.position.set(Math.cos(angle)*4.55,.55,Math.sin(angle)*4.55);centrepiece.add(cap);
}
const moteMaterial=new THREE.MeshBasicMaterial({color:0xbdf3ff,transparent:true,opacity:.5,depthWrite:false,blending:THREE.AdditiveBlending});
const moteGeometry=new THREE.SphereGeometry(.035,6,5);
const motes=[];
for(let i=0;i<26;i++){
  const angle=i*2.399,radius=.35+(i%7)*.26;
  const mote=new THREE.Mesh(moteGeometry,moteMaterial);
  mote.position.set(Math.cos(angle)*radius,.1+(i%13)*.28,Math.sin(angle)*radius);
  centrepiece.add(mote);
  motes.push({mote,speed:.22+(i%5)*.06,base:.1+(i%13)*.28});
}
beforeRenderCallbacks.push((now,delta)=>{
  if(playerPosition.x*playerPosition.x+playerPosition.z*playerPosition.z>900)return;
  for(const {ring,speed} of haloRings)ring.rotation.z+=speed*delta;
  for(const {ring,speed} of spinningFloorRings)ring.rotation.y+=speed*delta;
  for(const mote of motes){
    mote.mote.position.y+=mote.speed*delta;
    // Recycled at the top of the beam rather than respawned, so the count is
    // fixed and nothing allocates once the scene is built.
    if(mote.mote.position.y>3.7)mote.mote.position.y=mote.base%1.2;
  }
});
// Low, oversized glass prize display set flush against the true back wall.
const prizeDisplay=new THREE.Group();prizeDisplay.position.set(0,0,TOP_BAND_MIN_Z+1.15);scene.add(prizeDisplay);
const rearCaseGlass=new THREE.Mesh(new THREE.BoxGeometry(14.2,1.225,1.8),new THREE.MeshStandardMaterial({color:0x8deeff,emissive:0x173d5d,emissiveIntensity:.26,transparent:true,opacity:.16,metalness:.65,roughness:.06,side:THREE.DoubleSide,depthWrite:false}));rearCaseGlass.position.y=.6125;prizeDisplay.add(rearCaseGlass);
const rearCaseBase=new THREE.Mesh(new THREE.BoxGeometry(14.4,.16,2.04),new THREE.MeshStandardMaterial({color:0x142331,metalness:.9,roughness:.12}));rearCaseBase.position.y=.08;prizeDisplay.add(rearCaseBase);
const rearCaseTop=new THREE.Mesh(new THREE.BoxGeometry(14.4,.09,2.04),new THREE.MeshStandardMaterial({color:0x243a4b,emissive:0x173c56,emissiveIntensity:.6,metalness:.85,roughness:.1}));rearCaseTop.position.y=1.22;prizeDisplay.add(rearCaseTop);
for(const x of [-7,7]){const edge=new THREE.Mesh(new THREE.BoxGeometry(.1,1.28,.12),new THREE.MeshStandardMaterial({color:0x36f9f6,emissive:0x36f9f6,emissiveIntensity:1.15,metalness:.7,roughness:.12}));edge.position.set(x,.62,.98);prizeDisplay.add(edge);}
// One continuous overhead gallery light illuminates the entire prize lineup.
const prizeLightBar=new THREE.Mesh(new THREE.BoxGeometry(12.9,.055,.12),new THREE.MeshStandardMaterial({color:0xe9fbff,emissive:0xbfefff,emissiveIntensity:2.5,metalness:.35,roughness:.16}));prizeLightBar.position.set(0,1.11,-.66);prizeDisplay.add(prizeLightBar);
const prizeDisplayLight=new THREE.RectAreaLight(0xe9fbff,11.5,12.7,.12);prizeDisplayLight.position.set(0,1.08,-.58);prizeDisplayLight.lookAt(0,.26,.1);prizeDisplay.add(prizeDisplayLight);
const prizeDisplayFill=new THREE.AmbientLight(0xd8f3ff,1.35);prizeDisplay.add(prizeDisplayFill);
const prizeLightBeam=new THREE.DirectionalLight(0xe9fbff,4.2);prizeLightBeam.position.set(0,3,-.5);prizeLightBeam.target.position.set(0,.25,.1);prizeDisplay.add(prizeLightBeam,prizeLightBeam.target);
const prizeUnderlightBar=new THREE.Mesh(new THREE.BoxGeometry(12.9,.045,.1),new THREE.MeshStandardMaterial({color:0x87dfff,emissive:0x5fcaff,emissiveIntensity:1.85,metalness:.3,roughness:.18}));prizeUnderlightBar.position.set(0,.19,-.62);prizeDisplay.add(prizeUnderlightBar);
const prizeUnderlightBeam=new THREE.DirectionalLight(0x9addff,1.6);prizeUnderlightBeam.position.set(0,-.7,-.45);prizeUnderlightBeam.target.position.set(0,.62,.1);prizeDisplay.add(prizeUnderlightBeam,prizeUnderlightBeam.target);
const prizeDisplayLights=[prizeDisplayLight,prizeLightBeam,prizeUnderlightBeam];
// Trench Pepe stands on the counter top, at the same size he was in the case.
// The prize windows occupy x = +/-1.15, 3.45 and 5.75, so the middle of the
// counter is the one span of it that was never spoken for.
gangsterPepeMount.position.set(0,1.265,0);prizeDisplay.add(gangsterPepeMount);
gangsterPepeLight.position.set(0,1.95,.62);prizeDisplay.add(gangsterPepeLight);
function prizeLabel(text,color){const canvas=document.createElement('canvas');canvas.width=256;canvas.height=72;const c=canvas.getContext('2d');c.fillStyle='#070914';c.fillRect(0,0,256,72);c.strokeStyle=color;c.lineWidth=5;c.strokeRect(3,3,250,66);c.fillStyle='#fff4cc';c.font='bold 23px monospace';c.textAlign='center';c.textBaseline='middle';c.fillText(text,128,37);return new THREE.CanvasTexture(canvas);}
function addPrizeWindow(x,label,kind,color){const display=new THREE.Group();display.position.set(x,.62,.08);prizeDisplay.add(display);const toy=new THREE.Group();toy.position.set(0,-.02,.1);toy.scale.setScalar(1.15);if(kind==='pepe')toy.name='pepe-model-slot';if(kind==='penguin')toy.name='pudgy-model-slot';if(kind==='furthermore')toy.name='furthermore-model-slot';if(kind==='enterprise')toy.name='enterprise-model-slot';if(kind==='kurack')toy.name='kurack-model-slot';display.add(toy);
  const toyMat=new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.12,roughness:.38,metalness:.12});
  if(kind==='pepe'){const frog=new THREE.MeshStandardMaterial({color:0x4e9b37,emissive:0x1e5b1d,emissiveIntensity:.12,roughness:.3});const blueShirt=new THREE.MeshStandardMaterial({color:0x2732a1,emissive:0x11155c,emissiveIntensity:.14,roughness:.26});const shorts=new THREE.MeshStandardMaterial({color:0x613919,roughness:.43});const head=new THREE.Mesh(new THREE.SphereGeometry(.3,24,24),frog);head.scale.set(1.12,.82,.84);head.position.y=.17;toy.add(head);const torso=new THREE.Mesh(new THREE.SphereGeometry(.285,22,22),blueShirt);torso.scale.set(1.12,1.05,.76);torso.position.y=-.17;toy.add(torso);const pants=new THREE.Mesh(new THREE.SphereGeometry(.245,20,20),shorts);pants.scale.set(1.04,.46,.68);pants.position.y=-.39;toy.add(pants);for(const side of [-1,1]){const arm=new THREE.Mesh(new THREE.SphereGeometry(.095,16,16),frog);arm.scale.set(.62,1.7,.64);arm.rotation.z=side*.42;arm.position.set(side*.31,-.18,.01);toy.add(arm);const sleeve=new THREE.Mesh(new THREE.SphereGeometry(.11,16,16),blueShirt);sleeve.scale.set(.72,1.2,.7);sleeve.rotation.z=side*.42;sleeve.position.set(side*.25,-.08,.01);toy.add(sleeve);const leg=new THREE.Mesh(new THREE.CylinderGeometry(.07,.08,.22,14),frog);leg.position.set(side*.115,-.59,.02);toy.add(leg);}for(const eyeX of [-.12,.12]){const eye=new THREE.Mesh(new THREE.SphereGeometry(.125,20,20),new THREE.MeshStandardMaterial({color:0xf7f7ef,roughness:.18}));eye.scale.set(1,.9,.34);eye.position.set(eyeX,.22,.25);toy.add(eye);const pupil=new THREE.Mesh(new THREE.SphereGeometry(.068,16,16),new THREE.MeshStandardMaterial({color:0x080a12,metalness:.3,roughness:.08}));pupil.position.set(eyeX,.22,.307);toy.add(pupil);for(const [dx,dy,size] of [[-.018,.035,.022],[.024,.015,.012],[-.004,-.025,.01]]){const glint=new THREE.Mesh(new THREE.SphereGeometry(size,10,10),new THREE.MeshBasicMaterial({color:0xffffff}));glint.position.set(eyeX+dx,.22+dy,.365);toy.add(glint);}}const mouth=new THREE.Mesh(new THREE.TorusGeometry(.13,.024,10,22,Math.PI),new THREE.MeshStandardMaterial({color:0xb85461,roughness:.3}));mouth.rotation.z=Math.PI;mouth.position.set(0,.035,.285);toy.add(mouth);}
  if(kind==='penguin'){const blue=new THREE.MeshStandardMaterial({color:0x078ee8,emissive:0x075dac,emissiveIntensity:.22,roughness:.27,metalness:.08});const white=new THREE.MeshStandardMaterial({color:0xf8f6ed,roughness:.38});const orange=new THREE.MeshStandardMaterial({color:0xffad16,emissive:0xff7510,emissiveIntensity:.28,roughness:.25});const body=new THREE.Mesh(new THREE.SphereGeometry(.285,24,24),blue);body.scale.set(1,1.18,.9);toy.add(body);const belly=new THREE.Mesh(new THREE.SphereGeometry(.215,22,22),white);belly.scale.set(.92,1.2,.3);belly.position.set(0,-.02,.245);toy.add(belly);for(const wingX of [-.27,.27]){const wing=new THREE.Mesh(new THREE.SphereGeometry(.13,18,18),blue);wing.scale.set(.8,1.55,.6);wing.rotation.z=wingX<0?.28:-.28;wing.position.set(wingX,-.04,.01);toy.add(wing);}for(const footX of [-.115,.115]){const foot=new THREE.Mesh(new THREE.SphereGeometry(.085,16,16),orange);foot.scale.set(1.05,.54,1.28);foot.position.set(footX,-.34,.17);toy.add(foot);}const beak=new THREE.Mesh(new THREE.SphereGeometry(.075,16,16),orange);beak.scale.set(1,.62,.48);beak.position.set(0,.075,.315);toy.add(beak);for(const eyeX of [-.095,.095]){const eyeWhite=new THREE.Mesh(new THREE.SphereGeometry(.065,16,16),new THREE.MeshStandardMaterial({color:0xffffff,roughness:.18}));eyeWhite.position.set(eyeX,.15,.26);toy.add(eyeWhite);const pupil=new THREE.Mesh(new THREE.SphereGeometry(.04,14,14),new THREE.MeshStandardMaterial({color:0x070b16,metalness:.45,roughness:.08}));pupil.position.set(eyeX,.15,.314);toy.add(pupil);const glint=new THREE.Mesh(new THREE.SphereGeometry(.012,10,10),new THREE.MeshBasicMaterial({color:0xffffff}));glint.position.set(eyeX-.012,.17,.347);toy.add(glint);}for(const tx of [-.055,.02,.08]){const tuft=new THREE.Mesh(new THREE.ConeGeometry(.035,.13,10),blue);tuft.rotation.z=-.45+tx*4;tuft.position.set(tx,.31,.005);toy.add(tuft);}}
  if(kind==='shiba'){const head=new THREE.Mesh(new THREE.SphereGeometry(.27,20,20),toyMat);head.scale.y=.9;toy.add(head);for(const earX of [-.16,.16]){const ear=new THREE.Mesh(new THREE.ConeGeometry(.09,.22,12),toyMat);ear.position.set(earX,.23,.01);toy.add(ear);}const snout=new THREE.Mesh(new THREE.SphereGeometry(.115,16,16),new THREE.MeshStandardMaterial({color:0xffe7bc}));snout.position.set(0,-.055,.22);toy.add(snout);const nose=new THREE.Mesh(new THREE.SphereGeometry(.04,12,12),new THREE.MeshStandardMaterial({color:0x12131a}));nose.position.set(0,-.02,.32);toy.add(nose);}
  if(kind==='pill'){const white=new THREE.MeshStandardMaterial({color:0xf8f7ef,metalness:.12,roughness:.14});const green=new THREE.MeshStandardMaterial({color:0x258b25,emissive:0x144d19,emissiveIntensity:.28,metalness:.16,roughness:.16});const upperBody=new THREE.Mesh(new THREE.CylinderGeometry(.15,.15,.2,24),white);upperBody.position.y=.1;toy.add(upperBody);const lowerBody=new THREE.Mesh(new THREE.CylinderGeometry(.15,.15,.2,24),green);lowerBody.position.y=-.1;toy.add(lowerBody);const topCap=new THREE.Mesh(new THREE.SphereGeometry(.15,24,16,0,Math.PI*2,0,Math.PI/2),white);topCap.position.y=.2;toy.add(topCap);const bottomCap=new THREE.Mesh(new THREE.SphereGeometry(.15,24,16,0,Math.PI*2,Math.PI/2,Math.PI/2),green);bottomCap.position.y=-.2;toy.add(bottomCap);const seam=new THREE.Mesh(new THREE.TorusGeometry(.151,.009,8,24),new THREE.MeshStandardMaterial({color:0x0d4915,emissive:0x0d4915,emissiveIntensity:.22,metalness:.7}));seam.rotation.x=Math.PI/2;toy.add(seam);}
  if(kind==='penguin'){toy.clear();const exactPudgy=new THREE.Mesh(new THREE.PlaneGeometry(.72,.72),new THREE.MeshBasicMaterial({map:pudgyToyTexture}));exactPudgy.position.z=.12;toy.add(exactPudgy);}
}
addPrizeWindow(-5.75,'PEPE','pepe',0x62cf64);addPrizeWindow(-3.45,'PUDGY','penguin',0x72d8ff);addPrizeWindow(-1.15,'ENTERPRISE','enterprise',0x6aaeff);addPrizeWindow(1.15,'KURACK','kurack',0xffb42e);addPrizeWindow(3.45,'FURTHERMORE','furthermore',0xb875ff);addPrizeWindow(5.75,'PUMP.FUN','pill',0xff3cac);
let optimizedGltfLoaderPromise;
function getOptimizedGltfLoader(){if(!optimizedGltfLoaderPromise)optimizedGltfLoaderPromise=Promise.all([import('three/addons/loaders/GLTFLoader.js'),import('three/addons/libs/meshopt_decoder.module.js')]).then(([{GLTFLoader},{MeshoptDecoder}])=>new GLTFLoader().setMeshoptDecoder(MeshoptDecoder));return optimizedGltfLoaderPromise;}
async function installPepeModel(){try{const loader=await getOptimizedGltfLoader();loader.load('assets/models/pepe-the-frog.optimized.glb?v=meshopt-1',gltf=>{const slot=prizeDisplay.getObjectByName('pepe-model-slot');if(!slot)return;slot.clear();const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());model.position.sub(center);model.scale.setScalar(.58/Math.max(size.x,size.y,size.z));model.rotation.y=0;model.position.set(0,-.24,.22);slot.add(model);},undefined,error=>console.warn('Pepe model could not load.',error));}catch(error){console.warn('Pepe model loader could not initialize.',error)}}
async function loadPudgyColorTexture(buffer){const view=new DataView(buffer);let offset=12,json,bin;while(offset<buffer.byteLength){const length=view.getUint32(offset,true),type=view.getUint32(offset+4,true),chunk=new Uint8Array(buffer,offset+8,length);if(type===0x4e4f534a)json=JSON.parse(new TextDecoder().decode(chunk));if(type===0x004e4942)bin=chunk;offset+=8+length;}const image=json?.images?.[0],imageView=json?.bufferViews?.[image?.bufferView];if(!image||!imageView||!bin)throw new Error('Penguin color texture is missing.');const imageBytes=bin.slice(imageView.byteOffset||0,(imageView.byteOffset||0)+imageView.byteLength);const url=URL.createObjectURL(new Blob([imageBytes],{type:image.mimeType||'image/jpeg'}));return new Promise((resolve,reject)=>new THREE.TextureLoader().load(url,texture=>{URL.revokeObjectURL(url);texture.colorSpace=THREE.SRGBColorSpace;texture.flipY=false;texture.needsUpdate=true;resolve(texture);},undefined,error=>{URL.revokeObjectURL(url);reject(error)}));}
async function installPudgyModel(){try{const [loader,buffer]=await Promise.all([getOptimizedGltfLoader(),fetch('assets/models/pudgy-penguin.optimized.glb?v=meshopt-1').then(response=>{if(!response.ok)throw new Error(`Penguin model returned ${response.status}.`);return response.arrayBuffer()})]);const colorTexture=await loadPudgyColorTexture(buffer);const gltf=await new Promise((resolve,reject)=>loader.parse(buffer,'',resolve,reject));const slot=prizeDisplay.getObjectByName('pudgy-model-slot');if(!slot)return;slot.clear();const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());model.position.sub(center);model.traverse(node=>{if(node.isMesh)node.material=new THREE.MeshStandardMaterial({map:colorTexture,roughness:.55,metalness:0,side:THREE.DoubleSide});});model.scale.setScalar(.58/Math.max(size.x,size.y,size.z));model.rotation.y=0;model.position.y=-.08;slot.add(model);}catch(error){console.warn('Pudgy model could not load.',error)}}
async function installFurthermoreModel(){try{const loader=await getOptimizedGltfLoader();loader.load('assets/models/furthermore.optimized.glb?v=meshopt-1',gltf=>{const slot=prizeDisplay.getObjectByName('furthermore-model-slot');if(!slot)return;slot.clear();const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());model.position.sub(center);model.traverse(node=>{if(!node.isMesh)return;const materials=Array.isArray(node.material)?node.material:[node.material];for(const material of materials){if(material?.emissive){material.emissive.set(0x1a1209);material.emissiveIntensity=.1;}}});model.scale.setScalar(1.05/Math.max(size.x,size.y,size.z));model.rotation.y=-Math.PI/2;model.position.set(0,-.2,.18);slot.add(model);},undefined,error=>console.warn('Furthermore model could not load.',error));}catch(error){console.warn('Furthermore model loader could not initialize.',error)}}
async function installEnterpriseModel(){try{const loader=await getOptimizedGltfLoader();loader.load('assets/models/enterprise.optimized.glb?v=meshopt-1',gltf=>{const slot=prizeDisplay.getObjectByName('enterprise-model-slot');if(!slot)return;slot.clear();const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());model.position.sub(center);model.scale.setScalar(.76/Math.max(size.x,size.y,size.z));model.rotation.y=Math.PI/2;model.position.y=.02;slot.add(model);},undefined,error=>console.warn('Enterprise model could not load.',error));}catch(error){console.warn('Enterprise model loader could not initialize.',error)}}
async function installKurackModel(){try{const loader=await getOptimizedGltfLoader();loader.load('assets/models/kurack.optimized.glb?v=meshopt-1',gltf=>{const slot=prizeDisplay.getObjectByName('kurack-model-slot');if(!slot)return;slot.clear();const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3()),scale=.72/Math.max(size.x,size.y,size.z);model.scale.setScalar(scale);model.rotation.y=Math.PI*1.5;model.position.set(-center.x*scale,0,-center.z*scale);const scaledBounds=new THREE.Box3().setFromObject(model);model.position.y=-scaledBounds.min.y-.18;slot.add(model);},undefined,error=>console.warn('Kurack model could not load.',error));}catch(error){console.warn('Kurack model loader could not initialize.',error)}}
async function installGangsterPepe(){try{const loader=await getOptimizedGltfLoader();loader.load('assets/models/pepe-gangster-animated.optimized.glb?v=meshopt-1',gltf=>{const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3()),scale=.016/Math.max(size.x,size.y,size.z);model.scale.setScalar(scale);model.position.set(-center.x*scale,0,-center.z*scale);const scaledBounds=new THREE.Box3().setFromObject(model);model.position.y-=scaledBounds.min.y;gangsterPepeMount.add(model);if(gltf.animations.length){const mixer=new THREE.AnimationMixer(model);gltf.animations.forEach(clip=>mixer.clipAction(clip).play());animatedMixers.push(mixer);}},undefined,error=>console.warn('Animated gangster Pepe model could not load.',error));}catch(error){console.warn('Animated gangster Pepe loader could not initialize.',error)}}
let prizeModelsStarted=false,megaManStatuesStarted=false,nextHeavyAssetCheck=0;
// Real controllers on the deck instead of a generic stick and four buttons.
// Each model loads once per system and is cloned onto every cabinet of that
// system; clones share geometry and materials, so the cost is one upload each.
// The built-in controls stay until the model arrives, so a failed load simply
// leaves the cabinet as it was.
// Leave a clear border around every controller so it reads as an object resting
// on the 1.5 by .56 deck instead of becoming the deck itself. Depth remains the
// limiting dimension for the three-pronged N64 pad.
const CONTROLLER_DECK={width:.58,depth:.34};
const CONTROLLER_DISPLAY_SURFACE_Y=.035;
const controllerDisplayShelfGeometry=roundedSlab(1,.07,.72,.045,.015);
const controllerDisplaySupportGeometry=roundedSlab(.34,.22,.45,.04,.015);
const controllerDisplayShelfMaterial=new THREE.MeshStandardMaterial({color:0x090c14,roughness:.2,metalness:.88});
const CONTROLLER_MODELS={
  psx:{file:'playstation-controller.glb',rotation:[0,0,0],offset:[0,0,0]},
  n64:{file:'n64-controller.glb',rotation:[-Math.PI/2,0,0],offset:[0,0,0]},
  gamecube:{file:'gamecube-controller.glb',rotation:[0,0,0],offset:[0,0,0]}
};
const controllerLoadStarted=new Set();
function fitControllerToDeck(model,config){
  const bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3());
  const scale=Math.min(CONTROLLER_DECK.width/size.x,CONTROLLER_DECK.depth/(size.z||size.x));
  model.scale.setScalar(scale);
  const scaled=new THREE.Box3().setFromObject(model),center=scaled.getCenter(new THREE.Vector3());
  // Centre on the deck and rest on its surface rather than sinking through it.
  model.position.set(-center.x+config.offset[0],-scaled.min.y+config.offset[1]+CONTROLLER_DISPLAY_SURFACE_Y,-center.z+config.offset[2]);
  return model;
}
async function installControllerModel(system){
  const config=CONTROLLER_MODELS[system];
  if(!config||controllerLoadStarted.has(system))return;
  controllerLoadStarted.add(system);
  try{
    const loader=await getOptimizedGltfLoader();
    const gltf=await new Promise((resolve,reject)=>loader.load('assets/models/controllers/'+config.file+'?v=controllers-1',resolve,undefined,reject));
    for(const cabinet of cabinets){
      if(cabinet.controllerSystem!==system||!cabinet.controlSlot)continue;
      const model=gltf.scene.clone(true);
      model.rotation.set(...config.rotation);
      const mount=new THREE.Group();
      const shelf=new THREE.Mesh(controllerDisplayShelfGeometry,controllerDisplayShelfMaterial);shelf.position.y=-.035;mount.add(shelf);
      const support=new THREE.Mesh(controllerDisplaySupportGeometry,controllerDisplayShelfMaterial);support.position.set(0,-.14,-.27);mount.add(support);
      const shelfAccent=new THREE.Mesh(cabinetGeometry.deckLight,new THREE.MeshStandardMaterial({color:cabinet.hue,emissive:cabinet.hue,emissiveIntensity:1.1}));shelfAccent.position.set(0,.008,.345);mount.add(shelfAccent);
      mount.add(fitControllerToDeck(model,config));
      // A lowered retail-display shelf projects beyond the stock control deck,
      // keeping the pad visibly attached to the cabinet and clear of the CRT.
      mount.position.set(0,1.32,1.02);mount.rotation.x=.04;
      cabinet.controlSlot.clear();
      cabinet.controlSlot.add(mount);
    }
  }catch(error){console.warn('Controller model could not load for '+system+'.',error)}
}
function loadNearbySceneModels(now){if(now<nextHeavyAssetCheck)return;nextHeavyAssetCheck=now+500;
  for(const cabinet of cabinets){
    if(!cabinet.controllerSystem||controllerLoadStarted.has(cabinet.controllerSystem))continue;
    if(cabinet.g.position.distanceToSquared(playerPosition)<324)installControllerModel(cabinet.controllerSystem);
  }
  for(const cabinet of cabinets){
    if(cabinet.artApplied||!cabinet.artSlug)continue;
    if(cabinet.g.position.distanceToSquared(playerPosition)<324)applyCabinetArt(cabinet,cabinet.artSlug);
  }if(!prizeModelsStarted&&playerPosition.distanceToSquared(prizeDisplay.position)<144){prizeModelsStarted=true;installPepeModel();installPudgyModel();installFurthermoreModel();installEnterpriseModel();installKurackModel();installGangsterPepe();}if(!megaManStatuesStarted&&playerPosition.x<-18.6&&playerPosition.z<24&&playerPosition.z>-6){megaManStatuesStarted=true;installMegaManStatues();}}
let nextLightCull=0;
// The barrier beacons are children of their barrier group, so light.position is
// a local offset near the origin rather than the corner the beacon actually
// occupies. Rank on the world position instead.
function managedLightPosition(light){
  if(!light.userData.worldPosition){light.updateWorldMatrix(true,false);light.userData.worldPosition=light.getWorldPosition(new THREE.Vector3())}
  return light.userData.worldPosition;
}
function updateNearbyLights(now){if(now<nextLightCull)return;nextLightCull=now+250;const cabinetDistances=cabinets.map(cabinet=>({cabinet,distanceSq:cabinet.g.position.distanceToSquared(playerPosition)})).sort((a,b)=>a.distanceSq-b.distanceSq);let litCabinets=0;for(const {cabinet,distanceSq} of cabinetDistances){cabinet.g.visible=distanceSq<324;const lightsVisible=cabinet.g.visible&&distanceSq<64&&litCabinets<2;if(lightsVisible)litCabinets++;cabinet.renderLights.forEach(light=>{light.visible=lightsVisible});}const roomLights=[],accentLights=[];const muralLights=[];for(const light of managedSceneLights){const position=managedLightPosition(light),dx=position.x-playerPosition.x,dz=position.z-playerPosition.z;(light.userData.muralLight?muralLights:light.userData.accentLight?accentLights:roomLights).push({light,distanceSq:dx*dx+dz*dz})}
// Accent beacons only reach 2.8 units, so they are ranked against their own
// radius. Sharing one budget with the room lights let them win both slots from
// across the room and leave the floor unlit.
// Four, and reaching further. Two was tuned for a hall a third of this size,
// and in the ring it left the floor between rooms genuinely unlit.
roomLights.sort((a,b)=>a.distanceSq-b.distanceSq).forEach(({light,distanceSq},index)=>{light.visible=index<4&&distanceSq<400});
accentLights.sort((a,b)=>a.distanceSq-b.distanceSq).forEach(({light,distanceSq},index)=>{light.visible=index<2&&distanceSq<16});
// A mural washes its wall from across the room, so it is ranked over the range
// it actually reaches. On the accent budget every one of these sat dark unless
// the player pressed into the wall, which is the one place you cannot see it.
muralLights.sort((a,b)=>a.distanceSq-b.distanceSq).forEach(({light,distanceSq},index)=>{light.visible=index<3&&distanceSq<225});const prizeVisible=playerPosition.distanceToSquared(prizeDisplay.position)<144;gangsterPepeLight.visible=prizeVisible;prizeDisplayLights.forEach(light=>{light.visible=prizeVisible});}
const prizeSignCanvas=document.createElement('canvas');prizeSignCanvas.width=1024;prizeSignCanvas.height=192;const psc=prizeSignCanvas.getContext('2d');const prizeLedTexture=new THREE.CanvasTexture(prizeSignCanvas);
function drawPrizeLed(time=0){psc.fillStyle='#05060b';psc.fillRect(0,0,1024,192);for(let x=8;x<1024;x+=16){for(let y=8;y<192;y+=16){psc.fillStyle=(x+y)%32?'#101527':'#1c2540';psc.fillRect(x,y,3,3)}}psc.font='bold 88px monospace';psc.textBaseline='middle';psc.shadowColor='#ff3cac';psc.shadowBlur=20;psc.fillStyle='#fff4cc';const text='  ✦  PRIZE COUNTER  ✦  ';const width=psc.measureText(text).width;const offset=(time*.14)%(width+1024);psc.fillText(text,1024-offset,98);psc.fillText(text,1024-offset+width+160,98);psc.shadowBlur=0;prizeLedTexture.needsUpdate=true;}
drawPrizeLed();
const jumbotron=new THREE.Group();jumbotron.position.set(0,3.46875,.04);prizeDisplay.add(jumbotron);const signBody=new THREE.Mesh(new THREE.BoxGeometry(3.25,.78,.86),new THREE.MeshStandardMaterial({color:0x090b16,metalness:.85,roughness:.16}));jumbotron.add(signBody);
for(const [z,rotation] of [[.436,0],[-.436,Math.PI]]){const face=new THREE.Mesh(new THREE.PlaneGeometry(3.05,.58),new THREE.MeshBasicMaterial({map:prizeLedTexture}));face.position.z=z;face.rotation.y=rotation;jumbotron.add(face);}
point(0x36f9f6,-2.6,2.3,0,2);point(0xff3cac,2.6,2.3,0,2);
const start=document.querySelector('#start-screen'), prompt=document.querySelector('#prompt'), modal=document.querySelector('#machine-modal'), hudStatus=document.querySelector('.status');
const mobileMoveZone=document.querySelector('#mobile-move-zone'),mobileMoveThumb=document.querySelector('#mobile-move-thumb'),mobileLookZone=document.querySelector('#mobile-look-zone');
function updateViewStatus(){if(!hudStatus)return;hudStatus.textContent=document.body.classList.contains('gamepad-input')?`LEFT STICK · MOVE   /   RIGHT STICK · LOOK   /   A · USE   /   Y · ${cameraMode==='first-person'?'1ST':'3RD'} PERSON`:mobileInputAvailable()?`LEFT STICK · MOVE   /   DRAG · LOOK   /   VIEW · ${cameraMode==='first-person'?'1ST':'3RD'} PERSON`:`WASD · MOVE   /   MOUSE · LOOK   /   V · ${cameraMode==='first-person'?'1ST':'3RD'} PERSON`}
function toggleCameraMode(){
  if(activeCabinet||start.style.display!=='none')return;
  cameraMode=cameraMode==='first-person'?'third-person':'first-person';
  updateViewStatus();
  window.dispatchEvent(new CustomEvent('arcade:camera-mode-changed',{detail:{mode:cameraMode}}));
}
// A pad that is merely plugged in is not the input the player is using. The
// arcade follows whichever device was touched last, so an idle controller left
// behind the monitor cannot hold the HUD and the movement grant forever.
function setGamepadEngaged(engaged){
  if(gamepadEngaged===engaged)return;
  gamepadEngaged=engaged;
  document.body.classList.toggle('gamepad-input',engaged);
  updateViewStatus();
}
function consumeGamepadPress(pad,index,callback){
  const pressed=buttonPressed(pad,index),wasPressed=gamepadButtonState[index]===true;
  gamepadButtonState[index]=pressed;
  if(pressed&&!wasPressed)callback();
}
function interactWithNearbyCabinet(){
  if(!near)return;
  if(near.disabledReason==='desktop-only')showCabinetMessage('DESKTOP ONLY — ABOUT 1 GB PER GAME');
  else window.dispatchEvent(new CustomEvent('arcade:cabinet-interact',{detail:{cabinetId:near.id}}));
}
function pollArcadeGamepad(delta){
  const pad=pickGamepad(navigator.getGamepads?.(),activeGamepadIndex);
  if(!pad){activeGamepadIndex=null;gamepadMove.x=0;gamepadMove.y=0;gamepadButtonState.length=0;setGamepadEngaged(false);return false}
  activeGamepadIndex=pad.index;
  if(gamepadHasActivity(pad,GAMEPAD_DEAD_ZONE))setGamepadEngaged(true);
  if(!gamepadEngaged)return false;
  if(start.style.display!=='none'){
    consumeGamepadPress(pad,GAMEPAD_BUTTONS.SOUTH,beginArcade);
    consumeGamepadPress(pad,GAMEPAD_BUTTONS.START,beginArcade);
    return false;
  }
  readStick(pad,GAMEPAD_AXES.LEFT_X,GAMEPAD_AXES.LEFT_Y,GAMEPAD_DEAD_ZONE,gamepadMove);
  readDpad(pad,gamepadDpad);
  if(gamepadDpad.x)gamepadMove.x=gamepadDpad.x;
  if(gamepadDpad.y)gamepadMove.y=gamepadDpad.y;
  // The modal owns the view while a cabinet is open. Letting the right stick
  // through swung the camera behind it, so closing the cabinet put the player
  // somewhere they never chose to face.
  if(!activeCabinet){
    readStick(pad,GAMEPAD_AXES.RIGHT_X,GAMEPAD_AXES.RIGHT_Y,GAMEPAD_DEAD_ZONE,gamepadLook);
    yaw-=gamepadLook.x*delta*2.25;
    pitch=Math.max(-.42,Math.min(.58,pitch-gamepadLook.y*delta*1.75));
  }
  consumeGamepadPress(pad,GAMEPAD_BUTTONS.SOUTH,()=>{if(!activeCabinet)interactWithNearbyCabinet()});
  consumeGamepadPress(pad,GAMEPAD_BUTTONS.NORTH,toggleCameraMode);
  consumeGamepadPress(pad,GAMEPAD_BUTTONS.EAST,()=>{if(activeCabinet)closeMachine();else if(socialFollowProvider)socialFollowProvider=null});
  return true;
}
addEventListener('gamepadconnected',event=>{activeGamepadIndex=event.gamepad.index;gamepadButtonState.length=0});
addEventListener('gamepaddisconnected',event=>{if(activeGamepadIndex===event.gamepad.index){activeGamepadIndex=null;gamepadMove.x=0;gamepadMove.y=0;gamepadButtonState.length=0;setGamepadEngaged(false)}});
function beginArcade(){
  start.style.display='none';
  document.body.classList.add('arcade-started');
  // Pointer lock is optional: the floor still appears if a browser declines it.
  if(mobileInputAvailable())return;
  const lockAttempt = renderer.domElement.requestPointerLock();
  if (lockAttempt && typeof lockAttempt.catch === 'function') lockAttempt.catch(()=>{});
}
document.querySelector('#enter').onclick=beginArcade;
document.addEventListener('keydown', event=>{
  if (event.code === 'Enter' && start.style.display !== 'none') beginArcade();
});
// Browsers release mouse capture whenever the user changes tabs or apps.
// A click on the arcade safely reacquires it when returning.
renderer.domElement.addEventListener('click', ()=>{
  if (!mobileInputAvailable() && !activeCabinet && start.style.display === 'none' && !locked) renderer.domElement.requestPointerLock();
});
function resetMobileMove(){mobileMove.x=0;mobileMove.y=0;if(mobileMoveThumb)mobileMoveThumb.style.transform='translate(-50%,-50%)'}
window.addEventListener('blur', ()=>{ Object.keys(keys).forEach(key=>keys[key]=false);resetMobileMove(); });
document.addEventListener('pointerlockchange',()=>{locked=document.pointerLockElement===renderer.domElement;document.querySelector('#crosshair').style.opacity=locked||mobileInputAvailable()&&document.body.classList.contains('arcade-started')?'1':'0'});
document.addEventListener('mousemove',e=>{if(!locked)return;if(e.movementX||e.movementY)setGamepadEngaged(false);yaw-=e.movementX*.0025;pitch=Math.max(-.42,Math.min(.58,pitch-e.movementY*.0025))});
addEventListener('keydown',e=>{keys[e.code]=true;setGamepadEngaged(false);if(e.code==='KeyV'&&!e.repeat)toggleCameraMode();if(e.code==='KeyE'&&near&&(locked||mobileInputAvailable())&&!e.repeat)interactWithNearbyCabinet();if(e.code==='Escape'&&activeCabinet)closeMachine();else if(e.code==='Escape'&&socialFollowProvider)socialFollowProvider=null});addEventListener('keyup',e=>keys[e.code]=false);
if(mobileMoveZone&&mobileMoveThumb&&mobileLookZone){
  let movePointer=null,lookPointer=null,lastLookX=0,lastLookY=0;
  const updateMove=event=>{const rect=mobileMoveThumb.parentElement.getBoundingClientRect(),centerX=rect.left+rect.width/2,centerY=rect.top+rect.height/2,radius=rect.width*.34,dx=event.clientX-centerX,dy=event.clientY-centerY,length=Math.hypot(dx,dy)||1,scale=Math.min(1,radius/length),x=dx*scale,y=dy*scale;mobileMove.x=x/radius;mobileMove.y=y/radius;mobileMoveThumb.style.transform=`translate(calc(-50% + ${x}px),calc(-50% + ${y}px))`};
  mobileMoveZone.addEventListener('pointerdown',event=>{event.preventDefault();movePointer=event.pointerId;mobileMoveZone.setPointerCapture(event.pointerId);updateMove(event)});
  mobileMoveZone.addEventListener('pointermove',event=>{if(event.pointerId===movePointer)updateMove(event)});
  const endMove=event=>{if(event.pointerId!==movePointer)return;movePointer=null;resetMobileMove()};
  mobileMoveZone.addEventListener('pointerup',endMove);mobileMoveZone.addEventListener('pointercancel',endMove);
  mobileLookZone.addEventListener('pointerdown',event=>{event.preventDefault();lookPointer=event.pointerId;lastLookX=event.clientX;lastLookY=event.clientY;mobileLookZone.setPointerCapture(event.pointerId)});
  mobileLookZone.addEventListener('pointermove',event=>{if(event.pointerId!==lookPointer)return;const dx=event.clientX-lastLookX,dy=event.clientY-lastLookY;lastLookX=event.clientX;lastLookY=event.clientY;yaw-=dx*.006;pitch=Math.max(-.42,Math.min(.58,pitch-dy*.006))});
  const endLook=event=>{if(event.pointerId===lookPointer)lookPointer=null};mobileLookZone.addEventListener('pointerup',endLook);mobileLookZone.addEventListener('pointercancel',endLook);
  document.querySelector('#mobile-view').addEventListener('click',event=>{event.preventDefault();toggleCameraMode()});
  document.querySelector('#mobile-use').addEventListener('click',event=>{event.preventDefault();const down=new KeyboardEvent('keydown',{code:'KeyE',key:'e'}),up=new KeyboardEvent('keyup',{code:'KeyE',key:'e'});dispatchEvent(down);dispatchEvent(up)});
}
let near=null;
/**
 * Platforms whose emulation is not finished, stated at the cabinet.
 *
 * Keyed by platform rather than carried per game: the warning is a property of
 * the emulator behind the cabinet, and a per-game field is a thing someone can
 * forget to set on the next title added.
 */
const EXPERIMENTAL_PLATFORMS={
  ps2:'PLAYSTATION 2 SUPPORT IS EXPERIMENTAL AND STILL IN DEVELOPMENT · EXPECT SLOWDOWN, GLITCHES AND GAMES THAT DO NOT BOOT',
  gamecube:'GAMECUBE SUPPORT IS EXPERIMENTAL AND STILL IN DEVELOPMENT · EXPECT SLOWDOWN, GLITCHES AND GAMES THAT DO NOT BOOT'
};
function openMachine(c){
  activeCabinet=c;
  document.body.classList.add('cabinet-open');resetMobileMove();
  const romInput=document.querySelector('#rom-file');romInput.value='';romLoaded=false;
  // A title that is known to run below full speed says so on the way in.
  const performanceNote=c.performanceNote?` · ${c.performanceNote.toUpperCase()}`:'';
  const nativeState=document.querySelector('#native-runtime-state');
  if(nativeState)nativeState.hidden=true;
  const warning=document.querySelector('#cabinet-warning');
  if(warning){
    const platformWarning=EXPERIMENTAL_PLATFORMS[c.system];
    warning.hidden=!platformWarning;
    if(platformWarning)warning.textContent=platformWarning+(c.performanceNote?` · ${c.performanceNote.toUpperCase()}`:'');
  }
  document.querySelector('#machine-type').textContent=(c.system==='psx'?'PLAYSTATION // CABINET':(c.system==='n64'?'NINTENDO 64 // CABINET':(c.system==='snes'?'SUPER NINTENDO // CABINET':(c.system==='ps2'?'PLAYSTATION 2 // EXPERIMENTAL CABINET':(c.system==='gamecube'?'GAMECUBE // EXPERIMENTAL GECKO':c.type)))))+performanceNote;
  document.querySelector('#machine-name').textContent=c.name;
  const controls=document.querySelector('#emulator-controls');
  if(controls)controls.textContent=window.arcadeAvatarIdentity?.walletAuthenticated
    ?'CONTROLLER READY · WALLET SAVE / LOAD ENABLED · ESC EXIT'
    :'CONTROLLER READY · SAVE / LOAD REQUIRES SOLANA WALLET SIGN-IN · ESC EXIT';
  document.querySelector('#bios-control').style.display=c.system==='psx'?'flex':'none';
  const playButton=document.querySelector('#play-hosted-game');
  const discSelector=document.querySelector('#hosted-disc-selector'),hasMultipleDiscs=Array.isArray(c.hostedDiscs)&&c.hostedDiscs.length>1;
  playButton.style.display=c.hostedGame&&!hasMultipleDiscs&&c.enabled!==false?'inline-block':'none';
  discSelector.hidden=!hasMultipleDiscs;discSelector.replaceChildren();
  if(c.hostedGame&&!hasMultipleDiscs) playButton.textContent=`PLAY ${c.gameName.toUpperCase()} · ${formatDownloadSize(c.gameSizeBytes)}`;
  if(hasMultipleDiscs)c.hostedDiscs.forEach(disc=>{const button=document.createElement('button');button.type='button';button.textContent=`PLAY ${disc.label.toUpperCase()} · ${formatDownloadSize(disc.sizeBytes)}`;button.addEventListener('click',()=>{if(activeCabinet===c)launchEmulator(disc.url,{label:`${c.gameName} · ${disc.label}`,sizeBytes:disc.sizeBytes})});discSelector.append(button)});
  void refreshPs2CacheButton(c);
  if(c.system==='psx') document.querySelector('#rom-name').textContent=hasMultipleDiscs?`${c.hostedDiscs.length} DISC SET READY — CHOOSE A DISC`:(c.hostedGame?'LICENSED GAME READY — PRESS PLAY':(c.assetNote||`LOAD A ${c.gameName.toUpperCase()} GAME FILE`));
  if(c.system==='psx') document.querySelector('#bios-name').textContent=psxBios?`BIOS READY: ${psxBios.name.toUpperCase()}`:'HOSTED BIOS READY: SCPH1001.BIN';
  if(c.system==='n64') document.querySelector('#rom-name').textContent=c.hostedGame?'LICENSED N64 GAME READY — PRESS PLAY':'N64 EMULATOR READY — LOAD A .Z64, .N64, OR .V64 ROM';
  if(c.system==='snes') document.querySelector('#rom-name').textContent=c.hostedGame?'LICENSED SNES GAME READY — PRESS PLAY':'SNES EMULATOR READY — LOAD A .SFC OR .SMC ROM';
  if(c.system==='ps2') document.querySelector('#rom-name').textContent='EXPERIMENTAL PLAY! CORE READY — LOAD A LOCAL .ISO, .CHD, .CSO, .ISZ, .BIN, OR .ELF FILE';
  // Walking up to the cabinet is the first moment the answer could matter, and
  // the player has a modal to read before they press anything.
  if(c.system==='gamecube'||c.system==='ps2'){
    // Whether a cabinet is about to run natively is the single most useful
    // thing to say here, and it was previously invisible: a runtime that was
    // installed, running and refused looked exactly like no runtime at all.
    const nativeLine=document.querySelector('#native-runtime-state');
    const describe=detection=>{
      if(!nativeLine)return;
      const emulator=c.system==='ps2'?'PCSX2':'DOLPHIN';
      const missing=c.system==='ps2'?detection?.pcsx2Present===false:detection?.dolphinPresent===false;
      const native=Boolean(detection?.usable)&&!missing;
      // The reason travels with the verdict. Without it a player who cannot run
      // natively has to open a browser console to find out why, which is the
      // same dead end as saying nothing at all.
      const why=detection?.reason?` (${String(detection.reason).toUpperCase().replace(/[_-]/g,' ')})`:'';
      if(native)nativeLine.textContent=`NATIVE RUNTIME READY · ${emulator} WILL RUN THIS CABINET`;
      else if(detection?.usable)nativeLine.textContent=`ARCADE RUNTIME FOUND, BUT ${emulator} IS NOT INSTALLED · PLAYING IN THE BROWSER`;
      else if(detection?.pending)nativeLine.textContent='LOOKING FOR THE ARCADE RUNTIME…';
      else nativeLine.textContent=`NO ARCADE RUNTIME${why} · PLAYING IN THE BROWSER`;
      nativeLine.dataset.native=String(native);
      nativeLine.hidden=false;
    };
    describe(window.ARCADE_RUNTIME_DETECTION);
    window.ARCADE_ENSURE_RUNTIME_DETECTION?.()?.then?.(describe);
  }
  if(c.system==='gamecube') document.querySelector('#rom-name').textContent=c.disabledReason==='desktop-only'
    ?'GAMECUBE GAMES ARE DESKTOP ONLY — ABOUT 1 GB EACH'
    :(c.hostedGame?'EXPERIMENTAL GAMECUBE IMAGE READY — PRESS PLAY':'GECKO READY — LOAD A LOCAL .RVZ, .ISO, OR .GCM IMAGE');
  document.querySelector('.legal').textContent=c.system==='n64'?'Nintendo 64 games run locally through EmulatorJS using its Mupen64Plus Next browser core. No ROM data is uploaded.':(c.system==='snes'?'Super Nintendo games run locally through EmulatorJS in your browser. No ROM data is uploaded.':(c.system==='ps2'?'Experimental Play! WebAssembly PS2 emulation runs locally in your browser. Compatibility and performance vary; no game data is uploaded.':(c.system==='gamecube'?'Experimental Gecko WebGPU emulation runs locally in your browser. Large GameCube images require substantial memory; no game data is sent through multiplayer.':'Use game images and BIOS files legally dumped from hardware you own. PlayStation emulation runs locally in your browser; no ROM data is uploaded.')));
  window.ARCADE_MATCH_PANEL?.show(c.id,{maxPlayers:emulatorGameFor(c)?.maxPlayers??1});
  modal.style.display='grid';modal.setAttribute('aria-hidden','false');document.exitPointerLock();drawAttract(c);
}
function setEmulatorRuntimeActive(active){
  if(emulatorRuntimeActive===active)return;
  emulatorRuntimeActive=active;
  document.body.classList.toggle('emulator-running',active);
  window.dispatchEvent(new CustomEvent('arcade:emulator-mode-changed',{detail:{active}}));
}
function stopEmulator(){
  clearTimeout(emulatorLoadTimer);
  const frame=activeEmulatorFrame,objectUrls=emulatorObjectUrls;
  // EmulatorJS owns its runtime inside the iframe. Calling EJS_terminate on
  // this parent window never reached it, and removing the frame immediately
  // skipped the final memory-card/SRAM flush. Give the child a short,
  // bounded shutdown window; remove only the captured frame so a fast reopen
  // cannot be erased by the previous session's cleanup.
  try { frame?.contentWindow?.postMessage({type:'arcade:emulator-stop'},location.origin); }
  catch(error) { console.warn('Could not request a clean emulator shutdown.',error); }
  setTimeout(()=>{frame?.remove();objectUrls.forEach(url=>URL.revokeObjectURL(url))},500);
  document.querySelector('#emulator-stage').style.display='none';
  document.querySelector('.screen-wrap .scanlines').style.display='block';
  cvs.style.display='block';
  activeEmulatorFrame=null;pendingEmulatorSource=null;activeEmulatorAdapter=null;
  emulatorObjectUrls=[];
  setEmulatorRuntimeActive(false);
}
function closeMachine(notifyServer=true){const closing=activeCabinet;ps2CacheController?.abort();ps2CacheController=null;if(resolveEmulatorAdapter(closing))stopEmulator();window.ARCADE_MATCH_PANEL?.hide();modal.style.display='none';modal.setAttribute('aria-hidden','true');activeCabinet=null;document.body.classList.remove('cabinet-open');if(notifyServer&&closing)window.dispatchEvent(new CustomEvent('arcade:cabinet-session-ended',{detail:{cabinetId:closing.id}}));if(!mobileInputAvailable())renderer.domElement.requestPointerLock()}
document.querySelector('.close').onclick=closeMachine;
const cvs=document.querySelector('#game-screen'),ctx=cvs.getContext('2d'); let romLoaded=false,ship={x:320,bullets:[]},stars=Array.from({length:80},()=>({x:Math.random()*640,y:Math.random()*440,s:1+Math.random()*2})),psxBios=null;
const hostedPsxBios=biosAssetUrl;
function drawAttract(c){ctx.fillStyle='#03050c';ctx.fillRect(0,0,640,440);ctx.fillStyle='#36f9f6';ctx.font='30px monospace';ctx.textAlign='center';ctx.fillText(c.name,320,100);ctx.fillStyle='#ff3cac';ctx.font='15px monospace';ctx.fillText('INSERT ROM TO INITIALIZE',320,150);ctx.fillStyle='#a99abe';ctx.font='12px monospace';ctx.fillText('Your game appears here',320,330)}
document.querySelector('#rom-file').addEventListener('change',e=>{const f=e.target.files[0];if(!f||!activeCabinet)return;document.querySelector('#rom-name').textContent=`LOADED: ${f.name.toUpperCase()} · ${Math.ceil(f.size/1024)} KB`;romLoaded=true;ship={x:320,bullets:[]};});
let emulatorObjectUrls=[],emulatorLoadTimer,activeEmulatorFrame=null,pendingEmulatorSource=null,activeEmulatorAdapter=null;
const ps2Cache=window.ARCADE_PS2_CACHE,ps2CacheButton=document.querySelector('#cache-hosted-game');
let ps2CacheController=null;
const warmedEmulatorSystems=new Set(),warmedDiscCabinets=new Set(),fullyWarmedDiscs=new Set(),pendingRuntimeWarmups=new Set();
// Local caching is worth offering for anything with a download long enough to
// notice. The store itself is system agnostic; only the offer was PS2 only, so
// the main room's PlayStation and GameCube cabinets re-downloaded every launch.
const CACHEABLE_SYSTEMS=new Set(['psx','n64','gamecube','ps2']);
const ps2GameDescriptor=cabinet=>({id:cabinet.gameRegistryId,file:cabinet.gameFileName,sizeBytes:cabinet.gameSizeBytes});
async function refreshPs2CacheButton(cabinet=activeCabinet){
  const available=CACHEABLE_SYSTEMS.has(cabinet?.system)&&cabinet.hostedGame&&ps2Cache?.supported;
  ps2CacheButton.hidden=!available;if(!available)return;
  ps2CacheButton.disabled=true;ps2CacheButton.textContent='CHECKING LOCAL CACHE…';
  const cached=await ps2Cache.get(ps2GameDescriptor(cabinet));if(activeCabinet!==cabinet)return;
  ps2CacheButton.dataset.cached=cached?'true':'false';ps2CacheButton.textContent=cached?'CACHED LOCALLY':'CACHE GAME LOCALLY';ps2CacheButton.disabled=Boolean(cached);
}
// Walking up to a cabinet is the earliest reliable signal that its runtime is
// about to be needed. Opening one otherwise starts a cold serial chain: fetch
// the loader, then the core, then the game. Prefetching the runtime while the
// player is still crossing the floor takes that first hop off the clock.
// A streaming cabinet serves the core's disc reads from HTTP ranges, and the
// first of those reads — volume descriptor, root directory, boot config — all
// land in the opening megabytes. Pulling them onto disk while the player is
// still walking up is the difference between the modal opening onto a running
// game and opening onto a progress bar. The frame reads the same OPFS store
// from the same origin, so a chunk warmed here is one it never requests.
function warmStreamingDisc(cabinet){
  if(cabinet?.system!=='ps2'||!cabinet.hostedGame||!cabinet.gameFileName||!cabinet.gameSizeBytes)return;
  if(warmedDiscCabinets.has(cabinet.id)||navigator.connection?.saveData)return;
  warmedDiscCabinets.add(cabinet.id);
  import('./emulators/disc-range-cache.js?v=murals-5')
    .then(({prewarmDiscRanges})=>prewarmDiscRanges(
      {url:cabinet.hostedGame,name:cabinet.gameFileName,size:cabinet.gameSizeBytes},
      {chunks:cabinet.bootChunks?(lowPowerDevice?2:8):(lowPowerDevice?1:3),chunkList:cabinet.bootChunks}))
    .catch(error=>console.warn('Could not warm the disc for this cabinet.',error));
}
// Once a game is actually running, the rest of what it was measured reading is
// worth fetching in the background. A demand read that misses costs the player a
// visible stall — a 4 MB chunk is over half a second on a 45 Mbit line, and Mega
// Man X7 touches 46 of them before its title screen — so the difference between
// warming these during the intro and waiting for the core to ask for them is the
// difference between a game that runs and one that hitches every few seconds.
// Sequential on purpose: this shares a connection with the reads the core is
// waiting on, and taking them in the order they were first read means the
// earliest are on disk before the core reaches them.
function warmRemainingDisc(cabinet){
  const chunkList=cabinet?.bootChunks;
  if(!chunkList?.length||cabinet.system!=='ps2'||!cabinet.hostedGame||navigator.connection?.saveData)return;
  if(fullyWarmedDiscs.has(cabinet.id))return;
  fullyWarmedDiscs.add(cabinet.id);
  import('./emulators/disc-range-cache.js?v=murals-5')
    .then(({prewarmDiscRanges})=>prewarmDiscRanges(
      {url:cabinet.hostedGame,name:cabinet.gameFileName,size:cabinet.gameSizeBytes},
      {chunks:chunkList.length,chunkList,maxChunks:Math.max(128,chunkList.length+16)}))
    .then(result=>{if(result?.warmed)console.info(`Warmed ${result.warmed} more disc ranges for ${cabinet.gameName}.`)})
    .catch(error=>console.warn('Could not warm the rest of the disc.',error));
}
function warmEmulatorCore(cabinet){
  // PS2 and GameCube have a native path. Do not warm the browser core (or,
  // worse, begin pulling its disc ranges) while the loopback probe is still
  // deciding whether PCSX2/Dolphin will own the session. Before this guard a
  // player with the runtime installed paid for both paths, and a quick click
  // could commit to Play! merely because the probe had not answered yet.
  const runtimePlatform=cabinet?.system==='ps2'||cabinet?.system==='gamecube';
  const detection=window.ARCADE_RUNTIME_DETECTION;
  if(runtimePlatform&&(!detection||detection.pending)&&window.ARCADE_ENSURE_RUNTIME_DETECTION){
    if(!pendingRuntimeWarmups.has(cabinet.id)){
      pendingRuntimeWarmups.add(cabinet.id);
      Promise.resolve(window.ARCADE_ENSURE_RUNTIME_DETECTION()).finally(()=>{
        pendingRuntimeWarmups.delete(cabinet.id);
        // Only spend the warm-up after the player has stayed near this cabinet.
        if(near?.id===cabinet.id)warmEmulatorCore(cabinet);
      });
    }
    return;
  }
  const adapter=resolveEmulatorAdapter(cabinet);if(!adapter||warmedEmulatorSystems.has(adapter.id))return;
  // The runtime downloads and keeps its own verified image. Warming Play!'s
  // OPFS ranges at the same time duplicates network and disk traffic and makes
  // a demanding native session slower to become ready.
  if(adapter.id==='play-ps2')warmStreamingDisc(cabinet);
  warmedEmulatorSystems.add(adapter.id);
  for(const [href,as] of adapter.warmupAssets({platformId:cabinet?.system,biosUrl:biosAssetUrl})){
    if(!href)continue;
    const link=document.createElement('link');link.rel='prefetch';link.href=href;link.as=as;if(as==='fetch')link.crossOrigin='anonymous';document.head.appendChild(link)}
}
function formatDownloadSize(bytes){if(!Number.isFinite(bytes)||bytes<=0)return'HOSTED';const mb=bytes/1048576;return mb>=100?`${Math.round(mb)} MB`:`${mb.toFixed(1)} MB`}
function emulatorGameFor(cabinet){return cabinet?.gameRegistryId?window.ARCADE_GAME_REGISTRY?.byId?.get(cabinet.gameRegistryId)??null:null}
// Milestone 11.3/11.5: the cabinet no longer picks a core. A hosted game names
// its adapter; an unassigned cabinet running a local file falls back to platform
// coverage. Either way the decision lives in the registry, not here.
function resolveEmulatorAdapter(cabinet){
  const adapters=window.ARCADE_EMULATOR_ADAPTERS;if(!adapters)return null;
  // GameCube is the one platform where the right emulator depends on the
  // player rather than the game: native through the runtime if they have it
  // installed, the browser core if they do not. The registry cannot know which,
  // so the choice is made here from the startup probe.
  if(cabinet?.system==='ps2'&&window.ARCADE_CHOOSE_PS2_ADAPTER){
    return window.ARCADE_CHOOSE_PS2_ADAPTER({adapters,detection:window.ARCADE_RUNTIME_DETECTION}).adapter;
  }
  if(cabinet?.system==='gamecube'&&window.ARCADE_CHOOSE_GAMECUBE_ADAPTER){
    return window.ARCADE_CHOOSE_GAMECUBE_ADAPTER({adapters,detection:window.ARCADE_RUNTIME_DETECTION,isMobileDevice}).adapter;
  }
  const game=emulatorGameFor(cabinet);
  if(game){const resolution=adapters.resolveForGame(game);if(resolution.ok)return resolution.adapter}
  return adapters.forPlatform(cabinet?.system)[0]??null;
}
function launchEmulator(gameFile,options={}){
  const host=document.querySelector('#emulator-host'),stage=document.querySelector('#emulator-stage');
  const downloadBytes=options.sizeBytes??(typeof gameFile==='string'?activeCabinet?.gameSizeBytes:gameFile?.size),loadingLabel=options.label||activeCabinet?.gameName||'ARCADE GAME';
  const adapter=resolveEmulatorAdapter(activeCabinet);
  if(!adapter){showCabinetMessage('NO EMULATOR IS AVAILABLE FOR THIS GAME.');closeMachine();return}
  setEmulatorRuntimeActive(true);if(adapter.id==='play-ps2')warmRemainingDisc(activeCabinet);cvs.style.display='none';document.querySelector('.screen-wrap .scanlines').style.display='none';stage.style.display='grid';stage.style.placeItems='center';stage.style.color='#36f9f6';stage.style.fontFamily='monospace';stage.style.letterSpacing='.12em';host.textContent=`LOADING ${loadingLabel.toUpperCase()} · ${formatDownloadSize(downloadBytes)}...`;
  // Backends that take their source over postMessage boot with an empty frame,
  // so no object URL is minted for them: the File itself is handed across.
  const usesSourceHandshake=adapter.usesSourceHandshake===true;
  const localFile=typeof gameFile==='string'?null:gameFile;
  const gameUrl=typeof gameFile==='string'?gameFile:(usesSourceHandshake?'':URL.createObjectURL(gameFile));
  const biosUrl=activeCabinet?.system==='psx'?(psxBios?URL.createObjectURL(psxBios):hostedPsxBios):'';
  const gameName=activeCabinet?.gameName||'Arcade Game';
  const context={game:emulatorGameFor(activeCabinet),platformId:activeCabinet?.system,cabinetId:activeCabinet?.id,gameUrl,biosUrl,displayName:gameName,emulatorContentId:activeCabinet?.gameId||1,downloadBytes,localFile,dspUrl:gameCubeDspAssetUrl,baseUrl:location.href};
  // An adapter refuses rather than guesses when it cannot cover the platform,
  // so a resolution bug stops here with a message instead of booting a core
  // that cannot read the game.
  let descriptor;
  try{descriptor=adapter.describeFrame(context)}
  catch(error){for(const url of [gameUrl,biosUrl])if(typeof url==='string'&&url.startsWith('blob:'))URL.revokeObjectURL(url);setEmulatorRuntimeActive(false);showCabinetMessage(String(error?.message||'THIS GAME CANNOT BE STARTED.').toUpperCase());closeMachine();return}
  emulatorObjectUrls=[...descriptor.objectUrls];
  const player=document.createElement('iframe');player.title=descriptor.title;player.allow=descriptor.allow;player.src=descriptor.src;
  player.style.cssText='border:0;width:100%;height:100%;background:#02030a';player.onerror=()=>{showCabinetMessage('EMULATOR COULD NOT LOAD.');closeMachine()};
  activeEmulatorFrame=player;activeEmulatorAdapter=adapter;
  pendingEmulatorSource=usesSourceHandshake?adapter.initialHandshake(context):null;
  host.replaceChildren(player);
  const estimatedTimeout=Math.max(20000,Math.min(180000,20000+(Number(downloadBytes)||0)/524288*1000));
  clearTimeout(emulatorLoadTimer);emulatorLoadTimer=setTimeout(()=>{if(activeCabinet){closeMachine();showCabinetMessage('EMULATOR LOAD TIMED OUT. CHECK YOUR CONNECTION.')}},estimatedTimeout);
}
document.querySelector('#bios-file').addEventListener('change',e=>{const file=e.target.files[0];if(!file)return;psxBios=file;document.querySelector('#bios-name').textContent=`BIOS READY: ${file.name.toUpperCase()}`;});
// Prefer an already cached copy, but never make PLAY wait for a complete local
// download. EmulatorJS and Play! can begin from the hosted URL using byte-range
// requests, which turns first boot for large PlayStation images from a several
// minute prerequisite into an immediate emulator launch. Players who want the
// whole image on disk can still use the explicit CACHE GAME LOCALLY control.
async function resolveCachedHostedGame(cabinet){
  if(!CACHEABLE_SYSTEMS.has(cabinet.system)||!ps2Cache?.supported||!cabinet.gameSizeBytes)return null;
  const descriptor=ps2GameDescriptor(cabinet);
  try{
    return await ps2Cache.get(descriptor);
  }catch{return null}
}
document.querySelector('#play-hosted-game').addEventListener('click',async()=>{
  if(!activeCabinet?.hostedGame)return;
  const cabinet=activeCabinet;
  // Adapter choice depends on a loopback probe for the native runtime. Await
  // that one bounded decision before committing the session; otherwise a fast
  // click races the probe and sends even a PCSX2-equipped desktop to Play!.
  if((cabinet.system==='ps2'||cabinet.system==='gamecube')&&window.ARCADE_ENSURE_RUNTIME_DETECTION){
    await window.ARCADE_ENSURE_RUNTIME_DETECTION();
  }
  if(activeCabinet!==cabinet)return;
  const selectedAdapter=resolveEmulatorAdapter(cabinet);
  // A native runtime resolves its own verified on-disk image. Reading a second
  // browser cache first adds delay and memory pressure without supplying any
  // bytes the native emulator can use.
  const prepared=selectedAdapter?.id?.startsWith('ptc-runtime-')?null:await resolveCachedHostedGame(cabinet);
  if(activeCabinet!==cabinet)return;
  launchEmulator(prepared||cabinet.hostedGame);
});
ps2CacheButton.addEventListener('click',async()=>{const cabinet=activeCabinet;if(!CACHEABLE_SYSTEMS.has(cabinet?.system)||!cabinet.hostedGame||!ps2Cache?.supported||ps2CacheController)return;ps2CacheController=new AbortController();ps2CacheButton.disabled=true;try{await ps2Cache.download(ps2GameDescriptor(cabinet),cabinet.hostedGame,{signal:ps2CacheController.signal,onProgress:progress=>{if(activeCabinet===cabinet){const percent=Math.floor(progress*100);ps2CacheButton.textContent=`CACHING ${percent}%`;document.querySelector('#rom-name').textContent=`DOWNLOADING LOCAL COPY · ${percent}%`}}});if(activeCabinet===cabinet){ps2CacheButton.dataset.cached='true';ps2CacheButton.textContent='CACHED LOCALLY';document.querySelector('#rom-name').textContent='LOCAL COPY READY — FUTURE LAUNCHES WILL START FASTER'}}catch(error){if(error?.name!=='AbortError'&&activeCabinet===cabinet){ps2CacheButton.textContent='CACHE FAILED — RETRY';ps2CacheButton.disabled=false;document.querySelector('#rom-name').textContent=error.message.toUpperCase()}}finally{ps2CacheController=null}});
document.querySelector('#rom-file').addEventListener('change',e=>{const file=e.target.files[0];if(file&&resolveEmulatorAdapter(activeCabinet))launchEmulator(file);});
// Milestone 11.3: one message pump. Each backend's protocol lives in its own
// adapter, so adding a core never means editing this listener again.
addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==activeEmulatorFrame?.contentWindow)return;
  if(event.data?.type==='arcade:save-entitlement'){
    const controls=document.querySelector('#emulator-controls');
    if(controls)controls.textContent=event.data.allowed===true
      ?'CONTROLLER READY · WALLET SAVE / LOAD ENABLED · ESC EXIT'
      :'CONTROLLER READY · GUEST SESSION · SAVE / LOAD LOCKED · ESC EXIT';
    return;
  }
  const adapter=activeEmulatorAdapter;if(!adapter)return;
  const signal=adapter.interpretMessage(event.data);
  if(signal.kind==='ready'){
    if(signal.needsSource&&pendingEmulatorSource)activeEmulatorFrame.contentWindow?.postMessage(pendingEmulatorSource,location.origin);
    else clearTimeout(emulatorLoadTimer);
    return}
  // The frame has taken ownership of the download, so the load deadline that
  // guards a stalled boot no longer applies.
  if(signal.kind==='source-loading'){clearTimeout(emulatorLoadTimer);return}
  if(signal.kind==='source-accepted'){pendingEmulatorSource=null;clearTimeout(emulatorLoadTimer);return}
  if(signal.kind==='progress'){if(activeCabinet)document.querySelector('#rom-name').textContent=`DOWNLOADING GAME DATA · ${signal.percent}%`;return}
  if((signal.kind==='error'||signal.kind==='closed')&&activeCabinet){
    // The on-screen message stays short; the real cause goes to the console so
    // a blocked script can be told apart from a bad ROM.
    if(signal.detail)console.warn('[arcade] emulator failure:',signal.detail);
    clearTimeout(emulatorLoadTimer);closeMachine();showCabinetMessage(signal.message)}
});
function game(){if(!activeCabinet||!romLoaded)return;ctx.fillStyle='#02030a';ctx.fillRect(0,0,640,440);ctx.fillStyle='#85f9ff';stars.forEach(s=>{s.y+=s.s;if(s.y>440)s.y=0;ctx.fillRect(s.x,s.y,s.s,s.s)});if(keys.ArrowLeft)ship.x-=6;if(keys.ArrowRight)ship.x+=6;ship.x=Math.max(20,Math.min(620,ship.x));if(keys.Space&&ship.bullets.length<6)ship.bullets.push({x:ship.x,y:370});ship.bullets.forEach(b=>b.y-=10);ship.bullets=ship.bullets.filter(b=>b.y>0);ctx.fillStyle='#ff3cac';ctx.beginPath();ctx.moveTo(ship.x,350);ctx.lineTo(ship.x-18,392);ctx.lineTo(ship.x+18,392);ctx.fill();ctx.fillStyle='#fff6c7';ship.bullets.forEach(b=>ctx.fillRect(b.x-2,b.y,4,12));ctx.fillStyle='#36f9f6';ctx.font='13px monospace';ctx.textAlign='left';ctx.fillText('ROM SESSION // '+activeCabinet.name,20,28);ctx.fillText('SCORE '+String(Math.floor(performance.now()/30)%99999).padStart(5,'0'),20,48)}
function updateFollowCamera(){
  const followed=socialFollowProvider?.();
  if(followed){
    const heading=followed.rotation?.y||0;
    followOffset.set(0,2.3,4.8).applyAxisAngle(upAxis,heading);
    camera.position.lerp(cameraTarget.copy(followed.position).add(followOffset),.12);
    camera.lookAt(followed.position.x,followed.position.y+1,followed.position.z);
    return;
  }
  if(cameraMode==='first-person'){
    camera.position.copy(playerPosition);
    lookDirection.set(-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch));
    cameraTarget.copy(camera.position).add(lookDirection);
    camera.lookAt(cameraTarget);
    return;
  }
  // Match first-person mouse direction: moving the mouse upward should tilt
  // the view upward instead of lifting the chase camera and looking downward.
  followOffset.set(0,2.15-pitch*2.1,4.55).applyAxisAngle(upAxis,yaw);
  camera.position.copy(playerPosition).add(followOffset);
  cameraTarget.set(playerPosition.x,playerPosition.y+.78,playerPosition.z);
  camera.lookAt(cameraTarget);
}
let cabinetSnapshotReady=false,cabinetMessageUntil=0;
function showCabinetMessage(message){prompt.querySelector('b').textContent='CABINET';prompt.querySelector('span').textContent=message;prompt.classList.add('active');cabinetMessageUntil=performance.now()+2600}
// Read off the barriers themselves. Every sealed doorway has one, so a room
// added to the table above cannot arrive without its prompt.
function nearbyConstructionRoom(){
  for(const barrier of constructionBarriers){
    const dx=playerPosition.x-barrier.position.x,dz=playerPosition.z-barrier.position.z;
    if(dx*dx+dz*dz<6.25)return barrier.userData.roomName;
  }
  return null;
}
function updateConstructionPrompt(roomName){prompt.classList.add('active');prompt.querySelector('b').textContent='CAUTION';prompt.querySelector('span').textContent=`${roomName} Room Under Construction.`}
function setCabinetState(state){const cabinet=cabinetsById.get(state.cabinetId);if(!cabinet)return;if(!cabinet.enabled){cabinet.status='disabled';cabinet.occupiedByDisplayName=null;cabinet.statusLight.material.color.setHex(0x6c7896);cabinet.statusLight.material.emissive.setHex(0x26304a);return}cabinet.status=state.status;cabinet.occupiedByDisplayName=state.occupiedByDisplayName;const color=state.status==='available'?0x50ff9a:(state.status==='reserved'?0xffb42e:0xff3c76);cabinet.statusLight.material.color.setHex(color);cabinet.statusLight.material.emissive.setHex(color)}
function setCabinetStates(states,ready){cabinetSnapshotReady=ready;states.forEach(state=>setCabinetState(state));if(!ready)cabinets.forEach(c=>{c.status=c.enabled?'syncing':'disabled';c.occupiedByDisplayName=null;c.statusLight.material.color.setHex(0x6c7896);c.statusLight.material.emissive.setHex(c.enabled?0x6c7896:0x26304a)})}
function updateCabinetPrompt(){if(performance.now()<cabinetMessageUntil)return;if(!near){prompt.classList.remove('active');return}prompt.classList.add('active');const title=prompt.querySelector('b'),detail=prompt.querySelector('span');if(!near.enabled||near.status==='disabled'){if(near.disabledReason==='desktop-only'){title.textContent='GAMECUBE // DESKTOP ONLY';detail.textContent='ABOUT 1 GB PER GAME — OPEN ON A COMPUTER';return}
    if(near.system==='gamecube'){title.textContent='GAMECUBE // GECKO';detail.textContent='BOOT VALIDATION IN PROGRESS'}else if(near.system==='xbox'){title.textContent='XBOX DISPLAY';detail.textContent='AWAITING GAME SETUP'}else{title.textContent='PS2 DISPLAY';detail.textContent='BROWSER CORE REQUIRED'}return}if(!cabinetSnapshotReady){title.textContent='SYNCING';detail.textContent='CABINET STATUS';return}if(near.status==='available'){title.textContent=mobileInputAvailable()?'TAP USE':'PRESS E';detail.textContent='TO ENTER CABINET';return}title.textContent=near.status==='reserved'?'RESERVED':'IN USE';detail.textContent=near.occupiedByDisplayName?`BY ${near.occupiedByDisplayName}`:'PLEASE WAIT'}
function beginCabinetSession(cabinetId,alignment){const cabinet=cabinetsById.get(cabinetId);if(!cabinet||activeCabinet)return false;if(alignment?.position){playerPosition.set(...alignment.position);yaw=alignment.rotationY}openMachine(cabinet);return true}
function forceCloseCabinetSession(cabinetId){if(activeCabinet?.id===cabinetId)closeMachine(false)}
function resolvePartitionWallCollisions(previousX,previousZ){
  for(const wallX of [PLAYSTATION_WALL_X,N64_WALL_X]){
    // Both partition walls now run the full depth of the building: each side
    // has a rear gallery behind it, so neither wall stops at the back of the
    // playable rooms any more.
    // The wall runs the whole length of its column and no further: north of it
    // the hall is full width, which is what lets the top row's outer rooms open
    // onto the hall at all.
    if(playerPosition.z<SIDE_COLUMN_MIN_Z-PLAYER_COLLISION_RADIUS||playerPosition.z>SIDE_COLUMN_MAX_Z+PLAYER_COLLISION_RADIUS)continue;
    const crossedWall=(previousX-wallX)*(playerPosition.x-wallX)<=0&&previousX!==playerPosition.x;
    const crossing=(wallX-previousX)/(playerPosition.x-previousX);
    const crossingZ=crossedWall?previousZ+(playerPosition.z-previousZ)*crossing:playerPosition.z;
    if(OPEN_DOOR_Z.some(doorZ=>Math.abs(crossingZ-doorZ)<ROOM_DOOR_HALF_WIDTH-PLAYER_COLLISION_RADIUS))continue;
    const leftFace=wallX-PARTITION_WALL_HALF_THICKNESS-PLAYER_COLLISION_RADIUS;
    const rightFace=wallX+PARTITION_WALL_HALF_THICKNESS+PLAYER_COLLISION_RADIUS;
    if(previousX<wallX&&playerPosition.x>leftFace)playerPosition.x=leftFace;
    else if(previousX>=wallX&&playerPosition.x<rightFace)playerPosition.x=rightFace;
  }
}
/**
 * The walls between the rooms in a side column.
 *
 * There is no doorway anywhere along them — each room is entered from the hall
 * through the partition wall — so a player inside a column is held between the
 * two lines its room sits between.
 */
const SIDE_ROOM_DIVIDER_Z=[SIDE_COLUMN_MIN_Z,-ROOM_DEPTH,0,ROOM_DEPTH,SIDE_COLUMN_MAX_Z];
function resolveSocialLayoutCollisions(previousX,previousZ){
  if(Math.abs(playerPosition.x)<=Math.abs(PLAYSTATION_WALL_X)+PLAYER_COLLISION_RADIUS)return;
  for(const dividerZ of SIDE_ROOM_DIVIDER_Z){
    const northFace=dividerZ-PARTITION_WALL_HALF_THICKNESS-PLAYER_COLLISION_RADIUS;
    const southFace=dividerZ+PARTITION_WALL_HALF_THICKNESS+PLAYER_COLLISION_RADIUS;
    if(playerPosition.z<=northFace||playerPosition.z>=southFace)continue;
    if(previousZ<dividerZ)playerPosition.z=northFace;
    else playerPosition.z=southFace;
    return;
  }
}
// The wall that used to stand behind the hub is one of the column dividers
// now, and the rooms behind it are entered from the hall like every other room.
function resolveRearGalleryCollision(){}
/**
 * The top row: its front wall, with a doorway into each of its four rooms, and
 * the walls between them.
 *
 * The row used to be shut by the world bound half a metre in front of this
 * wall, so none of it needed collision. It is open now, and a wall nothing
 * enforces is a wall players walk through.
 */
function resolveTopRowCollisions(previousX,previousZ){
  const northFace=TOP_BAND_MIN_Z-PARTITION_WALL_HALF_THICKNESS-PLAYER_COLLISION_RADIUS;
  const southFace=TOP_BAND_MIN_Z+PARTITION_WALL_HALF_THICKNESS+PLAYER_COLLISION_RADIUS;
  if(playerPosition.z>northFace&&playerPosition.z<southFace
    &&!NORTH_ROOM_X.some(doorX=>Math.abs(playerPosition.x-doorX)<ROOM_DOOR_HALF_WIDTH-PLAYER_COLLISION_RADIUS)){
    if(previousZ<TOP_BAND_MIN_Z)playerPosition.z=northFace;else playerPosition.z=southFace;
    return;
  }
  if(playerPosition.z>=TOP_BAND_MIN_Z)return;
  for(const dividerX of NORTH_ROW_DIVIDER_X){
    const westFace=dividerX-PARTITION_WALL_HALF_THICKNESS-PLAYER_COLLISION_RADIUS;
    const eastFace=dividerX+PARTITION_WALL_HALF_THICKNESS+PLAYER_COLLISION_RADIUS;
    if(playerPosition.x<=westFace||playerPosition.x>=eastFace)continue;
    if(previousX<dividerX)playerPosition.x=westFace;else playerPosition.x=eastFace;
    return;
  }
}
let lastPrizeLedDraw=0;
const performanceStats=document.querySelector('#performance-stats');
let performanceWindowStart=performance.now(),performanceFrames=0,slowWindows=0,fastWindows=0,latestPerformance={fps:0,frameMs:0,quality:'WARMING'};
const getRendererStats=()=>{const memory=performance.memory;return{...latestPerformance,renderScale:currentPixelRatio,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,heapUsedMb:memory?Number((memory.usedJSHeapSize/1048576).toFixed(1)):null,heapLimitMb:memory?Number((memory.jsHeapSizeLimit/1048576).toFixed(1)):null}};
window.arcadeMultiplayer={scene,getCamera:()=>camera,getCanvas:()=>renderer.domElement,getLocalTransform:()=>({position:{x:playerPosition.x,y:playerPosition.y,z:playerPosition.z},rotationY:yaw}),getLocalAnimationState:()=>localAnimationState,isEmulatorActive:()=>emulatorRuntimeActive,isFirstPerson:()=>cameraMode==='first-person',getCameraMode:()=>cameraMode,isFollowingPlayer:()=>Boolean(socialFollowProvider),followPlayer:provider=>{socialFollowProvider=provider},clearPlayerFollow:()=>{socialFollowProvider=null},applyAuthoritativeTransform:({position,rotationY},strength=.12)=>{correctionTarget.set(position.x,position.y,position.z);playerPosition.lerp(correctionTarget,strength);const difference=Math.atan2(Math.sin(rotationY-yaw),Math.cos(rotationY-yaw));yaw+=difference*strength;},performanceProfile:{lowPower:lowPowerDevice,getRenderScale:()=>currentPixelRatio,getStats:getRendererStats},setCabinetState,setCabinetStates,showCabinetMessage,beginCabinetSession,forceCloseCabinetSession,onBeforeRender:callback=>{beforeRenderCallbacks.push(callback)}};
function updatePerformanceStats(now){performanceFrames++;const elapsed=now-performanceWindowStart;if(elapsed<1000)return;const fps=Math.round(performanceFrames*1000/elapsed),frameMs=Math.round(elapsed/performanceFrames),quality=currentPixelRatio<=pixelRatioFloor+.01?'LOW':currentPixelRatio<.9?'MED':'HIGH';latestPerformance={fps,frameMs,quality};if(performanceStats)performanceStats.textContent=`${fps} FPS · ${frameMs} MS · ${quality} · ${Math.round(currentPixelRatio*100)}%`;// This only ever went down.
//
// It dropped the scale on a single second under 48 fps — one hitch, a model
// finishing its load or a room's lights coming into range, was enough. It
// climbed back only after ten consecutive seconds over 57, and any second in
// the 48-57 band reset both counters to zero. A phone locked at 60 spends much
// of its time in that band on vsync jitter alone, so the climb never completed
// and the scale ratcheted to the floor and stayed there.
//
// Now: two slow seconds to drop, three to climb, and the band between them
// decays the counters instead of clearing them, so jitter no longer erases the
// evidence that the device is coping.
if(fps<44){slowWindows+=fps<30?2:1;fastWindows=0}
else if(fps>=54){fastWindows++;slowWindows=0}
else{slowWindows=Math.max(0,slowWindows-1);fastWindows=Math.max(0,fastWindows-1)}
if(slowWindows>=2&&currentPixelRatio>pixelRatioFloor){
  currentPixelRatio=Math.max(pixelRatioFloor,currentPixelRatio-(fps<30?.15:.08));
  renderer.setPixelRatio(currentPixelRatio);slowWindows=0;fastWindows=0;
}else if(fastWindows>=3&&currentPixelRatio<renderScaleCeiling()){
  currentPixelRatio=Math.min(renderScaleCeiling(),currentPixelRatio+.08);
  renderer.setPixelRatio(currentPixelRatio);fastWindows=0;
}performanceWindowStart=now;performanceFrames=0;}
// Callbacks that must run after movement is resolved but before the draw call.
// Anything positioning a scene object from playerPosition belongs here: run
// from its own requestAnimationFrame it would land a frame late and stutter.
function tick(){requestAnimationFrame(tick);const d=Math.min(clock.getDelta(),.05);if(emulatorRuntimeActive)return;const now=performance.now();const gamepadActive=pollArcadeGamepad(d);updatePerformanceStats(now);updateNearbyLights(now);animatedMixers.forEach(mixer=>mixer.update(d));if(now-lastPrizeLedDraw>=200&&playerPosition.distanceToSquared(prizeDisplay.position)<400){drawPrizeLed(now);lastPrizeLedDraw=now}loadNearbySceneModels(now);const controlsActive=locked||mobileInputAvailable()&&start.style.display==='none'&&!activeCabinet||gamepadActive&&!activeCabinet;if(controlsActive){movementVector.set((keys.KeyD?1:0)-(keys.KeyA?1:0)+mobileMove.x+gamepadMove.x,0,(keys.KeyS?1:0)-(keys.KeyW?1:0)+mobileMove.y+gamepadMove.y);localAnimationState=movementVector.lengthSq()?'walk':'idle';if(movementVector.lengthSq()){const analogSpeed=Math.min(1,movementVector.length());movementVector.normalize().multiplyScalar(d*5*analogSpeed).applyAxisAngle(upAxis,yaw);const previousX=playerPosition.x,previousZ=playerPosition.z;playerPosition.add(movementVector);resolvePartitionWallCollisions(previousX,previousZ);resolveSocialLayoutCollisions(previousX,previousZ);resolveStatueCollisions(previousX,previousZ);resolveRearGalleryCollision();resolveTopRowCollisions(previousX,previousZ);clampToWorld()}const planarReachSq=CABINET_PROMPT_RANGE*CABINET_PROMPT_RANGE-playerPosition.y*playerPosition.y;near=planarReachSq>0?(window.ARCADE_CABINET_SPATIAL_INDEX?.nearest(playerPosition.x,playerPosition.z,Math.sqrt(planarReachSq))?.payload??null):null;warmEmulatorCore(near);const constructionRoom=nearbyConstructionRoom();if(constructionRoom)updateConstructionPrompt(constructionRoom);else updateCabinetPrompt()}else{localAnimationState=activeCabinet?'interact':'idle';if(now>=cabinetMessageUntil)prompt.classList.remove('active')}updateFollowCamera();game();for(const callback of beforeRenderCallbacks)callback(now,d);renderer.render(scene,camera)}tick();
document.addEventListener('visibilitychange',()=>{performanceWindowStart=performance.now();performanceFrames=0;slowWindows=0;fastWindows=0});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);currentPixelRatio=Math.min(currentPixelRatio,renderScaleCeiling());renderer.setPixelRatio(currentPixelRatio)});
