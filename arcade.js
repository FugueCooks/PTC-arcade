import { GAMEPAD_AXES, GAMEPAD_BUTTONS, buttonPressed, DEFAULT_DEAD_ZONE as GAMEPAD_DEAD_ZONE, gamepadHasActivity, pickGamepad, readDpad, readStick } from './emulators/gamepad-mapping.js?v=poke-7';
const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x090611, .016);
const camera = new THREE.PerspectiveCamera(72, innerWidth/innerHeight, .1, 180);
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
// Silent Hill fills the top row's west corner, doubled sideways: its annex is
// bolted onto the OUTSIDE of the building's west wall, over ground nothing
// else uses. The walkable floor is the main rectangle plus this one, clamped
// against whichever rectangle the step began in.
const SILENT_HILL_EXPANSE={minX:-64.3,maxX:-42.7,minZ:-66.7,maxZ:-42.5};
// The arena hangs in the void north of the building, reached only through
// the vomitory: its region spans the globe, and the tunnel walls plus the
// bowl's own ellipse do the actual shepherding inside it.
const POKEMON_EXPANSE={minX:-12,maxX:66,minZ:-138.6,maxZ:-42.5};
// The Chao Garden meadow spills out of the building's east wall the way
// Silent Hill leaves the west one: its ground continues outside the shell,
// and the cliff-edge ellipse does the actual shepherding on it.
const CHAO_EXPANSE={minX:42.7,maxX:102.5,minZ:3,maxZ:64.5};
const WORLD_REGIONS=[WORLD_BOUNDS,SILENT_HILL_EXPANSE,POKEMON_EXPANSE,CHAO_EXPANSE];
function insideRegion(region,x,z){return x>=region.minX&&x<=region.maxX&&z>=region.minZ&&z<=region.maxZ}
function clampToWorld(previousX,previousZ){
  const region=WORLD_REGIONS.find(candidate=>insideRegion(candidate,previousX,previousZ))??WORLD_BOUNDS;
  if(WORLD_REGIONS.some(candidate=>insideRegion(candidate,playerPosition.x,playerPosition.z)))return;
  playerPosition.x=Math.max(region.minX,Math.min(region.maxX,playerPosition.x));
  playerPosition.z=Math.max(region.minZ,Math.min(region.maxZ,playerPosition.z));
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
// The base wash the whole building sits in. The old values left everything
// outside a managed light's radius near-black; this is a soft violet sky over
// a warm floor bounce plus a low lavender ambient — colour without glare, and
// none of it counts against the per-frame light budget.
scene.add(new THREE.HemisphereLight(0x6a5fc9,0x2a1e14,1.55));
scene.add(new THREE.AmbientLight(0x8a7fb8,.4));
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
// One world-aligned tile grid across every open floor plate. Each plate used
// to stretch the same 7x8.5 repeat over its own size, so the grid jumped
// pitch and phase at every seam; repeat and offset now derive from where the
// plate stands in the world, with the hall floor as the phase reference.
const FLOOR_PITCH_X=43.2/7,FLOOR_PITCH_Z=67.2/8.5;
const HALL_FLOOR_STYLE={emissive:0x10091c,emissiveIntensity:.42,roughness:.66,metalness:.14};
const EXPANSION_FLOOR_STYLE={color:0x8fa8d8,emissive:0x0b1324,emissiveIntensity:.38,roughness:.7,metalness:.12};
function worldAlignedFloorMaterial(width,depth,centerX,centerZ,style){
  const map=floorTextures.map.clone(),roughnessMap=floorTextures.roughnessMap.clone();
  map.needsUpdate=roughnessMap.needsUpdate=true;
  for(const texture of [map,roughnessMap]){
    texture.repeat.set(width/FLOOR_PITCH_X,depth/FLOOR_PITCH_Z);
    texture.offset.set((centerX-width/2+21.6)/FLOOR_PITCH_X%1,(33.6-centerZ-depth/2)/FLOOR_PITCH_Z%1);
  }
  return new THREE.MeshStandardMaterial({map,roughnessMap,...style});
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(43.2,67.2),hallFloorMaterial);floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
const topBandFloor = new THREE.Mesh(new THREE.PlaneGeometry(86.4,16.8),worldAlignedFloorMaterial(86.4,16.8,0,-42,HALL_FLOOR_STYLE));topBandFloor.rotation.x=-Math.PI/2;topBandFloor.position.set(0,0,-42);topBandFloor.receiveShadow=true;scene.add(topBandFloor);
function box(w,h,d,color,x,y,z,emissive=0){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:emissive,roughness:.43,metalness:.65}));m.position.set(x,y,z);m.castShadow=true;scene.add(m);return m}
// Tokyo-noir ceiling. A real ceiling plane closes off what used to be an open
// black void, and the full-width cyan light bars are replaced by short recessed
// troffers, so the room reads as a low-lit game centre rather than an arena.
// Every fixture here is emissive geometry only: none of it adds a real light,
// so the ceiling costs nothing against the per-frame light budget.
// One plane with a rectangular hole over the Pokemon stadium: its dome rises
// well past the building's ceiling height, and a lid across the room would cut
// the dome off at the knees. The plane is rotated +x, so local y maps to world
// z plus the plane's own offset.
const ceilingShape=new THREE.Shape();
ceilingShape.moveTo(-43.2,-58.8);ceilingShape.lineTo(43.2,-58.8);ceilingShape.lineTo(43.2,58.8);ceilingShape.lineTo(-43.2,58.8);ceilingShape.closePath();
// No stadium hole any more: the arena left the building for the void past
// the north wall, and the room it left is the concourse, roofed like any
// other room.
// And a second over the Chao Garden, whose sky dome also rises past the
// building's ceiling. Local y is world z plus the plane's offset, as above.
// The garden moved a room north, and the Pokemon Center that took its old
// room fits under the ceiling, so the hole moved with the sky.
// The old garden room is the tunnel's dark now: its ceiling hole is gone.
// The third hole is Silent Hill's: its facades rise past the ceiling and its
// sky is the dark the fog fades into. The block mirrors the stadium in the
// top row's west corner, so its hole mirrors the stadium's.
const silentHillHole=new THREE.Path();
silentHillHole.moveTo(-43.2,-58.8);silentHillHole.lineTo(-21.6,-58.8);silentHillHole.lineTo(-21.6,-33.6);silentHillHole.lineTo(-43.2,-33.6);silentHillHole.closePath();
ceilingShape.holes.push(silentHillHole);
const ceiling=new THREE.Mesh(new THREE.ShapeGeometry(ceilingShape),new THREE.MeshStandardMaterial({color:0x0c0a15,roughness:.95,metalness:.06,side:THREE.DoubleSide}));
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
// The ceiling beams stop where the carved-out rooms begin: a beam crossing
// the Chao Garden hung in its sky as a floating black slab. West of the
// garden the run is unchanged; the beams never reached Silent Hill or the
// stadium.
for(let z=-15;z<=15;z+=5)box(z<-12?49.6:56,.26,.34,0x14111f,z<-12?-3.2:0,4.9,z,.04);
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
// The two partition walls no longer mirror each other. The garden's growth
// pushed the whole east column south: Metroid and the room after it keep full
// depth and the unbuilt room at the bottom absorbs the squeeze, so every door
// on that side moved to its room's new centre.
const OPEN_DOOR_Z_WEST=[-25.2,-8,8,25.2];
const OPEN_DOOR_Z_EAST=[-25.2,-3.6,13.2,27.6];
const EAST_ROOM_Z=[-22.8,-3.6,13.2,27.6];
const EAST_WALL_Z={'-16.8':-12,'0':4.8,'16.8':21.6};
const SIDE_COLUMN_MIN_Z=-33.6,SIDE_COLUMN_MAX_Z=33.6;
const TOP_BAND_MIN_Z=-50.4,NORTH_ROW_MIN_Z=-67.2;
// One room remains in the top row's middle; each end of the row, plus the
// same bite of the band below it, is a corner block — the Pokemon stadium at
// 1.5x in the east, the Silent Hill fog in the west.
const NORTH_ROOM_X=[-10.8];
const POKEMON_WEST_X=10.8,POKEMON_SOUTH_Z=-42,POKEMON_DOOR_X=27;
const SILENT_EAST_X=-21.6,SILENT_SOUTH_Z=-42,SILENT_DOOR_X=-32.4,SILENT_WEST_X=-64.8;
const POKEMON_CENTER_X=27,POKEMON_CENTER_Z=-54.6;
const TOURNAMENT_MIN_Z=SIDE_COLUMN_MAX_Z,TOURNAMENT_MAX_Z=50.4;
const MEGAMAN_ROOM_WEST_X=-SHELL_HALF_WIDTH,MEGAMAN_ROOM_CENTER_X=-ANNEX_ROOM_CENTER_X,MEGAMAN_ROOM_CENTER_Z=8.4,MEGAMAN_ROOM_WIDTH=ROOM_SPAN,MEGAMAN_ROOM_DEPTH=ROOM_DEPTH,MEGAMAN_ROOM_DOOR_Z=8;
// The outer wall runs the whole depth of the building on both sides.
const SHELL_DEPTH=TOURNAMENT_MAX_Z-NORTH_ROW_MIN_Z,SHELL_CENTER_Z=(TOURNAMENT_MAX_Z+NORTH_ROW_MIN_Z)/2;
// The west shell opens where Silent Hill spills out of the building; the
// wall resumes at the fog's south line and runs to the back of the building.
box(.3,5,92.4,0x180d31,-SHELL_HALF_WIDTH,2.5,4.2);
box(.3,5,78.4,0x180d31,SHELL_HALF_WIDTH,2.5,-28);
box(.3,5,35.2,0x180d31,SHELL_HALF_WIDTH,2.5,32.8);
// The north wall runs on across the annex, which closes its own west and
// south sides.
// The north wall parts where the stadium concourse runs out to the globe.
box(90.1,5,.3,0x180d31,-19.75,2.5,NORTH_ROW_MIN_Z);
box(14.5,5,.3,0x180d31,35.95,2.5,NORTH_ROW_MIN_Z);
box(.3,5,25.2,0x180d31,SILENT_WEST_X,2.5,-54.6);
box(21.6,5,.3,0x180d31,-54,2.5,SILENT_SOUTH_Z);
box(SHELL_HALF_WIDTH*2,5,.3,0x180d31,0,2.5,TOURNAMENT_MAX_Z);
// The wall the prize counter stands against: the top row's front wall, with a
// doorway into each of its four rooms. The panelled centre span is the backdrop
// behind the counter, which is why it is the one segment kept decorative.
const rearPanelMaterial=new THREE.MeshStandardMaterial({color:0x17233a,emissive:0x08162b,emissiveIntensity:.5,roughness:.58,metalness:.38});
const rearWall=box(18.4,5,.3,0x15182a,0,2.5,TOP_BAND_MIN_Z,.18);rearWall.receiveShadow=true;
for(let x=-8;x<=8;x+=4){const panel=new THREE.Mesh(new THREE.BoxGeometry(3.82,4.62,.055),rearPanelMaterial);panel.position.set(x,2.42,TOP_BAND_MIN_Z+.18);panel.receiveShadow=true;scene.add(panel)}
box(18,.09,.08,0xd18a52,0,4.78,TOP_BAND_MIN_Z+.23,.85);box(18,.12,.08,0x251447,0,.1,TOP_BAND_MIN_Z+.23,.55);
// The front wall now ends where the Pokemon room begins; the short closer
// covers the strip between the counter backdrop and the stadium's west wall.
for(const [centerX,width] of [[-17,9.2],[10,1.6]])box(width,5,.3,0x15182a,centerX,2.5,TOP_BAND_MIN_Z,.18);
const NORTH_ROW_DIVIDER_X=[-HALL_HALF_WIDTH];
for(const dividerX of NORTH_ROW_DIVIDER_X)box(.3,5,25.2,0x11182c,dividerX,2.5,-54.6,.06);
// Silent Hill's own shell, mirroring the stadium's: a south wall into the
// band with the entrance doorway at its centre.
box(9.2,5,.3,0x11182c,-38.6,2.5,SILENT_SOUTH_Z,.06);
box(9.2,5,.3,0x11182c,-26.2,2.5,SILENT_SOUTH_Z,.06);
// The old stadium room opened up when the arena left for the void: its west
// wall is gone, so the concourse room reads as part of the band, with the
// lit tube running through the dark. The south wall still holds the line.
box(14.6,5,.3,0x11182c,18.1,2.5,POKEMON_SOUTH_Z,.06);
box(14.6,5,.3,0x11182c,35.9,2.5,POKEMON_SOUTH_Z,.06);
const gangsterPepeMount=new THREE.Group();
const gangsterPepeLight=new THREE.PointLight(0xb9f5ff,3,3.5,2);
const PLAYSTATION_WALL_X=-HALL_HALF_WIDTH,N64_WALL_X=HALL_HALF_WIDTH,PARTITION_WALL_HALF_THICKNESS=.18,PLAYABLE_ROOM_DOOR_Z=-8,CONSTRUCTION_ROOM_DOOR_Z=8,PS2_ROOM_CENTER_X=-ANNEX_ROOM_CENTER_X,PS2_ROOM_CENTER_Z=-25.2,PS2_ROOM_DOOR_Z=-16.8,PS2_ROOM_BACK_Z=-33.6,ROOM_DOOR_HALF_WIDTH=1.6,PLAYER_COLLISION_RADIUS=.34;
const PARTITION_WALL_SEGMENTS_WEST=[[-30.2,6.8],[-16.6,14],[0,12.8],[16.6,14],[30.2,6.8]];
// The first east segment is gone: the Pokemon Center fronts the hall through
// where it stood, one wide opening with the old plaza doorway.
const PARTITION_WALL_SEGMENTS_EAST=[[-8.6,6.8],[4.8,13.6],[20.4,11.2],[31.4,4.4]];
function buildPartitionWall(wallX,accent,segments){
  for(const [centerZ,depth] of segments){
    const wall=box(PARTITION_WALL_HALF_THICKNESS*2,5,depth,0x111425,wallX,2.5,centerZ,.08);wall.receiveShadow=true;
    box(.42,.08,depth,accent,wallX,4.86,centerZ,.9);box(.42,.1,depth,0x251447,wallX,.08,centerZ,.45);
  }
}
// The console logos that hung on the two divider walls are gone: the rooms are
// being re-themed by title rather than by machine, so a PlayStation mark on the
// wall of a room that no longer holds PlayStation games named the wrong thing.
buildPartitionWall(PLAYSTATION_WALL_X,0xd18a52,PARTITION_WALL_SEGMENTS_WEST);
buildPartitionWall(N64_WALL_X,0x36f9f6,PARTITION_WALL_SEGMENTS_EAST);
/**
 * Solana atmosphere for the shared hub.
 *
 * The signs are generated locally rather than downloaded, so they appear with
 * the room itself and add no asset request. Their broad glow is additive
 * geometry; the small wall washes below join the existing managed-light pool
 * and are capped at one live Solana light near the player.
 */
const SOLANA_PALETTE=Object.freeze([0x14f195,0x20d9ff,0x9945ff]);
const solanaAtmosphere=new THREE.Group();solanaAtmosphere.name='solana-atmosphere';scene.add(solanaAtmosphere);
function createSolanaSignTexture(){
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=256;
  const context=canvas.getContext('2d');
  const background=context.createLinearGradient(0,0,1024,256);
  background.addColorStop(0,'#05070d');background.addColorStop(.52,'#0b1121');background.addColorStop(1,'#090614');
  context.fillStyle=background;context.fillRect(0,0,1024,256);
  context.strokeStyle='rgba(128,236,255,.24)';context.lineWidth=2;context.strokeRect(9,9,1006,238);
  for(let y=14;y<256;y+=8){context.fillStyle='rgba(255,255,255,.018)';context.fillRect(0,y,1024,2)}
  const ribbon=context.createLinearGradient(362,0,642,0);
  ribbon.addColorStop(0,'#14f195');ribbon.addColorStop(.48,'#20d9ff');ribbon.addColorStop(1,'#9945ff');
  const stripe=(y,reverse=false)=>{
    const left=reverse?392:362,right=reverse?612:642,slant=34;
    context.beginPath();context.moveTo(left+slant,y);context.lineTo(right,y);context.lineTo(right-slant,y+42);context.lineTo(left,y+42);context.closePath();
    context.shadowColor=reverse?'#9945ff':'#14f195';context.shadowBlur=18;context.fillStyle=ribbon;context.fill();context.shadowBlur=0;
  };
  // Just the mark: three slanted bars, centred. No wordmark, no tagline.
  stripe(48);stripe(107,true);stripe(166);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=Math.min(4,renderer.capabilities.getMaxAnisotropy());return texture;
}
const solanaSignTexture=createSolanaSignTexture();
const solanaSignBackingMaterial=new THREE.MeshStandardMaterial({color:0x04060c,emissive:0x070b16,emissiveIntensity:.5,metalness:.82,roughness:.2});
const solanaSignFaceMaterial=new THREE.MeshBasicMaterial({map:solanaSignTexture,side:THREE.FrontSide});
function addSolanaNeonSign({x,y,z,rotationY,width=5.8,height=1.45}){
  const sign=new THREE.Group();sign.name='solana-neon-sign';sign.position.set(x,y,z);sign.rotation.y=rotationY;sign.userData.solanaNeon=true;
  const backing=new THREE.Mesh(new THREE.BoxGeometry(width+.24,height+.22,.12),solanaSignBackingMaterial);sign.add(backing);
  const face=new THREE.Mesh(new THREE.PlaneGeometry(width,height),solanaSignFaceMaterial);face.position.z=.066;sign.add(face);
  const glow=new THREE.Mesh(new THREE.PlaneGeometry(width*1.12,height*1.3),new THREE.MeshBasicMaterial({map:solanaSignTexture,color:0xa5ffe3,transparent:true,opacity:.18,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.FrontSide}));
  glow.position.z=.075;sign.add(glow);
  solanaAtmosphere.add(sign);return sign;
}
addSolanaNeonSign({x:PLAYSTATION_WALL_X+.205,y:3.7,z:-16.6,rotationY:Math.PI/2,width:5.2,height:1.25});
addSolanaNeonSign({x:N64_WALL_X-.205,y:3.7,z:20.4,rotationY:-Math.PI/2,width:5.2,height:1.25});
const solanaWestWash=point(SOLANA_PALETTE[0],-18.8,2.8,-16.6,3.15);solanaWestWash.userData.solanaLight=true;
const solanaEastWash=point(SOLANA_PALETTE[2],18.8,2.8,20.4,3.15);solanaEastWash.userData.solanaLight=true;
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
  const liningMaxZ=wallX<0?-1.7:1.8,seamMaxZ=wallX<0?-3.4:3.5,trimLength=wallX<0?16.8:18.4,trimZ=wallX<0?-8.4:-4.5;
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
// Metroid moved south with the garden's growth and keeps its full depth; its
// murals re-hang on the room's actual walls, which is what went missing when
// the divider moved out from under them.
themeRoom({
  centerX:ANNEX_ROOM_CENTER_X,centerZ:-3.6,
  far:'metroid-room-mural.webp?v=metroid-1',
  near:'metroid-room-mural-3.webp?v=metroid-1',
  side:'metroid-room-mural-2.webp?v=metroid-1'
});
/**
 * The Pokemon room is the inside of the stadium rather than a room with
 * stadium pictures in it.
 *
 * Its three walls carry the bowl — the jumbotron end, the far tiers, the long
 * side — and this is everything below them: the field the player is standing
 * on, the barrier that separates it from the stands, and the floodlight banks
 * that light it. The field is drawn rather than loaded, so it costs one canvas
 * and no download.
 */
function pokemonFieldTexture(){
  const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=840;
  const c=canvas.getContext('2d');
  // The armored platform the field sits on: grey deck plates in a panel grid,
  // red service segments, bolt heads — the stage, not a lawn.
  c.fillStyle='#7b8290';c.fillRect(0,0,1080,840);
  c.strokeStyle='#4f545f';c.lineWidth=6;
  for(let x=0;x<=1080;x+=135){c.beginPath();c.moveTo(x,0);c.lineTo(x,840);c.stroke()}
  for(let y=0;y<=840;y+=140){c.beginPath();c.moveTo(0,y);c.lineTo(1080,y);c.stroke()}
  c.fillStyle='#a72e2e';
  for(const [x,y,w,h] of [[30,30,150,40],[900,30,150,40],[30,770,150,40],[900,770,150,40],[500,18,80,26],[500,796,80,26],[16,390,26,60],[1038,390,26,60]])c.fillRect(x,y,w,h);
  c.fillStyle='#3d424c';
  for(let i=0;i<40;i++){c.beginPath();c.arc(40+(i*167)%1000,44+(i*211)%752,7,0,Math.PI*2);c.fill()}
  // The field: bright green, cornered like the stage, mown in wide bands.
  const inset=96,cut=150;
  const tracePlate=()=>{
    c.beginPath();
    c.moveTo(inset+cut,inset);c.lineTo(1080-inset-cut,inset);c.lineTo(1080-inset,inset+cut);
    c.lineTo(1080-inset,840-inset-cut);c.lineTo(1080-inset-cut,840-inset);c.lineTo(inset+cut,840-inset);
    c.lineTo(inset,840-inset-cut);c.lineTo(inset,inset+cut);c.closePath();
  };
  tracePlate();c.save();c.clip();
  c.fillStyle='#59bd4a';c.fillRect(0,0,1080,840);
  for(let x=0;x<1080;x+=120){if((x/120)%2){c.fillStyle='#63c953';c.fillRect(x,0,120,840)}}
  // The dark wedges either side of centre, and the yellow guides at their backs.
  c.fillStyle='#2f7d34';
  c.beginPath();c.moveTo(250,330);c.lineTo(250,510);c.lineTo(360,420);c.closePath();c.fill();
  c.beginPath();c.moveTo(830,330);c.lineTo(830,510);c.lineTo(720,420);c.closePath();c.fill();
  c.fillStyle='#ffd23e';
  for(const [ax,ay,dx] of [[205,420,-1],[875,420,1]]){
    c.beginPath();c.moveTo(ax,ay-26);c.lineTo(ax,ay+26);c.lineTo(ax+dx*40,ay);c.closePath();c.fill();
  }
  c.restore();
  tracePlate();c.strokeStyle='#e8eef2';c.lineWidth=8;c.lineJoin='round';c.stroke();
  // The ball at centre, in the toy's own colours, as the stage paints it.
  const cx=540,cy=420,r=150;
  c.fillStyle='#e23d3d';c.beginPath();c.arc(cx,cy,r,Math.PI,0);c.closePath();c.fill();
  c.fillStyle='#f4f6f8';c.beginPath();c.arc(cx,cy,r,0,Math.PI);c.closePath();c.fill();
  c.fillStyle='#16181d';c.fillRect(cx-r,cy-11,r*2,22);
  c.beginPath();c.arc(cx,cy,44,0,Math.PI*2);c.fill();
  c.fillStyle='#f4f6f8';c.beginPath();c.arc(cx,cy,30,0,Math.PI*2);c.fill();
  c.strokeStyle='#16181d';c.lineWidth=8;c.beginPath();c.arc(cx,cy,r,0,Math.PI*2);c.stroke();
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  // The plane maps canvas x down the room rather than across it; a quarter
  // turn puts the ball band, the wedges and the mowing the way the stage
  // has them.
  texture.center.set(.5,.5);texture.rotation=-Math.PI/2;
  return texture;
}
/**
 * The stands as a bowl rather than four flat walls.
 *
 * One elliptical band carries the whole panorama — jumbotron end, one long
 * side, the opposite tiers, the long side mirrored so the loop closes — and a
 * shallow dome caps it, so looking around or up never finds a corner. A real
 * stadium has no corners, and the corners were what kept this reading as a
 * decorated room.
 *
 * The band's ellipse touches the room's walls at their midpoints and pulls
 * inside them toward the corners. There is deliberately no collision on it:
 * its radii leave every doorway usable, and a player who walks behind it in a
 * corner sees the mirrored outside of the bowl, not a void, because the band
 * is double-sided.
 */
function buildPokemonStadium(centerX,arenaCz){
  /**
   * Tripled, the arena no longer fits in the building: the globe hangs in the
   * void north of it, and the vomitory is a real concourse — from the Pokemon
   * Center's back doorway, up the length of the old stadium room, out through
   * the building's north wall, and into the mouth of the sphere. The tunnel
   * stays at player scale; everything inside the globe is built at the old
   * scale in a group and scaled three times, so the whole stage grows
   * together, exactly as drawn.
   */
  const tunnelMaterial=new THREE.MeshStandardMaterial({color:0x141b29,emissive:0x0c1322,emissiveIntensity:.55,roughness:.7,metalness:.25,side:THREE.DoubleSide});
  const tunnelTrim=new THREE.MeshStandardMaterial({color:0x4fd9ff,emissive:0x4fd9ff,emissiveIntensity:1.2,metalness:.4,roughness:.3});
  const TUNNEL_HALF_W=1.7;
  const TUNNEL_MOUTH_Z=-42.0;
  const TUNNEL_EXIT_Z=-88;
  const TUNNEL_LENGTH=TUNNEL_MOUTH_Z-TUNNEL_EXIT_Z,tunnelZ=(TUNNEL_MOUTH_Z+TUNNEL_EXIT_Z)/2;
  for(const side of [-1,1]){
    const wall=new THREE.Mesh(new THREE.BoxGeometry(.24,2.7,TUNNEL_LENGTH),tunnelMaterial);
    wall.position.set(centerX+side*TUNNEL_HALF_W,1.35,tunnelZ);scene.add(wall);
    // A lit handrail line down each wall, the strip every stadium tunnel has.
    const rail=new THREE.Mesh(new THREE.BoxGeometry(.05,.07,TUNNEL_LENGTH-.4),tunnelTrim);
    rail.position.set(centerX+side*(TUNNEL_HALF_W-.14),1.05,tunnelZ);scene.add(rail);
  }
  const roof=new THREE.Mesh(new THREE.BoxGeometry(TUNNEL_HALF_W*2+.48,.24,TUNNEL_LENGTH),tunnelMaterial);
  roof.position.set(centerX,2.82,tunnelZ);scene.add(roof);
  // Its own floor: past the building the concourse is a gangway over the
  // void, and it lands on the floating platform itself.
  const deckCanvas=document.createElement('canvas');deckCanvas.width=128;deckCanvas.height=128;
  const dk=deckCanvas.getContext('2d');
  dk.fillStyle='#12161f';dk.fillRect(0,0,128,128);
  for(let y=6;y<128;y+=16){dk.fillStyle='#1a2030';dk.fillRect(0,y,128,5)}
  dk.fillStyle='#233044';dk.fillRect(60,0,8,128);
  const deckTexture=new THREE.CanvasTexture(deckCanvas);deckTexture.colorSpace=THREE.SRGBColorSpace;
  deckTexture.wrapT=THREE.RepeatWrapping;deckTexture.repeat.set(1,Math.round(TUNNEL_LENGTH/2.6));
  const gangway=new THREE.Mesh(new THREE.BoxGeometry(TUNNEL_HALF_W*2+.48,.2,TUNNEL_LENGTH),
    new THREE.MeshStandardMaterial({map:deckTexture,roughness:.6,metalness:.3}));
  gangway.position.set(centerX,-.1,tunnelZ);scene.add(gangway);
  // Recessed ceiling panels down the run, so the long walk reads lit from
  // inside and the far end glows before the bowl opens.
  const tunnelPanelMaterial=new THREE.MeshBasicMaterial({color:0x9db8cc});
  for(let z=TUNNEL_EXIT_Z+1;z<TUNNEL_MOUTH_Z-1;z+=1.9){
    const panel=new THREE.Mesh(new THREE.PlaneGeometry(.8,.3),tunnelPanelMaterial);
    panel.rotation.x=Math.PI/2;panel.position.set(centerX,2.79,z);scene.add(panel);
  }
  // Structural ribs down the run, a second accent line above the handrail,
  // and a treadplate deck: the bare tube read as unfinished, and a player is
  // inside it for forty metres now.
  const ribMaterial=new THREE.MeshStandardMaterial({color:0x141b2c,emissive:0x0b1424,emissiveIntensity:.5,metalness:.6,roughness:.4});
  for(let z=TUNNEL_EXIT_Z+2.6;z<TUNNEL_MOUTH_Z-1.4;z+=4.6){
    for(const side of [-1,1]){
      const post=new THREE.Mesh(new THREE.BoxGeometry(.18,2.62,.34),ribMaterial);
      post.position.set(centerX+side*(TUNNEL_HALF_W-.09),1.31,z);scene.add(post);
    }
    const lintel=new THREE.Mesh(new THREE.BoxGeometry(TUNNEL_HALF_W*2,.2,.34),ribMaterial);
    lintel.position.set(centerX,2.6,z);scene.add(lintel);
  }
  for(const side of [-1,1]){
    const accent=new THREE.Mesh(new THREE.BoxGeometry(.03,.05,TUNNEL_LENGTH-.4),
      new THREE.MeshStandardMaterial({color:0xbfd9e8,emissive:0x9db8cc,emissiveIntensity:.5,metalness:.3,roughness:.4}));
    accent.position.set(centerX+side*(TUNNEL_HALF_W-.13),2.28,tunnelZ);scene.add(accent);
  }
  const guideMaterial=new THREE.MeshBasicMaterial({color:0x8ff0ff,transparent:true,opacity:.4,depthWrite:false,blending:THREE.AdditiveBlending});
  for(const side of [-1,1]){
    const guide=new THREE.Mesh(new THREE.PlaneGeometry(.09,TUNNEL_LENGTH+1.6),guideMaterial);
    guide.rotation.x=-Math.PI/2;guide.position.set(centerX+side*1.15,.028,tunnelZ-.5);scene.add(guide);
  }
  // The portal at the Pokemon Center end: pylons and a header, the gate seen
  // through the doorway where the wall map hung.
  const portalMaterial=new THREE.MeshStandardMaterial({color:0x121a2a,emissive:0x0d1f38,emissiveIntensity:.55,metalness:.6,roughness:.35});
  for(const side of [-1,1]){
    const pylon=new THREE.Mesh(new THREE.BoxGeometry(.55,3.4,.55),portalMaterial);
    pylon.position.set(centerX+side*(TUNNEL_HALF_W+.45),1.7,TUNNEL_MOUTH_Z);scene.add(pylon);
    const cap=new THREE.Mesh(new THREE.BoxGeometry(.55,.12,.55),tunnelTrim);
    cap.position.set(centerX+side*(TUNNEL_HALF_W+.45),3.46,TUNNEL_MOUTH_Z);scene.add(cap);
  }
  const header=new THREE.Mesh(new THREE.BoxGeometry(TUNNEL_HALF_W*2+1.45,.55,.55),portalMaterial);
  header.position.set(centerX,3.15,TUNNEL_MOUTH_Z);scene.add(header);
  const headerTrim=new THREE.Mesh(new THREE.BoxGeometry(TUNNEL_HALF_W*2+1.3,.09,.12),tunnelTrim);
  headerTrim.position.set(centerX,2.85,TUNNEL_MOUTH_Z-.24);scene.add(headerTrim);

  // ---- the arena, built at the old scale and grown whole ----
  const arena=new THREE.Group();
  arena.position.set(centerX,0,arenaCz);
  arena.scale.setScalar(3);
  scene.add(arena);
  const RX=15.75,RZ=12.15,SPHERE_RY=8,SPHERE_CY=4.2;
  const sphereTexture=(()=>{
    const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=1024;
    const c=canvas.getContext('2d');
    const sky=c.createLinearGradient(0,0,0,470);
    sky.addColorStop(0,'#04060e');sky.addColorStop(.6,'#0b1130');sky.addColorStop(1,'#1b2450');
    c.fillStyle=sky;c.fillRect(0,0,2048,470);
    for(let i=0;i<340;i++){const x=(i*211)%2048,y=((i*97)%420)*.98;c.globalAlpha=.25+(i%4)*.2;c.fillStyle=i%5?'#cdd7ee':'#ffffff';c.fillRect(x,y,2,2)}
    c.globalAlpha=1;
    // Fireworks, like the night the picture was taken.
    const burst=(bx,by,r,spokes,core,tip)=>{
      c.strokeStyle=core;c.lineWidth=3;
      for(let i=0;i<spokes;i++){const angle=i/spokes*Math.PI*2;
        c.globalAlpha=.85;c.beginPath();c.moveTo(bx+Math.cos(angle)*r*.15,by+Math.sin(angle)*r*.15);
        c.lineTo(bx+Math.cos(angle)*r,by+Math.sin(angle)*r);c.stroke();
        c.globalAlpha=1;c.fillStyle=tip;c.beginPath();c.arc(bx+Math.cos(angle)*r,by+Math.sin(angle)*r,4,0,Math.PI*2);c.fill();
      }
      c.fillStyle='#ffffff';c.beginPath();c.arc(bx,by,6,0,Math.PI*2);c.fill();
    };
    burst(1620,150,105,26,'#8a3ff0','#e79bff');
    burst(1500,255,44,18,'#c05ae0','#ffb8f0');
    burst(420,120,60,20,'#7a52e8','#d9a8ff');
    c.fillStyle='#07090f';
    for(let x=0;x<2048;x+=26){const h=18+((x*37)%52);c.fillRect(x,470-h,24,h)}
    c.fillStyle='#e8d27a';
    for(let i=0;i<160;i++){c.globalAlpha=.5;c.fillRect((i*89)%2048,436+((i*31)%30),2,2)}
    c.globalAlpha=1;
    c.fillStyle='#171b26';c.fillRect(0,470,2048,26);
    for(let x=10;x<2048;x+=34){c.fillStyle='#fff6d8';c.fillRect(x,478,7,7);c.globalAlpha=.35;c.fillStyle='#fff0b8';c.fillRect(x-3,474,13,15);c.globalAlpha=1}
    const crowd=['#cfd6e2','#e2c9c9','#c9e2cf','#d8d2b8','#c9cde2','#e2d9c9'];
    let top=496;
    for(let tier=0;tier<4;tier++){
      const height=tier<2?66:74;
      c.fillStyle=tier%2?'#4e5563':'#575e6d';c.fillRect(0,top,2048,height);
      for(let i=0;i<1400;i++){
        const x=(i*61+tier*23)%2048,y=top+6+((i*37+tier*11)%(height-14));
        c.fillStyle=crowd[(i+tier)%6];c.globalAlpha=.75;c.fillRect(x,y,4,6);
      }
      c.globalAlpha=1;
      for(let x=0;x<2048;x+=256){c.fillStyle='#2c313c';c.fillRect(x,top,10,height)}
      c.fillStyle='#181c26';c.fillRect(0,top+height,2048,10);
      top+=height+10;
    }
    c.fillStyle='#23272f';c.fillRect(0,top,2048,1024-top);
    c.fillStyle='#a03434';
    for(let x=0;x<2048;x+=170){c.fillRect(x+16,top+14,120,22)}
    c.fillStyle='#0b0d13';c.fillRect(0,top+52,2048,1024-top-52);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
    return texture;
  })();
  // The tunnel pierces the globe at player scale, so the cut is measured in
  // the arena's local frame at a third of its world size.
  // The bowl is fine-meshed, so its mouth is cut where every corner of a
  // triangle is inside the box; the shell is coarse — its triangles are
  // six metres wide — so it is cut loose, any corner inside, and the hole
  // is generous because a dark outer shell with a big hole is invisible
  // while a shell that seals the tunnel is a wall at the end of the walk.
  const cutMouth=(geometry,scaleX,scaleY,scaleZ,loose)=>{
    const position=geometry.attributes.position;
    const inMouth=index=>{
      const x=position.getX(index)*scaleX;
      const y=position.getY(index)*scaleY+SPHERE_CY;
      const z=position.getZ(index)*scaleZ;
      return loose?(Math.abs(x)<1.3&&y<1.5&&z>8.6):(Math.abs(x)<.8&&y<1.06&&z>9.2&&z<12.6);
    };
    const oldIndex=geometry.index,kept=[];
    for(let i=0;i<oldIndex.count;i+=3){
      const p=oldIndex.getX(i),q=oldIndex.getX(i+1),r=oldIndex.getX(i+2);
      const gone=loose?(inMouth(p)||inMouth(q)||inMouth(r)):(inMouth(p)&&inMouth(q)&&inMouth(r));
      if(gone)continue;
      kept.push(p,q,r);
    }
    geometry.setIndex(kept);
  };
  const bowlGeometry=new THREE.SphereGeometry(1,96,56);
  cutMouth(bowlGeometry,RX+.15,SPHERE_RY,RZ+.15,true);
  const bowl=new THREE.Mesh(bowlGeometry,new THREE.MeshBasicMaterial({map:sphereTexture,side:THREE.BackSide}));
  bowl.scale.set(RX+.15,SPHERE_RY,RZ+.15);
  bowl.position.set(0,SPHERE_CY,0);
  arena.add(bowl);
  const shellGeometry=new THREE.SphereGeometry(1,48,24);
  cutMouth(shellGeometry,RX+.38,SPHERE_RY+.2,RZ+.38,true);
  const bowlShell=new THREE.Mesh(shellGeometry,
    new THREE.MeshStandardMaterial({color:0x0c1220,emissive:0x0a1425,emissiveIntensity:.35,roughness:.6,metalness:.3}));
  bowlShell.scale.set(RX+.38,SPHERE_RY+.2,RZ+.38);
  bowlShell.position.set(0,SPHERE_CY,0);
  arena.add(bowlShell);
  // The floating platform and the void it floats over.
  const field=new THREE.Mesh(new THREE.PlaneGeometry(18.9,14.1),
    new THREE.MeshStandardMaterial({map:pokemonFieldTexture(),roughness:.82,metalness:.05,emissive:0x0d2a12,emissiveIntensity:.35}));
  field.rotation.x=-Math.PI/2;field.position.set(0,.017,0);field.receiveShadow=true;arena.add(field);
  const voidCanvas=document.createElement('canvas');voidCanvas.width=512;voidCanvas.height=512;
  const vc=voidCanvas.getContext('2d');
  const drop=vc.createRadialGradient(256,256,168,256,256,256);
  drop.addColorStop(0,'#171b26');drop.addColorStop(.25,'#0a0d15');drop.addColorStop(1,'#04050a');
  vc.fillStyle=drop;vc.fillRect(0,0,512,512);
  const voidTexture=new THREE.CanvasTexture(voidCanvas);voidTexture.colorSpace=THREE.SRGBColorSpace;
  const voidRing=new THREE.Mesh(new THREE.RingGeometry(.66,1.06,64),
    new THREE.MeshBasicMaterial({map:voidTexture,side:THREE.DoubleSide}));
  voidRing.rotation.x=-Math.PI/2;voidRing.scale.set(13.6,10.5,1);
  voidRing.position.set(0,.009,0);arena.add(voidRing);
  const underGlow=new THREE.MeshStandardMaterial({color:0xb02828,emissive:0xa01818,emissiveIntensity:1.4,roughness:.4});
  for(const [gx,gz] of [[-6,-7.2],[-3,-7.2],[0,-7.2],[3,-7.2],[6,-7.2],[-6,7.2],[-3,7.2],[0,7.2],[3,7.2],[6,7.2],[-9.6,-3.5],[-9.6,0],[-9.6,3.5],[9.6,-3.5],[9.6,0],[9.6,3.5]]){
    const vent=new THREE.Mesh(new THREE.BoxGeometry(.6,.09,.12),underGlow);
    if(Math.abs(gx)>9)vent.rotation.y=Math.PI/2;
    vent.position.set(gx,.03,gz);arena.add(vent);
  }
  // The set pieces, the way the stage dresses them: the jumbotron over the
  // way in, the string of bulbs above it, a floodlight wing over each side.
  const steel=new THREE.MeshStandardMaterial({color:0x171a22,metalness:.6,roughness:.4});
  const darkSteel=new THREE.MeshStandardMaterial({color:0x10131a,metalness:.5,roughness:.5});
  const redTrim=new THREE.MeshStandardMaterial({color:0xb02828,emissive:0x8a1414,emissiveIntensity:.9,roughness:.4});
  const lampFace=new THREE.MeshBasicMaterial({color:0xfff6dc});
  const screenZ=8.6;
  for(const side of [-1,1]){
    const jumboBase=new THREE.Mesh(new THREE.BoxGeometry(3.7,1.5,1.7),steel);
    jumboBase.position.set(side*5.7,.75,screenZ+.2);arena.add(jumboBase);
    const pad=new THREE.Mesh(new THREE.BoxGeometry(2.6,.5,1.8),darkSteel);
    pad.position.set(side*5.4,1.75,screenZ-.1);arena.add(pad);
    const padTop=new THREE.Mesh(new THREE.PlaneGeometry(2.4,1.6),
      new THREE.MeshStandardMaterial({color:0x4faf46,emissive:0x1c4a1c,emissiveIntensity:.4,roughness:.7}));
    padTop.rotation.x=-Math.PI/2;padTop.position.set(side*5.4,2.01,screenZ-.1);arena.add(padTop);
  }
  const jumboFrame=new THREE.Mesh(new THREE.BoxGeometry(10.4,4.2,.5),darkSteel);
  jumboFrame.position.set(0,5.15,screenZ);arena.add(jumboFrame);
  const jumboPanel=new THREE.Mesh(new THREE.PlaneGeometry(9.9,3.7),
    new THREE.MeshStandardMaterial({color:0x0c130e,emissive:0x0a1a10,emissiveIntensity:.5,roughness:.3,metalness:.2}));
  jumboPanel.position.set(0,5.15,screenZ-.27);arena.add(jumboPanel);
  for(const side of [-1,1]){
    const pylon=new THREE.Mesh(new THREE.BoxGeometry(1.15,7.4,1.15),darkSteel);
    pylon.position.set(side*6.35,3.7,screenZ+.1);arena.add(pylon);
    const stripe=new THREE.Mesh(new THREE.BoxGeometry(.2,5.6,.1),redTrim);
    stripe.position.set(side*6.1,3.9,screenZ-.5);arena.add(stripe);
  }
  const lightBar=new THREE.Mesh(new THREE.BoxGeometry(11.8,.22,.24),steel);
  lightBar.position.set(0,7.65,screenZ-.1);arena.add(lightBar);
  for(let i=0;i<21;i++){
    const bulb=new THREE.Mesh(new THREE.SphereGeometry(.13,8,6),lampFace);
    bulb.position.set(-5.5+i*.55,7.48,screenZ-.2);arena.add(bulb);
  }
  const stringGlow=new THREE.Mesh(new THREE.PlaneGeometry(12.4,1.7),
    new THREE.MeshBasicMaterial({map:haloTexture,color:0xffedb8,transparent:true,opacity:.55,depthWrite:false,blending:THREE.AdditiveBlending}));
  stringGlow.position.set(0,7.5,screenZ-.3);arena.add(stringGlow);
  for(const side of [-1,1]){
    const wing=new THREE.Group();
    wing.position.set(side*10.6,6.3,1.2);
    wing.rotation.z=side*.42;
    const wingSlab=new THREE.Mesh(new THREE.BoxGeometry(5,.4,2.8),steel);wing.add(wingSlab);
    for(let row=0;row<2;row++)for(let col=0;col<5;col++){
      const cellLamp=new THREE.Mesh(new THREE.PlaneGeometry(.62,.5),lampFace);
      cellLamp.position.set(-1.8+col*.9,-.22,row?-.72:.72);
      cellLamp.rotation.x=Math.PI/2;
      wing.add(cellLamp);
    }
    const wingGlow=new THREE.Mesh(new THREE.PlaneGeometry(5.4,3.4),
      new THREE.MeshBasicMaterial({map:haloTexture,color:0xfff3cc,transparent:true,opacity:.5,depthWrite:false,blending:THREE.AdditiveBlending}));
    wingGlow.position.y=-.5;wingGlow.rotation.x=-Math.PI/2;wing.add(wingGlow);
    arena.add(wing);
    // The two managed lights live in world space: light ranges do not scale
    // with a parent group, so they are placed and sized for the grown arena.
    const flood=new THREE.PointLight(0xfff2d6,46,68,2);
    flood.position.set(centerX+side*21,14,arenaCz+3.6);
    scene.add(flood);managedSceneLights.push(flood);
  }
}
// Super Mario, in the west column behind Metal Gear.
themeRoom({
  centerX:MEGAMAN_ROOM_CENTER_X,centerZ:-25.2,
  far:'mario-room-mural.webp?v=mario-1',
  near:'mario-room-mural-3.webp?v=mario-1',
  side:'mario-room-mural-2.webp?v=mario-1'
});
// Final Fantasy fills the wide top-row room. Its geometry is its own — a 32 m
// back wall and two 16.4 m sides, with the doorway wall left bare — so its
// murals are hung directly rather than through themeRoom, with the same
// backing panels, planes and sampled mood lighting.
// Hangs murals on walls whose geometry themeRoom does not fit — the top-row
// rooms have their own shapes. Same backing panels, planes and sampled mood
// lighting as everywhere else.
function hangMuralWalls(walls){
  for(const wall of walls){
    wall.backing();
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
hangMuralWalls([
    {file:'ff-room-mural.webp?v=poke-7',span:32,at:new THREE.Vector3(-5.4,2.5,-66.94),
      backing:()=>box(32,5,.08,0x050711,-5.4,2.5,-67.01,.12),
      rotation:0,normal:new THREE.Vector3(0,0,1),along:new THREE.Vector3(1,0,0),count:6},
    {file:'ff-room-mural-2.webp?v=poke-7',span:16,at:new THREE.Vector3(10.54,2.5,-59),
      backing:()=>box(.08,5,16,0x050711,10.61,2.5,-59,.12),
      rotation:-Math.PI/2,normal:new THREE.Vector3(-1,0,0),along:new THREE.Vector3(0,0,1),count:4},
    {file:'ff-room-mural-3.webp?v=poke-7',span:16,at:new THREE.Vector3(-21.34,2.5,-59),
      backing:()=>box(.08,5,16,0x050711,-21.41,2.5,-59,.12),
      rotation:Math.PI/2,normal:new THREE.Vector3(1,0,0),along:new THREE.Vector3(0,0,-1),count:4}
]);
// Zelda swapped places with Silent Hill: it hangs in the west column's bottom
// room now — the Wind Waker ensemble on the back wall, the vista along the
// shell, and the divider pair on the north wall at its own width rather than
// stretched to a wall it was not cut for.
hangMuralWalls([
  {file:'zelda-room-mural.webp?v=zelda-1',span:21.3,at:new THREE.Vector3(-32.4,2.5,33.34),
    backing:()=>box(21.3,5,.08,0x050711,-32.4,2.5,33.41,.12),
    rotation:Math.PI,normal:new THREE.Vector3(0,0,-1),along:new THREE.Vector3(-1,0,0),count:5},
  {file:'zelda-room-mural-2.webp?v=zelda-1',span:21.3,at:new THREE.Vector3(-32.4,2.5,17.12),
    backing:()=>box(21.3,5,.08,0x050711,-32.4,2.5,16.99,.12),
    rotation:0,normal:new THREE.Vector3(0,0,1),along:new THREE.Vector3(1,0,0),count:4},
  {file:'zelda-room-mural-3.webp?v=zelda-1',span:16.5,at:new THREE.Vector3(-42.88,2.5,25.2),
    backing:()=>box(.08,5,16.5,0x050711,-43.01,2.5,25.2,.12),
    rotation:Math.PI/2,normal:new THREE.Vector3(1,0,0),along:new THREE.Vector3(0,0,-1),count:4}
]);
// Pokemon, in the east column: the bowl itself, not flat murals — the band and
// dome carry the stands, so this room does not go through themeRoom at all.
buildPokemonStadium(POKEMON_CENTER_X,-108.45);
/**
 * The Sonic room is the Chao Garden.
 *
 * Like the stadium, it is the place itself rather than a room with pictures of
 * it: a grass meadow ringed by cliffs, a stretch of open sea where the cliffs
 * part, a waterfall feeding a pool, palm trees, fruit on the grass, and a day
 * sky overhead rising through its own hole in the building's ceiling. Every
 * texture is painted to a canvas and every shape is primitive geometry — the
 * Dreamcast garden was low-poly, and so is this one, on purpose.
 *
 * The space under the sky is left clear for the Chao when their models arrive.
 */
function buildChaoGarden(centerX,centerZ){
  // A circle in a square room, which is what the reference is: a round cove.
  // The mouth is aimed at the doorway rather than at a compass point, since
  // the room's centre no longer lines up with it.
  // Tall enough to swallow the tops of the room's five-metre walls, which
  // were poking into the sky as floating black slabs.
  // The new room is standard depth, so the cove is an ellipse: full width
  // along the walls, shallower toward the dividers. The mouth is on the long
  // axis where the radius is RX, so the arch's radial placement holds.
  const R=10.35,RX=R,RZ=7.95,BAND_BASE=.4,BAND_TOP=5.3;
  const MOUTH_ARC=3.6/RZ;
  const MOUTH_THETA=Math.atan2(21.6-centerX,0);
  const THETA_START=MOUTH_THETA+MOUTH_ARC/2,THETA_LENGTH=Math.PI*2-MOUTH_ARC;
  // The horizon band: sky over sea all the way round, with two headlands of
  // cliff painted on top so the garden reads as a cove. The mouth faces the
  // doorway, and the cliffs stand either side of it.
  const bandCanvas=document.createElement('canvas');bandCanvas.width=2048;bandCanvas.height=256;
  const bc=bandCanvas.getContext('2d');
  const sky=bc.createLinearGradient(0,0,0,150);
  sky.addColorStop(0,'#9fd4ee');sky.addColorStop(1,'#dff2f9');
  bc.fillStyle=sky;bc.fillRect(0,0,2048,150);
  const sea=bc.createLinearGradient(0,150,0,256);
  sea.addColorStop(0,'#3f7fc4');sea.addColorStop(.6,'#2e63ad');sea.addColorStop(1,'#20447e');
  bc.fillStyle=sea;bc.fillRect(0,150,2048,106);
  // Haze where sea meets sky, and whitecaps thinning with distance.
  bc.fillStyle='#cfe8f4';bc.globalAlpha=.55;bc.fillRect(0,146,2048,9);bc.globalAlpha=1;
  bc.fillStyle='#ffffff';
  for(let i=0;i<90;i++){const x=(i*211)%2048,y=158+(i*67)%92;
    bc.globalAlpha=(.2-((y-158)/92)*.12)+(i%4)*.04;bc.fillRect(x,y,20+(i%5)*10,2)}
  bc.globalAlpha=1;
  // A distant island out in the open water, and clouds on the horizon.
  bc.fillStyle='#7fa3bd';bc.beginPath();bc.ellipse(980,150,84,17,0,Math.PI,0);bc.fill();
  bc.fillStyle='#93b78f';bc.beginPath();bc.ellipse(966,146,32,9,0,Math.PI,0);bc.fill();
  for(let i=0;i<9;i++){const x=(i*479)%2048,y=104+(i*37)%36;bc.globalAlpha=.55;bc.fillStyle='#ffffff';
    bc.beginPath();bc.ellipse(x,y,60+(i%3)*24,12,0,0,Math.PI*2);bc.fill();
    bc.beginPath();bc.ellipse(x+42,y+7,36,9,0,0,Math.PI*2);bc.fill()}
  bc.globalAlpha=1;
  /**
   * The cliffs, drawn as a solid rock face rather than the fence the first
   * pass produced: that version stepped its columns with gaps, so the sea
   * gradient showed through between every one and the wall read as pickets.
   * Now a dark backfill goes down first, the columns overlap it, each carries
   * strata, a shadow seam and a mossy cap, and nothing behind shows through.
   */
  function cliffs(u0,u1){
    const x0=u0*2048,x1=u1*2048;
    bc.fillStyle='#6f6754';bc.fillRect(x0,8,x1-x0,248);
    for(let x=x0;x<x1;x+=30){
      const top=14+((x*13)%44),shade=((x*7)%3);
      bc.fillStyle=shade===0?'#c4b99e':shade===1?'#b0a58b':'#9a8f77';
      bc.fillRect(x,top,31,256-top);
      for(let y=top+18;y<250;y+=26){bc.fillStyle='rgba(90,82,66,.45)';bc.fillRect(x,y,31,3)}
      bc.fillStyle='#7b7260';bc.fillRect(x+29,top,3,256-top);
      bc.fillStyle='#e0d7bd';bc.fillRect(x+2,top+8,3,246-top);
      bc.fillStyle='#3f9e47';bc.fillRect(x,top,31,7);
      bc.fillStyle='#57c25f';bc.fillRect(x+((x*11)%14),top,9,10);
    }
  }
  cliffs(0,.34);cliffs(.62,1);
  const bandTexture=new THREE.CanvasTexture(bandCanvas);bandTexture.colorSpace=THREE.SRGBColorSpace;
  // A shadowed overhang caps the mouth, so the opening in the cliffs is
  // door-height: without it the arcade hall showed through the gap above the
  // doorway, ceiling fixtures floating in the garden sky. It is near-black on
  // purpose — the pale rock it used to be read as a grey slab hanging over
  // the door from the hall side.
  const archMaterial=new THREE.MeshStandardMaterial({color:0x1c1916,roughness:.95,metalness:.02});
  const arch=new THREE.Mesh(new THREE.BoxGeometry(1.4,BAND_TOP-2.7,5),archMaterial);
  arch.position.set(centerX+Math.sin(MOUTH_THETA)*(R-.3),(BAND_TOP+2.7)/2,centerZ+Math.cos(MOUTH_THETA)*(R-.3));
  arch.rotation.y=MOUTH_THETA+Math.PI/2;scene.add(arch);
  const band=new THREE.Mesh(
    new THREE.CylinderGeometry(1,1,BAND_TOP-BAND_BASE,72,1,true,THETA_START,THETA_LENGTH),
    new THREE.MeshBasicMaterial({map:bandTexture,side:THREE.DoubleSide}));
  band.scale.set(RX,1,RZ);band.position.set(centerX,(BAND_BASE+BAND_TOP)/2,centerZ);scene.add(band);
  const skirt=new THREE.Mesh(
    new THREE.CylinderGeometry(1,1,BAND_BASE,72,1,true,THETA_START,THETA_LENGTH),
    new THREE.MeshStandardMaterial({color:0x8d8371,roughness:.9,metalness:.05,side:THREE.DoubleSide}));
  skirt.scale.set(RX,1,RZ);skirt.position.set(centerX,BAND_BASE/2,centerZ);scene.add(skirt);
  // The day sky, through the second ceiling hole.
  const skyCanvas=document.createElement('canvas');skyCanvas.width=512;skyCanvas.height=512;
  const sc2=skyCanvas.getContext('2d');
  const zenith=sc2.createLinearGradient(0,0,0,512);
  zenith.addColorStop(0,'#5fb2e6');zenith.addColorStop(.7,'#9dd3ef');zenith.addColorStop(1,'#d9f0f8');
  sc2.fillStyle=zenith;sc2.fillRect(0,0,512,512);
  sc2.fillStyle='#ffffff';
  for(let i=0;i<12;i++){const x=(i*197)%512,y=90+(i*151)%360;sc2.globalAlpha=.42;
    sc2.beginPath();sc2.ellipse(x,y,52+(i%4)*18,16,0,0,Math.PI*2);sc2.fill();
    sc2.beginPath();sc2.ellipse(x+34,y+8,34,12,0,0,Math.PI*2);sc2.fill()}
  sc2.globalAlpha=1;
  const skyTexture=new THREE.CanvasTexture(skyCanvas);skyTexture.colorSpace=THREE.SRGBColorSpace;
  const skyDome=new THREE.Mesh(
    new THREE.SphereGeometry(1,48,24,0,Math.PI*2,0,Math.PI/2),
    new THREE.MeshBasicMaterial({map:skyTexture,side:THREE.BackSide}));
  skyDome.scale.set(RX,5,RZ);skyDome.position.set(centerX,BAND_TOP,centerZ);scene.add(skyDome);
  // The meadow: vivid mottled grass with a worn dirt fringe at the cliffs.
  const grassCanvas=document.createElement('canvas');grassCanvas.width=512;grassCanvas.height=512;
  const gc=grassCanvas.getContext('2d');
  gc.fillStyle='#3ecf4a';gc.fillRect(0,0,512,512);
  for(let i=0;i<340;i++){const x=(i*97)%512,y=(i*173)%512;
    gc.fillStyle=i%3?'#46d852':(i%2?'#36b542':'#54e060');gc.globalAlpha=.5;
    gc.beginPath();gc.ellipse(x,y,14+(i%9)*3,9+(i%5)*3,i,0,Math.PI*2);gc.fill()}
  gc.globalAlpha=1;
  // The meadow darkens toward the cliff base, which is what grounds the wall.
  const rim=gc.createRadialGradient(256,256,150,256,256,256);
  rim.addColorStop(0,'rgba(20,80,28,0)');rim.addColorStop(1,'rgba(20,80,28,.55)');
  gc.fillStyle=rim;gc.fillRect(0,0,512,512);
  const grassTexture=new THREE.CanvasTexture(grassCanvas);grassTexture.colorSpace=THREE.SRGBColorSpace;
  grassTexture.wrapS=grassTexture.wrapT=THREE.RepeatWrapping;
  /**
   * The meadow rolls. A flat disc read as a billiard table; this one is a
   * radial mesh with gentle mounds and a rise toward the cliff base, flattened
   * across the mouth so the way in stays level ground. The texture repeats at
   * a quarter of its old scale, so the mottle survives being seen from a
   * standing eye instead of blurring across twenty metres.
   */
  const meadowRadius=R-.15,RINGS=9,SECTORS=48;
  const meadowGeometry=new THREE.BufferGeometry();
  const positions=[],uvs=[],indices=[];
  for(let ring=0;ring<=RINGS;ring++){
    const fraction=ring/RINGS,radius=fraction*meadowRadius;
    for(let sector=0;sector<=SECTORS;sector++){
      const angle=sector/SECTORS*Math.PI*2;
      const x=Math.cos(angle)*radius,z=Math.sin(angle)*radius;
      const mouthGap=Math.abs(Math.atan2(Math.sin(angle-MOUTH_THETA+Math.PI/2),Math.cos(angle-MOUTH_THETA+Math.PI/2)));
      const flatten=Math.min(1,mouthGap/.8);
      const rim=Math.max(0,(fraction-.72)/.28);
      const height=(rim*rim*.5+Math.sin(angle*3+radius*1.2)*.07+Math.sin(angle*5-radius*.8)*.05)*flatten;
      positions.push(x,Math.max(0,height),z);
      uvs.push((x+meadowRadius)/5,(z+meadowRadius)/5);
    }
  }
  for(let ring=0;ring<RINGS;ring++)for(let sector=0;sector<SECTORS;sector++){
    const a=ring*(SECTORS+1)+sector,b=a+SECTORS+1;
    // Wound so the faces look up: the first cut faced the floor, and the
    // meadow simply did not render from above.
    indices.push(a,a+1,b,b,a+1,b+1);
  }
  meadowGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  meadowGeometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
  meadowGeometry.setIndex(indices);meadowGeometry.computeVertexNormals();
  const meadow=new THREE.Mesh(meadowGeometry,
    new THREE.MeshStandardMaterial({map:grassTexture,roughness:.85,metalness:.02,emissive:0x1c6b24,emissiveIntensity:.42}));
  meadow.scale.z=RZ/RX;
  meadow.position.set(centerX,.02,centerZ);meadow.receiveShadow=true;scene.add(meadow);
  // A worn sandy path from the mouth toward the middle of the garden.
  const sandCanvas=document.createElement('canvas');sandCanvas.width=128;sandCanvas.height=128;
  const sn=sandCanvas.getContext('2d');
  sn.fillStyle='#d9c391';sn.fillRect(0,0,128,128);
  for(let i=0;i<160;i++){sn.fillStyle=i%2?'#cbb27b':'#e6d4a6';sn.globalAlpha=.5;
    sn.fillRect((i*37)%128,(i*53)%128,3,2)}
  sn.globalAlpha=1;
  const sandTexture=new THREE.CanvasTexture(sandCanvas);sandTexture.colorSpace=THREE.SRGBColorSpace;
  const path=new THREE.Mesh(new THREE.PlaneGeometry(6.5,2.6),
    new THREE.MeshBasicMaterial({map:sandTexture,transparent:true,opacity:.9,depthWrite:false}));
  path.rotation.x=-Math.PI/2;
  path.rotation.z=-MOUTH_THETA+Math.PI/2;
  path.position.set(centerX+Math.sin(MOUTH_THETA)*(R-3.6),.045,centerZ+Math.cos(MOUTH_THETA)*(R-3.6));
  scene.add(path);
  // Flowers in the grass, one instanced mesh so ninety of them cost one call.
  const flowerColours=[0xffffff,0xffe36b,0xff9ad5];
  const flowers=new THREE.InstancedMesh(new THREE.PlaneGeometry(.09,.09),
    new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide}),90);
  const flowerMatrix=new THREE.Matrix4(),flowerColour=new THREE.Color();
  for(let i=0;i<90;i++){
    const angle=i*2.399,radius=1.2+((i*53)%80)/10;
    flowerMatrix.makeRotationX(-Math.PI/2);
    flowerMatrix.setPosition(centerX+Math.cos(angle)*radius,.09,centerZ+Math.sin(angle)*radius*.96);
    flowers.setMatrixAt(i,flowerMatrix);
    flowers.setColorAt(i,flowerColour.setHex(flowerColours[i%3]));
  }
  scene.add(flowers);
  // The pool and its waterfall, tucked against the north-east cliffs.
  const poolX=centerX+5.2,poolZ=centerZ-3.9;
  const poolRim=new THREE.Mesh(new THREE.CircleGeometry(1,36),new THREE.MeshBasicMaterial({color:0x9fd4ea}));
  poolRim.rotation.x=-Math.PI/2;poolRim.scale.set(2.9,2.1,1);poolRim.position.set(poolX,.035,poolZ);scene.add(poolRim);
  const pool=new THREE.Mesh(new THREE.CircleGeometry(1,36),new THREE.MeshBasicMaterial({color:0x4189cc}));
  pool.rotation.x=-Math.PI/2;pool.scale.set(2.45,1.7,1);pool.position.set(poolX,.045,poolZ);scene.add(pool);
  const fallCanvas=document.createElement('canvas');fallCanvas.width=128;fallCanvas.height=256;
  const fc=fallCanvas.getContext('2d');
  const water=fc.createLinearGradient(0,0,0,256);
  water.addColorStop(0,'#bfe6f5');water.addColorStop(1,'#6fb4e0');
  fc.fillStyle=water;fc.fillRect(0,0,128,256);
  fc.strokeStyle='#ffffff';
  for(let x=6;x<128;x+=11){fc.globalAlpha=.35+(x%3)*.15;fc.lineWidth=2+(x%3);
    fc.beginPath();fc.moveTo(x,0);fc.lineTo(x-4,256);fc.stroke()}
  fc.globalAlpha=1;
  const fallTexture=new THREE.CanvasTexture(fallCanvas);fallTexture.colorSpace=THREE.SRGBColorSpace;
  fallTexture.wrapT=THREE.RepeatWrapping;
  // Two sheets, offset and out of phase, falling from the band's own height —
  // and actually falling: the texture scrolls whenever anyone is in the room.
  const fallSheets=[];
  for(const [off,width,opacity] of [[0,2.3,1],[.16,1.7,.55]]){
    const sheet=new THREE.Mesh(new THREE.PlaneGeometry(width,BAND_TOP-.5),
      new THREE.MeshBasicMaterial({map:off?fallTexture.clone():fallTexture,transparent:off>0,opacity,depthWrite:!off}));
    sheet.material.map.wrapT=THREE.RepeatWrapping;
    sheet.position.set(poolX+1.6+off,(BAND_TOP-.5)/2+.35,poolZ-1.35+off);
    sheet.lookAt(centerX,1.2,centerZ);scene.add(sheet);
    fallSheets.push(sheet);
  }
  beforeRenderCallbacks.push((now,delta)=>{
    const dx=playerPosition.x-centerX,dz=playerPosition.z-centerZ;
    if(dx*dx+dz*dz>240)return;
    fallSheets[0].material.map.offset.y-=delta*.9;
    fallSheets[1].material.map.offset.y-=delta*1.25;
  });
  const foam=new THREE.Mesh(new THREE.CircleGeometry(1,24),new THREE.MeshBasicMaterial({color:0xeaf7fc,transparent:true,opacity:.85}));
  foam.rotation.x=-Math.PI/2;foam.scale.set(1.15,.6,1);foam.position.set(poolX+1.35,.06,poolZ-1.1);scene.add(foam);
  // The palms, boulders and cliff columns are real models now, generated in
  // Blender on this machine and loaded lazily on approach — see
  // installChaoGardenProps below.
  // Fruit on the grass, the garden's own colours.
  const fruitColours=[0xffd23e,0xff8c3a,0xff5fae,0xa06cff];
  const fruitGeometry=new THREE.SphereGeometry(.13,10,8);
  for(let i=0;i<9;i++){
    const angle=i*2.399,radius=1.6+(i%5)*1.15;
    const fruit=new THREE.Mesh(fruitGeometry,new THREE.MeshStandardMaterial({color:fruitColours[i%4],roughness:.4,emissive:fruitColours[i%4],emissiveIntensity:.12}));
    fruit.scale.y=1.35;fruit.position.set(centerX+Math.cos(angle)*radius,.16,centerZ+Math.sin(angle)*radius*.75);
    scene.add(fruit);
  }
  // Daylight: two warm suns on the managed budget, one over the meadow and one
  // at the falls.
  for(const [lx,lz] of [[-2.5,1.5],[4.8,-3.2]]){
    const sun=new THREE.PointLight(0xfff3d0,4.8,16,2);
    sun.position.set(centerX+lx,3.6,centerZ+lz);
    scene.add(sun);managedSceneLights.push(sun);
  }
}
// The garden mounts are declared ahead of everything that assigns them: the
// bore group is built right here at module evaluation.
let chaoGardenMount=null,chaoBoreGroup=null,chaoRockTexture=null;
// The supplied SA1-style garden model owns the room now. A grass disc holds
// the floor while its GLB loads, and the suns stay because the model brings
// no lights of its own.
const chaoGardenFallback=new THREE.Mesh(
  new THREE.CircleGeometry(1,48),
  new THREE.MeshStandardMaterial({color:0x215f31,emissive:0x123b20,emissiveIntensity:.4,roughness:.92})
);
chaoGardenFallback.name='chao-garden-loading-floor';
chaoGardenFallback.rotation.x=-Math.PI/2;
chaoGardenFallback.scale.set(21,29,1);
chaoGardenFallback.position.set(80,.025,33);
scene.add(chaoGardenFallback);
for(const [sx,sz] of [[60,13.2],[70,10],[70,26],[80,16],[80,40],[92,30],[70,50],[94,48],[64,34],[90,10]]){
  const sun=new THREE.PointLight(0xfff3d0,8.4,46,1.8);
  sun.position.set(sx,8.5,sz);
  scene.add(sun);managedSceneLights.push(sun);
}
// The garden's own sky: a fine-meshed dome and sea disc built here, sized so
// the dome's west rim tucks against the shell and a small notch over the
// corridor keeps it out of the tunnel's air. Replaces the model's coarse
// skybox, whose facets were the size of the sky itself.
{
  const skyCanvas=document.createElement('canvas');skyCanvas.width=64;skyCanvas.height=512;
  const skyContext=skyCanvas.getContext('2d');
  skyCanvas.width=512;
  const skyGradient=skyContext.createLinearGradient(0,0,0,512);
  skyGradient.addColorStop(0,'#2050c8');skyGradient.addColorStop(.5,'#3f7ade');
  skyGradient.addColorStop(.82,'#9fd0f2');skyGradient.addColorStop(1,'#d9ecf8');
  skyContext.fillStyle=skyGradient;skyContext.fillRect(0,0,512,512);
  // puffy clouds, drawn as clustered soft ellipses in the sky's middle band
  for(let cloud=0;cloud<16;cloud++){
    const cx=(cloud*167)%512,cy=196+((cloud*97)%78),puffs=5+cloud%4;
    for(let puff=0;puff<puffs;puff++){
      const px=cx+((puff*53)%84)-42,py=cy+((puff*37)%26)-13,r=20+((cloud+puff)*29)%26;
      const glow=skyContext.createRadialGradient(px,py,r*.2,px,py,r);
      glow.addColorStop(0,'rgba(255,255,255,.95)');glow.addColorStop(.7,'rgba(255,255,255,.55)');glow.addColorStop(1,'rgba(255,255,255,0)');
      skyContext.fillStyle=glow;
      skyContext.beginPath();skyContext.ellipse(px,py,r*1.5,r,0,0,Math.PI*2);skyContext.fill();
    }
  }
  const skyTexture=new THREE.CanvasTexture(skyCanvas);skyTexture.colorSpace=THREE.SRGBColorSpace;
  const dome=new THREE.Mesh(new THREE.SphereGeometry(70,64,32),new THREE.MeshBasicMaterial({map:skyTexture,side:THREE.BackSide,fog:false}));
  dome.position.set(113,-.5,36);dome.scale.y=.72;
  // the corridor notch: fine mesh, so the hole is small and hides in the rock
  const domePositions=dome.geometry.attributes.position,domeIndex=dome.geometry.index,keptSky=[];
  const domeVertex=new THREE.Vector3();
  const inCorridor=v=>{domeVertex.fromBufferAttribute(domePositions,v);domeVertex.multiply(dome.scale).add(dome.position);return domeVertex.x<58.5&&Math.abs(domeVertex.z-13.2)<3.4&&domeVertex.y<6};
  for(let i=0;i<domeIndex.count;i+=3){
    const a=domeIndex.getX(i),b=domeIndex.getX(i+1),c=domeIndex.getX(i+2);
    if(inCorridor(a)||inCorridor(b)||inCorridor(c))continue;
    keptSky.push(a,b,c);
  }
  dome.geometry.setIndex(keptSky);
  scene.add(dome);
  const sea=new THREE.Mesh(new THREE.CircleGeometry(69.5,48),new THREE.MeshBasicMaterial({color:0x3f8fd6,fog:false}));
  sea.rotation.x=-Math.PI/2;sea.position.set(113,-2.4,36);scene.add(sea);
}
// The way out is a stone bore: straight walls and one smooth barrel vault
// from the arcade door, through the old room's dark, out the shell, and past
// the sky's rim, surfacing on the meadow. A low-frequency noise map keeps it
// reading as rock without a single jagged slab.
{
  const bore=new THREE.Group();bore.name='chao-garden-tunnel';scene.add(bore);chaoBoreGroup=bore;
  // The old garden room is sealed off from the bore by two full walls, floor
  // to ceiling: the tunnel is a corridor through solid building, not a tube
  // crossing a dark room a player could end up beside.
  for(const wallZ of [10.75,15.65]){
    const seal=box(21.1,5,.3,0x11182c,32.15,2.5,wallZ,.05);seal.receiveShadow=true;
  }
  const rockCanvas=document.createElement('canvas');rockCanvas.width=rockCanvas.height=128;
  const rockContext=rockCanvas.getContext('2d');
  rockContext.fillStyle='#8f8a82';rockContext.fillRect(0,0,128,128);
  for(let i=0;i<340;i++){
    const shade=118+((i*37)%46);
    rockContext.fillStyle='rgb('+shade+','+(shade-5)+','+(shade-12)+')';
    rockContext.globalAlpha=.24;
    rockContext.beginPath();rockContext.arc((i*53)%128,(i*89)%128,3+(i*29)%9,0,Math.PI*2);rockContext.fill();
  }
  rockContext.globalAlpha=1;
  const rockTexture=new THREE.CanvasTexture(rockCanvas);rockTexture.wrapS=rockTexture.wrapT=THREE.RepeatWrapping;rockTexture.repeat.set(6,2);chaoRockTexture=rockTexture;
  const boreRock=new THREE.MeshStandardMaterial({map:rockTexture,roughness:.94,metalness:.03,side:THREE.DoubleSide});
  const BORE_MIN_X=21.9,BORE_MAX_X=57.6,BORE_LENGTH=BORE_MAX_X-BORE_MIN_X,BORE_CENTER_X=(BORE_MIN_X+BORE_MAX_X)/2;
  for(const side of [-1,1]){
    const wall=new THREE.Mesh(new THREE.BoxGeometry(BORE_LENGTH,2,.6),boreRock);
    wall.position.set(BORE_CENTER_X,1,13.2+side*2.33);bore.add(wall);
  }
  const vault=new THREE.Mesh(new THREE.CylinderGeometry(2.05,2.05,BORE_LENGTH,22,1,true,0,Math.PI),boreRock);
  vault.rotation.z=Math.PI/2;vault.scale.y=1;vault.position.set(BORE_CENTER_X,1.95,13.2);
  vault.scale.set(1,1,.95);bore.add(vault);
  const header=new THREE.Mesh(new THREE.BoxGeometry(1.6,1.7,5.4),boreRock);
  header.position.set(22.5,4.25,13.2);bore.add(header);
  const boreFloor=new THREE.Mesh(new THREE.BoxGeometry(41.4,.06,5.6),new THREE.MeshStandardMaterial({map:rockTexture,roughness:.96,metalness:.02,color:0x777168}));
  boreFloor.position.set(42.3,.03,13.2);bore.add(boreFloor);
  // The mouth is a mound of marble-toned boulders, oversized and sunk so
  // nothing floats and nothing peeks through from behind.
  const portalRock=new THREE.MeshBasicMaterial({map:rockTexture,color:0xc9d3dd,fog:false});
  const portalPieces=[
    [59.8,1.6,9.4, 5.6,7.4,4.6, .34,-.12],
    [59.8,1.6,17.0, 5.6,7.4,4.6, -.34,.12],
    [59.4,5.7,13.2, 7.8,4.6,7.4, .1,.05],
    [61.4,2.2,16.9, 4.6,5.8,4.2, -.5,0],
    [61.4,2.2,9.6, 4.6,5.8,4.2, .5,0],
    [58.6,7.8,13.2, 6.4,3.8,6.2, -.15,-.06]
  ];
  for(const [px,py,pz,sx,sy,sz,ry,rz] of portalPieces){
    const boulder=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),portalRock);
    boulder.position.set(px,py,pz);
    boulder.rotation.set(0,ry,rz);
    bore.add(boulder);
  }
  // a stone exit pad wide enough that no sea sliver survives beside the path
  const exitPad=new THREE.Mesh(new THREE.BoxGeometry(7.2,.07,8.2),new THREE.MeshBasicMaterial({map:rockTexture,color:0xb9c4cf,fog:false}));
  exitPad.position.set(59.6,.028,13.2);bore.add(exitPad);
  for(const x of [26.5,33.5,40.5,46.5,51.6,57.2]){
    const bulb=new THREE.Mesh(new THREE.BoxGeometry(.16,.1,.3),new THREE.MeshStandardMaterial({color:0xffd9a0,emissive:0xffc070,emissiveIntensity:2.2}));
    bulb.position.set(x,2.72,14.15);bore.add(bulb);
    const lantern=new THREE.PointLight(0xffd9a0,2.4,8,1.9);
    lantern.position.set(x,2.5,13.5);bore.add(lantern);managedSceneLights.push(lantern);
  }
}
/**
 * The Silent Hill buildings: a supplied SH1 building model, cloned along both
 * streets in place of the generated brick boxes. Its measured world box is
 * x -8..8, z -1.8..6.5, 9.1 tall (the Sketchfab root recentres the OBJ), so
 * each entry is that box placed by eye: backs buried in outer walls only,
 * never poking into a neighbouring room, never crossing a street.
 */
/**
 * The Pokemon Center, filling the dead band in front of the stadium: a
 * supplied interior model at 0.66 scale, a kiosk under the arcade's ceiling.
 * The player walks in through a doorway cut in its west wall, crosses the
 * lobby, and leaves through the slot where the bookshelf beside the counter
 * stood — that cut lands exactly on the stadium wall's existing door gap, so
 * the bookshelf's place in the wall IS the vomitory entrance, framed by the
 * portal pylons already standing behind it.
 *
 * The model ships one merged unlit mesh, so the bookshelf and both openings
 * are cut by dropping triangles inside world-space boxes after placement:
 * unlit means it glows in the dark pocket without costing a single light,
 * and it sits 4 cm above the arcade slab so the two floors never z-fight.
 */
function installPokemonCenter(){
  void (async()=>{try{
    const loader=await getOptimizedGltfLoader();
    loader.load('assets/models/pokemon/pokemon-center.glb?v=pokecenter-1',gltf=>{
      const mount=new THREE.Group();
      mount.add(gltf.scene);
      mount.position.set(23.9,.04,-36.05);
      mount.scale.setScalar(.885);
      scene.add(mount);
      mount.updateWorldMatrix(true,true);
      // The wall map and the wall behind it, aligned on the stadium's door
      // gap — the shelf beside the counter stays. The model's own open
      // storefront faces the hall and the plaza south of it.
      // Loose: the wall is panelled in metre-wide quads whose corners sit
      // outside any door-sized box, so a triangle goes when ANY corner is
      // inside. The height cap keeps the roof band; whatever hung in the
      // door zone — the map — goes with the wall.
      const OPENINGS=[
        {minX:25.32,maxX:28.85,minY:-.2,maxY:3.6,minZ:-42.4,maxZ:-38.8}
      ];
      const vertex=new THREE.Vector3();
      mount.traverse(o=>{
        if(!o.isMesh)return;
        o.castShadow=false;o.receiveShadow=false;
        const geometry=o.geometry,position=geometry.attributes.position;
        const inOpening=index=>{
          vertex.fromBufferAttribute(position,index).applyMatrix4(o.matrixWorld);
          return OPENINGS.some(h=>vertex.x>=h.minX&&vertex.x<=h.maxX&&vertex.y>=h.minY&&vertex.y<=h.maxY&&vertex.z>=h.minZ&&vertex.z<=h.maxZ);
        };
        const oldIndex=geometry.index,kept=[];
        const count=oldIndex?oldIndex.count:position.count;
        for(let i=0;i<count;i+=3){
          const a=oldIndex?oldIndex.getX(i):i,b=oldIndex?oldIndex.getX(i+1):i+1,c=oldIndex?oldIndex.getX(i+2):i+2;
          if(inOpening(a)||inOpening(b)||inOpening(c))continue;
          kept.push(a,b,c);
        }
        geometry.setIndex(kept);
      });
      // The loose cut tears panels along their diagonals, so the opening is
      // finished as a portal: jambs down both sides, a header over the top,
      // and a lit strip under it — a gate, not a hole with a board on it.
      const portalSteel=new THREE.MeshStandardMaterial({color:0x11161f,emissive:0x0a1220,emissiveIntensity:.5,roughness:.5,metalness:.5});
      const portalGlow=new THREE.MeshStandardMaterial({color:0x4fd9ff,emissive:0x4fd9ff,emissiveIntensity:1.1,roughness:.3,metalness:.4});
      // The jambs sit exactly on the collision corridor: a doorway that
      // shows wider than it walks is an invisible wall wearing a frame.
      for(const jx of [25.7,28.45]){
        const jamb=new THREE.Mesh(new THREE.BoxGeometry(.34,3.3,.5),portalSteel);
        jamb.position.set(jx,1.65,-40.6);scene.add(jamb);
        const jambCap=new THREE.Mesh(new THREE.BoxGeometry(.34,.1,.5),portalGlow);
        jambCap.position.set(jx,3.36,-40.6);scene.add(jambCap);
      }
      const lintelPlate=new THREE.Mesh(new THREE.BoxGeometry(4.9,1.9,.5),portalSteel);
      lintelPlate.position.set(27.08,4.15,-40.6);scene.add(lintelPlate);
      const lintelTrim=new THREE.Mesh(new THREE.BoxGeometry(2.4,.09,.1),portalGlow);
      lintelTrim.position.set(27.08,3.22,-40.36);scene.add(lintelTrim);
      // The loose cut tears the whole east stretch of the wall away, and the
      // black gap it left read as walkable while the arcade wall behind it
      // refused the step — an invisible wall in a hole. The stretch is
      // rebuilt as clean panels in the building own colours, full-bright
      // like its unlit bake, leaving only the framed doorway.
      const centerWall=new THREE.MeshBasicMaterial({color:0xf2dfa6});
      const centerWainscot=new THREE.MeshBasicMaterial({color:0xd97a4e});
      for(const [wx,ww] of [[24.75,1.75],[31.3,5.2]]){
        const fill=new THREE.Mesh(new THREE.BoxGeometry(ww,4,.34),centerWall);
        fill.position.set(wx,2,-40.82);scene.add(fill);
        const skirt=new THREE.Mesh(new THREE.BoxGeometry(ww,.85,.1),centerWainscot);
        skirt.position.set(wx,.43,-40.6);scene.add(skirt);
      }
      const overDoor=new THREE.Mesh(new THREE.BoxGeometry(9.7,.95,.34),centerWall);
      overDoor.position.set(28.75,4.48,-40.82);scene.add(overDoor);
    },undefined,error=>console.warn('The Pokemon Center could not load.',error));
  }catch(error){console.warn('The Pokemon Center loader could not initialize.',error)}})();
}
function installSilentHillBuildings(){
  void (async()=>{try{
    const loader=await getOptimizedGltfLoader();
    loader.load('assets/models/silent-hill/sh1-building-11.glb?v=sh-buildings-1',gltf=>{
      const source=gltf.scene;
      source.traverse(o=>{if(o.isMesh){o.castShadow=false;o.receiveShadow=false}});
      for(const [x,z,turn,scale] of [
        [-28.1,-58.4,Math.PI/2,1],
        [-31,-65.4,0,1],
        [-48,-65.4,0,1.04],
        [-63,-65.4,0,.97],
        [-54.5,-41,Math.PI,1]
      ]){
        const building=source.clone(true);
        const mount=new THREE.Group();
        mount.add(building);
        mount.position.set(x,0,z);
        mount.rotation.y=turn;
        mount.scale.setScalar(scale);
        scene.add(mount);
      }
    },undefined,error=>console.warn('Silent Hill buildings could not load.',error));
  }catch(error){console.warn('Silent Hill building loader could not initialize.',error)}})();
}
function installChaoGardenFlora(){
  // Palms from the old procedural garden's prop file, and flower billboards,
  // seated on the real ground by the same ray the walk uses. All full-bright.
  void (async()=>{try{
    const loader=await getOptimizedGltfLoader();
    loader.load('assets/models/chao-garden-props.glb?v=chao-props-2',gltf=>{
      const palm=gltf.scene.getObjectByName('Palm');
      if(!palm)return;
      palm.traverse(o=>{if(o.isMesh){const m=Array.isArray(o.material)?o.material[0]:o.material;o.material=new THREE.MeshBasicMaterial({map:m.map??null,color:m.color?.clone()??new THREE.Color(0x3da53c),fog:false});o.castShadow=false;o.receiveShadow=false}});
      for(const [px,pz,scale,turn] of [[66,7.5,1.5,.4],[69.5,20,1.3,2.2],[65,31,1.6,4.1],[74,45,1.4,1.1],[84,7,1.35,3.3],[92,15,1.55,5.2],[98,29,1.3,.9],[88,45,1.5,2.7],[78,30,1.2,3.9],[95,51,1.4,1.8],[64,50,1.35,2.4],[72,52,1.2,4.6],[86,52,1.45,1.3],[94,53,1.25,3.1],[68,47,1.15,5.5]]){
        const ground=chaoLawnAt(px,pz);
        if(ground===null)continue;
        const tree=palm.clone(true);
        tree.position.set(px,ground,pz);tree.scale.setScalar(scale);tree.rotation.y=turn;
        scene.add(tree);
      }
    },undefined,()=>{});
  }catch(error){console.warn('Garden palms could not load.',error)}})();
  const flowerCanvas=document.createElement('canvas');flowerCanvas.width=flowerCanvas.height=64;
  const flowerContext=flowerCanvas.getContext('2d');
  const flowerColours=['#ff7fc4','#8fa8ff','#fff2f7','#ffd25f'];
  flowerContext.clearRect(0,0,64,64);
  for(let i=0;i<4;i++){
    const fx=16+(i%2)*30,fy=16+Math.floor(i/2)*30;
    flowerContext.fillStyle=flowerColours[i];
    for(let petal=0;petal<5;petal++){
      const angle=petal*Math.PI*2/5;
      flowerContext.beginPath();flowerContext.ellipse(fx+Math.cos(angle)*6,fy+Math.sin(angle)*6,5,5,0,0,Math.PI*2);flowerContext.fill();
    }
    flowerContext.fillStyle='#ffe97a';
    flowerContext.beginPath();flowerContext.arc(fx,fy,3.6,0,Math.PI*2);flowerContext.fill();
  }
  const flowerTexture=new THREE.CanvasTexture(flowerCanvas);flowerTexture.colorSpace=THREE.SRGBColorSpace;
  const flowerMaterial=new THREE.MeshBasicMaterial({map:flowerTexture,transparent:true,side:THREE.DoubleSide,fog:false});
  for(let i=0;i<26;i++){
    const fx=63+((i*173)%370)/10,fz=6+((i*257)%440)/10;
    const ground=chaoLawnAt(fx,fz);
    if(ground===null)continue;
    const patch=new THREE.Group();
    for(const spin of [0,Math.PI/2]){
      const quad=new THREE.Mesh(new THREE.PlaneGeometry(.55,.4),flowerMaterial);
      quad.rotation.y=spin;quad.position.y=.2;patch.add(quad);
    }
    patch.position.set(fx,ground,fz);patch.rotation.y=i*1.7;
    scene.add(patch);
  }
}
function installChaoGardenEggs(){
  // Chao eggs: the garden's whole point. Speckled shells in the classic
  // colours, seated on the lawn.
  const speckleCanvas=document.createElement('canvas');speckleCanvas.width=speckleCanvas.height=64;
  const speckleContext=speckleCanvas.getContext('2d');
  speckleContext.fillStyle='#ffffff';speckleContext.fillRect(0,0,64,64);
  speckleContext.globalAlpha=.5;
  for(let i=0;i<26;i++){
    speckleContext.fillStyle=i%2?'#00000022':'#00000014';
    speckleContext.beginPath();speckleContext.arc((i*37)%64,(i*53)%64,2.4+(i%3),0,Math.PI*2);speckleContext.fill();
  }
  speckleContext.globalAlpha=1;
  const speckleTexture=new THREE.CanvasTexture(speckleCanvas);speckleTexture.colorSpace=THREE.SRGBColorSpace;
  const eggColours=[0xfff8ea,0xbfe8c9,0xffc9dd,0xbcd4ff,0xffe08a,0xd9c2f0,0xfff8ea,0xc9f0ee,0xffd9b0];
  const eggGeometry=new THREE.SphereGeometry(.34,18,14);
  eggColours.forEach((colour,index)=>{
    const egg=new THREE.Mesh(eggGeometry,new THREE.MeshBasicMaterial({map:speckleTexture,color:colour,fog:false}));
    const ex=64+((index*211)%330)/10,ez=8+((index*307)%420)/10;
    const ground=chaoLawnAt(ex,ez);
    if(ground===null)return;
    egg.scale.set(1,1.32,1);
    egg.position.set(ex,ground+.4,ez);
    egg.rotation.set(((index*73)%10-5)*.03,index*1.3,((index*41)%10-5)*.03);
    scene.add(egg);
  });
}
function installChaoGardenModel(){
  void (async()=>{try{
    const loader=await getOptimizedGltfLoader();
    loader.load('assets/models/chao-garden-3.glb?v=garden-exact-6',gltf=>{
      // Everything hard about this model is baked into the file now: world
      // transform, the flattened walkable ground, the clean rock cap on the
      // west cut, and the carved tunnel corridor. The runtime just mounts it.
      // The model's own water texture is saturated blue and no tint can
      // desaturate a map, so the falls get a painted one: soft white streams
      // over the faintest aqua, the reference's water exactly.
      const waterCanvas=document.createElement('canvas');waterCanvas.width=128;waterCanvas.height=256;
      const waterContext=waterCanvas.getContext('2d');
      waterContext.fillStyle='rgba(214,240,250,.55)';waterContext.fillRect(0,0,128,256);
      for(let streak=0;streak<46;streak++){
        const wx=(streak*29)%128,ww=2+(streak*13)%5;
        const streakGradient=waterContext.createLinearGradient(0,0,0,256);
        streakGradient.addColorStop(0,'rgba(255,255,255,'+(0.22+(streak%4)*0.12)+')');
        streakGradient.addColorStop(.5,'rgba(255,255,255,'+(0.08+(streak%3)*0.08)+')');
        streakGradient.addColorStop(1,'rgba(255,255,255,'+(0.3+(streak%4)*0.1)+')');
        waterContext.fillStyle=streakGradient;
        waterContext.fillRect(wx,0,ww,256);
      }
      const waterTexture=new THREE.CanvasTexture(waterCanvas);
      waterTexture.wrapS=waterTexture.wrapT=THREE.RepeatWrapping;waterTexture.repeat.set(3,1.4);
      waterTexture.colorSpace=THREE.SRGBColorSpace;
      beforeRenderCallbacks.push((now,delta)=>{waterTexture.offset.y-=delta*.32});
      const source=gltf.scene,doomed=[];
      source.traverse(node=>{
        if(node.isCamera||node.isLight){doomed.push(node);return}
        if(!node.isMesh)return;
        node.castShadow=false;node.receiveShadow=false;
        // The reference look is the Dreamcast's: textures at full brightness,
        // no scene lighting, no arcade fog. One material swap gets all of it.
        const materials=Array.isArray(node.material)?node.material:[node.material];
        const replaced=materials.map(material=>{
          const name=material.name||'';
          const isWater=/0012|0013|0033/.test(name);
          const isRock=/0011|0014|0032/.test(name);
          const bright=new THREE.MeshBasicMaterial({
            map:isWater?waterTexture:(material.map??null),
            color:isRock?new THREE.Color(0xc9d3dd):new THREE.Color(0xffffff),
            transparent:isWater||material.transparent,
            opacity:isWater?.5:material.opacity,
            depthWrite:!isWater,
            side:THREE.DoubleSide,fog:false});
          bright.userData.isLawn=/0010/.test(name);
          bright.userData.isWater=isWater;
          return bright;
        });
        node.material=Array.isArray(node.material)?replaced:replaced[0];
      });
      doomed.forEach(node=>node.removeFromParent());
      source.name='chao-garden-environment';
      scene.add(source);
      chaoGardenMount=source;
      // The authored falls leave gaps between tiers; one continuous curtain,
      // sized off the tall water geometry itself, completes the drop.
      const fallsBox=new THREE.Box3(),pieceBox=new THREE.Box3(),fallsSlabs=[];
      let fallsFound=false;
      source.traverse(node=>{
        if(!node.isMesh)return;
        const materials=Array.isArray(node.material)?node.material:[node.material];
        if(!materials.some(material=>material.map===waterTexture))return;
        pieceBox.setFromObject(node);
        if(pieceBox.max.y-pieceBox.min.y<8)return;
        // these building-sized translucent slabs are what hid the rock:
        // they go, and thin streams take their place
        fallsSlabs.push(node);
        if(fallsFound)fallsBox.union(pieceBox);else{fallsBox.copy(pieceBox);fallsFound=true}
      });
      fallsSlabs.forEach(node=>node.removeFromParent());
      if(fallsFound){
        const fallsCentreX=(fallsBox.min.x+fallsBox.max.x)/2;
        const fallsSpan=fallsBox.max.x-fallsBox.min.x;
        const fallsTop=fallsBox.max.y-4;
        const fallsHeight=fallsTop-fallsBox.min.y;
        const curtainMaterial=new THREE.MeshBasicMaterial({map:waterTexture,transparent:true,opacity:.48,depthWrite:false,side:THREE.DoubleSide,fog:false});
        // three narrow streams instead of one milky wall: rock shows between
        for(const [offset,widthShare,heightShare] of [[-.22,.2,1],[.06,.3,.92],[.32,.16,.8]]){
          const stream=new THREE.Mesh(new THREE.PlaneGeometry(fallsSpan*widthShare,fallsHeight*heightShare),curtainMaterial);
          stream.position.set(fallsCentreX+fallsSpan*offset,fallsBox.min.y+fallsHeight*heightShare/2,fallsBox.min.z-.35);
          scene.add(stream);
        }
        // the headwall sits right behind the streams' crest: the rock the
        // water falls from, in plain view
        const headwallMaterial=new THREE.MeshBasicMaterial({map:chaoRockTexture,color:0xc9d3dd,fog:false});
        const headwall=new THREE.Mesh(new THREE.BoxGeometry(fallsSpan+10,9,8),headwallMaterial);
        headwall.position.set(fallsCentreX,fallsTop+3.6,fallsBox.min.z+2.8);
        scene.add(headwall);
      }
      chaoGardenFallback.visible=false;
      installChaoGardenFlora();
      installChaoGardenEggs();
    },undefined,error=>console.warn('The Chao Garden model could not load.',error));
  }catch(error){console.warn('The Chao Garden model loader could not initialize.',error)}})();
}
/**
 * The Silent Hill room: an empty city block in dense fog.
 *
 * A wet street runs the depth of the room, walled by
 * dark brick facades that rise past the building's ceiling through their own
 * hole — above them there is only the dark the fog fades into. An abandoned
 * car sits mid-street, dead streetlamps and poles line the kerbs, and the fog
 * itself is layered billboards, so it costs geometry rather than lights.
 *
 * Cryptic red arrows are painted on the asphalt, leading from the doorway
 * through the fog toward the back of the block — where the game machines will
 * stand, with the monsters hidden along the way.
 */
function buildSilentHillBlock(){
  const CX=-32.4,MIN_Z=-67,MAX_Z=-42.2,CZ=(MIN_Z+MAX_Z)/2;
  // The street: cracked asphalt with a faded double centre line.
  const roadCanvas=document.createElement('canvas');roadCanvas.width=256;roadCanvas.height=512;
  const rc=roadCanvas.getContext('2d');
  rc.fillStyle='#1e2124';rc.fillRect(0,0,256,512);
  for(let i=0;i<700;i++){const x=(i*37)%256,y=(i*91)%512;rc.fillStyle=i%2?'#24282c':'#191c1f';rc.globalAlpha=.5;rc.fillRect(x,y,2,2)}
  rc.globalAlpha=1;rc.strokeStyle='#141619';rc.lineWidth=1.6;
  for(let i=0;i<7;i++){rc.beginPath();rc.moveTo((i*67)%256,0);
    for(let y=0;y<512;y+=52){rc.lineTo(((i*67)%256)+((y*13+i*29)%34)-17,y)}rc.stroke()}
  rc.fillStyle='#8f8348';rc.globalAlpha=.55;
  for(let y=6;y<512;y+=44){rc.fillRect(120,y,5,26);rc.fillRect(131,y,5,26)}
  rc.globalAlpha=1;
  const roadTexture=new THREE.CanvasTexture(roadCanvas);roadTexture.colorSpace=THREE.SRGBColorSpace;
  const road=new THREE.Mesh(new THREE.PlaneGeometry(21.2,MAX_Z-MIN_Z),
    new THREE.MeshStandardMaterial({map:roadTexture,roughness:.55,metalness:.25}));
  road.rotation.x=-Math.PI/2;road.position.set(CX,.025,CZ);road.receiveShadow=true;scene.add(road);
  // Kerbs along both sides.
  const kerb=new THREE.MeshStandardMaterial({color:0x2c3034,roughness:.85});
  for(const side of [-1,1]){
    const walk=new THREE.Mesh(new THREE.BoxGeometry(1.7,.14,MAX_Z-MIN_Z),kerb);
    walk.position.set(CX+side*9.6,.07,CZ);scene.add(walk);
  }
  // The buildings are no longer generated: real Silent Hill 1 building
  // geometry stands along both streets, cloned from a supplied model —
  // installSilentHillBuildings, loaded on approach like every heavy asset.
  // A cross-street runs west out of the building into the annex, and the
  // parking lot at the end of it is where the game machines will stand.
  const crossRoad=new THREE.Mesh(new THREE.PlaneGeometry(10,21.4),
    new THREE.MeshStandardMaterial({map:roadTexture,roughness:.55,metalness:.25}));
  crossRoad.rotation.x=-Math.PI/2;crossRoad.rotation.z=Math.PI/2;
  crossRoad.position.set(-53.9,.026,-52);crossRoad.receiveShadow=true;scene.add(crossRoad);
  for(const side of [-1,1]){
    const crossWalk=new THREE.Mesh(new THREE.BoxGeometry(21.4,.14,1.7),kerb);
    crossWalk.position.set(-53.9,.07,-52+side*5.85);scene.add(crossWalk);
  }
  // The abandoned car, mid-street where the reference parks it.
  const paint=new THREE.MeshStandardMaterial({color:0x24333a,roughness:.4,metalness:.5});
  const body=new THREE.Mesh(new THREE.BoxGeometry(1.05,.5,2.3),paint);body.position.set(CX+.9,.42,CZ+1.2);body.rotation.y=.09;scene.add(body);
  const cabin=new THREE.Mesh(new THREE.BoxGeometry(.95,.42,1.25),paint);cabin.position.set(CX+.9,.85,CZ+1.05);cabin.rotation.y=.09;scene.add(cabin);
  const tyre=new THREE.MeshStandardMaterial({color:0x0d0f11,roughness:.95});
  for(const [dx,dz] of [[-.5,-.75],[.5,-.75],[-.5,.8],[.5,.8]]){
    const wheel=new THREE.Mesh(new THREE.CylinderGeometry(.19,.19,.14,10),tyre);
    wheel.rotation.z=Math.PI/2;wheel.position.set(CX+.9+dx,.19,CZ+1.2+dz);scene.add(wheel);
  }
  // The streetlamps and their wires are gone: bare grey sticks floating in
  // fog read as debug geometry, not a dead town. The fog and the buildings
  // carry the street on their own.
  // The fog: a soft radial billboard, layered standing and lying down. Static,
  // unlit, additive-free — grey on grey is what makes it read as weather.
  const fogCanvas=document.createElement('canvas');fogCanvas.width=128;fogCanvas.height=128;
  const fg=fogCanvas.getContext('2d');
  const puff=fg.createRadialGradient(64,64,8,64,64,64);
  puff.addColorStop(0,'rgba(168,175,178,.75)');puff.addColorStop(.6,'rgba(160,168,172,.35)');puff.addColorStop(1,'rgba(160,168,172,0)');
  fg.fillStyle=puff;fg.fillRect(0,0,128,128);
  const fogTexture=new THREE.CanvasTexture(fogCanvas);fogTexture.colorSpace=THREE.SRGBColorSpace;
  const fogMaterial=new THREE.MeshBasicMaterial({map:fogTexture,transparent:true,opacity:.55,depthWrite:false,side:THREE.DoubleSide});
  const fogGeometry=new THREE.PlaneGeometry(7.5,6.5);
  for(let i=0;i<70;i++){
    const sheet=new THREE.Mesh(fogGeometry,fogMaterial);
    sheet.position.set(CX+((i*73)%180)/10-9,(i%3)*1.5+1.7,MIN_Z+1+((i*127)%230)/10);
    sheet.rotation.y=(i*2.399)%Math.PI;
    sheet.renderOrder=3;scene.add(sheet);
  }
  // The back of the block drowns deepest, and the whole annex drowns with
  // it: standing sheets across both, thickening toward the lot.
  for(let i=0;i<22;i++){
    const sheet=new THREE.Mesh(fogGeometry,fogMaterial);
    sheet.position.set(CX+((i*67)%180)/10-9,(i%3)*1.5+1.7,MIN_Z+.6+((i*113)%60)/10);
    sheet.rotation.y=(i*1.93)%Math.PI;
    sheet.renderOrder=3;scene.add(sheet);
  }
  for(let i=0;i<55;i++){
    const sheet=new THREE.Mesh(fogGeometry,fogMaterial);
    sheet.position.set(-64+((i*73)%200)/10,(i%3)*1.5+1.7,-66+((i*127)%230)/10);
    sheet.rotation.y=(i*2.399)%Math.PI;
    sheet.renderOrder=3;scene.add(sheet);
  }
  const mistGeometry=new THREE.PlaneGeometry(9,6.5);
  for(let i=0;i<24;i++){
    const mist=new THREE.Mesh(mistGeometry,fogMaterial);
    mist.rotation.x=-Math.PI/2;mist.rotation.z=(i*1.7)%Math.PI;
    mist.position.set(CX+((i*89)%220)/10-8,.5+(i%2)*.35,MIN_Z+2+((i*151)%220)/10);
    mist.renderOrder=3;scene.add(mist);
  }
  // The annex's own ground mist, lying across the cross-street and the lot.
  for(let i=0;i<16;i++){
    const mist=new THREE.Mesh(mistGeometry,fogMaterial);
    mist.rotation.x=-Math.PI/2;mist.rotation.z=(i*1.7)%Math.PI;
    mist.position.set(-63+((i*89)%190)/10,.5+(i%2)*.35,-65+((i*151)%210)/10);
    mist.renderOrder=3;scene.add(mist);
  }
  // The red arrows, painted rough on the asphalt: the trail from the doorway
  // into the fog, toward where the machines will stand.
  const arrowCanvas=document.createElement('canvas');arrowCanvas.width=128;arrowCanvas.height=96;
  const ac=arrowCanvas.getContext('2d');
  ac.fillStyle='#7d100c';
  ac.beginPath();ac.moveTo(10,38);ac.lineTo(78,38);ac.lineTo(78,16);ac.lineTo(120,48);ac.lineTo(78,80);ac.lineTo(78,58);ac.lineTo(10,58);ac.closePath();ac.fill();
  // Worn through: speckle holes so it reads painted long ago, not signage.
  ac.globalCompositeOperation='destination-out';
  for(let i=0;i<90;i++){ac.globalAlpha=.5;ac.beginPath();ac.arc((i*37)%128,(i*53)%96,1.6+(i%4),0,Math.PI*2);ac.fill()}
  ac.globalCompositeOperation='source-over';ac.globalAlpha=1;
  const arrowTexture=new THREE.CanvasTexture(arrowCanvas);arrowTexture.colorSpace=THREE.SRGBColorSpace;
  const arrowMaterial=new THREE.MeshBasicMaterial({map:arrowTexture,transparent:true,opacity:.85,depthWrite:false});
  // The trail turns west at the junction now: up the main street, out of the
  // building through the opened wall, and along the cross-street to the lot.
  const trail=[[-32.4,-43.4],[-33.9,-46.3],[-35.6,-49.2],[-37.6,-51.6],[-40.6,-52.6],[-43.8,-52.2],[-47,-51.8],[-50.2,-52.4],[-53.4,-52.8],[-56.6,-52.2],[-59.4,-51.9]];
  for(let i=0;i<trail.length;i++){
    const [ax,az]=trail[i];
    const next=trail[i+1]??[-61.8,-51.8];
    const arrow=new THREE.Mesh(new THREE.PlaneGeometry(1.15,.86),arrowMaterial);
    arrow.rotation.x=-Math.PI/2;
    arrow.rotation.z=-Math.atan2(next[1]-az,next[0]-ax);
    arrow.position.set(ax,.045,az);arrow.renderOrder=4;scene.add(arrow);
  }
  // What light there is: two sickly grey-green pools on the managed budget.
  for(const [x,z] of [[-31.5,-45],[-35,-55],[-29,-63],[-48,-52],[-57,-52.5],[-62.5,-51.5]]){
    const pall=new THREE.PointLight(0xaab8a4,2.6,13,2);
    pall.position.set(x,3.2,z);scene.add(pall);managedSceneLights.push(pall);
  }
  // A second car, nose-in at the back lot, and faded parking bays beside it —
  // the lot is where the machines will stand, at the end of the arrow trail.
  const paint2=new THREE.MeshStandardMaterial({color:0x3a3330,roughness:.5,metalness:.4});
  const body2=new THREE.Mesh(new THREE.BoxGeometry(1.05,.5,2.3),paint2);body2.position.set(-59.8,.42,-50.2);body2.rotation.y=2.7;scene.add(body2);
  const cabin2=new THREE.Mesh(new THREE.BoxGeometry(.95,.42,1.25),paint2);cabin2.position.set(-59.9,.85,-50.14);cabin2.rotation.y=2.7;scene.add(cabin2);
  const bay=new THREE.MeshBasicMaterial({color:0x9aa0a4,transparent:true,opacity:.16,depthWrite:false});
  for(let i=0;i<5;i++){
    const line=new THREE.Mesh(new THREE.PlaneGeometry(.1,4.4),bay);
    line.rotation.x=-Math.PI/2;line.rotation.z=1.2;
    line.rotation.z=Math.PI/2;
    line.position.set(-62.2,.03,-56+i*2.05);scene.add(line);
  }
}
buildSilentHillBlock();
// No light rig added per room: the ring already lays one into every side room,
// and a second in the same room is two rigs competing for the same light
// budget. The stadium's floodlights are the exception, and they are its point.
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
  const west=roomX<0;
  const columnFloor=new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SPAN,SIDE_COLUMN_DEPTH),worldAlignedFloorMaterial(ROOM_SPAN,SIDE_COLUMN_DEPTH,roomX,SIDE_COLUMN_CENTER_Z,EXPANSION_FLOOR_STYLE));
  columnFloor.rotation.x=-Math.PI/2;columnFloor.position.set(roomX,.002,SIDE_COLUMN_CENTER_Z);columnFloor.receiveShadow=true;scene.add(columnFloor);
  // Both columns run under a plate again in full: Silent Hill left the west
  // column for the top row's corner, and Zelda's murals took its old room.
  if(west)box(ROOM_SPAN,.12,67.2,0x090b18,roomX,5.08,0,.08);
  // The east column's plate stops at the garden's new room: its sky dome
  // rises through the hole cut for it. The old garden room is the Pokemon
  // Center's plaza now, covered by the main ceiling like any other room.
  else{box(ROOM_SPAN,.12,16.8,0x090b18,roomX,5.08,-3.6,.08);box(ROOM_SPAN,.12,16.8,0x090b18,roomX,5.08,13.2,.08);box(ROOM_SPAN,.12,12,0x090b18,roomX,5.08,27.6,.08);}
  for(const wallZ of [SIDE_COLUMN_MIN_Z,-ROOM_DEPTH,0,ROOM_DEPTH,SIDE_COLUMN_MAX_Z]){
    // The east column's end wall is gone: the Pokemon Center runs from the
    // stadium's wall across the old band pocket into its plaza.
    if(!west&&wallZ===SIDE_COLUMN_MIN_Z)continue;
    // The east column's dividers all moved with the garden's growth: full
    // rooms follow it, and the bottom room absorbs the squeeze.
    const wallAt=(!west&&EAST_WALL_Z[String(wallZ)]!==undefined)?EAST_WALL_Z[String(wallZ)]:wallZ;
    const wall=box(ROOM_SPAN-.4,5,.3,0x11182c,roomX+(west?-.2:.2),2.5,wallAt,.05);wall.receiveShadow=true;
  }
  SIDE_ROOM_Z.forEach((centerZ,index)=>{
    // The Chao Garden lights itself — suns and sky — so its new slot takes
    // no troffers; the plaza it left inherits the rig like any room.
    if(!west&&index===2)return;
    const at=west?centerZ:EAST_ROOM_Z[index];
    for(let z=at-6;z<=at+6;z+=4)box(ROOM_SPAN-.5,.035,.055,0x4e7ea8,roomX,4.65,z,.8);
    lightRoom(roomX,at,ROOM_SPAN,ROOM_DEPTH,SIDE_ROOM_ACCENTS[index]);
  });
}
// The top row, and the full-width band of hall in front of it.
const NORTH_ROW_CENTER_Z=(NORTH_ROW_MIN_Z+TOP_BAND_MIN_Z)/2,TOP_BAND_CENTER_Z=(TOP_BAND_MIN_Z+SIDE_COLUMN_MIN_Z)/2;
// Silent Hill's annex floor, outside the building proper: no ceiling above
// it, ever — the open dark is the point.
const silentAnnexFloor=new THREE.Mesh(new THREE.PlaneGeometry(21.6,25.2),worldAlignedFloorMaterial(21.6,25.2,-54,-54.6,EXPANSION_FLOOR_STYLE));
silentAnnexFloor.rotation.x=-Math.PI/2;silentAnnexFloor.position.set(-54,.002,-54.6);silentAnnexFloor.receiveShadow=true;scene.add(silentAnnexFloor);
const northRowFloor=new THREE.Mesh(new THREE.PlaneGeometry(SHELL_HALF_WIDTH*2,ROOM_DEPTH),worldAlignedFloorMaterial(SHELL_HALF_WIDTH*2,ROOM_DEPTH,0,NORTH_ROW_CENTER_Z,EXPANSION_FLOOR_STYLE));
northRowFloor.rotation.x=-Math.PI/2;northRowFloor.position.set(0,.002,NORTH_ROW_CENTER_Z);northRowFloor.receiveShadow=true;scene.add(northRowFloor);
box(32.4,.12,ROOM_DEPTH,0x090b18,-5.4,5.08,NORTH_ROW_CENTER_Z,.08);
// The middle top-row room absorbed the strip the stadium's wall cut off its
// neighbour, so its rig is wider. Neither corner needs one — the stadium's
// bowl carries its own light and Silent Hill is lit by its own palls — and
// the band's rig stops where the fog begins.
lightRoom(-5.4,NORTH_ROW_CENTER_Z,32.4,ROOM_DEPTH,SIDE_ROOM_ACCENTS[1]);
lightRoom(10.8,TOP_BAND_CENTER_Z,64.8,ROOM_DEPTH,0xffb066);
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
// The annex went with Silent Hill, so the hall's ceiling is full width again.
const tournamentCeiling=box(86.4,.12,TOURNAMENT_ROOM_DEPTH,0x090b18,0,5.08,TOURNAMENT_ROOM_CENTER_Z,.08);tournamentCeiling.receiveShadow=true;
box(.3,5,TOURNAMENT_ROOM_DEPTH,0x11182c,-SHELL_HALF_WIDTH,2.5,TOURNAMENT_ROOM_CENTER_Z,.06);box(.3,5,TOURNAMENT_ROOM_DEPTH,0x11182c,SHELL_HALF_WIDTH,2.5,TOURNAMENT_ROOM_CENTER_Z,.06);
box(TOURNAMENT_ROOM_WIDTH,5,.3,0x11182c,0,2.5,TOURNAMENT_ROOM_BACK_Z,.06);
// The hub's front wall, either side of the one doorway. It reaches the
// partition walls rather than stopping short of them, which used to leave a two
// metre hole at each end that only the old room's narrower side walls covered.
box(SHELL_HALF_WIDTH-ROOM_DOOR_HALF_WIDTH,5,.3,0x11182c,-(SHELL_HALF_WIDTH+ROOM_DOOR_HALF_WIDTH)/2,2.5,TOURNAMENT_ROOM_DOOR_Z,.06);
box(SHELL_HALF_WIDTH-ROOM_DOOR_HALF_WIDTH,5,.3,0x11182c,(SHELL_HALF_WIDTH+ROOM_DOOR_HALF_WIDTH)/2,2.5,TOURNAMENT_ROOM_DOOR_Z,.06);
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
/**
 * A cabinet whose body is a supplied model rather than the procedural shell:
 * the Pokemon machines. The plinth, underglow, floor glow, marquee plate and
 * status light are the house language every cabinet speaks; the model is the
 * machine itself, loaded once per file on approach and cloned into place.
 * Models are Y-up with their ground at zero and their front on +z, measured
 * before placement, so an entry is a scale and a yard position.
 */
const pokemonMachineFiles=new Map();
function loadPokemonMachine(file){
  if(pokemonMachineFiles.has(file))return pokemonMachineFiles.get(file);
  const pending=(async()=>{
    // The row is built during module evaluation, before the loader further
    // down the file exists: one yielded tick and the whole file has run.
    await new Promise(resolve=>setTimeout(resolve));
    const loader=await getOptimizedGltfLoader();
    return await new Promise((resolve,reject)=>loader.load(file,gltf=>{
      gltf.scene.traverse(o=>{if(o.isMesh){o.castShadow=false;o.receiveShadow=false}});
      resolve(gltf.scene);
    },undefined,reject));
  })();
  pokemonMachineFiles.set(file,pending);
  return pending;
}
function makeModelCabinet(id,name,x,z,hue,system,model){
  const g=new THREE.Group();g.position.set(x,0,z);g.rotation.y=model.rotY??0;
  const plinth=new THREE.Mesh(cabinetGeometry.plinth,cabinetPlinthMaterial);plinth.position.y=.05;plinth.scale.set(model.plinthScale??1.4,1,model.plinthScale??1.4);g.add(plinth);
  const underglowMat=new THREE.MeshBasicMaterial({color:hue,transparent:true,opacity:.62});
  const railScale=model.plinthScale??1.4;
  for(const [railGeometry,px,pz] of [[cabinetGeometry.railLong,0,.52*railScale],[cabinetGeometry.railLong,0,-.52*railScale],[cabinetGeometry.railSide,.72*railScale,0],[cabinetGeometry.railSide,-.72*railScale,0]]){
    const rail=new THREE.Mesh(railGeometry,underglowMat);rail.scale.set(railScale,1,railScale);rail.position.set(px,.106,pz);g.add(rail);
  }
  const floorGlow=new THREE.PointLight(hue,1.3,3,2);floorGlow.position.set(0,.14,0);g.add(floorGlow);
  if(!model.noPlate){
    const plate=new THREE.Mesh(new THREE.PlaneGeometry(1.9,.58),new THREE.MeshBasicMaterial({map:cabinetMarqueeTexture(name,hue,system),side:THREE.DoubleSide}));
    plate.position.set(0,model.plateY??3.4,.1);g.add(plate);
  }
  // Key art instead of a text marquee where the user supplied it: a standing
  // pad on the floor in front of the machine, or a banner across the machine's
  // blank top. Both load lazily and simply stay absent until their file exists.
  const artPlane=(art,place)=>{if(!art)return;cabinetArtLoader.load('assets/art/pokemon/'+art.file+'?v=poke-mats-1',texture=>{
    texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;
    const aspect=texture.image.height/texture.image.width;
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(art.w,art.w*aspect),new THREE.MeshBasicMaterial({map:texture}));
    place(mesh,aspect);g.add(mesh);
  },undefined,()=>{});};
  artPlane(model.mat,mesh=>{mesh.rotation.x=-Math.PI/2;mesh.position.set(0,.065,model.matZ??1.35)});
  artPlane(model.top,mesh=>{mesh.position.set(0,model.top.y,model.top.z);mesh.rotation.x=model.top.tilt??0});
  const statusMaterial=new THREE.MeshStandardMaterial({color:0x50ff9a,emissive:0x50ff9a,emissiveIntensity:2.4});
  const statusLight=new THREE.Mesh(cabinetGeometry.statusLight,statusMaterial);statusLight.position.set(1.05,model.statusY??(model.plateY??3.4)-.02,.1);g.add(statusLight);
  const screen=new THREE.Mesh(new THREE.PlaneGeometry(.72,.54),new THREE.MeshBasicMaterial({color:0x050710}));
  screen.position.set(0,1.4,model.screenZ??.2);screen.visible=false;g.add(screen);
  void loadPokemonMachine(model.file).then(source=>{
    const body=source.clone(true);
    body.scale.setScalar(model.scale);
    body.position.y=(model.lift??0)+.1;body.position.z=model.offsetZ??0;
    g.add(body);
  }).catch(error=>console.warn('A Pokemon machine model could not load.',error));
  scene.add(g);
  const cabinet={id,g,name,type:id.toUpperCase(),screen,hue,statusLight,controlSlot:new THREE.Group(),controllerSystem:system,renderLights:[floorGlow],status:'syncing',occupiedByDisplayName:null,enabled:true};
  cabinets.push(cabinet);cabinetsById.set(id,cabinet);indexCabinet(cabinet);
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
  // Metal Gear Solid stands in its own themed room, in front of the far
  // mural, the way the Mega Man room fronts its cabinets with its art. The
  // rest hold their foyer slots.
  const slot=id==='metal-gear-solid'?{x:-32.4,z:-1.8,rotation:Math.PI}:FOYER_WEST[index];
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
// Cabinet 10 was an empty shell holding a seat for a game that never came.
const MEGAMAN_CABINET_ORDER=[1,2,3,4,5,6,8,7,9];
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
for(const [index,x,z,rotation,hue] of n64CabinetLayout){
  // Pokemon Snap moved to the plaza, into the Pokemon arcade machine.
  if(index===1)continue;
  const cabinetId=`n64-cabinet-0${index}`,hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);makeCabinet(cabinetId,hosted?hosted.name.toUpperCase():`N64 // READY 0${index}`,x,z,hue,false,false,'n64');const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;configureHostedCabinet(cabinetId)}
/**
 * The Pokemon library, lined up on the arena platform's north deck strip in
 * release order — the Game Boy line on the Game Boy machines through VBA-M,
 * the DS library on the DS Lite machines through melonDS, and Pokemon Snap
 * in the Pokemon arcade machine where it landed between Blue and Yellow.
 * All face the field; every machine carries its own cart.
 */
const POKEMON_MACHINE_MODELS={
  gb:{file:'assets/models/pokemon/gameboy-cabinet.glb?v=poke-machines-1',scale:.17,plateY:3.35,plinthScale:1.15},
  arc:{file:'assets/models/pokemon/pokemon-arcade-cabinet.glb?v=poke-machines-1',scale:.374,plateY:3.9,plinthScale:1.15},
  ds:{file:'assets/models/pokemon/nds-cabinet.glb?v=poke-machines-1',scale:.22,plateY:2.6,plinthScale:1.6},
  gbasp:{file:'assets/models/pokemon/gba-sp-cabinet.glb?v=poke-machines-2',scale:.5,plateY:2.6,plinthScale:1.15,lift:.61,offsetZ:-.48}
};
const POKEMON_MACHINE_ROW=[
  ['gameboy-cabinet-01','gb',1.46,0xff5f5f,{noPlate:true,statusY:3.06,mat:{file:'pokemon-red-mat.webp',w:1.8}}],
  ['gameboy-cabinet-02','gb',3.5,0x5f8cff,{noPlate:true,statusY:3.06,mat:{file:'pokemon-blue-mat.webp',w:1.8}}],
  ['n64-cabinet-01','arc',5.49,0xffd23e,{noPlate:true,statusY:3.35,top:{file:'pokemon-snap-banner.png',w:1.07,y:2.1,z:.12,tilt:0}}],
  ['gameboy-cabinet-03','gb',7.49,0xffe45f,{noPlate:true,statusY:3.06,mat:{file:'pokemon-yellow-mat.webp',w:1.8}}],
  ['gameboy-cabinet-04','gb',9.52,0xd9b44a],
  ['gameboy-cabinet-05','gb',11.54,0xc8ccd4],
  ['gameboy-cabinet-06','gb',13.57,0x8ee6ff],
  ['gameboy-cabinet-07','gbasp',15.6,0xd45f5f],
  ['gameboy-cabinet-08','gbasp',17.63,0x4a8cd4],
  ['gameboy-cabinet-09','gbasp',19.66,0xff8c5f],
  ['gameboy-cabinet-10','gbasp',21.7,0x7dff67],
  ['gameboy-cabinet-11','gbasp',23.73,0xb08cff],
  ['gameboy-cabinet-12','gbasp',25.76,0x4ad48c],
  ['nds-cabinet-01','ds',28.4,0x8cb4ff],
  ['nds-cabinet-02','ds',31.65,0xffb4d9],
  ['nds-cabinet-03','ds',34.9,0xd9d9e6],
  ['nds-cabinet-04','ds',38.15,0xffcf6b],
  ['nds-cabinet-05','ds',41.4,0xc0c0d0],
  ['nds-cabinet-06','ds',44.65,0x4a4a5f],
  ['nds-cabinet-07','ds',47.9,0xf0f0f5],
  ['nds-cabinet-08','ds',51.15,0x5f5f74],
  ['nds-cabinet-09','ds',54.4,0xfafaff]
];
for(const [cabinetId,kind,rowX,hue,opts] of POKEMON_MACHINE_ROW){
  const hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);
  const label=hosted?hosted.name.toUpperCase():cabinetId.toUpperCase();
  const model=opts?{...POKEMON_MACHINE_MODELS[kind],...opts}:POKEMON_MACHINE_MODELS[kind];
  makeModelCabinet(cabinetId,label,rowX,-127.2,hue,hosted?.system??(kind==='ds'?'nds':'gb'),model);
  configureHostedCabinet(cabinetId);
}
// Five experimental GameCube cabinets sit inside their dedicated construction
// room, facing its doorway. Gecko remains available for later runtime work, but
// the cabinets cannot be reached while the room is blocked.
const gamecubeTitles=['THE LEGEND OF ZELDA: THE WIND WAKER','THE LEGEND OF ZELDA: TWILIGHT PRINCESS','PIKMIN','SUPER SMASH BROS. MELEE','SUPER MARIO SUNSHINE'];
const GAMECUBE_HUES=[0x8b5cf6,0x36f9f6,0xff4da6,0x7dff67,0xffb42e];
// Cabinet 04 — Super Smash Bros. Melee — stands in the tournament hall with
// the other headline multiplayer games; the rest hold their foyer slots, so a
// missing cabinet reads as a gap in the row rather than a renumbering.
const gamecubeCabinetLayout=GAMECUBE_HUES.map((hue,index)=>index===3
  ?[4,-9,42,Math.PI/2,hue]
  :[index+1,FOYER_EAST[7+index].x,FOYER_EAST[7+index].z,FOYER_EAST[7+index].rotation,hue]);
for(const [index,x,z,rotation,hue] of gamecubeCabinetLayout){
  const cabinetId=`gamecube-cabinet-0${index}`;
  makeCabinet(cabinetId,gamecubeTitles[index-1],x,z,hue,false,false,'gamecube');
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system:'gamecube',emulator:'gecko',gameName:gamecubeTitles[index-1],enabled:!isMobileDevice,status:isMobileDevice?'disabled':'available',disabledReason:isMobileDevice?'desktop-only':undefined});configureHostedCabinet(cabinetId);
}
const expansionCabinetColors=[0xff3cac,0x36f9f6,0xffb42e,0x934dff,0x7dff67];
const ps2RoomTitles=['GOD OF WAR','KINGDOM HEARTS','GRAND THEFT AUTO: SAN ANDREAS','DBZ TENKAICHI 3','PS2 // READY 05'];
// Cabinet 04 — DBZ Budokai Tenkaichi 3 — faces Melee across the tournament
// hall; the rest hold their foyer slots.
const ps2CabinetLayout=Array.from({length:5},(_,index)=>index===3
  ?[4,15,42,-Math.PI/2]
  :[index+1,FOYER_WEST[7+index].x,FOYER_WEST[7+index].z,FOYER_WEST[7+index].rotation]);
for(const [index,x,z,rotation] of ps2CabinetLayout){
  const cabinetId=`psx-back-cabinet-0${index}`,hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);
  makeCabinet(cabinetId,ps2RoomTitles[index-1],x,z,expansionCabinetColors[index-1],false,false,'ps2');
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system:'ps2',gameName:hosted?.name||ps2RoomTitles[index-1],gameId:hosted?.emulatorId||26000+index,enabled:Boolean(hosted),status:hosted?'available':'disabled'});configureHostedCabinet(cabinetId);
}
// The five Xbox placeholders are the Halo LAN row along the tournament hall's
// back wall, facing the floor. Still disabled: the room is sealed and no Halo
// image is hosted yet, so the stations stand ready rather than pretend to run.
const xboxCabinetLayout=[[1,-8,48.4,Math.PI],[2,-4,48.4,Math.PI],[3,0,48.4,Math.PI],[4,4,48.4,Math.PI],[5,8,48.4,Math.PI]];
for(const [index,x,z,rotation] of xboxCabinetLayout){
  const cabinetId=`xbox-cabinet-0${index}`;
  makeCabinet(cabinetId,`HALO LAN // STATION 0${index}`,x,z,expansionCabinetColors[5-index],false,false,'xbox');
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
for(const doorZ of OPEN_DOOR_Z_WEST)lightThreshold(PLAYSTATION_WALL_X,doorZ,false);
// No threshold at -25.2 any more: that doorway widened into the Pokemon
// Center's storefront opening, and a lit strip floating in it would be odd.
for(const doorZ of OPEN_DOOR_Z_EAST)if(doorZ!==-25.2)lightThreshold(N64_WALL_X,doorZ,false);
for(const doorX of NORTH_ROOM_X)lightThreshold(doorX,TOP_BAND_MIN_Z,true);
lightThreshold(POKEMON_DOOR_X,POKEMON_SOUTH_Z,true);
lightThreshold(SILENT_DOOR_X,SILENT_SOUTH_Z,true);
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
// The counter's flanks: a capsule tower on either end of the case, built from
// the case's own materials so the three read as one piece of furniture. The
// capsules are the arcade's gacha stock, procedural and light.
for(const side of [-1,1]){
  const flank=new THREE.Group();flank.position.set(side*8.9,0,0);prizeDisplay.add(flank);
  const flankBase=new THREE.Mesh(new THREE.BoxGeometry(1.16,.16,1.16),new THREE.MeshStandardMaterial({color:0x142331,metalness:.9,roughness:.12}));
  flankBase.position.y=.08;flank.add(flankBase);
  const flankGlass=new THREE.Mesh(new THREE.BoxGeometry(.98,2.28,.98),new THREE.MeshStandardMaterial({color:0x8deeff,emissive:0x173d5d,emissiveIntensity:.26,transparent:true,opacity:.16,metalness:.65,roughness:.06,side:THREE.DoubleSide,depthWrite:false}));
  flankGlass.position.y=1.3;flank.add(flankGlass);
  const flankTop=new THREE.Mesh(new THREE.BoxGeometry(1.16,.09,1.16),new THREE.MeshStandardMaterial({color:0x243a4b,emissive:0x173c56,emissiveIntensity:.6,metalness:.85,roughness:.1}));
  flankTop.position.y=2.49;flank.add(flankTop);
  for(const [ex,ez] of [[-.52,.52],[.52,.52],[-.52,-.52],[.52,-.52]]){
    const edge=new THREE.Mesh(new THREE.BoxGeometry(.08,2.34,.08),new THREE.MeshStandardMaterial({color:0x36f9f6,emissive:0x36f9f6,emissiveIntensity:1.15,metalness:.7,roughness:.12}));
    edge.position.set(ex,1.3,ez);flank.add(edge);
  }
  const capsuleShell=new THREE.MeshStandardMaterial({color:0xf4f8fb,transparent:true,opacity:.55,roughness:.08,metalness:.15});
  const capsuleColours=[0xff3cac,0x36f9f6,0xffb42e,0x934dff,0x7dff67,0x5f8cff,0xff5f5f];
  for(let i=0;i<9;i++){
    const angle=(i*2.399+side)*1,radius=.16+((i*53)%23)/100;
    const cx=Math.cos(angle)*radius*.9,cz=Math.sin(angle)*radius*.9,cy=.36+i*.235;
    const bottom=new THREE.Mesh(new THREE.SphereGeometry(.145,16,10,0,Math.PI*2,Math.PI/2,Math.PI/2),
      new THREE.MeshStandardMaterial({color:capsuleColours[(i+(side>0?3:0))%capsuleColours.length],emissive:capsuleColours[(i+(side>0?3:0))%capsuleColours.length],emissiveIntensity:.18,roughness:.24}));
    bottom.position.set(cx,cy,cz);flank.add(bottom);
    const top=new THREE.Mesh(new THREE.SphereGeometry(.145,16,10,0,Math.PI*2,0,Math.PI/2),capsuleShell);
    top.position.set(cx,cy,cz);flank.add(top);
  }
  const flankGlow=new THREE.PointLight(0x9be8ff,1.3,3.4,2);flankGlow.position.set(0,1.5,.2);flank.add(flankGlow);
  prizeDisplayLights.push(flankGlow);
}
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
let prizeModelsStarted=false,megaManStatuesStarted=false,chaoGardenModelStarted=false,silentHillBuildingsStarted=false,pokemonCenterStarted=false,nextHeavyAssetCheck=0;
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
  }if(!prizeModelsStarted&&playerPosition.distanceToSquared(prizeDisplay.position)<144){prizeModelsStarted=true;installPepeModel();installPudgyModel();installFurthermoreModel();installEnterpriseModel();installKurackModel();installGangsterPepe();}if(!megaManStatuesStarted&&playerPosition.x<-18.6&&playerPosition.z<24&&playerPosition.z>-6){megaManStatuesStarted=true;installMegaManStatues();}if(!chaoGardenModelStarted&&playerPosition.x>14&&playerPosition.z>4&&playerPosition.z<22){chaoGardenModelStarted=true;installChaoGardenModel();}if(!silentHillBuildingsStarted&&playerPosition.x<-14&&playerPosition.z<-28){silentHillBuildingsStarted=true;installSilentHillBuildings();}if(!pokemonCenterStarted&&playerPosition.x>8&&playerPosition.z<-6){pokemonCenterStarted=true;installPokemonCenter();}}
let nextLightCull=0;
// The barrier beacons are children of their barrier group, so light.position is
// a local offset near the origin rather than the corner the beacon actually
// occupies. Rank on the world position instead.
function managedLightPosition(light){
  if(!light.userData.worldPosition){light.updateWorldMatrix(true,false);light.userData.worldPosition=light.getWorldPosition(new THREE.Vector3())}
  return light.userData.worldPosition;
}
function updateNearbyLights(now){if(now<nextLightCull)return;nextLightCull=now+250;const cabinetDistances=cabinets.map(cabinet=>({cabinet,distanceSq:cabinet.g.position.distanceToSquared(playerPosition)})).sort((a,b)=>a.distanceSq-b.distanceSq);let litCabinets=0;for(const {cabinet,distanceSq} of cabinetDistances){cabinet.g.visible=distanceSq<324;const lightsVisible=cabinet.g.visible&&distanceSq<64&&litCabinets<2;if(lightsVisible)litCabinets++;cabinet.renderLights.forEach(light=>{light.visible=lightsVisible});}const roomLights=[],accentLights=[],muralLights=[],solanaLights=[];for(const light of managedSceneLights){const position=managedLightPosition(light),dx=position.x-playerPosition.x,dz=position.z-playerPosition.z;(light.userData.solanaLight?solanaLights:light.userData.muralLight?muralLights:light.userData.accentLight?accentLights:roomLights).push({light,distanceSq:dx*dx+dz*dz})}
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
muralLights.sort((a,b)=>a.distanceSq-b.distanceSq).forEach(({light,distanceSq},index)=>{light.visible=index<3&&distanceSq<225});
// The Solana signs carry their own cheap additive glow. One nearby wall wash
// is enough to tint the player and floor without raising the live light budget
// by one light per sign as the arcade grows.
solanaLights.sort((a,b)=>a.distanceSq-b.distanceSq).forEach(({light,distanceSq},index)=>{light.visible=index<1&&distanceSq<144});
const prizeVisible=playerPosition.distanceToSquared(prizeDisplay.position)<144;gangsterPepeLight.visible=prizeVisible;prizeDisplayLights.forEach(light=>{light.visible=prizeVisible});}
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
  import('./emulators/disc-range-cache.js?v=poke-7')
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
  import('./emulators/disc-range-cache.js?v=poke-7')
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
  if((cabinet?.system==='gb'||cabinet?.system==='gbc'||cabinet?.system==='gba')&&window.ARCADE_CHOOSE_GB_ADAPTER){
    return window.ARCADE_CHOOSE_GB_ADAPTER({adapters,detection:window.ARCADE_RUNTIME_DETECTION}).adapter;
  }
  if(cabinet?.system==='nds'&&window.ARCADE_CHOOSE_NDS_ADAPTER){
    return window.ARCADE_CHOOSE_NDS_ADAPTER({adapters,detection:window.ARCADE_RUNTIME_DETECTION}).adapter;
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
    // The cause rides along on screen: a player who cannot open the console
    // can still show us exactly what refused to start.
    if(signal.detail)console.warn('[arcade] emulator failure:',signal.detail);
    clearTimeout(emulatorLoadTimer);closeMachine();
    showCabinetMessage(signal.detail?`${signal.message} ${String(signal.detail).toUpperCase().slice(0,110)}`:signal.message)}
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
  // Inside the garden bore the camera goes first-person no matter the mode:
  // any chase offset ends up in the rock or out in the void.
  const inGardenBore=playerPosition.x>21.3&&playerPosition.x<60.1&&Math.abs(playerPosition.z-13.2)<1.7;
  if(cameraMode==='first-person'||inGardenBore){
    camera.position.copy(playerPosition);
    lookDirection.set(-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch));
    cameraTarget.copy(camera.position).add(lookDirection);
    camera.lookAt(cameraTarget);
    return;
  }
  // Match first-person mouse direction: moving the mouse upward should tilt
  // the view upward instead of lifting the chase camera and looking downward.
  // Inside the vomitory the camera ducks with the player and hugs the tube:
  // the standard offset floated it through the concourse roof, which read as
  // the tunnel falling apart rather than as a camera artifact.
  const inVomitory=Math.abs(playerPosition.x-27)<2.2&&playerPosition.z<-41.5&&playerPosition.z>-88.5;
  if(inVomitory)followOffset.set(0,.72-pitch*1.2,2.5).applyAxisAngle(upAxis,yaw);
  else followOffset.set(0,2.15-pitch*2.1,4.55).applyAxisAngle(upAxis,yaw);
  camera.position.copy(playerPosition).add(followOffset);
  if(inVomitory){
    camera.position.x=Math.max(25.75,Math.min(28.25,camera.position.x));
    camera.position.y=Math.max(.9,Math.min(2.25,camera.position.y));
  }
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
    const doors=wallX<0?OPEN_DOOR_Z_WEST:OPEN_DOOR_Z_EAST;
    if(doors.some(doorZ=>Math.abs(crossingZ-doorZ)<ROOM_DOOR_HALF_WIDTH-PLAYER_COLLISION_RADIUS))continue;
    // The Pokemon Center's storefront: the east wall is open from the old
    // plaza door to the column's end.
    if(wallX===N64_WALL_X&&crossingZ>-33.7&&crossingZ<-12.1)continue;
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
  // The dividers live between the partition and the shell and nowhere else:
  // unbounded, they cut invisible walls across the garden expanse.
  if(Math.abs(playerPosition.x)>=SHELL_HALF_WIDTH)return;
  for(const dividerZ of SIDE_ROOM_DIVIDER_Z){
    // The east column's end wall is open: the Pokemon Center spans it.
    if(dividerZ===SIDE_COLUMN_MIN_Z&&playerPosition.x>0)continue;
    // The east column's dividers all stand at their re-planned lines.
    const wallZ=(playerPosition.x>0&&EAST_WALL_Z[String(dividerZ)]!==undefined)?EAST_WALL_Z[String(dividerZ)]:dividerZ;
    if(wallZ!==dividerZ){
      const northFace=wallZ-PARTITION_WALL_HALF_THICKNESS-PLAYER_COLLISION_RADIUS;
      const southFace=wallZ+PARTITION_WALL_HALF_THICKNESS+PLAYER_COLLISION_RADIUS;
      if(playerPosition.z>northFace&&playerPosition.z<southFace){
        if(previousZ<wallZ)playerPosition.z=northFace;else playerPosition.z=southFace;
      }
      continue;
    }
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
 * The Pokemon bowl is solid.
 *
 * The stands are an ellipse just inside the drawn band, and the only way
 * through them is the entrance tunnel on the doorway side. Crossing anywhere
 * else — outward from the field or inward from a room corner — puts the player
 * back on the boundary. The same rule runs on both authoritative paths.
 */
// The stands are a real sphere now, which narrows toward the floor: the
// walkable ellipse is the globe at ankle height, not the old band.
const POKEBOWL={cx:POKEMON_CENTER_X,cz:-108.45,ax:38.7,az:29.7,laneHalfWidth:1.5};
/**
 * The Chao Garden's cliffs, the same rule at the garden's scale: an ellipse
 * just inside the painted band, passable only where the cliffs part at the
 * doorway. Mirrored on both authoritative paths.
 */
// A circle now: the garden is square, so the cove is round, and the lane sits
// at the doorway's own z rather than the circle's centre.
const CHAO_GARDEN={doorZ:13.2,laneHalfWidth:1.5,laneEndX:63.2};
// The fence is the geometry itself, and so is the floor: a step stands
// wherever a ray straight down finds ground within a stride's climb of the
// player's feet, and the player's height follows that ground. Slopes and
// shelves are walked, sheer cliffs and open sea are refused.

const chaoGroundRay=new THREE.Raycaster();
const chaoGroundOrigin=new THREE.Vector3(),chaoGroundDown=new THREE.Vector3(0,-1,0);
function chaoGroundAt(x,z,feetY){
  chaoGroundOrigin.set(x,42,z);
  chaoGroundRay.set(chaoGroundOrigin,chaoGroundDown);
  const hits=chaoBoreGroup?chaoGroundRay.intersectObjects([chaoGardenMount,chaoBoreGroup],true):chaoGroundRay.intersectObject(chaoGardenMount,true);
  for(const hit of hits){
    const groundY=hit.point.y;
    if(groundY>-3.5&&groundY<=feetY+1.9)return groundY;
  }
  return null;
}
function chaoLawnAt(x,z){
  // strictly grass: the topmost surface must wear the lawn material, so no
  // palm, flower or egg can ever seat on water or bare rock again
  if(!chaoGardenMount)return null;
  chaoGroundOrigin.set(x,42,z);
  chaoGroundRay.set(chaoGroundOrigin,chaoGroundDown);
  const hits=chaoGroundRay.intersectObject(chaoGardenMount,true);
  for(const hit of hits){
    if(hit.point.y<-3.5||hit.point.y>10)continue;
    const material=Array.isArray(hit.object.material)?hit.object.material[0]:hit.object.material;
    if(material?.userData?.isWater)return null;
    return material?.userData?.isLawn?hit.point.y:null;
  }
  return null;
}
function resolveChaoGardenCollisions(previousX,previousZ){
  // The bore is the only road through the old room, and past the shell the
  // measured grass edge is the only fence. A step that lands on neither goes
  // back where it began.
  if(playerPosition.x<21.6)return;
  const inLane=Math.abs(playerPosition.z-CHAO_GARDEN.doorZ)<CHAO_GARDEN.laneHalfWidth&&playerPosition.x<CHAO_GARDEN.laneEndX;
  if(playerPosition.x<42.7){
    if(playerPosition.z<4.8||playerPosition.z>21.6)return;
    if(!inLane){playerPosition.x=previousX;playerPosition.z=previousZ}
    else playerPosition.y+=(1.65-playerPosition.y)*.35;
    return;
  }
  if(!chaoGardenMount){
    if(!inLane){playerPosition.x=previousX;playerPosition.z=previousZ}
    return;
  }
  const ground=chaoGroundAt(playerPosition.x,playerPosition.z,playerPosition.y-1.65);
  if(ground===null){
    // the bore floor and apron are not part of the model: the lane carries
    // the player over them at arcade height
    if(inLane){playerPosition.y+=(1.65-playerPosition.y)*.35;return}
    playerPosition.x=previousX;playerPosition.z=previousZ;
    return;
  }
  playerPosition.y+=(ground+1.65-playerPosition.y)*.35;
}


function resolvePokemonBowlCollisions(previousX,previousZ){
  if(playerPosition.z>-70)return;
  // The tunnel lane, on the doorway side only: the matching band of ellipse on
  // the far side is the jumbotron, and there is no way through a jumbotron.
  if(Math.abs(playerPosition.x-POKEBOWL.cx)<POKEBOWL.laneHalfWidth&&playerPosition.z>POKEBOWL.cz+POKEBOWL.az*.5)return;
  const dx=(playerPosition.x-POKEBOWL.cx)/POKEBOWL.ax,dz=(playerPosition.z-POKEBOWL.cz)/POKEBOWL.az;
  const now=dx*dx+dz*dz;
  const pdx=(previousX-POKEBOWL.cx)/POKEBOWL.ax,pdz=(previousZ-POKEBOWL.cz)/POKEBOWL.az;
  const before=pdx*pdx+pdz*pdz;
  if((before<=1)===(now<=1))return;
  // Projected to the side the step began on, a hair short of the boundary so
  // the next frame does not re-detect a crossing.
  const scale=(before<=1?.995:1.005)/Math.sqrt(now);
  playerPosition.x=POKEBOWL.cx+(playerPosition.x-POKEBOWL.cx)*scale;
  playerPosition.z=POKEBOWL.cz+(playerPosition.z-POKEBOWL.cz)*scale;
}
/**
 * The top row: its front wall, with a doorway into each of its four rooms, and
 * the walls between them.
 *
 * The row used to be shut by the world bound half a metre in front of this
 * wall, so none of it needed collision. It is open now, and a wall nothing
 * enforces is a wall players walk through.
 */
function resolveTopRowCollisions(previousX,previousZ){
  const wallGap=PARTITION_WALL_HALF_THICKNESS+PLAYER_COLLISION_RADIUS;
  // The vomitory's two walls. The tunnel spans the mouth at z=-42 down to the
  // field's edge, and its walls are the way in being a passage rather than a
  // suggestion: a player brushing one from either side is held off it.
  if(playerPosition.z>-87.8&&playerPosition.z<POKEMON_SOUTH_Z+.5){
    for(const wallX of [POKEMON_DOOR_X-1.7,POKEMON_DOOR_X+1.7]){
      const westFace=wallX-(.12+PLAYER_COLLISION_RADIUS),eastFace=wallX+(.12+PLAYER_COLLISION_RADIUS);
      if(playerPosition.x<=westFace||playerPosition.x>=eastFace)continue;
      if(previousX<wallX)playerPosition.x=westFace;else playerPosition.x=eastFace;
      return;
    }
  }
  // The front wall at z=-50.4 runs between the two corner blocks: Silent Hill
  // took its west stretch the way the stadium took its east one.
  if(playerPosition.x<SILENT_EAST_X){
    // Silent Hill's south wall, with the entrance at its centre.
    const northFace=SILENT_SOUTH_Z-wallGap,southFace=SILENT_SOUTH_Z+wallGap;
    if(playerPosition.z>northFace&&playerPosition.z<southFace
      &&Math.abs(playerPosition.x-SILENT_DOOR_X)>=1.72-PLAYER_COLLISION_RADIUS){
      if(previousZ<SILENT_SOUTH_Z)playerPosition.z=northFace;else playerPosition.z=southFace;
      return;
    }
  }else if(playerPosition.x<POKEMON_WEST_X){
    const northFace=TOP_BAND_MIN_Z-wallGap,southFace=TOP_BAND_MIN_Z+wallGap;
    if(playerPosition.z>northFace&&playerPosition.z<southFace
      &&!NORTH_ROOM_X.some(doorX=>Math.abs(playerPosition.x-doorX)<ROOM_DOOR_HALF_WIDTH-PLAYER_COLLISION_RADIUS)){
      if(previousZ<TOP_BAND_MIN_Z)playerPosition.z=northFace;else playerPosition.z=southFace;
      return;
    }
  }else{
    // The stadium's south wall, with the entrance at its centre.
    const northFace=POKEMON_SOUTH_Z-wallGap,southFace=POKEMON_SOUTH_Z+wallGap;
    if(playerPosition.z>northFace&&playerPosition.z<southFace
      &&Math.abs(playerPosition.x-POKEMON_DOOR_X)>=ROOM_DOOR_HALF_WIDTH-PLAYER_COLLISION_RADIUS){
      if(previousZ<POKEMON_SOUTH_Z)playerPosition.z=northFace;else playerPosition.z=southFace;
      return;
    }
  }
  // The old west wall is gone with the arena: the concourse room is open
  // to the band, and the tube's own walls do the shepherding inside it.
  if(playerPosition.z>=SILENT_SOUTH_Z||playerPosition.x>=POKEMON_WEST_X)return;
  for(const dividerX of NORTH_ROW_DIVIDER_X){
    const westFace=dividerX-wallGap,eastFace=dividerX+wallGap;
    if(playerPosition.x<=westFace||playerPosition.x>=eastFace)continue;
    if(previousX<dividerX)playerPosition.x=westFace;else playerPosition.x=eastFace;
    return;
  }
}
let lastPrizeLedDraw=0;
const performanceStats=document.querySelector('#performance-stats');
// The build stamp. Every deploy bumps the shared cache key, and this constant
// is spelled with the same string, so the same sed that bumps the key bumps
// the stamp: the corner of the screen always names the exact build running.
const ARCADE_BUILD='garden-exact-6';
if(performanceStats){
  const buildStamp=document.createElement('div');
  buildStamp.id='build-stamp';
  buildStamp.textContent='BUILD · '+ARCADE_BUILD.toUpperCase();
  buildStamp.style.cssText='color:#6b6486;font-size:9px;letter-spacing:.08em;margin-top:3px;text-align:right';
  performanceStats.insertAdjacentElement('afterend',buildStamp);
}
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
function tick(){requestAnimationFrame(tick);const d=Math.min(clock.getDelta(),.05);if(emulatorRuntimeActive)return;const now=performance.now();const gamepadActive=pollArcadeGamepad(d);updatePerformanceStats(now);updateNearbyLights(now);animatedMixers.forEach(mixer=>mixer.update(d));if(now-lastPrizeLedDraw>=200&&playerPosition.distanceToSquared(prizeDisplay.position)<400){drawPrizeLed(now);lastPrizeLedDraw=now}loadNearbySceneModels(now);const controlsActive=locked||mobileInputAvailable()&&start.style.display==='none'&&!activeCabinet||gamepadActive&&!activeCabinet;if(controlsActive){movementVector.set((keys.KeyD?1:0)-(keys.KeyA?1:0)+mobileMove.x+gamepadMove.x,0,(keys.KeyS?1:0)-(keys.KeyW?1:0)+mobileMove.y+gamepadMove.y);localAnimationState=movementVector.lengthSq()?'walk':'idle';if(movementVector.lengthSq()){const analogSpeed=Math.min(1,movementVector.length());movementVector.normalize().multiplyScalar(d*11.25*analogSpeed).applyAxisAngle(upAxis,yaw);const previousX=playerPosition.x,previousZ=playerPosition.z;playerPosition.add(movementVector);resolvePartitionWallCollisions(previousX,previousZ);resolveSocialLayoutCollisions(previousX,previousZ);resolveStatueCollisions(previousX,previousZ);resolveRearGalleryCollision();resolvePokemonBowlCollisions(previousX,previousZ);resolveChaoGardenCollisions(previousX,previousZ);resolveTopRowCollisions(previousX,previousZ);clampToWorld(previousX,previousZ)}const planarReachSq=CABINET_PROMPT_RANGE*CABINET_PROMPT_RANGE-playerPosition.y*playerPosition.y;near=planarReachSq>0?(window.ARCADE_CABINET_SPATIAL_INDEX?.nearest(playerPosition.x,playerPosition.z,Math.sqrt(planarReachSq))?.payload??null):null;warmEmulatorCore(near);const constructionRoom=nearbyConstructionRoom();if(constructionRoom)updateConstructionPrompt(constructionRoom);else updateCabinetPrompt()}else{localAnimationState=activeCabinet?'interact':'idle';if(now>=cabinetMessageUntil)prompt.classList.remove('active')}updateFollowCamera();game();for(const callback of beforeRenderCallbacks)callback(now,d);renderer.render(scene,camera)}tick();
document.addEventListener('visibilitychange',()=>{performanceWindowStart=performance.now();performanceFrames=0;slowWindows=0;fastWindows=0});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);currentPixelRatio=Math.min(currentPixelRatio,renderScaleCeiling());renderer.setPixelRatio(currentPixelRatio)});
