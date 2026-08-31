import { GAMEPAD_AXES, GAMEPAD_BUTTONS, buttonPressed, DEFAULT_DEAD_ZONE as GAMEPAD_DEAD_ZONE, gamepadHasActivity, pickGamepad, readDpad, readStick } from './emulators/gamepad-mapping.js?v=sh-seal-1';
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
const WORLD_BOUNDS={minX:-42.7,maxX:42.7,minZ:-66.7,maxZ:49.9};
// Silent Hill fills the top row's west corner, doubled sideways: its annex is
// bolted onto the OUTSIDE of the building's west wall, over ground nothing
// else uses. The walkable floor is the main rectangle plus this one, clamped
// against whichever rectangle the step began in.
const SILENT_HILL_EXPANSE={minX:-64.3,maxX:-21.6,minZ:-95.5,maxZ:-42.5};
// The arena hangs in the void north of the building, reached only through
// the vomitory: its region spans the globe, and the tunnel walls plus the
// bowl's own ellipse do the actual shepherding inside it.
const POKEMON_EXPANSE={minX:-12,maxX:66,minZ:-138.6,maxZ:-42.5};
// The Chao Garden meadow spills out of the building's east wall the way
// Silent Hill leaves the west one: its ground continues outside the shell,
// and the cliff-edge ellipse does the actual shepherding on it.
const CHAO_EXPANSE={minX:42.7,maxX:86.6,minZ:31.3,maxZ:93.3};
const TEMPLE_EXPANSE={minX:-124.5,maxX:-42.7,minZ:24.8,maxZ:59.2};
// Peach's Castle stands outside the west wall on the Mario room's own line,
// the way the Temple of Time stands outside it further south. The room is not
// a room any more: it is the forecourt you cross to reach the front steps.
// minZ -55, not -42. The castle model is symmetric about z -25.2 and its hall
// reaches z -52, but this bound was centred on -15.1, so ten metres of the
// hall's southern end -- including one of its doorways -- was walled off by an
// invisible line with nothing to show for it. resolveCastleFloor still refuses
// any step with no floor under it, so widening the box opens the room without
// opening the void.
const CASTLE_EXPANSE={minX:-119.7,maxX:-42.7,minZ:-63,maxZ:11.8};
const WORLD_REGIONS=[WORLD_BOUNDS,SILENT_HILL_EXPANSE,POKEMON_EXPANSE,CHAO_EXPANSE,TEMPLE_EXPANSE,CASTLE_EXPANSE];
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
// How far up and down a player may look. It was -0.42 to +0.58 -- 24 degrees
// down, 33 up -- which in a building with a vaulted ceiling and a Triforce on
// the floor means you can see neither. 1.45 is just short of straight up and
// straight down, stopping shy of vertical so the view never flips.
const LOOK_PITCH_LIMIT=1.45;
let yaw=0,pitch=0, locked=false, activeCabinet=null, localAnimationState='idle', cameraMode='third-person', socialFollowProvider=null, emulatorRuntimeActive=false;
// The base wash the whole building sits in. The old values left everything
// outside a managed light's radius near-black; this is a soft violet sky over
// a green-blue floor bounce plus a low lavender ambient — colour without glare, and
// none of it counts against the per-frame light budget.
scene.add(new THREE.HemisphereLight(0x756fe0,0x12362d,2.15));
scene.add(new THREE.AmbientLight(0x8b9bc7,.72));
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
/**
 * The building's boxes, batched.
 *
 * box() used to create a Mesh with its own BoxGeometry and its own material per
 * call, and it is called from loops everywhere the building repeats — wall
 * segments, ceiling plates, light strips, dividers. Every one was a draw call.
 * With the whole map open that put the frame at 2,000+ draw calls, which is why
 * dropping the render scale never helped: the cost was per-call CPU overhead,
 * not pixels.
 *
 * During the synchronous build, calls are pooled by (color, emissive) and
 * flushed into one InstancedMesh per pool — the same technique the ceiling
 * troffers already use — with each instance a unit cube scaled to its box. No
 * box() call rotates its result, so every instance matrix is diagonal and the
 * shader's mat3(instanceMatrix) keeps normals exact after its normalize.
 *
 * Callers only ever touch castShadow/receiveShadow on the return value, and
 * shadows are disabled renderer-wide, so pooled calls return a stub with those
 * properties. Anything created after the seal — nothing does today — falls back
 * to the old one-mesh path rather than breaking.
 */
const staticBoxPool=new Map();let staticBoxesSealed=false;
const unitBoxGeometry=new THREE.BoxGeometry(1,1,1);
function box(w,h,d,color,x,y,z,emissive=0){
  if(staticBoxesSealed){
    const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:emissive,roughness:.43,metalness:.65}));
    m.position.set(x,y,z);scene.add(m);return m;
  }
  const key=color+':'+emissive;
  let pool=staticBoxPool.get(key);
  if(!pool){pool={color,emissive,entries:[]};staticBoxPool.set(key,pool)}
  pool.entries.push([w,h,d,x,y,z]);
  return {castShadow:true,receiveShadow:true,visible:true,position:new THREE.Vector3(x,y,z)};
}
function flushStaticBoxes(){
  staticBoxesSealed=true;
  const transform=new THREE.Object3D();
  for(const {color,emissive,entries} of staticBoxPool.values()){
    const material=new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:emissive,roughness:.43,metalness:.65});
    const batch=new THREE.InstancedMesh(unitBoxGeometry,material,entries.length);
    entries.forEach(([w,h,d,x,y,z],index)=>{transform.position.set(x,y,z);transform.scale.set(w,h,d);transform.updateMatrix();batch.setMatrixAt(index,transform.matrix)});
    batch.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    batch.computeBoundingSphere();
    scene.add(batch);
  }
  staticBoxPool.clear();
}
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
// The fourth is the warp pipe's. The Mario room is one tube from wall to wall
// and the tube is bigger than the room: the crown reaches 5.87 against a
// ceiling at 5.08, so a lid here sliced the top off the pipe and hung a flat
// black chord across the bore for anyone standing inside it. The slot is cut to
// the lip's nine metres, the same width the partition wall leaves for the
// mouth, so the tube rises through it along its whole length.
const warpPipeHole=new THREE.Path();
warpPipeHole.moveTo(-43.2,-21.3);warpPipeHole.lineTo(-21.6,-21.3);warpPipeHole.lineTo(-21.6,-12.3);warpPipeHole.lineTo(-43.2,-12.3);warpPipeHole.closePath();
ceilingShape.holes.push(warpPipeHole);
// The volume the tube occupies, in world coordinates. The building lays its
// ceiling out room by room without knowing one of the rooms is a warp pipe, so
// anything it would hang in here has to be held back: inside the bore there is
// no ceiling to hang from, and the fitting draws as junk floating in the
// tunnel. Matches the slot cut above.
const insideWarpPipeSlot=(x,z)=>x>-43.2&&x<-21.6&&z>-29.7&&z<-20.7;
// The temple stands outside the building now, off the south-west corner, so
// the roof needs no hole for it.
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
// Every troffer used to be three separate scene objects. The expanded arcade
// now has hundreds of them, so keep their identical geometry in five GPU
// batches (housing, two diffuser colours and two halo colours). This preserves
// the layout while removing hundreds of draw calls.
const ceilingFixturePositions={housing:[],warmPanel:[],coolPanel:[],warmHalo:[],coolHalo:[]};
function queueCeilingFixture(x,z,cool=false){
  // Nothing hangs inside the warp pipe. The Mario room's rig is laid on the
  // room, but the room is a tube now, and its middle row of troffers came out
  // in mid-air halfway down the bore -- lit fittings floating in a pipe, hung
  // from a ceiling that is no longer above them.
  if(insideWarpPipeSlot(x,z))return;
  ceilingFixturePositions.housing.push([x,z]);
  ceilingFixturePositions[cool?'coolPanel':'warmPanel'].push([x,z]);
  ceilingFixturePositions[cool?'coolHalo':'warmHalo'].push([x,z]);
}
function addCeilingFixtureBatch(geometry,material,positions,y,rotationX=0){
  if(!positions.length)return;
  const batch=new THREE.InstancedMesh(geometry,material,positions.length),transform=new THREE.Object3D();
  positions.forEach(([x,z],index)=>{transform.position.set(x,y,z);transform.rotation.set(rotationX,0,0);transform.updateMatrix();batch.setMatrixAt(index,transform.matrix)});
  batch.instanceMatrix.setUsage(THREE.StaticDrawUsage);batch.instanceMatrix.needsUpdate=true;batch.frustumCulled=true;scene.add(batch);
}
function flushCeilingFixtures(){
  addCeilingFixtureBatch(new THREE.BoxGeometry(3.6,.17,.52),ceilingHousingMaterial,ceilingFixturePositions.housing,4.95);
  const panelGeometry=new THREE.PlaneGeometry(3.3,.34),haloGeometry=new THREE.PlaneGeometry(5.4,1.6);
  addCeilingFixtureBatch(panelGeometry,warmPanelMaterial,ceilingFixturePositions.warmPanel,4.862,Math.PI/2);
  addCeilingFixtureBatch(panelGeometry,coolPanelMaterial,ceilingFixturePositions.coolPanel,4.862,Math.PI/2);
  addCeilingFixtureBatch(haloGeometry,warmHaloMaterial,ceilingFixturePositions.warmHalo,4.84,Math.PI/2);
  addCeilingFixtureBatch(haloGeometry,coolHaloMaterial,ceilingFixturePositions.coolHalo,4.84,Math.PI/2);
}
// The ceiling beams stop where the carved-out rooms begin: a beam crossing
// the Chao Garden hung in its sky as a floating black slab. West of the
// garden the run is unchanged; the beams never reached Silent Hill or the
// stadium.
for(let z=-15;z<=15;z+=5)box(z<-12?49.6:56,.26,.34,0x14111f,z<-12?-3.2:0,4.9,z,.04);
for(const [row,z] of [-12.5,-7.5,-2.5,2.5,7.5,12.5].entries()){
  const cool=row%3===1;
  for(const x of [-21,-9,0,9,21])queueCeilingFixture(x,z,cool);
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
      queueCeilingFixture(x,z,cool);
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
// Instanced, like the troffers above: 33 pendants were 99 meshes and 99 draw
// calls for three shapes that never move.
{
  const pendantSpots=[];
  for(const x of [-11.5,0,11.5])for(let z=-31;z<=31;z+=6.2)pendantSpots.push([x,z]);
  addCeilingFixtureBatch(pendantCordGeometry,ceilingHousingMaterial,pendantSpots,4.55);
  addCeilingFixtureBatch(pendantTubeGeometry,pendantMaterial,pendantSpots,4.02);
  addCeilingFixtureBatch(pendantBloomGeometry,pendantBloomMaterial,pendantSpots,4.02);
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
// The east wall's only opening is the Pokemon Center's storefront run, which
// is handled as an open stretch rather than a doorway; the -25.2 entry lies
// inside that stretch. The three rooms south of it were empty and are deleted:
// the wall is solid across where their doorways were.
const OPEN_DOOR_Z_EAST=[-25.2];
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
// The west shell used to run unbroken from z -42 to 33.6. It is cut at the
// Mario room's own doorway line now — a 4.4m gap on z -25.2 — because the
// castle stands outside it and the room is the way through to the front steps.
box(.3,5,14.6,0x180d31,-SHELL_HALF_WIDTH,2.5,-34.7);box(.3,5,56.6,0x180d31,-SHELL_HALF_WIDTH,2.5,5.3);
box(.3,5,4.4,0x180d31,-SHELL_HALF_WIDTH,2.5,35.8);box(.3,5,4.4,0x180d31,-SHELL_HALF_WIDTH,2.5,48.2);
box(.3,5,82.2,0x180d31,SHELL_HALF_WIDTH,2.5,-26.1);box(.3,5,23,0x180d31,SHELL_HALF_WIDTH,2.5,26.5);box(.3,5,4.4,0x180d31,SHELL_HALF_WIDTH,2.5,48.2);
// The north wall runs on across the annex, which closes its own west and
// south sides.
// The north wall parts where the stadium concourse runs out to the globe.
box(21.7,5,.3,0x180d31,-54.05,2.5,NORTH_ROW_MIN_Z);box(46.5,5,.3,0x180d31,1.55,2.5,NORTH_ROW_MIN_Z);
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
// And the return that closes the step between the two north wall lines. The
// front wall stands on z -50.4 as far as the stadium room, and the stadium's
// own south wall stands on -42, so there are eight metres of corner between
// them at x 10.8. Losing the old west wall left that corner open: standing at
// the prize counter you looked straight past it into the unlit concourse, and
// walking east along z -45 took you out of the building entirely and up the
// back of the stadium without ever using the vomitory.
box(.3,5,POKEMON_SOUTH_Z-TOP_BAND_MIN_Z,0x11182c,POKEMON_WEST_X,2.5,(TOP_BAND_MIN_Z+POKEMON_SOUTH_Z)/2,.06);
const gangsterPepeMount=new THREE.Group();
const gangsterPepeLight=new THREE.PointLight(0xb9f5ff,3,3.5,2);
const PLAYSTATION_WALL_X=-HALL_HALF_WIDTH,N64_WALL_X=HALL_HALF_WIDTH,PARTITION_WALL_HALF_THICKNESS=.18,PLAYABLE_ROOM_DOOR_Z=-8,CONSTRUCTION_ROOM_DOOR_Z=8,PS2_ROOM_CENTER_X=-ANNEX_ROOM_CENTER_X,PS2_ROOM_CENTER_Z=-25.2,PS2_ROOM_DOOR_Z=-16.8,PS2_ROOM_BACK_Z=-33.6,ROOM_DOOR_HALF_WIDTH=1.6,PLAYER_COLLISION_RADIUS=.34,PLAYER_EYE_HEIGHT=1.65;
// The first two segments are pulled back to clear the warp pipe's mouth: the
// opening on z -25.2 runs the pipe's full nine metres rather than a door's 3.2,
// so the tube is seen whole from the hall instead of cropped to a slot.
const PARTITION_WALL_SEGMENTS_WEST=[[-31.65,3.9],[-15.15,11.1],[0,12.8],[16.6,14],[30.2,6.8]];
// The first east segment is gone: the Pokemon Center fronts the hall through
// where it stood, one wide opening with the old plaza doorway.
const PARTITION_WALL_SEGMENTS_EAST=[[10.8,45.6]];
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
// Soft pools follow the main walking route instead of adding another row of
// signs. Their additive floor halos cost no lights; only the two nearest real
// washes are enabled, so the arcade is brighter without multiplying GPU work.
const solanaPoolGeometry=new THREE.PlaneGeometry(11,8);
const SOLANA_AMBIENT_POOLS=Object.freeze([
  [-8,-27,SOLANA_PALETTE[0]], [8,-19,SOLANA_PALETTE[1]],
  [-8,-11,SOLANA_PALETTE[2]], [8,-3,SOLANA_PALETTE[0]],
  [-8,5,SOLANA_PALETTE[1]], [8,13,SOLANA_PALETTE[2]],
  [-8,21,SOLANA_PALETTE[0]], [8,29,SOLANA_PALETTE[1]]
]);
const solanaAmbientPools=[];
for(const [x,z,color] of SOLANA_AMBIENT_POOLS){
  const material=new THREE.MeshBasicMaterial({map:haloTexture,color,transparent:true,opacity:.11,depthWrite:false,blending:THREE.AdditiveBlending});
  const pool=new THREE.Mesh(solanaPoolGeometry,material);pool.rotation.x=-Math.PI/2;pool.position.set(x,.018,z);pool.renderOrder=2;pool.userData.decorative=true;solanaAtmosphere.add(pool);
  const wash=new THREE.PointLight(color,7.5,18,2);wash.position.set(x,2.65,z);wash.visible=false;wash.userData.solanaLight=true;wash.userData.baseIntensity=7.5;scene.add(wash);managedSceneLights.push(wash);
  solanaAmbientPools.push({pool,material,wash,phase:(x+z)*.17});
}
beforeRenderCallbacks.push(now=>{
  for(const accent of solanaAmbientPools){
    const breath=.5+.5*Math.sin(now*.00055+accent.phase);
    accent.material.opacity=.09+breath*.055;
    if(accent.wash.visible)accent.wash.intensity=accent.wash.userData.baseIntensity*(.94+breath*.12);
  }
});
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
// The tournament hall is open: it is the south approach now, and the Temple
// of Time stands off its west end.
// Silent Hill is sealed while the district is rebuilt: its doorway is solid
// in all three authorities, and this barrier is what tells the player why
// they stop in front of it.
sealDoorway('Silent Hill',SILENT_DOOR_X,SILENT_SOUTH_Z+.55,0);
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
// The Metal Gear room is scrapped. Its three murals came down with it and its
// cabinet went back to the PlayStation shelf, so the room behind Mega Man is
// bare wall waiting on whatever takes it next.
// Metroid, across the hall in the east column. Each wall is a band from one of
// the three images supplied for it, cut to that wall's own aspect.
// Metroid moved south with the garden's growth and keeps its full depth; its
// murals re-hang on the room's actual walls, which is what went missing when
// the divider moved out from under them.
// Moved across the hall into the west column's middle room — bare wall since
// Metal Gear was scrapped — so the whole series sits beside Mega Man. Its old
// east-column room goes back to waiting for whatever takes it next.
themeRoom({
  centerX:MEGAMAN_ROOM_CENTER_X,centerZ:-8.4,
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
let stadiumArenaWorld=null;
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
  stadiumArenaWorld=arena;
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
// The Mario room is gone. The warp pipe was already the room -- one tube from
// wall to wall -- and everything the room still owned existed only to be
// glimpsed through the corners of the pipe's mouth: three murals, their
// backing panels, a light rig inside a sealed box. All of it is deleted, and
// the mouth is closed with this collar: the partition leaves a 9m rectangular
// opening and the pipe's lip is a 4.5m circle, so the four corners between
// them looked straight into the dead room. Rectangle minus bore, hung just
// behind the lip so the rim overlaps it; the rectangle is oversized past the
// floor and the wall head so the bore hole never crosses the outline, which
// ShapeGeometry cannot triangulate.
{
  const collar=new THREE.Shape();
  collar.moveTo(-29.7,-1.5);collar.lineTo(-20.7,-1.5);collar.lineTo(-20.7,7.45);collar.lineTo(-29.7,7.45);collar.closePath();
  const bore=new THREE.Path();
  bore.absarc(-25.2,2.97,4.42,0,Math.PI*2,true);
  collar.holes.push(bore);
  const wall=new THREE.Mesh(new THREE.ShapeGeometry(collar,48),
    new THREE.MeshStandardMaterial({color:0x111425,emissive:0x111425,emissiveIntensity:.08,roughness:.43,metalness:.65,side:THREE.DoubleSide}));
  wall.rotation.y=-Math.PI/2;
  wall.position.set(-21.65,0,0);
  scene.add(wall);
}
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
    {file:'ff-room-mural.webp?v=sh-seal-1',span:32,at:new THREE.Vector3(-5.4,2.5,-66.94),
      backing:()=>box(32,5,.08,0x050711,-5.4,2.5,-67.01,.12),
      rotation:0,normal:new THREE.Vector3(0,0,1),along:new THREE.Vector3(1,0,0),count:6},
    {file:'ff-room-mural-2.webp?v=sh-seal-1',span:16,at:new THREE.Vector3(10.54,2.5,-59),
      backing:()=>box(.08,5,16,0x050711,10.61,2.5,-59,.12),
      rotation:-Math.PI/2,normal:new THREE.Vector3(-1,0,0),along:new THREE.Vector3(0,0,1),count:4},
    {file:'ff-room-mural-3.webp?v=sh-seal-1',span:16,at:new THREE.Vector3(-21.34,2.5,-59),
      backing:()=>box(.08,5,16,0x050711,-21.41,2.5,-59,.12),
      rotation:Math.PI/2,normal:new THREE.Vector3(1,0,0),along:new THREE.Vector3(0,0,-1),count:4}
]);
// The Zelda room holds the Temple of Time itself now; no murals, the
// building is the exhibit. It loads on approach like every heavy model.
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
let chaoGardenMount=null;
// Everything the garden draws hangs here, so the cull can hide the island
// whole from every region that is not looking at it.
const CHAO_DX=-15.9,CHAO_DZ=28.8;
const chaoWorld=new THREE.Group();
chaoWorld.name='chao-garden-world';
chaoWorld.position.set(CHAO_DX,0,CHAO_DZ);
scene.add(chaoWorld);
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
chaoWorld.add(chaoGardenFallback);
for(const [sx,sz] of [[60,13.2],[70,10],[70,26],[80,16],[80,40],[92,30],[70,50],[94,48],[64,34],[90,10]]){
  const sun=new THREE.PointLight(0xfff3d0,8.4,46,1.8);
  sun.position.set(sx,8.5,sz);
  chaoWorld.add(sun);managedSceneLights.push(sun);
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
  dome.position.set(113,-.5,43);dome.scale.y=.72;
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
  chaoWorld.add(dome);
  const sea=new THREE.Mesh(new THREE.CircleGeometry(69.5,48),new THREE.MeshBasicMaterial({color:0x3f8fd6,fog:false}));
  sea.rotation.x=-Math.PI/2;sea.position.set(113,-2.4,43);chaoWorld.add(sea);
}
// There is no bore any more. The island was carried to the corner until its
// meadow met the shell wall, so the doorway opens onto grass and the corridor
// that used to bridge them is not built at all.
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
/**
 * The two sides of the arena floor.
 *
 * Every Pokemon is scaled from its Pokedex height and then by one shared
 * factor, so they stand in true proportion to each other: Arceus towers, a
 * Pikachu comes up to its ankle. The lines face across the field, and the
 * flier holds station over the centre.
 */
const POKEMON_ROSTER_SCALE=2.1,POKEMON_FIELD_Z=-108.45,POKEMON_FIELD_Y=.06;
const pokemonModelCache=new Map();
function loadPokemonModel(file){
  if(!pokemonModelCache.has(file))pokemonModelCache.set(file,getOptimizedGltfLoader().then(loader=>new Promise((resolve,reject)=>loader.load('assets/models/pokemon/'+file+'?v=pokemon-roster-3',resolve,undefined,reject))));
  return pokemonModelCache.get(file);
}
/**
 * The world-space bounds of a model as it will actually be drawn.
 *
 * A glTF's geometry bounds describe its BIND pose, but the GPU draws the
 * skeleton's live pose, and on a rigged model the two are routinely different
 * shapes. Sizing and grounding from the bind box is why Arceus hung three
 * metres over the grass, why Charizard was scaled to fit a splayed mess, and
 * why Silver stood two heads taller than he was asked to be while Sonic sank
 * into the lawn. Only skinned meshes pay the per-vertex walk; everything else
 * renders exactly as its bounds describe.
 *
 * Also returns the floor: the lowest point of the meshes the creature is
 * actually made of. A leftover shadow blob or a stray helper hanging below the
 * feet would otherwise lift the whole animal off the ground, so a part holding
 * under a twentieth of the vertices gets no say in where it stands.
 */
const measurePose=model=>{
  // updateMatrixWorld, not updateWorldMatrix: only the former runs
  // SkinnedMesh's override, which refreshes bindMatrixInverse. Without it
  // every posed vertex comes back in a stale frame and the model is sized
  // from nonsense — Tyranitar came out 163 metres tall.
  model.updateMatrixWorld(true);
  const bounds=new THREE.Box3(),vertex=new THREE.Vector3(),parts=[];
  let total=0;
  model.traverse(node=>{
    if(!node.isMesh||!node.geometry?.attributes?.position)return;
    const positions=node.geometry.attributes.position;
    let box;
    if(node.isSkinnedMesh){
      box=new THREE.Box3();
      for(let i=0;i<positions.count;i++){
        node.getVertexPosition(i,vertex);
        box.expandByPoint(vertex.applyMatrix4(node.matrixWorld));
      }
    }else box=new THREE.Box3().setFromObject(node);
    if(box.isEmpty())return;
    bounds.union(box);
    total+=positions.count;
    parts.push({box,count:positions.count});
  });
  if(!total)return{bounds:new THREE.Box3().setFromObject(model),floor:0};
  let lowest=null;
  for(const part of parts){
    if(part.count<total*.05)continue;
    if(lowest===null||part.box.min.y<lowest)lowest=part.box.min.y;
  }
  return{bounds,floor:lowest??bounds.min.y};
};

function installPokemonRoster(){
  const brighten=model=>model.traverse(node=>{
    if(!node.isMesh)return;
    node.castShadow=false;node.receiveShadow=false;node.frustumCulled=false;
    const materials=Array.isArray(node.material)?node.material:[node.material];
    const swapped=materials.map(material=>new THREE.MeshBasicMaterial({map:material.map??null,color:material.color?.clone()??new THREE.Color(0xffffff),vertexColors:material.vertexColors===true,transparent:material.transparent,opacity:material.opacity,alphaTest:material.alphaTest,side:material.side}));
    node.material=Array.isArray(node.material)?swapped:swapped[0];
  });
  // Skinning happens on the GPU from the skeleton's live pose, but a glTF's
  // geometry bounds describe its bind pose, and on every rigged model here the
  // two differ. Measuring the bind box sized each animal wrongly and hung it in
  // the air: Arceus stood 3.1m clear of the grass, Tyranitar 2.0m, and
  // Charizard — whose bind pose is a splayed, tail-stretched mess — was scaled
  // to fit that mess. So walk the posed vertices, which is what the player
  // actually sees. Only skinned meshes need the slow path; the rest render
  // exactly as their bounds describe.
  //
  // A leftover shadow blob or a stray helper hangs below the feet, and taken
  // as the model's bottom it lifts the whole animal off the field. Only the
  // meshes the creature is actually made of get a say in where it stands; a
  // handful of stray vertices does not.
  const place=(file,options)=>{
    void loadPokemonModel(file).then(gltf=>{
      const model=gltf.scene;
      brighten(model);
      // The pose has to be settled before anything is measured off it, so the
      // clip is played and stepped to its first frame here rather than being
      // left for the render loop to start a frame later.
      let mixer=null;
      if(gltf.animations.length&&options.idle!==true){
        mixer=new THREE.AnimationMixer(model);
        mixer.clipAction(gltf.animations[0]).play();
        mixer.update(0);
      }
      const {bounds,floor:standing}=measurePose(model),size=bounds.getSize(new THREE.Vector3()),centre=bounds.getCenter(new THREE.Vector3());
      const span=options.lengthwise?Math.max(size.x,size.y,size.z):size.y;
      const scale=options.metres*POKEMON_ROSTER_SCALE/Math.max(span,.001);
      const floor=options.lengthwise?centre.y:standing;
      const holder=new THREE.Group();
      model.scale.setScalar(scale);
      model.position.set(-centre.x*scale,-floor*scale,-centre.z*scale);
      holder.add(model);
      if(mixer)animatedMixers.push(mixer);
      holder.position.set(options.x,POKEMON_FIELD_Y+(options.hover??0),options.z);
      // the models are authored facing +z; a quarter turn puts a line
      // shoulder-on to the field and looking across it
      holder.rotation.y=options.rotY;
      pokemonRosterWorld.add(holder);
      if(options.hover){
        const baseY=holder.position.y;
        beforeRenderCallbacks.push((now,delta)=>{
          holder.position.y=baseY+Math.sin(now*.0011)*1.3;
          if(options.circle)holder.rotation.y+=delta*options.circle;
          else holder.rotation.y=options.rotY+Math.sin(now*.0007)*.22;
        });
      }
    }).catch(error=>console.warn('An arena Pokemon could not load:',file,error));
  };
  const west=POKEMON_CENTER_X-13.5,east=POKEMON_CENTER_X+13.5;
  // the challengers, west side, looking east
  // Arceus's only clip is a broken "Take 001" that scatters its mesh across
  // half the stadium, so it is placed deliberately still. Charizard's first
  // clip is its real standing idle and it needs it: the bind pose is the
  // splayed, stretched-tail mess you get without one.
  place('arceus.glb',{x:west,z:POKEMON_FIELD_Z,metres:3.2,rotY:-Math.PI/2,idle:true});
  place('entei.glb',{x:west+1.5,z:POKEMON_FIELD_Z-11,metres:2.1,rotY:Math.PI/2});
  place('pikachu.glb',{x:west+2.4,z:POKEMON_FIELD_Z+10.5,metres:.4,rotY:Math.PI/2});
  // the champions, east side, looking west
  place('tyranitar.glb',{x:east,z:POKEMON_FIELD_Z,metres:2,rotY:-Math.PI/2});
  place('venusaur.glb',{x:east-1.5,z:POKEMON_FIELD_Z-11,metres:2,rotY:-Math.PI/2});
  place('ditto.glb',{x:east-2.4,z:POKEMON_FIELD_Z+10.5,metres:.3,rotY:-Math.PI/2});
  place('charizard.glb',{x:east+3.4,z:POKEMON_FIELD_Z+5,metres:1.7,rotY:-Math.PI/2});
  // Rayquaza holds the sky over the centre circle, turning slowly, low enough
  // to read as a body overhead rather than a mark against the stars
  place('rayquaza.glb',{x:POKEMON_CENTER_X,z:POKEMON_FIELD_Z,metres:8.93,lengthwise:true,rotY:0,hover:14});
}
function installPokemonCenter(){
  void (async()=>{try{
    const loader=await getOptimizedGltfLoader();
    loader.load('assets/models/pokemon/pokemon-center.glb?v=pokecenter-1',gltf=>{
      const mount=new THREE.Group();
      mount.add(gltf.scene);
      mount.position.set(23.9,.04,-36.05);
      // Back to the uniform .885 it was authored at. Growing the plan by a
      // quarter filled the bay, but this storefront is not a free-standing
      // model: its opening is CUT from the arcade's own wall by a world-space
      // box, framed by jambs pinned to the stadium collision corridor at
      // x 25.7/28.45, and patched by cream panels typed as world literals. Move
      // the model and none of that follows. The visible costs were a cream slab
      // adrift in the lobby and the back wall closing over the vomitory mouth
      // that arcade.js:381-382 deliberately leaves open at x 25.4..28.6. The
      // dead space it was grown to fill is the Pikomat's now.
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
      // Everything below is typed in WORLD space against the model at .885,
      // and that is a standing constraint on the mount above, not a detail.
      // These pieces patch the storefront's own wall; the jambs are pinned to
      // the stadium collision corridor at x 25.7/28.45, which does not move;
      // and the opening itself is CUT out of the arcade wall by a world-space
      // box. Rescale the mount and none of it follows. It was tried: the model
      // grew a quarter, these literals stayed, and the result was a flat cream
      // slab standing in the middle of the lobby and the model's back wall
      // closing over the vomitory mouth that arcade.js:381-382 leaves open.
      // Remapping them through the same growth fixed the slab and still walked
      // the sign off the door the jambs frame. If this storefront ever does
      // need to be bigger, the wall cut, the jambs, the fills and the tunnel
      // furniture all have to be re-authored together.
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
      // The supplied Pokemon logo is a decorative skin on the existing
      // lintel. It deliberately has no collider and does not alter the room.
      loader.load('assets/models/pokemon/pokemon-logo.glb?v=pokemon-logo-1',logoGltf=>{
        const logo=logoGltf.scene;
        logo.traverse(object=>{
          if(!object.isMesh)return;
          object.castShadow=false;
          object.receiveShadow=false;
          const makeUnlit=source=>new THREE.MeshBasicMaterial({
            map:source?.map??null,
            color:source?.color?.clone?.()??new THREE.Color(0xffffff),
            transparent:Boolean(source?.transparent||(source?.opacity??1)<1),
            opacity:source?.opacity??1,
            alphaTest:source?.alphaTest??0,
            side:source?.side??THREE.FrontSide,
            vertexColors:Boolean(source?.vertexColors),
            toneMapped:false
          });
          object.material=Array.isArray(object.material)
            ?object.material.map(makeUnlit)
            :makeUnlit(object.material);
        });
        logo.updateWorldMatrix(true,true);
        // The bake carries its two colours on the wrong pieces: the letter
        // bodies wear the blue swatch and the thin rim around them wears the
        // yellow, so the sign read as a blue outline with nothing inside it.
        // Every texture in this file is a single flat 8x8 colour, so the fix is
        // simply to trade them. The bodies are the larger shape by a wide
        // margin — about three and a half times the rim's bounding volume — so
        // volume tells the two apart without relying on mesh names.
        const painted=[];
        logo.traverse(node=>{
          if(!node.isMesh)return;
          const material=Array.isArray(node.material)?node.material[0]:node.material;
          if(!material?.map)return;
          const box=new THREE.Box3().setFromObject(node),span=box.getSize(new THREE.Vector3());
          painted.push({material,volume:span.x*span.y*span.z});
        });
        painted.sort((a,b)=>b.volume-a.volume);
        if(painted.length>=2){
          const bodies=painted[0].material,rim=painted[1].material;
          const swatch=bodies.map;bodies.map=rim.map;rim.map=swatch;
          bodies.needsUpdate=true;rim.needsUpdate=true;
        }
        const bounds=new THREE.Box3().setFromObject(logo);
        const size=bounds.getSize(new THREE.Vector3());
        const centre=bounds.getCenter(new THREE.Vector3());
        const holder=new THREE.Group();
        logo.position.sub(centre);
        holder.add(logo);
        holder.scale.setScalar(Math.min(4.15/Math.max(size.x,.001),1.48/Math.max(size.y,.001)));
        // The lintel is read from the south, so the logo's face has to point
        // that way. A half turn showed its back instead: the letters mirrored
        // and the whole sign went flat blue, because the back of the wordmark
        // is its unlit outline plate.
        holder.rotation.y=0;
        holder.position.set(27.08,4.15,-40.48);
        scene.add(holder);
      },undefined,error=>console.warn('The Pokemon vomitory logo could not load.',error));
    },undefined,error=>console.warn('The Pokemon Center could not load.',error));
  }catch(error){console.warn('The Pokemon Center loader could not initialize.',error)}})();
}
// The Temple of Time fills the old Zelda room, entrance facing the doorway.
// Its textures carry their own light, so meshes go full-bright; the player
// climbs its porch steps and raised floor by raycast, like the garden.
let templeOfTimeStarted=false,templeMount=null,templeSettle=false;
// Each outlying region hangs from its own group so the cull can drop the whole
// place in one flag when nobody is near it. A hidden subtree costs no draw
// calls, and these three are the heaviest things in the scene.
const silentHillWorld=new THREE.Group();
silentHillWorld.name='silent-hill-world';
scene.add(silentHillWorld);
const pokemonRosterWorld=new THREE.Group();
pokemonRosterWorld.name='pokemon-roster-world';
scene.add(pokemonRosterWorld);
const templeDown=new THREE.Vector3(0,-1,0),templeRayOrigin=new THREE.Vector3(),templeRay=new THREE.Raycaster();
function installTempleOfTime(){
  void (async()=>{try{
    const loader=await getOptimizedGltfLoader();
    loader.load('assets/models/temple-of-time.glb?v=plan-9',gltf=>{
      const temple=gltf.scene;
      // one stray untextured fragment of the deleted entrance door survives in
      // the bake as a black box on the sill; nothing untextured belongs here
      const doomed=[];
      temple.traverse(node=>{
        if(!node.isMesh)return;
        // The flank patch is baked into the model — 42 "flank" meshes and three
        // "corridorlid" slabs added straight to the glb, not written here. It
        // shows: the lid runs on well past the staircase it was meant to cover,
        // the wall under it is a bare slab, and there is still a hole through to
        // the sky. Geometry that cannot be measured cannot be adjusted, so it
        // comes out by name and is rebuilt below where its numbers are visible.
        // threshold is deliberately NOT in this set. It is the landing plate
        // outside the door and the only floor there, so resolveTempleFloor needs
        // it: strip it and a player cannot leave the building. It was stripped
        // once and replaced with a solid block, which put a ten metre monolith
        // across the staircase. The plate stays; what it needed was something
        // under it at the wall line, not instead of it.
        if(/^(flanks|flankn|corridorlid|threshold)/.test(node.name||'')){doomed.push(node);return}
        const first=Array.isArray(node.material)?node.material[0]:node.material;
        if(!first.map){doomed.push(node);return}
        node.castShadow=false;node.receiveShadow=false;
        const materials=Array.isArray(node.material)?node.material:[node.material];
        const swapped=materials.map(material=>new THREE.MeshBasicMaterial({map:material.map??null,color:material.color?.clone()??new THREE.Color(0xffffff),transparent:material.transparent,opacity:material.opacity,side:material.side}));
        node.material=Array.isArray(node.material)?swapped:swapped[0];
      });
      doomed.forEach(node=>node.removeFromParent());
      const mount=new THREE.Group();
      mount.add(temple);
      // The temple is two buildings — the great hall with its stained glass and
      // the sanctum behind the Door of Time — standing 9.5m apart with only the
      // corridor tube joining them at floor level. Everything above and beside
      // that tube was open to the void, which is the hole. It is closed here as
      // a link block: two flanks on the buildings' own lines at z 30.2 and 53.8,
      // and a roof over the top at y 17. Walls and a lid, not a filled volume —
      // the baked patch packed the whole 9.5 by 24 by 22 space with slabs, which
      // is why it read as a bare mass rather than as part of the building.
      // Marble is borrowed from the model itself so it matches the courses
      // either side rather than being a flat approximation of them.
      // The dominant material by vertex count, not the first one found. The
      // first is a character banner, and a link block wearing Sheik across both
      // flanks is worse than the hole it closes; the masonry is the material
      // most of the building is actually made of.
      let marble=null,marbleWeight=0;
      const weights=new Map();
      temple.traverse(node=>{
        if(!node.isMesh||!node.geometry?.attributes?.position)return;
        const first=Array.isArray(node.material)?node.material[0]:node.material;
        if(!first?.map)return;
        const weight=(weights.get(first)??0)+node.geometry.attributes.position.count;
        weights.set(first,weight);
        if(weight>marbleWeight){marbleWeight=weight;marble=first}
      });
      if(marble){
        // Tiled, not stretched. One copy of the atlas smeared over a 9.5 by 22
        // metre face reads as a smear; repeating it at roughly the course size
        // of the walls either side lets it pass as masonry.
        const courses=marble.map.clone();
        courses.needsUpdate=true;
        courses.wrapS=courses.wrapT=THREE.RepeatWrapping;
        courses.repeat.set(2.4,5.5);
        const stone=new THREE.MeshBasicMaterial({map:courses,color:marble.color?.clone()??new THREE.Color(0xffffff),side:THREE.DoubleSide});
        const link=[
          [9.5,22,.5,-75.75,6,30.2],   // south flank, on the great hall's own line
          [9.5,22,.5,-75.75,6,53.8],   // north flank
          [9.5,.5,23.6,-75.75,17,42],  // the roof over the gap
          // The entrance stood open from the stair to y 8.9 — ten metres wide
          // and nine tall, with the masonry only starting again above it. From
          // the bottom of the steps that is not a doorway, it is a missing
          // wall: you look up through it and out of the building. Measured, not
          // guessed — the jambs sit at z 36.9 and 47.1 and the arch springs at
          // 8.95, so this fills exactly what was left open above head height
          // and leaves the door itself the 3.2m it needs.
          [.5,5.75,10.2,-46.2,6.075,42],
          // And the corners either side of it. The hall's ledge had been
          // covering these by accident: trim it back to the stairs, as it should
          // be, and the east end turns out never to have been closed outboard of
          // the door jambs. One side looked out at the arcade's own untextured
          // shell 19m away, the other at nothing at all.
          [.5,12.5,9,-46.2,2.75,32.7],
          [.5,12.5,9,-46.2,2.75,51.3]
        ];
        for(const [w,h,d,x,y,z] of link){
          const piece=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),stone);
          piece.position.set(x,y,z);
          mount.add(piece);
        }
        // And the doorway under that head. Capping the arch was not enough: from
        // the hall floor, 97 of 1012 rays fired across the front of the building
        // still went past it, every one crossing the wall plane between y -3.17
        // and 3.10 — the band under the head, split in two by the landing slab,
        // which is also what was seen jutting through the opening from below.
        //
        // Sealed rather than glazed or narrowed, because there is nothing out
        // there to look at. The temple stands three metres off the arcade's west
        // wall, and that wall is open on this line, so the sightline runs
        // straight through the building and out the far side to the Chao Garden.
        //
        // The entrance is built after the mount goes in, so it can sample the
        // wall it is filling rather than guess at it.
      }
      scene.add(mount);
      templeMount=mount;
      // The entrance patch wears the wall it fills.
      //
      // The link block borrows `marble`, the dominant material by vertex count,
      // and for a flank standing between two buildings that is right. At the
      // front door it is not: the dominant material is the pale floor stone, and
      // against the dark banded masonry of the front wall a patch made of it
      // reads as a bare slab dropped in the opening — which is exactly how it
      // looked. Sample the wall beside the doorway instead and take whatever is
      // actually there, so the fill matches its surroundings by construction
      // rather than by my judgement of them.
      const wallProbe=new THREE.Raycaster(new THREE.Vector3(-52,2,35),new THREE.Vector3(1,0,0),0,22);
      const wallSample=wallProbe.intersectObject(mount,true).filter(hit=>hit.face&&hit.object.material?.map)[0];
      const facing=wallSample?.object.material??marble;
      if(facing?.map){
        // One texture tile per four metres, the same density the link block
        // ends up at, so a three metre landing does not wear a twenty metre
        // flank's stretch. BoxGeometry maps every face 0..1, so the repeat has
        // to be set per piece from that piece's own size.
        const dressed=(width,height)=>{
          const map=facing.map.clone();map.needsUpdate=true;
          map.wrapS=map.wrapT=THREE.RepeatWrapping;
          map.repeat.set(Math.max(1,Math.round(width/4)),Math.max(1,Math.round(height/4)));
          return new THREE.MeshBasicMaterial({map,color:facing.color?.clone()??new THREE.Color(0xffffff),side:THREE.DoubleSide});
        };
        // A real entryway, not a filled hole.
        //
        // Flush panels on the wall line closed the view but left the front of
        // the temple blank: from the forecourt there was no door at all. What
        // reads as a door is depth, so the opening keeps its full ten metres and
        // gains a reveal — two returns and a soffit — set 1.4m into the wall. It
        // is a passage, not a plug: the doorway above the stairs stays open and
        // walkable, and what you see through it is the arcade's own west room,
        // which is where it actually leads. The sky and the ground beyond are
        // covered by the head above and the apron below.
        //
        // All on the scene, not the mount: this stone is DoubleSide and anything
        // in the doorway that templeGroundAt can see is read as floor at its
        // underside, which would drop a walker three and a half metres. The
        // temple has no lateral collision, so the entry passes a player either
        // way — the same reason its own columns are walk-through.
        // The ground outside the door is ground, not a floating plate.
        //
        // threshold, the plate the model lays at y 0 outside the door, floats:
        // probing the whole footprint, there is no floor whatever under it from
        // x -48 eastward, so anyone who walks out through the doorway -- and the
        // temple has no lateral collision, so everyone can -- ends up standing in
        // a void looking up at its bare underside. That is the horizontal plane.
        //
        // It replaces the plate rather than propping it up: a base under a floating
        // slab is still something you can walk inside. The block starts at x -49,
        // east of where the stairs reach y 0.01 on their own at -49, so it cannot
        // touch them -- the last attempt began at -51.5 and put a block through
        // the staircase.
        const apron=new THREE.Mesh(new THREE.BoxGeometry(7.6,3.5,12),dressed(7.6,3.5));
        apron.position.set(-45.2,-1.75,42);
        mount.add(apron);
        const reveal=dressed(10.2,3.5);
        for(const [w,h,d,x,y,z,material] of [
          [1.4,6.9,.4,-46.9,-.15,36.8,reveal],   // south return
          [1.4,6.9,.4,-46.9,-.15,47.2,reveal],   // north return
          [1.4,.4,10.8,-46.9,3.4,42,reveal]      // soffit over the opening
        ]){
          const piece=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);
          piece.position.set(x,y,z);
          scene.add(piece);
        }
      }
    },undefined,error=>console.warn('Temple of Time failed to load:',error));
  }catch(error){console.warn('Temple of Time failed to load:',error)}})();
}
const TEMPLE_STEP=1.4,TEMPLE_FALL=6.8;
/**
 * The temple's floor, cached on a grid.
 *
 * The raycast underneath this measures 7.5ms on a mid machine — for a model of
 * only 19,469 triangles, which is the surprise. Two things make it that slow:
 * the glb is meshopt-quantised, so three.js takes its slow per-vertex
 * dequantising path, and one mesh (Object_32, 10,822 triangles) spans the whole
 * building, so no bounding volume culls anything. Filtering to the meshes over
 * the probe point only takes it to 6.2ms. It is called every frame a player
 * moves inside the temple, which is most of a 60fps budget spent on the floor.
 *
 * The floor does not change, so the answer is cached rather than recomputed:
 * 0.4m cells, and half-metre buckets of foot height because the result depends
 * on where the walker's feet are (a lintel overhead is walked under, not onto).
 * At 11.25 m/s a cell lasts about 35ms, so the raycast runs a few times a second
 * instead of sixty, and standing still or looking around costs nothing at all.
 */
const templeGroundCache=new Map();
function templeGroundAt(x,z,feetY){
  if(!templeMount)return null;
  const key=Math.round(x*2.5)+':'+Math.round(z*2.5)+':'+Math.round(feetY*2);
  const cached=templeGroundCache.get(key);
  if(cached!==undefined)return cached;
  templeRayOrigin.set(x,feetY+TEMPLE_STEP+.1,z);
  templeRay.set(templeRayOrigin,templeDown);
  templeRay.far=TEMPLE_STEP+TEMPLE_FALL+.2;
  let ground=null;
  for(const hit of templeRay.intersectObject(templeMount,true)){
    const y=hit.point.y;
    // arches and lintels overhead are walked under, not onto
    if(y>feetY+TEMPLE_STEP)continue;
    ground=y<feetY-TEMPLE_FALL?null:y;
    break;
  }
  // A walked path is bounded by the room, but clear it rather than let a long
  // session grow the map without limit.
  if(templeGroundCache.size>24000)templeGroundCache.clear();
  templeGroundCache.set(key,ground);
  return ground;
}
function resolveTempleFloor(previousX,previousZ){
  const inRoom=playerPosition.x>-124.5&&playerPosition.x<-41.6&&playerPosition.z>24.8&&playerPosition.z<59.2;
  if(!inRoom){
    if(templeSettle){
      playerPosition.y+=(1.65-playerPosition.y)*.3;
      if(Math.abs(playerPosition.y-1.65)<.02){playerPosition.y=1.65;templeSettle=false}
    }
    return;
  }
  templeSettle=true;
  const feet=playerPosition.y-1.65;
  let ground=templeGroundAt(playerPosition.x,playerPosition.z,feet);
  if(ground===null){
    // Slide before refusing, the same as the castle: a full revert also kills
    // the along-edge component of the step, which made every temple edge and
    // jamb feel like glue when brushed at an angle.
    const slideGround=templeGroundAt(playerPosition.x,previousZ,feet);
    if(slideGround!==null){playerPosition.z=previousZ;ground=slideGround}
    else{
      const slideGround2=templeGroundAt(previousX,playerPosition.z,feet);
      if(slideGround2!==null){playerPosition.x=previousX;ground=slideGround2}
    }
  }
  if(ground===null){
    // stone ahead, or a drop with no floor: the step is refused and the
    // walker keeps the ground they were already standing on
    playerPosition.x=previousX;playerPosition.z=previousZ;
    const held=templeGroundAt(previousX,previousZ,feet);
    if(held!==null)playerPosition.y+=(held+1.65-playerPosition.y)*.35;
    else playerPosition.y+=(1.65-playerPosition.y)*.35;
    return;
  }
  playerPosition.y+=(ground+1.65-playerPosition.y)*.35;
}
/**
 * Peach's Castle, outside the west wall on the Mario room's own line.
 *
 * Placed like the Temple of Time and walked the same way: the model's geometry
 * IS the floor, found by a ray straight down, and a step with nothing under it
 * is refused. That is what makes the black doorways inside the castle solid
 * without building a single wall for them — there is no floor behind one, so
 * the walk stops at the threshold.
 *
 * The model's front, the brick arch with the red carpet, faces +x, which is
 * the way a player arrives: west out of the old Mario room.
 *
 * It is placed so the castle's OWN carpet comes through the wall rather than
 * being met by a painted one. The bake's red runner (Object_2) reaches 9m
 * further east than anything else — the brick arch stops at x -52.1, the grass
 * and the sky shell earlier still — so sliding the whole model 6m east pushes
 * only the carpet through the doorway and leaves the archway outside where it
 * belongs. It lands about 6m into the room.
 *
 * The mount also drops 0.86 so that carpet lies at y 0.02: level with the
 * arcade floor rather than on a 0.88 step, and two centimetres above it rather
 * than exactly on it, because coplanar with the room's own floor is a z-fight
 * across six metres.
 */
/**
 * The Pikomat, filling the bay east of the Pokemon Center.
 *
 * Kept at 4.8m because the hall ceiling is a flat 5.08 — that is as big as
 * anything in here gets. It arrives with its own materials rather than the
 * full-bright swap the baked rooms take, because its window is authored with
 * KHR_materials_transmission and flattening that would cost it the glass.
 *
 * It is 320 meshes, which is a lot of draw calls for one prop, so it hangs
 * from its own mount and drops out of the frame entirely unless somebody is
 * on that side of the building.
 */
let pikomatStarted=false,pikomatMount=null;
const PIKOMAT_X=39.8,PIKOMAT_Z=-38.2,PIKOMAT_HEIGHT=4.8;
function installPikomat(){
  if(pikomatStarted)return;
  pikomatStarted=true;
  void (async()=>{try{
    const loader=await getOptimizedGltfLoader();
    loader.load('assets/models/props/pikomat.glb?v=sh-seal-1',gltf=>{
      const machine=gltf.scene;
      machine.traverse(node=>{if(!node.isMesh)return;node.castShadow=false;node.receiveShadow=false;});
      machine.updateMatrixWorld(true);
      const bounds=new THREE.Box3().setFromObject(machine);
      const size=bounds.getSize(new THREE.Vector3()),centre=bounds.getCenter(new THREE.Vector3());
      const scale=PIKOMAT_HEIGHT/Math.max(size.y,.001);
      machine.scale.setScalar(scale);
      machine.position.set(-centre.x*scale,-bounds.min.y*scale,-centre.z*scale);
      const mount=new THREE.Group();
      mount.add(machine);
      mount.position.set(PIKOMAT_X,0,PIKOMAT_Z);
      mount.rotation.y=Math.PI;
      scene.add(mount);
      pikomatMount=mount;
    },undefined,error=>console.warn('The Pikomat could not load.',error));
  }catch(error){console.warn('Pikomat loader could not initialize.',error)}})();
}
let castleStarted=false,castleMount=null,castleSettle=false;
const castleDown=new THREE.Vector3(0,-1,0),castleRayOrigin=new THREE.Vector3(),castleRay=new THREE.Raycaster();
const CASTLE_STEP=1.4,CASTLE_FALL=6.8,CASTLE_CENTRE_X=-75.4,CASTLE_CENTRE_Z=-25.2,CASTLE_HEIGHT=31.5,CASTLE_THRESHOLD_X=-44.6;
// The walled approach between the archway and the arcade wall, on the arch's
// own z lines so the arch closes its west end.
const CASTLE_APPROACH_Z=-25.2,CASTLE_APPROACH_HALF=5.4,CASTLE_APPROACH_WEST=-57.4;
// The pipe IS the Mario room: you step out of the hall straight into it and it
// carries you the room's whole 21.6m depth to the castle wall. Its own file
// stands it upright — x and z are the circular section, 7.224 across, y is the
// axis, 5.584 long, origin at the base and rim at the far end.
//
// The section is deliberately larger than the room. Nine metres across gives a
// bore of 5.8 — wide enough that the tube reads as a tunnel you are inside
// rather than a ring you step through — and at that size it cuts up through the
// 5.08 ceiling and down through the floor, which is allowed here. The axis sits
// at 2.92 so the bore's floor still lands level with the room's own; a player
// walks the bottom of the pipe, not a ledge inside it.
const CASTLE_PIPE_BORE=1.246,CASTLE_PIPE_LENGTH=3.87;
// 2.97, not 2.92. At 2.92 the axis equalled the bore radius exactly, so the
// tube's lowest point sat at y 0.000 while the room's floor sits at 0.002 —
// and the floor came through the green in a hairline down the whole length.
// Five centimetres of lift clears it and is nothing to step over.
const CASTLE_PIPE_EAST=-21.6,CASTLE_PIPE_WEST=-43.2,CASTLE_PIPE_AXIS_Y=2.97,CASTLE_PIPE_BORE_RADIUS=2.9;
// How far off the centre line a player may walk. The pipe is round and the
// room's floor is flat, so the tube gives nothing to stop a walker at: its
// inner surface leaves the floor gradually, and two metres out it is already
// climbing through their shins. 2.2 is where that wall stands waist high, and
// it is also where the archway at the far end already puts its jambs, so the
// channel is the same width at both ends of the run.
//
// The mouth is nine metres wide but only this much of it is a way through: the
// ring between the bore and the lip is the pipe's own wall seen end on. Held
// here because all three authorities have to agree.
const CASTLE_PIPE_CHANNEL_HALF=2.2;
// Where that channel starts, coming from the castle. The approach corridor is
// 10.8m wide and the bore is 4.4, and the archway's brick shoulders are drawn
// across the whole of that difference over x -43.7..-43.2. They are the taper,
// so the narrow section begins at their west face rather than at the pipe's
// own end half a metre later -- otherwise a walker is refused by nothing until
// they are already standing inside the brick.
const CASTLE_ARCHWAY_WEST=CASTLE_PIPE_WEST-.5;
const CASTLE_PIPE_SHADE=.74;
function installPeachsCastle(){
  if(castleStarted)return;
  castleStarted=true;
  void (async()=>{try{
    const loader=await getOptimizedGltfLoader();
    loader.load('assets/models/mario/peachs-castle-1f.glb?v=castle-model-1',gltf=>{
      const castle=gltf.scene;
      // The bake carries its own light, like the temple's and the garden's.
      castle.traverse(node=>{
        if(!node.isMesh)return;
        node.castShadow=false;node.receiveShadow=false;
        const materials=Array.isArray(node.material)?node.material:[node.material];
        const swapped=materials.map(material=>new THREE.MeshBasicMaterial({
          map:material.map??null,color:material.color?.clone()??new THREE.Color(0xffffff),
          transparent:material.transparent,opacity:material.opacity,side:THREE.DoubleSide,fog:false}));
        node.material=Array.isArray(node.material)?swapped:swapped[0];
      });
      castle.updateMatrixWorld(true);
      const bounds=new THREE.Box3().setFromObject(castle);
      const size=bounds.getSize(new THREE.Vector3()),centre=bounds.getCenter(new THREE.Vector3());
      const scale=CASTLE_HEIGHT/Math.max(size.y,.001);
      castle.scale.setScalar(scale);
      castle.position.set(-centre.x*scale,-bounds.min.y*scale,-centre.z*scale);
      const mount=new THREE.Group();
      mount.add(castle);
      mount.position.set(CASTLE_CENTRE_X,-.86,CASTLE_CENTRE_Z);
      // The bake encloses itself only as far as x -57.4 — that is where its sky
      // shell and its grass both stop. East of that only the arch and the
      // carpet continue, so the whole 14m approach between the archway and the
      // arcade's own wall had floor under it and nothing at either side: open
      // to the black, both to look at and to walk out through. It is roofed and
      // walled here, on the arch's own z lines so the arch itself closes the
      // west end, in the arch's own brick so it reads as the same building.
      const brick=(()=>{
        let found=null;
        mount.traverse(node=>{if(!found&&node.isMesh&&node.name==='Object_4')found=Array.isArray(node.material)?node.material[0]:node.material});
        return found;
      })();
      if(brick){
        const courses=brick.map?brick.map.clone():null;
        if(courses){courses.needsUpdate=true;courses.wrapS=courses.wrapT=THREE.RepeatWrapping;courses.repeat.set(4,3.4)}
        const walling=new THREE.MeshBasicMaterial({map:courses,color:brick.color?.clone()??new THREE.Color(0xffffff),side:THREE.DoubleSide});
        const localZ=z=>z-CASTLE_CENTRE_Z,localX=x=>x-CASTLE_CENTRE_X,localY=y=>y+.86;
        // The last two are the shoulders. The approach is 10.8m across and the
        // arcade's doorway is 4.4, so either side of the opening the corridor
        // met nothing but the shell wall — and that wall is only 5m tall, so
        // above it the corridor was still open, and the join read as a seam
        // with daylight in it. These close the shoulders the corridor's full
        // height, flush against the wall's inner face, so the passage simply
        // narrows into the doorway.
        const shoulder=(CASTLE_APPROACH_HALF-ROOM_DOOR_HALF_WIDTH-.6)/2+ROOM_DOOR_HALF_WIDTH+.6;
        const shoulderWidth=CASTLE_APPROACH_HALF-ROOM_DOOR_HALF_WIDTH-.6;
        for(const [w,h,d,x,y,z] of [
          [14.2,13,.5,-50.3,6.5,CASTLE_APPROACH_Z-CASTLE_APPROACH_HALF],
          [14.2,13,.5,-50.3,6.5,CASTLE_APPROACH_Z+CASTLE_APPROACH_HALF],
          [14.2,.5,CASTLE_APPROACH_HALF*2,-50.3,13,CASTLE_APPROACH_Z],
          [.5,13,shoulderWidth,-43.45,6.5,CASTLE_APPROACH_Z-shoulder],
          [.5,13,shoulderWidth,-43.45,6.5,CASTLE_APPROACH_Z+shoulder],
          // The reveals. Cutting the shell left two raw edges 0.3m deep on the
          // sides of the opening, and the shell's own colour is 0x180d31 — all
          // but black. Unfaced they read as a dead slot beside the doorway
          // rather than as the thickness of a wall, which is what they are.
          [.62,5.2,.14,-43.2,2.6,CASTLE_APPROACH_Z-2.2],
          [.62,5.2,.14,-43.2,2.6,CASTLE_APPROACH_Z+2.2]
        ]){
          const piece=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),walling);
          piece.position.set(localX(x),localY(y),localZ(z));
          mount.add(piece);
        }
      }
      // The approach reads as a warp pipe rather than a brick box. The bake's
      // axis runs along world z once its Z-up root is applied, so a quarter
      // turn lays it down the corridor with its mouth facing east — the way a
      // player arrives. It is scaled wide enough to fill the corridor's section
      // so the masonry behind it barely shows, and long enough to run the whole
      // 14.2m from the arcade wall to the archway.
      void getOptimizedGltfLoader().then(pipeLoader=>pipeLoader.load('assets/models/mario/warp-pipe.glb?v=sh-seal-1',pipeGltf=>{
        const pipe=pipeGltf.scene;
        pipe.updateMatrixWorld(true);
        pipe.traverse(node=>{
          if(!node.isMesh)return;
          node.castShadow=false;node.receiveShadow=false;
          const materials=Array.isArray(node.material)?node.material:[node.material];
          const swapped=materials.map(material=>new THREE.MeshBasicMaterial({
            // The bake's green is a very bright 0.94; taken down to about three
            // quarters it still reads as a warp pipe without glowing.
            map:material.map??null,
            color:(material.color?.clone()??new THREE.Color(0xffffff)).multiplyScalar(CASTLE_PIPE_SHADE),
            side:THREE.DoubleSide,toneMapped:false}));
          node.material=Array.isArray(node.material)?swapped:swapped[0];
          // The far end is capped in the bake, so the tube dead-ends in a green
          // disc instead of opening on the castle. The cap is the ring of
          // triangles lying flat in the base plane; drop those and the pipe is
          // open at both ends. Measured in the model's own space, where that
          // plane is y=0, and a triangle only goes if ALL THREE of its corners
          // are in it — otherwise the wall's bottom course goes with it.
          const geometry=node.geometry,position=geometry.attributes.position;
          const vertex=new THREE.Vector3(),lift=[];
          for(let i=0;i<position.count;i++){
            vertex.fromBufferAttribute(position,i).applyMatrix4(node.matrixWorld);
            lift.push(vertex.y);
          }
          const index=geometry.getIndex(),kept=[];
          const count=index?index.count:position.count;
          for(let i=0;i<count;i+=3){
            const a=index?index.getX(i):i,b=index?index.getX(i+1):i+1,c=index?index.getX(i+2):i+2;
            if(lift[a]<.02&&lift[b]<.02&&lift[c]<.02)continue;
            kept.push(a,b,c);
          }
          if(kept.length<count)geometry.setIndex(kept);
        });
        pipe.scale.set(CASTLE_PIPE_BORE,CASTLE_PIPE_LENGTH,CASTLE_PIPE_BORE);
        const pipeMount=new THREE.Group();
        pipeMount.add(pipe);
        // A quarter turn about Z lays the pipe down and puts its rim — the mouth —
        // at the +x end, facing a player walking west out of the arcade. The
        // origin is the base, so it is planted at the archway end and runs east
        // to meet the wall.
        pipeMount.rotation.z=-Math.PI/2;
        pipeMount.position.set(CASTLE_PIPE_WEST-CASTLE_CENTRE_X,CASTLE_PIPE_AXIS_Y+.86,CASTLE_APPROACH_Z-CASTLE_CENTRE_Z);
        mount.add(pipeMount);
        // The bore measures 6.8m clear from end to end, but the pipe's material
        // is one flat unlit green inside and out, so an open tube reads as a
        // solid wall — there is no shading to tell you it is hollow. The murals
        // go in here and do that job: three walls of Mario running the length of
        // the tube, so walking in is a portal rather than a green rectangle.
        // Set in to 2.4, not hard against the wall. The bore is a cylinder of
        // radius 3.4, so a panel at 3.3 out from the axis has only +/-0.8 of
        // height before it pushes through the curve — which is why the first
        // pass pinched them into strips. At 2.4 there is +/-2.4 to play with.
        // 2.0 out from the axis: the bore's radius is 2.92, so that offset still
        // leaves 2.13 of half-height and a 3.8m panel sits inside the curve.
        // Curved to the bore rather than hung flat inside it. Three flat planes in
        // a round tube leave wedges of green at every edge and read as boards
        // propped in a pipe; these are strips of the cylinder itself, so the art
        // wraps the wall the way paint would. Built by hand because a
        // CylinderGeometry runs its axis along y and maps u around the arc — the
        // opposite of what is wanted on both counts.
        // A quarter circle on each flank, and nothing across the crown. At this
        // radius the bore's top sits at 5.69 and the hall's ceiling is at 5.02, so
        // a band over the crown draws above the roof and is simply not seen —
        // measured, not guessed. Anything within 41 degrees of vertical is lost,
        // so the arcs run 45 to 135 either side: y 4.89 down to 1.05, clear of the
        // ceiling above and of the walker below.
        // Galaxy goes right around the bore and the whole way down it: one
        // continuous skin rather than panels with green between them. The radius
        // is 2.90 against a bore of 2.92, which puts the bottom of the wrap at
        // y 0.07 — on the walking floor, so you walk on the starfield rather than
        // through a band floating above it. The crown ends up above the hall's
        // ceiling and is simply never seen, which costs nothing now that there is
        // no separate panel up there to lose.
        const skinRadius=CASTLE_PIPE_BORE_RADIUS,skinArc=Math.PI*2,skinX=[CASTLE_PIPE_WEST+.6,CASTLE_PIPE_EAST-.6];
        const axisY=CASTLE_PIPE_AXIS_Y+.86,axisZ=CASTLE_APPROACH_Z-CASTLE_CENTRE_Z;
        const curvedSkin=(centre,fromX,toX)=>{
          const arcSegments=64,positions=[],uvs=[],indices=[];
          for(let i=0;i<=1;i++){
            const along=i,x=fromX+(toX-fromX)*along-CASTLE_CENTRE_X;
            for(let j=0;j<=arcSegments;j++){
              const across=j/arcSegments,theta=centre-skinArc/2+skinArc*across;
              positions.push(x,axisY+skinRadius*Math.cos(theta),axisZ+skinRadius*Math.sin(theta));
              // v runs with the arc, not against it, so the art's own bottom edge
              // lands at the bottom of the bore: the green planet ends up under the
              // player's feet and the sky over their head.
              uvs.push(along,across);
            }
          }
          for(let i=0;i<1;i++)for(let j=0;j<arcSegments;j++){
            const a=i*(arcSegments+1)+j,b=a+arcSegments+1;
            indices.push(a,b,a+1,a+1,b,b+1);
          }
          const geometry=new THREE.BufferGeometry();
          geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
          geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
          geometry.setIndex(indices);
          geometry.computeVertexNormals();
          return geometry;
        };
        // Top of the bore, then the two haunches either side of it.
        {
          const texture=new THREE.TextureLoader().load('assets/art/mario-galaxy-portal.jpg?v=galaxy-portal-1');
          texture.colorSpace=THREE.SRGBColorSpace;
          texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
          // One pass, no tiling. This art is 800x1242 — portrait — so its long
          // edge goes around the bore and its short edge down the tunnel, which
          // costs 1.72x of stretch along the length. The old landscape mural cost
          // 4.2x the other way and turned into a smear; this is the same single
          // wrap, on a picture shaped to survive it.
          texture.repeat.set(1,1);
          mount.add(new THREE.Mesh(curvedSkin(0,skinX[0],skinX[1]),
            new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,toneMapped:false})));
        }
      },undefined,error=>console.warn('The warp pipe could not load.',error)));
      scene.add(mount);
      castleMount=mount;
      // A decal lying exactly on the surface it decorates cannot win a depth
      // test on its own. The sun medallion in the entrance hall is a nine
      // vertex plane at y=0, coplanar with the checkerboard, and with the
      // camera at near .1 and far 180 the buffer has no bits left to separate
      // them at this scale — it tears into stripes. Anything with no thickness
      // at all is a decal by definition, so it is told to draw in front of
      // whatever it lies on. Measured after mounting, because the bake's own
      // Z-up-to-Y-up root means flatness is only meaningful in world space.
      mount.updateMatrixWorld(true);
      const decalSpan=new THREE.Vector3();
      castle.traverse(node=>{
        if(!node.isMesh)return;
        new THREE.Box3().setFromObject(node).getSize(decalSpan);
        if(decalSpan.y>.02)return;
        for(const material of (Array.isArray(node.material)?node.material:[node.material])){
          material.polygonOffset=true;material.polygonOffsetFactor=-4;material.polygonOffsetUnits=-4;
        }
      });
    },undefined,error=>console.warn('Peachs Castle could not load.',error));
  }catch(error){console.warn('Peachs Castle loader could not initialize.',error)}})();
}
function castleGroundAt(x,z,feetY){
  if(!castleMount)return null;
  castleRayOrigin.set(x,feetY+CASTLE_STEP+.1,z);
  castleRay.set(castleRayOrigin,castleDown);
  castleRay.far=CASTLE_STEP+CASTLE_FALL+.2;
  for(const hit of castleRay.intersectObject(castleMount,true)){
    const y=hit.point.y;
    // the arch overhead and the painted sky are walked under, not onto
    if(y>feetY+CASTLE_STEP)continue;
    return y<feetY-CASTLE_FALL?null:y;
  }
  return null;
}
function resolveCastleFloor(previousX,previousZ){
  const inCastle=playerPosition.x<WORLD_BOUNDS.minX
    &&playerPosition.x>CASTLE_EXPANSE.minX
    &&playerPosition.z>CASTLE_EXPANSE.minZ&&playerPosition.z<CASTLE_EXPANSE.maxZ;
  if(!inCastle){
    if(castleSettle){
      playerPosition.y+=(1.65-playerPosition.y)*.3;
      if(Math.abs(playerPosition.y-1.65)<.02){playerPosition.y=1.65;castleSettle=false}
    }
    return;
  }
  // The approach is a corridor, not an apron. Its carpet is far wider than the
  // walls that now enclose it, and floor alone is permission to walk: without
  // this a player simply strolls through the brick and out into the black
  // beside it, which is exactly what happened.
  if(playerPosition.x>CASTLE_APPROACH_WEST&&Math.abs(playerPosition.z-CASTLE_APPROACH_Z)>CASTLE_APPROACH_HALF-PLAYER_COLLISION_RADIUS){
    playerPosition.x=previousX;playerPosition.z=previousZ;
    return;
  }
  castleSettle=true;
  const feet=playerPosition.y-1.65;
  let ground=castleGroundAt(playerPosition.x,playerPosition.z,feet);
  // The castle's own ground starts at x -43.4 and the hall's stops at -42.7,
  // so there is two thirds of a metre of doorway with neither under it. Left
  // to the refusal rule that gap is a wall across the arch: every step into it
  // finds no floor and is put back. The threshold keeps the hall's level
  // instead, and the castle's own 25cm lip is a step up from there.
  if(ground===null&&playerPosition.x>CASTLE_THRESHOLD_X)ground=0;
  if(ground===null){
    // Slide before refusing. A full revert kills the along-edge component of
    // the step too, so brushing a floor edge or a railing at an angle stopped
    // ALL movement -- the sticky-wall feel on every castle edge. Try the step
    // with one axis at a time; only a corner refuses outright.
    const slideGround=castleGroundAt(playerPosition.x,previousZ,feet);
    if(slideGround!==null){playerPosition.z=previousZ;ground=slideGround}
    else{
      const slideGround2=castleGroundAt(previousX,playerPosition.z,feet);
      if(slideGround2!==null){playerPosition.x=previousX;ground=slideGround2}
    }
  }
  if(ground===null){
    playerPosition.x=previousX;playerPosition.z=previousZ;
    const held=castleGroundAt(previousX,previousZ,feet);
    if(held!==null)playerPosition.y+=(held+1.65-playerPosition.y)*.35;
    else playerPosition.y+=(1.65-playerPosition.y)*.35;
    return;
  }
  playerPosition.y+=(ground+1.65-playerPosition.y)*.35;
}
/**
 * The two things walking the street.
 *
 * Both keep their own lit materials rather than going full-bright: the point
 * of them is that the fog gives them up slowly. Pyramid Head is authored
 * facing away from the camera, the twins toward it, so their turns differ.
 */
function installSilentHillCast(){
  const place=(file,options)=>{
    void (async()=>{try{
      const loader=await getOptimizedGltfLoader();
      loader.load('assets/models/silent-hill/'+file+'?v=sh-galaxy-3',gltf=>{
        const model=gltf.scene;
        model.traverse(node=>{if(node.isMesh){node.castShadow=false;node.receiveShadow=false}});
        const bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),centre=bounds.getCenter(new THREE.Vector3());
        const scale=options.height/Math.max(size.y,.001);
        const holder=new THREE.Group();
        model.scale.setScalar(scale);
        model.position.set(-centre.x*scale,-bounds.min.y*scale,-centre.z*scale);
        holder.add(model);
        holder.position.set(options.x,0,options.z);
        holder.rotation.y=options.rotY;
        silentHillWorld.add(holder);
      },undefined,error=>console.warn('A Silent Hill figure could not load:',file,error));
    }catch(error){console.warn('Silent Hill cast loader could not initialize.',error)}})();
  };
  // At the head of the street, hard against the east kerb where the fog is
  // thickest. He was briefly put at x=-25.3 on the strength of a corner that
  // measured well on paper and turned out to be INSIDE the block at (-21.4,-86),
  // whose footprint runs x -25.65..-17.15 — which is why nobody could find him.
  // -27.5 is in the roadway, about two metres clear of that block's west face,
  // so he reads against its blank return as you come up the street. Turned half
  // a circle to face back down the walk; the model faces away at rest.
  place('pyramid-head.glb',{x:-27.5,z:-89.9,height:3.4,rotY:Math.PI});
  // The twins keep to the kerbs, side-on to the street.
  place('twin-victim.glb',{x:-40.2,z:-50.4,height:1.35,rotY:Math.PI/2});
  place('twin-victim.glb',{x:-25.4,z:-63.4,height:1.35,rotY:-Math.PI/2+.3});
}
function installSilentHillBuildings(){
  void (async()=>{try{
    const loader=await getOptimizedGltfLoader();
    loader.load('assets/models/silent-hill/sh1-building-11.glb?v=sh-buildings-1',gltf=>{
      const source=gltf.scene;
      source.traverse(o=>{if(o.isMesh){o.castShadow=false;o.receiveShadow=false}});
      // Taller blocks, built the way a building gets taller: more storeys.
      // Stretching one copy on Y smeared its windows into ribbons, so each
      // site stacks whole copies instead and the masonry keeps its proportions.
      // Only the ground floor brings its pavement slab.
      const STOREY=9;
      source.updateWorldMatrix(true,true);
      const meshOrder=[],storeyBox=new THREE.Box3();
      let slabIndex=-1;
      source.traverse(node=>{
        if(!node.isMesh)return;
        storeyBox.setFromObject(node);
        if(storeyBox.max.y-storeyBox.min.y<1)slabIndex=meshOrder.length;
        meshOrder.push(node);
      });
      for(const [x,z,turn,scale,storeys] of [
        [-28.1,-58.4,Math.PI/2,1,2],
        // Two blocks backed against the arcade's north wall, either side of
        // the one above. The warp pipe room's sky-brick box rises 2.4m proud
        // of the arcade roof, and from the far north end of the street
        // (z -92..-96) shallow rays cleared every rooftop and landed on that
        // crown: Super Mario sky, framed by Silent Hill. These two close the
        // band x -21..-51; raycast-swept from the whole district, no eye
        // point sees the crown past them.
        [-29,-55.1,Math.PI,1,2],
        [-43,-55.1,Math.PI,1.02,2],
        [-31,-65.4,0,1,3],
        [-48,-65.4,0,1.04,2],
        [-63,-65.4,0,.97,3],
        [-54.5,-41,Math.PI,1,2],
        // the street north of the building: blocks down both kerbs, thinning
        // out as the fog takes over
        [-21.4,-72.5,-Math.PI/2,1.02,3],
        [-21.4,-86,-Math.PI/2,.98,2],
        [-43.4,-72.5,Math.PI/2,1,2],
        [-43.4,-86,Math.PI/2,1.03,3],
        [-32.4,-93.5,0,1.05,3]
      ]){
        const mount=new THREE.Group();
        for(let level=0;level<storeys;level++){
          const building=source.clone(true);
          if(level>0&&slabIndex>=0){
            let seen=0;
            building.traverse(node=>{
              if(!node.isMesh)return;
              if(seen===slabIndex)node.visible=false;
              seen++;
            });
          }
          building.position.y=level*STOREY;
          mount.add(building);
        }
        mount.position.set(x,0,z);
        mount.rotation.y=turn;
        mount.scale.setScalar(scale);
        silentHillWorld.add(mount);
        // Each block is a hollow facade, open at the back and the top, and
        // nothing enforced it: you could walk through the brickwork and out
        // into the black behind the street. Take the footprint from the placed
        // mount rather than the source, so scale and the quarter turns are
        // already in it. Only the ground storey needs measuring — the upper
        // copies sit directly above it.
        mount.updateMatrixWorld(true);
        const footprint=new THREE.Box3().setFromObject(mount.children[0]);
        silentHillBlocks.push({
          minX:footprint.min.x,maxX:footprint.max.x,
          minZ:footprint.min.z,maxZ:footprint.max.z
        });
      }
      // Solid cores for the two wall-backed blocks. The facade model is a
      // hollow shell -- open back, open top, glass windows -- so on its own it
      // leaks the exact sightline those two were placed to close: raycasts
      // from the north street still reached the pipe room's crown through
      // window openings. A dark core the size of each block makes them
      // opaque from every angle, and in the fog it reads as interior gloom.
      for(const [coreX,coreZ,coreW,coreH,coreD] of [[-29,-55.1,15.7,17.9,8.1],[-43,-55.1,16,18.3,8.2]]){
        const core=new THREE.Mesh(new THREE.BoxGeometry(coreW,coreH,coreD),new THREE.MeshBasicMaterial({color:0x07090f}));
        core.position.set(coreX,coreH/2-.05,coreZ);
        silentHillWorld.add(core);
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
      for(const [px,pz,scale,turn] of [[66,7.5,1.5,.4],[69.5,20,1.3,2.2],[65,31,1.6,4.1],[84,7,1.35,3.3],[92,15,1.55,5.2],[98,29,1.3,.9],[78,30,1.2,3.9],[88,36,1.5,2.7],[95,33,1.4,1.8],[71,36,1.2,4.6]]){
        const ground=chaoGroundAt(px+CHAO_DX,pz+CHAO_DZ,6)??.25;
        if(ground<-0.05)continue;
        const tree=palm.clone(true);
        tree.position.set(px,ground,pz);tree.scale.setScalar(scale);tree.rotation.y=turn;
        chaoWorld.add(tree);
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
    const fx=63+((i*173)%370)/10,fz=6+((i*257)%300)/10;
    const ground=chaoGroundAt(fx+CHAO_DX,fz+CHAO_DZ,9)??.25;
    if(ground<-0.05)continue;
    const patch=new THREE.Group();
    for(const spin of [0,Math.PI/2]){
      const quad=new THREE.Mesh(new THREE.PlaneGeometry(.55,.4),flowerMaterial);
      quad.rotation.y=spin;quad.position.y=.2;patch.add(quad);
    }
    patch.position.set(fx,ground,fz);patch.rotation.y=i*1.7;
    chaoWorld.add(patch);
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
    const ex=64+((index*211)%330)/10,ez=8+((index*307)%300)/10;
    const ground=chaoGroundAt(ex+CHAO_DX,ez+CHAO_DZ,9)??.25;
    if(ground<-0.05)return;
    egg.scale.set(1,1.32,1);
    egg.position.set(ex,ground+.4,ez);
    egg.rotation.set(((index*73)%10-5)*.03,index*1.3,((index*41)%10-5)*.03);
    chaoWorld.add(egg);
  });
}
const sonicModelCache=new Map();
function loadSonicModel(file){
  if(!sonicModelCache.has(file))sonicModelCache.set(file,getOptimizedGltfLoader().then(loader=>new Promise((resolve,reject)=>loader.load('assets/models/sonic/'+file+'?v=plan-9',resolve,undefined,reject))));
  return sonicModelCache.get(file);
}
// Object3D.clone leaves a skinned copy bound to the original's skeleton, which
// is why these rigs used to be handed out rather than copied. SkeletonUtils
// rebinds the bones, so one cached glTF can serve any number of placements.
let skeletonUtilsPromise=null;
function getSkeletonUtils(){return skeletonUtilsPromise??=import('three/addons/utils/SkeletonUtils.js');}
function installChaoGardenCast(){
  // The garden's residents, from the supplied Sonic models. Everything gets
  // the garden's full-bright look and stands on the real ground.
  const brighten=model=>model.traverse(node=>{
    if(!node.isMesh)return;
    node.castShadow=false;node.receiveShadow=false;
    const materials=Array.isArray(node.material)?node.material:[node.material];
    const swapped=materials.map(material=>new THREE.MeshBasicMaterial({map:material.map??null,color:material.color?.clone()??new THREE.Color(0xffffff),vertexColors:material.vertexColors===true,transparent:material.transparent,opacity:material.opacity,fog:false}));
    node.material=Array.isArray(node.material)?swapped:swapped[0];
  });
  const place=(file,options)=>{
    void Promise.all([loadSonicModel(file),getSkeletonUtils()]).then(([gltf,SkeletonUtils])=>{
      // A skinned rig cannot survive Object3D.clone — the copy keeps pointing at
      // the original's bones — so these used to be placed by handing out the
      // loader's own gltf.scene. That is only safe if each file is placed once
      // and only once, and neither held: omochao is placed twice, and any
      // second pass over the cast re-measured a model that had already been
      // scaled, read its finished height as its raw height, and overwrote the
      // real scale with 1. That is how Silver ended up drawn at his authored
      // 48 metres. SkeletonUtils.clone rebinds the skeleton, so every placement
      // now gets its own instance and measuring one cannot disturb another.
      const skinned=Boolean(gltf.scene.getObjectByProperty('type','SkinnedMesh'));
      const model=skinned?SkeletonUtils.clone(gltf.scene):gltf.scene.clone(true);
      brighten(model);
      // skinned bounds confuse the culler into hiding whole characters
      model.traverse(node=>{if(node.isMesh)node.frustumCulled=false});
      // Settle the pose before measuring anything off it. These rigs render
      // nothing like their bind pose, and sizing from the bind box is what had
      // Silver and Shadow standing two heads over the garden while Sonic sank
      // to his shins in the lawn.
      let mixer=null;
      if(gltf.animations.length){
        mixer=new THREE.AnimationMixer(model);
        mixer.clipAction(gltf.animations[0]).play();
        mixer.update(0);
      }
      const {bounds,floor}=measurePose(model),size=bounds.getSize(new THREE.Vector3()),centre=bounds.getCenter(new THREE.Vector3());
      const scale=options.height/Math.max(size.y,.001);
      const holder=new THREE.Group();
      model.scale.setScalar(scale);
      model.position.set(-centre.x*scale,-floor*scale,-centre.z*scale);
      holder.add(model);
      if(mixer)animatedMixers.push(mixer);
      let spotX=options.x,spotZ=options.z,groundY=options.y??null;
      if(groundY===null){
        for(const [dx,dz] of [[0,0],[0,-3],[0,-6],[3,0],[-3,0],[3,-4],[-3,-4]]){
          const probe=chaoGroundAt(options.x+dx+CHAO_DX,options.z+dz+CHAO_DZ,12);
          if(probe!==null&&(probe>-0.05||options.wet)){spotX=options.x+dx;spotZ=options.z+dz;groundY=probe;break}
        }
        if(groundY===null)groundY=.25;
      }
      holder.position.set(spotX,groundY+(options.hover??0),spotZ);
      holder.rotation.y=options.rotY??0;
      chaoWorld.add(holder);
      if(options.spinY||options.bob){
        const baseY=holder.position.y;
        beforeRenderCallbacks.push((now,delta)=>{
          if(options.spinY)holder.rotation.y+=delta*options.spinY;
          if(options.bob)holder.position.y=baseY+Math.sin(now*.0016+options.x)*options.bob;
        });
      }
    }).catch(error=>console.warn('A garden resident could not load:',file,error));
  };
  // the four hedgehogs and the fox
  place('amy.glb',{x:69,z:16,height:1.42,rotY:2.4});
  place('shadow.glb',{x:91,z:27,height:2.54,rotY:-2});
  place('tails.glb',{x:73,z:45,height:1.35,rotY:0});
  place('sonic.glb',{x:81,z:12,height:1.5,rotY:2.9});
  place('silver.glb',{x:76,z:20,height:1.45,rotY:-1.2});
  // chao, everywhere a chao should be
  for(const [cx,cz,turn] of [[72,12,1.2],[80,22,3.4],[88,12,5.1],[70,30,2.2],[84,34,4.4]])place('baby-chao.glb',{x:cx,z:cz,height:.55,rotY:turn});
  for(const [cx,cz,turn] of [[74,36,2.8],[92,20,.7]])place('tails-chao.glb',{x:cx,z:cz,height:.6,rotY:turn});
  // two omochao, hovering and bobbing the way omochao do
  place('omochao.glb',{x:67,z:22,height:.8,hover:.45,bob:.12,rotY:1.1});
  place('omochao.glb',{x:86,z:28,height:.8,hover:.45,bob:.12,rotY:-2.4});
  // the chaos emeralds, large, high over the garden, turning slowly
  place('emeralds.glb',{x:80,z:30,y:14,height:2.6,spinY:.3});
  // rings, floating at collect height, all spinning
  for(let i=0;i<16;i++){
    const rx=64+((i*197)%340)/10,rz=6+((i*283)%380)/10;
    place('ring.glb',{x:rx,z:rz,height:.85,hover:1.1,spinY:2.6,rotY:i*.8,wet:true});
  }
}
let chaoGardenInstalled=false;
function installChaoGardenModel(){
  // The caller sets chaoGardenModelStarted, so a debug call or a second
  // proximity tick could build the whole garden twice over. Guard it here
  // instead, where it cannot be forgotten.
  if(chaoGardenInstalled)return;
  chaoGardenInstalled=true;
  void (async()=>{try{
    const loader=await getOptimizedGltfLoader();
    loader.load('assets/models/chao-garden-4.glb?v=plan-9',gltf=>{
      // Everything hard about this model is baked into the file now: world
      // transform, the flattened walkable ground, the clean rock cap on the
      // west cut, and the carved tunnel corridor. The runtime just mounts it.
      // The falls used to be painted here instead: a canvas of white streaks
      // over the faintest aqua, on the reasoning that the model's own water is
      // too saturated to tint down. But a white sheet hung on a grey cliff
      // reads as more cliff, and the paint was going onto the wrong surfaces
      // anyway. The model's water is used as authored and simply set moving —
      // it is the only thing in the garden that is meant to be blue.
      const runningWater=[];
      // Plus, not minus: the atlas is authored flipY:false like every glTF
      // texture, so subtracting from the offset ran the falls upward.
      beforeRenderCallbacks.push((now,delta)=>{for(const map of runningWater)map.offset.y+=delta*.32});
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
          // The atlas was read off by number and the numbers were wrong. 0012
          // and 0013 are grey STONE, so the painted falls texture was being
          // spread over 32m of cliff face: those were the white translucent
          // sheets standing where rock should be. The only water in the model
          // is 0032, the pool, and 0033, the fall itself — the two the file
          // authors as alphaMode BLEND. 0032 was being tinted grey AND left
          // writing depth while translucent, which is what punched the cyan
          // quads through everything behind them.
          //
          // Everything else is rock or grass and keeps its own map at full
          // brightness. The grey wash went with the misreading: it was
          // draining the colour out of the lawn and the pool both.
          const isWater=/0032|0033/.test(name);
          let map=material.map??null;
          if(isWater&&map){
            // A clone, so the scroll belongs to this surface and not to every
            // other place the atlas is sampled.
            map=map.clone();map.needsUpdate=true;
            map.wrapS=map.wrapT=THREE.RepeatWrapping;
            runningWater.push(map);
          }
          const bright=new THREE.MeshBasicMaterial({
            map,
            color:new THREE.Color(0xffffff),
            transparent:isWater,
            opacity:isWater?.82:1,
            depthWrite:!isWater,
            side:THREE.DoubleSide,fog:false});
          bright.userData.isLawn=/0011/.test(name);
          bright.userData.isWater=isWater;
          return bright;
        });
        node.material=Array.isArray(node.material)?replaced:replaced[0];
      });
      doomed.forEach(node=>node.removeFromParent());
      source.name='chao-garden-environment';
      chaoWorld.add(source);
      chaoGardenMount=source;
      // A curtain and a rill used to hang here too, two big translucent planes
      // sized off the water geometry to close the gaps between tiers. They
      // were cut from the same white paint as the falls and read as two more
      // pale sheets leaning on the rock. The model's own cascade stands on its
      // own once it is actually wearing its water.
      //
      // There were three more slabs here — a headwall, a summit ledge and a
      // 64m backdrop — built to give the water somewhere to fall from and
      // something to read against. All three were painting with
      // chaoRockTexture, which has been null ever since the bore was cut
      // (5949974) took its generator away: an untextured, unlit box in flat
      // 0xc9d3dd. They were also sized from a WORLD-space Box3 and then added
      // to chaoWorld, which is offset (-15.9, 0, 28.8), so each one landed
      // 15.9m west and 28.8m north of the falls it was framing. That is the
      // stack of pale cuboids. The model already carries real eroded cliff,
      // 74m of it across x 43.3..117.6, so nothing needs standing in for it.
      chaoGardenFallback.visible=false;
      installChaoGardenFlora();
      installChaoGardenEggs();
      installChaoGardenCast();
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
  const CX=-32.4,MIN_Z=-94.5,MAX_Z=-42.2,CZ=(MIN_Z+MAX_Z)/2;
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
  for(const [x,z] of [[-31.5,-45],[-35,-55],[-29,-63],[-48,-52],[-57,-52.5],[-62.5,-51.5],[-35,-71],[-29,-79],[-35,-88]]){
    const pall=new THREE.PointLight(0xaab8a4,2.6,13,2);
    pall.position.set(x,3.2,z);scene.add(pall);managedSceneLights.push(pall);
  }
  // The blocks stand three storeys now, and a lamp at head height reaches a
  // third of the way up one. These hang over the street instead, dim and cold,
  // so the upper courses read as masonry rather than as a hole in the fog.
  // They rank as accent lights so they cannot take the pavement's own slots.
  for(const [x,z] of [[-32.4,-49],[-32.4,-61],[-55,-52],[-32.4,-75],[-32.4,-89]]){
    const wash=new THREE.PointLight(0x9fb0a8,2.2,34,1.5);
    wash.position.set(x,15.5,z);
    wash.userData.accentLight=true;wash.userData.wideAccent=true;
    scene.add(wash);managedSceneLights.push(wash);
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
  // The east floor stops where the sealed bay begins: only the Pokemon
  // storefront run (z -33.6..-12) is still stood on.
  const floorDepth=west?SIDE_COLUMN_DEPTH:21.6;
  const floorCentre=west?SIDE_COLUMN_CENTER_Z:-22.8;
  const columnFloor=new THREE.Mesh(new THREE.PlaneGeometry(ROOM_SPAN,floorDepth),worldAlignedFloorMaterial(ROOM_SPAN,floorDepth,roomX,floorCentre,EXPANSION_FLOOR_STYLE));
  columnFloor.rotation.x=-Math.PI/2;columnFloor.position.set(roomX,.002,floorCentre);columnFloor.receiveShadow=true;scene.add(columnFloor);
  // The west plate stops at the Temple of Time's room: its dome rises
  // through the hole cut for it in the main ceiling. It breaks a second time
  // over the Mario room, on the same nine metre slot, because this plate hangs
  // six centimetres below the main ceiling and would have cropped the pipe on
  // its own.
  if(west){box(ROOM_SPAN,.12,3.9,0x090b18,roomX,5.08,-31.65,.08);box(ROOM_SPAN,.12,37.5,0x090b18,roomX,5.08,-1.95,.08);}
  // The east column's plate stops at the garden's new room: its sky dome
  // rises through the hole cut for it. The old garden room is the Pokemon
  // Center's plaza now, covered by the main ceiling like any other room.
  // One plate seals the whole dead bay east of the wall: the three empty
  // rooms behind it are deleted, so there is nothing under it to light or see.
  else{box(ROOM_SPAN,.12,45.6,0x090b18,roomX,5.08,10.8,.08);}
  for(const wallZ of [SIDE_COLUMN_MIN_Z,-ROOM_DEPTH,0,ROOM_DEPTH,SIDE_COLUMN_MAX_Z]){
    // The east column's end wall is gone: the Pokemon Center runs from the
    // stadium's wall across the old band pocket into its plaza.
    if(!west&&wallZ===SIDE_COLUMN_MIN_Z)continue;
    // The east column's dividers between its deleted rooms are gone with the
    // rooms. The wall at -12 stays: it is the Pokemon storefront's south wall.
    // The wall at 33.6 stays: it faces the tournament hall.
    if(!west&&(wallZ===0||wallZ===ROOM_DEPTH))continue;
    const wallAt=(!west&&EAST_WALL_Z[String(wallZ)]!==undefined)?EAST_WALL_Z[String(wallZ)]:wallZ;
    const wall=box(ROOM_SPAN-.4,5,.3,0x11182c,roomX+(west?-.2:.2),2.5,wallAt,.05);wall.receiveShadow=true;
  }
  SIDE_ROOM_Z.forEach((centerZ,index)=>{
    // East of the wall only the Pokemon storefront run is still a place:
    // the three rooms south of it are deleted and sealed, so no strips and
    // no troffers burn behind the wall.
    if(!west&&index>0)return;
    // The Mario room is the warp pipe and nothing else now: no strips, no
    // troffers, no accent points burning inside a sealed box.
    if(west&&index===0)return;
    const at=west?centerZ:EAST_ROOM_Z[index];
    // Four cyan strips per room at 4.65. In the Mario room the middle two land
    // at z -27.2 and -23.2, which is inside the bore: they drew as a pair of lit
    // wires strung across the tunnel a metre and a half over your head.
    for(let z=at-6;z<=at+6;z+=4){
      if(insideWarpPipeSlot(roomX,z))continue;
      box(ROOM_SPAN-.5,.035,.055,0x4e7ea8,roomX,4.65,z,.8);
    }
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
box(.3,5,4.4,0x11182c,-SHELL_HALF_WIDTH,2.5,35.8,.06);box(.3,5,4.4,0x11182c,-SHELL_HALF_WIDTH,2.5,48.2,.06);box(.3,5,4.4,0x11182c,SHELL_HALF_WIDTH,2.5,35.8,.06);box(.3,5,4.4,0x11182c,SHELL_HALF_WIDTH,2.5,48.2,.06);
box(TOURNAMENT_ROOM_WIDTH,5,.3,0x11182c,0,2.5,TOURNAMENT_ROOM_BACK_Z,.06);
// The hub's front wall, either side of the one doorway. It reaches the
// partition walls rather than stopping short of them, which used to leave a two
// metre hole at each end that only the old room's narrower side walls covered.
box(SHELL_HALF_WIDTH-ROOM_DOOR_HALF_WIDTH,5,.3,0x11182c,-(SHELL_HALF_WIDTH+ROOM_DOOR_HALF_WIDTH)/2,2.5,TOURNAMENT_ROOM_DOOR_Z,.06);
box(SHELL_HALF_WIDTH-ROOM_DOOR_HALF_WIDTH,5,.3,0x11182c,(SHELL_HALF_WIDTH+ROOM_DOOR_HALF_WIDTH)/2,2.5,TOURNAMENT_ROOM_DOOR_Z,.06);
for(let x=-40;x<=40;x+=4)box(3.82,.055,.06,0x4e7ea8,x,4.66,TOURNAMENT_ROOM_BACK_Z-.19,.75);
lightRoom(0,TOURNAMENT_ROOM_CENTER_Z,TOURNAMENT_ROOM_WIDTH,TOURNAMENT_ROOM_DEPTH,0xffb066);
flushCeilingFixtures();
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
/**
 * The cabinets' shared-material shells, instanced across all cabinets.
 *
 * A standard cabinet is ~30 meshes; eight of them — plinth, body, head, bezel,
 * glass sheen, deck and the two light channels — use module-level materials
 * identical on every cabinet, and none of them ever moves after build. With
 * ~20 cabinets in draw range at spawn that was ~160 draw calls of repeated
 * shapes. They pool here and flush into one InstancedMesh per part before the
 * first frame — after the row builders have set each group's final rotation,
 * which is why the matrices are composed at flush rather than at creation.
 *
 * The hue-tinted parts, the marquee, the screen, the art and everything in the
 * controlSlot stay per-cabinet: hues differ per machine, screens toggle, and
 * controller models swap into the slot per system.
 */
const cabinetPartPool=[];let cabinetPartsSealed=false;
function poolCabinetPart(group,geometry,material,x,y,z,rotationX=0){
  if(cabinetPartsSealed){
    const m=new THREE.Mesh(geometry,material);m.position.set(x,y,z);m.rotation.x=rotationX;group.add(m);return;
  }
  cabinetPartPool.push({group,geometry,material,x,y,z,rotationX});
}
function flushCabinetParts(){
  cabinetPartsSealed=true;
  const batches=new Map();
  for(const part of cabinetPartPool){
    const key=part.geometry.uuid+'|'+part.material.uuid;
    let batch=batches.get(key);
    if(!batch){batch={geometry:part.geometry,material:part.material,parts:[]};batches.set(key,batch)}
    batch.parts.push(part);
  }
  const local=new THREE.Matrix4(),world=new THREE.Matrix4();
  const shift=new THREE.Vector3(),spin=new THREE.Quaternion(),one=new THREE.Vector3(1,1,1);
  for(const {geometry,material,parts} of batches.values()){
    const batch=new THREE.InstancedMesh(geometry,material,parts.length);
    parts.forEach((part,index)=>{
      part.group.updateMatrixWorld(true);
      shift.set(part.x,part.y,part.z);
      spin.setFromEuler(new THREE.Euler(part.rotationX,0,0));
      local.compose(shift,spin,one);
      world.multiplyMatrices(part.group.matrixWorld,local);
      batch.setMatrixAt(index,world);
    });
    batch.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    batch.computeBoundingSphere();
    scene.add(batch);
  }
  cabinetPartPool.length=0;
}
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
  poolCabinetPart(g,cabinetGeometry.plinth,cabinetPlinthMaterial,0,.05,0);
  const underglowMat=new THREE.MeshBasicMaterial({color:hue,transparent:true,opacity:.62});
  for(const [railGeometry,px,pz] of [[cabinetGeometry.railLong,0,.52],[cabinetGeometry.railLong,0,-.52],[cabinetGeometry.railSide,.72,0],[cabinetGeometry.railSide,-.72,0]]){const rail=new THREE.Mesh(railGeometry,underglowMat);rail.position.set(px,.106,pz);g.add(rail)}
  const floorGlow=new THREE.PointLight(hue,1.15,2.2,2);floorGlow.position.set(0,.12,0);g.add(floorGlow);
  poolCabinetPart(g,cabinetGeometry.body,cabinetShellMaterial,0,.78,0);
  const panelTint=new THREE.Color(shellColor).multiplyScalar(.2);
  const lowerInset=new THREE.Mesh(cabinetGeometry.bodyInset,new THREE.MeshStandardMaterial({color:panelTint,emissive:shellColor,emissiveIntensity:.05,roughness:.36,metalness:.8}));lowerInset.position.set(0,.79,.5405);g.add(lowerInset);
  poolCabinetPart(g,cabinetGeometry.head,cabinetHeadMaterial,0,2.05,-.05,-.1);
  const trimMat=new THREE.MeshStandardMaterial({color:hue,emissive:hue,emissiveIntensity:1.15,roughness:.3,metalness:.45});
  for(const sx of [-.795,.795]){
    poolCabinetPart(g,cabinetGeometry.lightChannel,cabinetChannelMaterial,sx,1.32,.529);
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
  poolCabinetPart(g,cabinetGeometry.bezel,cabinetBezelMaterial,0,2.06,.35,-.1);
  const screen=new THREE.Mesh(cabinetGeometry.screen,new THREE.MeshBasicMaterial({color:0x050710}));screen.position.set(0,2.06,.38);screen.rotation.x=-.1;g.add(screen);
  poolCabinetPart(g,cabinetGeometry.glassSheen,cabinetGlassMaterial,0,2.06,.388,-.1);
  poolCabinetPart(g,cabinetGeometry.deck,cabinetDeckMaterial,0,1.4,.47,.16);
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
  // baseY, because not every room's floor is the hall's. The Temple of Time's
  // back room sits at -0.657 and its machines have to stand on it rather than
  // hover half a metre over it.
  const g=new THREE.Group();g.position.set(x,model.baseY??0,z);g.rotation.y=model.rotY??0;
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
    // modelRotY turns the shell inside the cabinet. rotY turns the cabinet, so
    // it cannot fix a model whose own front is not its +z — spinning the group
    // takes the marquee and the plinth with it. The Game Boy Advance is
    // authored facing +x, which put its back to the room.
    body.rotation.y=model.modelRotY??0;
    body.position.y=(model.lift??0)+.1;body.position.z=model.offsetZ??0;
    g.add(body);
  }).catch(error=>console.warn('A Pokemon machine model could not load.',error));
  scene.add(g);
  // The 18 m cull is tuned for rows you walk along. In a 34 m round room the far
  // side of a ring stands 25 m off and would simply not be drawn, so a machine
  // can ask to be culled at 30 instead.
  // artApplied up front, so the generated panels never land on one of these.
  // applyCabinetArt hangs a 1.12 x 1.22 front and two 0.78 x 1.62 sides at
  // fixed offsets sized for the standard upright; on a console sitting on a
  // plinth they stand off it in mid-air and bury the model they are supposed to
  // dress. A model cabinet's shell is the artwork.
  const cabinet={id,g,name,type:id.toUpperCase(),screen,hue,statusLight,controlSlot:new THREE.Group(),controllerSystem:system,renderLights:[floorGlow],status:'syncing',occupiedByDisplayName:null,enabled:true,artApplied:true,cullSq:model.farCull?900:undefined};
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
  // Pokemon Snap moved to the plaza, into the Pokemon arcade machine; Ocarina
  // of Time moved to the Temple of Time with the rest of the Zelda library; and
  // Super Mario 64 moved into Peach's Castle, which is the one room in the
  // building it is actually about. All three leave a gap in the row rather than
  // a renumbering.
  if(index===1||index===2||index===5)continue;
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
  ['n64-cabinet-01','arc',13.57,0xffd23e,{noPlate:true,statusY:3.35,top:{file:'pokemon-snap-banner.png',w:1.07,y:2.1,z:.12,tilt:0}}],
  ['gameboy-cabinet-03','gb',5.49,0xffe45f,{noPlate:true,statusY:3.06,mat:{file:'pokemon-yellow-mat.webp',w:1.8}}],
  ['gameboy-cabinet-04','gb',7.49,0xd9b44a],
  ['gameboy-cabinet-05','gb',9.52,0xc8ccd4],
  ['gameboy-cabinet-06','gb',11.54,0x8ee6ff],
  ['gameboy-cabinet-07','gbasp',15.6,0xd45f5f],
  ['gameboy-cabinet-08','gbasp',17.63,0x4a8cd4],
  ['gameboy-cabinet-09','gbasp',19.66,0xff8c5f],
  ['gameboy-cabinet-10','gbasp',21.7,0x7dff67],
  ['gameboy-cabinet-12','gbasp',23.73,0x4ad48c],
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
/**
 * The Temple of Time's back room: every Zelda game in the arcade, in one ring.
 *
 * The room is a regular octagon 15.9 m to a wall face, with the Triforce dais
 * off-centre in it and eight columns on a 12.25 m circle. The ring sits at 8.5,
 * inside the columns and clear of the dais, which reaches 5.9 from the middle.
 *
 * It runs 30 to 330 degrees rather than the whole circle: the sixty degree
 * sector facing the doorway stays empty so the room opens on the Triforce
 * rather than on the back of a machine. Every cabinet turns to face the middle,
 * so the ring reads as an exhibition rather than a row that happens to be bent.
 *
 * Order is chronological from the doorway anticlockwise, 1986 to 2009, which is
 * why the ids are not in sequence around it.
 */
const ZELDA_ROOM_CENTRE_X=-96.845,ZELDA_ROOM_CENTRE_Z=42,ZELDA_ROOM_FLOOR=-.657,ZELDA_RING_RADIUS=8.5;
// Five machines for five shapes of hardware. The handhelds share one shell
// because five Game Boy variants in a row would read as a mistake; the two
// consoles that lie flat get a lower marquee so it sits over the machine rather
// than a metre above it.
const ZELDA_MACHINE_MODELS={
  handheld:{file:'assets/models/zelda/zelda-gba-cabinet.glb?v=sh-seal-1',scale:1.55,lift:.496,modelRotY:-Math.PI/2,plateY:1.74,plinthScale:1.15,statusY:1.72},
  ds:{file:'assets/models/zelda/zelda-ds-cabinet.glb?v=sh-seal-1',scale:.1,lift:-.005,plateY:1.86,plinthScale:1.3,statusY:1.84},
  gamecube:{file:'assets/models/zelda/zelda-gamecube-cabinet.glb?v=sh-seal-1',scale:.22,lift:.004,plateY:1.74,plinthScale:1.25,statusY:1.72},
  n64:{file:'assets/models/zelda/zelda-n64-cabinet.glb?v=sh-seal-1',scale:.85,lift:.211,plateY:1.5,plinthScale:1.2,statusY:1.48},
  nes:{file:'assets/models/zelda/zelda-nes-cabinet.glb?v=sh-seal-1',scale:3.7,lift:.159,plateY:1.44,plinthScale:1.1,statusY:1.42}
};
const ZELDA_ROOM_RING=[
  ['zelda-cabinet-08','nes',0xd4b24a],       // The Legend of Zelda, 1986
  ['zelda-cabinet-01','handheld',0x8ee6ff],  // Link's Awakening, 1993
  ['n64-cabinet-05','n64',0xffd23e],         // Ocarina of Time, 1998
  ['zelda-cabinet-09','n64',0xc06fff],       // Majora's Mask, 2000
  ['zelda-cabinet-02','handheld',0x5fd48c],  // Oracle of Ages, 2001
  ['zelda-cabinet-03','handheld',0xff8c5f],  // Oracle of Seasons, 2001
  ['zelda-cabinet-04','handheld',0x9ad6ff],  // A Link to the Past & Four Swords, 2002
  ['gamecube-cabinet-01','gamecube',0x4ad8c8],// The Wind Waker, 2003
  ['zelda-cabinet-05','handheld',0x6fe36f],  // The Minish Cap, 2005
  ['gamecube-cabinet-02','gamecube',0xd4a24a],// Twilight Princess, 2006
  ['zelda-cabinet-06','ds',0x5f8cff],        // Phantom Hourglass, 2007
  ['zelda-cabinet-07','ds',0xffcf6b]         // Spirit Tracks, 2009
];
const zeldaCabinetSpots=[];
ZELDA_ROOM_RING.forEach(([cabinetId,kind,hue],index)=>{
  const bearing=(30+index*(300/(ZELDA_ROOM_RING.length-1)))*Math.PI/180;
  const x=ZELDA_ROOM_CENTRE_X+ZELDA_RING_RADIUS*Math.cos(bearing);
  const z=ZELDA_ROOM_CENTRE_Z+ZELDA_RING_RADIUS*Math.sin(bearing);
  const hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);
  const label=hosted?hosted.name.toUpperCase():cabinetId.toUpperCase();
  // A cabinet's front is its +z. Turn that to face the middle of the room.
  const rotY=Math.atan2(-Math.cos(bearing),-Math.sin(bearing));
  makeModelCabinet(cabinetId,label,x,z,hue,hosted?.system??'gb',
    {...ZELDA_MACHINE_MODELS[kind],baseY:ZELDA_ROOM_FLOOR,rotY,farCull:true});
  configureHostedCabinet(cabinetId);
  // The GameCube pair keeps the shelf's desktop-only gate: Gecko does not run
  // on a phone, and moving the machine does not change that.
  if(kind==='gamecube')Object.assign(cabinets[cabinets.length-1],
    {system:'gamecube',emulator:'gecko',enabled:!isMobileDevice,status:isMobileDevice?'disabled':'available',disabledReason:isMobileDevice?'desktop-only':undefined});
  zeldaCabinetSpots.push([x,z]);
});
/**
 * Peach's Castle: the Mario library, a machine at each of the hall's doorways.
 *
 * The hall has six openings with floor in front of them to stand on — four on
 * the checkerboard at y 0.019 and two on the 2F landing at 9.024. The rest of
 * the shell's openings give onto outer terraces at 3.62 and 10.82 with nothing
 * to stand on, and two of those fall outside CASTLE_EXPANSE entirely, so the
 * last three machines line the hall's west wall between the doorways instead.
 *
 * Every position here was solved in-engine rather than read off the model:
 * step in from the opening until a downward ray finds real floor, then face the
 * middle of the hall. The registry carries the same numbers, because the server
 * refuses a handover to a cabinet that is not where it says it is.
 */
const MARIO_MACHINE_MODELS={
  // The three supplied arcade cabinets, all authored facing +z, so none needs a
  // modelRotY. Scaled to 2.7m at the marquee to sit with the arcade's own
  // cabinets rather than at literal life size, which would leave them narrower
  // than the marquee plate that labels them.
  smb:{file:'assets/models/mario/mario-smb-arcade.glb?v=sh-seal-1',scale:.0726,lift:.018,offsetZ:-.196,plateY:2.62,statusY:2.6,plinthScale:1.2},
  bros:{file:'assets/models/mario/mario-bros-arcade.glb?v=sh-seal-1',scale:1.3583,lift:-.071,offsetZ:-.135,plateY:2.62,statusY:2.6,plinthScale:1.05},
  smb3:{file:'assets/models/mario/mario-smb3-arcade.glb?v=sh-seal-1',scale:1.4985,lift:1.35,plateY:2.62,statusY:2.6,plinthScale:1.15},
  // and the console shells the Zelda room already brought in
  n64:{file:'assets/models/zelda/zelda-n64-cabinet.glb?v=sh-seal-1',scale:.85,lift:.211,plateY:1.5,statusY:1.48,plinthScale:1.2},
  nes:{file:'assets/models/zelda/zelda-nes-cabinet.glb?v=sh-seal-1',scale:3.7,lift:.159,plateY:1.44,statusY:1.42,plinthScale:1.1},
  gamecube:{file:'assets/models/zelda/zelda-gamecube-cabinet.glb?v=sh-seal-1',scale:.22,lift:.004,plateY:1.74,statusY:1.72,plinthScale:1.25}
};
const MARIO_CASTLE_RING=[
  ['mario-cabinet-01','smb',   -102.35, 0.019,  -2.74, 1.5708,0xff5f5f], // super-mario-bros — hall north-west
  ['mario-cabinet-02','smb',    -98.36, 0.019, -11.01, 0.7854,0xffa14d], // super-mario-bros-2 — hall north diagonal
  ['mario-cabinet-04','bros',   -98.42, 0.019, -39.49, 2.3562,0x4aa8ff], // mario-bros — hall south diagonal
  ['n64-cabinet-02','n64',   -102.41, 0.019, -47.73, 1.5708,0xffd23e], // super-mario-64 — hall south-west
  ['mario-cabinet-03','smb3',  -102.40, 9.024, -25.23, 1.5708,0x7dff67], // super-mario-bros-3 — the grand 2F door
  ['mario-cabinet-05','n64',   -109.68, 9.024,   2.42, 2.3562,0x8cb4ff], // mario-kart-64 — 2F north
  ['mario-cabinet-06','n64',   -109.90,10.818, -53.43, 0.7854,0xd9d9e6], // paper-mario — upper south-west
  // Slid 1.9 along the wall: these two doorways are also the terrace stair
  // landings, and a machine centred on the walk line is a wall across it.
  ['mario-cabinet-07','nes',   -100.70, 3.625,  10.29, 3.1416,0xc06fff], // super-mario-world — north terrace
  ['mario-cabinet-08','nes',    -91.00, 3.625, -60.63, 0.0000,0x5fd48c], // dr-mario — south terrace
  ['gamecube-cabinet-05','gamecube',-100.50, 0.019,   0.30, 2.3562,0x36f9f6], // super-mario-sunshine — hall back-right corner
];
const marioCabinetSpots=[];
for(const [cabinetId,kind,x,floorY,z,yaw,hue] of MARIO_CASTLE_RING){
  const hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);
  const label=hosted?hosted.name.toUpperCase():cabinetId.toUpperCase();
  makeModelCabinet(cabinetId,label,x,z,hue,hosted?.system??'nes',
    {...MARIO_MACHINE_MODELS[kind],baseY:floorY,rotY:yaw,farCull:true});
  // Sunshine keeps the GameCube shelf's desktop-only gate: Gecko does not run
  // on a phone, and moving the machine does not change that.
  if(kind==='gamecube')Object.assign(cabinets[cabinets.length-1],
    {system:'gamecube',emulator:'gecko',enabled:!isMobileDevice,status:isMobileDevice?'disabled':'available',disabledReason:isMobileDevice?'desktop-only':undefined});
  configureHostedCabinet(cabinetId);
  marioCabinetSpots.push([x,z,floorY]);
}
// Five experimental GameCube cabinets sit inside their dedicated construction
// room, facing its doorway. Gecko remains available for later runtime work, but
// the cabinets cannot be reached while the room is blocked.
const gamecubeTitles=['THE LEGEND OF ZELDA: THE WIND WAKER','THE LEGEND OF ZELDA: TWILIGHT PRINCESS','PIKMIN','SUPER SMASH BROS. MELEE','SUPER MARIO SUNSHINE'];
const GAMECUBE_HUES=[0x8b5cf6,0x36f9f6,0xff4da6,0x7dff67,0xffb42e];
// Melee is back in the foyer row with the rest of the GameCube shelf. It stood
// out in the tournament hall with the other headline multiplayer games; that
// hall is being decorated, so the whole multiplayer set has come indoors and
// every cabinet holds its own slot again with no gap in the numbering.
const gamecubeCabinetLayout=GAMECUBE_HUES.map((hue,index)=>
  [index+1,FOYER_EAST[7+index].x,FOYER_EAST[7+index].z,FOYER_EAST[7+index].rotation,hue]);
for(const [index,x,z,rotation,hue] of gamecubeCabinetLayout){
  // Wind Waker and Twilight Princess stand in the Temple of Time; Super Mario
  // Sunshine stands in Peach's Castle, which is the other room it belongs in.
  if(index===1||index===2||index===5)continue;
  const cabinetId=`gamecube-cabinet-0${index}`;
  makeCabinet(cabinetId,gamecubeTitles[index-1],x,z,hue,false,false,'gamecube');
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system:'gamecube',emulator:'gecko',gameName:gamecubeTitles[index-1],enabled:!isMobileDevice,status:isMobileDevice?'disabled':'available',disabledReason:isMobileDevice?'desktop-only':undefined});configureHostedCabinet(cabinetId);
}
// The Metroid room's row: seven uprights with their backs to the east shell,
// facing the door, in release order from the room's north end. The murals were
// already hung; these are the games they were promising. The two Primes keep
// the GameCube shelf's desktop-only gate, since Gecko does not run on phones.
const METROID_ROW=[
  ['metroid-cabinet-01','metroid',  -15.3,0xffb42e,'nes'],
  ['metroid-cabinet-02','metroid-2-return-of-samus',    -13,0x8ee6ff,'gb'],
  ['metroid-cabinet-03','super-metroid',  -10.7,0xc06fff,'snes'],
  ['metroid-cabinet-04','metroid-fusion',   -8.4,0xff5f5f,'gba'],
  ['metroid-cabinet-05','metroid-prime',   -6.1,0x7dff67,'gamecube'],
  ['metroid-cabinet-06','metroid-zero-mission',   -3.8,0x4aa8ff,'gba'],
  ['metroid-cabinet-07','metroid-prime-2-echoes',   -1.5,0x36f9f6,'gamecube'],
];
for(const [cabinetId,gameId,rowZ,hue,system] of METROID_ROW){
  const hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);
  const label=hosted?hosted.name.toUpperCase():cabinetId.toUpperCase();
  makeCabinet(cabinetId,label,-41.9,rowZ,hue,false,false,system);
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=Math.PI/2;
  if(system==='gamecube')Object.assign(cabinet,{system:'gamecube',emulator:'gecko',enabled:!isMobileDevice,status:isMobileDevice?'disabled':'available',disabledReason:isMobileDevice?'desktop-only':undefined});
  configureHostedCabinet(cabinetId);
}
/**
 * The Sonic library, on the Chao Garden's north meadow: consoles on plinths in
 * release order, facing the water. The meadow is flat at y 0.12 the whole way.
 * The four Genesis classics run through segaMD; the two PS2 discs through the
 * Play! runtime like the rest of the PS2 shelf; the two Dreamcast Adventures
 * stand as display machines on the Dreamcast shell -- nothing in this stack
 * runs Dreamcast, and a labelled machine that says so beats an empty lawn.
 */
const SEGA_MACHINE_MODELS={
  genesis:{file:'assets/models/sega/sega-genesis.glb?v=sh-seal-1',scale:3.7,lift:0,plateY:1.44,statusY:1.42,plinthScale:1.1},
  dreamcast:{file:'assets/models/sega/sega-dreamcast.glb?v=sh-seal-1',scale:3.2,lift:-.051,plateY:1.44,statusY:1.42,plinthScale:1.1},
  ps2:{file:'assets/models/sega/sega-dreamcast.glb?v=sh-seal-1',scale:0,lift:0,plateY:2.62,statusY:2.6,plinthScale:1.4}
};
const SONIC_GARDEN_ROW=[
  ['sonic-cabinet-01','genesis',    50,'sonic-the-hedgehog',0x4aa8ff],
  ['sonic-cabinet-02','genesis',    53,'sonic-the-hedgehog-2',0xffb42e],
  ['sonic-cabinet-03','genesis',    56,'sonic-the-hedgehog-3',0xff5f5f],
  ['sonic-cabinet-04','genesis',    59,'sonic-and-knuckles',0xd4b24a],
  ['sonic-cabinet-05','dreamcast',  62,'SONIC ADVENTURE',0x8ee6ff],
  ['sonic-cabinet-06','dreamcast',  65,'SONIC ADVENTURE 2',0xc06fff],
  ['sonic-cabinet-07','ps2',        68,'sonic-mega-collection-plus',0x7dff67],
  ['sonic-cabinet-08','ps2',        71,'shadow-the-hedgehog',0x1b1b28],
];
const sonicCabinetSpots=[];
for(const [cabinetId,kind,rowX,gameOrLabel,hue] of SONIC_GARDEN_ROW){
  const hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);
  const label=hosted?hosted.name.toUpperCase():gameOrLabel;
  if(kind==='ps2'){
    // The PS2 discs take the house upright, the same machine the PS2 shelf
    // uses, rather than a console shell that does not exist for them.
    makeCabinet(cabinetId,label,rowX,39,hue,false,false,'ps2');
    const cabinet=cabinets[cabinets.length-1];
    cabinet.g.position.y=.12;
    Object.assign(cabinet,{system:'ps2',enabled:true,status:'available'});
  }else{
    makeModelCabinet(cabinetId,label,rowX,39,hue,hosted?.system??'genesis',
      {...SEGA_MACHINE_MODELS[kind],baseY:.12,rotY:0,farCull:true});
    if(kind==='dreamcast')Object.assign(cabinets[cabinets.length-1],
      {enabled:false,status:'disabled',disabledReason:'display-only'});
  }
  configureHostedCabinet(cabinetId);
  sonicCabinetSpots.push([rowX,39]);
}
/**
 * The horror shelf, along the Silent Hill room's north wall: the three PSX
 * Resident Evils, RE4 on PS2, and the four PS2-era Silent Hills, in release
 * order west to east. Standard uprights -- the room's fog does the theming.
 */
const SILENT_ROOM_ROW=[
  ['sh-room-cabinet-01','psx',-41.0,0x8f1d1d],
  ['sh-room-cabinet-02','psx',-38.6,0xb03a2e],
  ['sh-room-cabinet-03','psx',-36.2,0xd35400],
  ['sh-room-cabinet-04','ps2',-33.8,0x9c640c],
  ['sh-room-cabinet-05','ps2',-31.4,0x7b7d7d],
  ['sh-room-cabinet-06','ps2',-29.0,0xa04000],
  ['sh-room-cabinet-07','ps2',-26.6,0x6e2c00],
  ['sh-room-cabinet-08','ps2',-24.2,0x515a5a],
];
for(const [cabinetId,system,rowX,hue] of SILENT_ROOM_ROW){
  const hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);
  const label=hosted?hosted.name.toUpperCase():cabinetId.toUpperCase();
  makeCabinet(cabinetId,label,rowX,-49.6,hue,false,false,system);
  const cabinet=cabinets[cabinets.length-1];
  Object.assign(cabinet,{system,enabled:Boolean(hosted),status:hosted?'available':'disabled'});
  configureHostedCabinet(cabinetId);
}
const expansionCabinetColors=[0xff3cac,0x36f9f6,0xffb42e,0x934dff,0x7dff67];
const ps2RoomTitles=['GOD OF WAR','KINGDOM HEARTS','GRAND THEFT AUTO: SAN ANDREAS','DBZ TENKAICHI 3','PS2 // READY 05'];
// DBZ Tenkaichi 3 used to face Melee across the tournament hall. It rejoins the
// PS2 shelf for the same reason Melee did.
const ps2CabinetLayout=Array.from({length:5},(_,index)=>
  [index+1,FOYER_WEST[7+index].x,FOYER_WEST[7+index].z,FOYER_WEST[7+index].rotation]);
for(const [index,x,z,rotation] of ps2CabinetLayout){
  const cabinetId=`psx-back-cabinet-0${index}`,hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);
  makeCabinet(cabinetId,ps2RoomTitles[index-1],x,z,expansionCabinetColors[index-1],false,false,'ps2');
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system:'ps2',gameName:hosted?.name||ps2RoomTitles[index-1],gameId:hosted?.emulatorId||26000+index,enabled:Boolean(hosted),status:hosted?'available':'disabled'});configureHostedCabinet(cabinetId);
}
// The Halo LAN row is gone: five stations that never held a hosted game,
// deleted rather than left standing dark at the south end of the floor.
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
// The Mario doorway is the warp pipe's mouth now. lightThreshold hangs two
// jamb posts at +/-1.72 and lays a glowing strip across the floor, which inside
// a nine metre round opening reads as a square frame standing in the middle of
// it. That one gets no threshold; the pipe is its own doorway.
for(const doorZ of OPEN_DOOR_Z_WEST)if(doorZ!==CASTLE_APPROACH_Z)lightThreshold(PLAYSTATION_WALL_X,doorZ,false);
// No threshold at -25.2 any more: that doorway widened into the Pokemon
// Center's storefront opening, and a lit strip floating in it would be odd.
// The east wall has no doorways to mark: its one opening is the Pokemon
// storefront run, which is a missing stretch of wall rather than a door.
for(const doorX of NORTH_ROOM_X)lightThreshold(doorX,TOP_BAND_MIN_Z,true);
lightThreshold(POKEMON_DOOR_X,POKEMON_SOUTH_Z,true);
// Silent Hill's threshold glow came down with the seal: a doorway under
// construction tape does not also get a lit welcome mat.
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
const instanceMatrix=new THREE.Matrix4(),instanceEuler=new THREE.Euler(),instanceQuaternion=new THREE.Quaternion();
const instancePosition=new THREE.Vector3(),instanceScale=new THREE.Vector3(1,1,1);
const placeInstance=(mesh,index,x,y,z,rx,ry,rz)=>{
  instancePosition.set(x,y,z);
  instanceEuler.set(rx,ry,rz);
  instanceQuaternion.setFromEuler(instanceEuler);
  instanceMatrix.compose(instancePosition,instanceQuaternion,instanceScale);
  mesh.setMatrixAt(index,instanceMatrix);
};
for(const [radius,count,length,material,speed] of [[2.62,24,.19,medallionMaterial,.11],[4.18,32,.13,medallionWarmMaterial,-.07]]){
  const dashes=new THREE.InstancedMesh(new THREE.PlaneGeometry(.05,length),material,count);
  dashes.position.y=.034;
  for(let i=0;i<count;i++){
    const angle=i/count*Math.PI*2;
    placeInstance(dashes,i,Math.cos(angle)*radius,0,Math.sin(angle)*radius,-Math.PI/2,0,-angle);
  }
  dashes.instanceMatrix.needsUpdate=true;
  centrepiece.add(dashes);
  spinningFloorRings.push({ring:dashes,speed});
}
const bollardMaterial=new THREE.MeshStandardMaterial({color:0x1a2740,emissive:0x123c5e,emissiveIntensity:.9,metalness:.72,roughness:.24});
const bollardCapMaterial=new THREE.MeshBasicMaterial({color:0x8ff0ff,transparent:true,opacity:.85,blending:THREE.AdditiveBlending,depthWrite:false});
const bollardGeometry=new THREE.CylinderGeometry(.075,.1,.52,10);
const bollardCapGeometry=new THREE.SphereGeometry(.085,10,8);
const bollards=new THREE.InstancedMesh(bollardGeometry,bollardMaterial,8);
const bollardCaps=new THREE.InstancedMesh(bollardCapGeometry,bollardCapMaterial,8);
for(let i=0;i<8;i++){
  const angle=i/8*Math.PI*2+Math.PI/8;
  placeInstance(bollards,i,Math.cos(angle)*4.55,.26,Math.sin(angle)*4.55,0,0,0);
  placeInstance(bollardCaps,i,Math.cos(angle)*4.55,.55,Math.sin(angle)*4.55,0,0,0);
}
bollards.instanceMatrix.needsUpdate=true;bollardCaps.instanceMatrix.needsUpdate=true;
centrepiece.add(bollards);centrepiece.add(bollardCaps);
const moteMaterial=new THREE.MeshBasicMaterial({color:0xbdf3ff,transparent:true,opacity:.5,depthWrite:false,blending:THREE.AdditiveBlending});
const moteGeometry=new THREE.SphereGeometry(.035,6,5);
const moteField=new THREE.InstancedMesh(moteGeometry,moteMaterial,26);
centrepiece.add(moteField);
const motes=[];
for(let i=0;i<26;i++){
  const angle=i*2.399,radius=.35+(i%7)*.26;
  motes.push({x:Math.cos(angle)*radius,z:Math.sin(angle)*radius,y:.1+(i%13)*.28,speed:.22+(i%5)*.06,base:.1+(i%13)*.28});
  placeInstance(moteField,i,Math.cos(angle)*radius,.1+(i%13)*.28,Math.sin(angle)*radius,0,0,0);
}
moteField.instanceMatrix.needsUpdate=true;
beforeRenderCallbacks.push((now,delta)=>{
  if(playerPosition.x*playerPosition.x+playerPosition.z*playerPosition.z>900)return;
  for(const {ring,speed} of haloRings)ring.rotation.z+=speed*delta;
  for(const {ring,speed} of spinningFloorRings)ring.rotation.y+=speed*delta;
  for(let i=0;i<motes.length;i++){
    const mote=motes[i];
    mote.y+=mote.speed*delta;
    // Recycled at the top of the beam rather than respawned, so the count is
    // fixed and nothing allocates once the scene is built.
    if(mote.y>3.7)mote.y=mote.base%1.2;
    placeInstance(moteField,i,mote.x,mote.y,mote.z,0,0,0);
  }
  moteField.instanceMatrix.needsUpdate=true;
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
let optimizedGltfLoaderPromise,pendingSceneLoads=0;
function getOptimizedGltfLoader(){if(!optimizedGltfLoaderPromise)optimizedGltfLoaderPromise=Promise.all([import('three/addons/loaders/GLTFLoader.js'),import('three/addons/libs/meshopt_decoder.module.js')]).then(([{GLTFLoader},{MeshoptDecoder}])=>{
  const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // Every installer pulls through this one loader and not one of them reports
  // when it has finished — they hand a callback to loader.load inside a void
  // async wrapper and return nothing. Rather than make a dozen callers start
  // returning promises, the loader counts its own outstanding work, and the
  // preload waits on that count.
  const load=loader.load.bind(loader);
  loader.load=(url,onLoad,onProgress,onError)=>{
    pendingSceneLoads++;
    let settled=false;
    const done=()=>{if(!settled){settled=true;pendingSceneLoads--}};
    load(url,gltf=>{try{onLoad?.(gltf)}finally{done()}},onProgress,error=>{try{onError?.(error)}finally{done()}});
  };
  return loader;
});return optimizedGltfLoaderPromise;}
// Resolves once nothing is in flight and nothing new started on the following
// frame — a finished load often starts another from inside its own callback
// (the garden loads its flora, its eggs and its cast that way).
// A timer and not requestAnimationFrame: a page opened in a background tab
// gets no frames at all, and the preload would sit at nought per cent for as
// long as the tab stayed unlooked-at. Timers still fire there.
function settleSceneLoads(timeoutMs=45000){
  return new Promise(resolve=>{
    const deadline=performance.now()+timeoutMs;
    let quiet=0;
    const check=()=>{
      if(performance.now()>deadline){console.warn('A preload step did not settle in time; carrying on.');resolve();return}
      // Two quiet polls in a row, because a finished load often starts another
      // from inside its own callback — the garden loads its flora, its eggs
      // and its whole cast that way.
      quiet=pendingSceneLoads>0?0:quiet+1;
      if(quiet>=2){resolve();return}
      setTimeout(check,80);
    };
    setTimeout(check,80);
  });
}
async function installPepeModel(){try{const loader=await getOptimizedGltfLoader();loader.load('assets/models/pepe-the-frog.optimized.glb?v=meshopt-1',gltf=>{const slot=prizeDisplay.getObjectByName('pepe-model-slot');if(!slot)return;slot.clear();const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());model.position.sub(center);model.scale.setScalar(.58/Math.max(size.x,size.y,size.z));model.rotation.y=0;model.position.set(0,-.24,.22);slot.add(model);},undefined,error=>console.warn('Pepe model could not load.',error));}catch(error){console.warn('Pepe model loader could not initialize.',error)}}
async function loadPudgyColorTexture(buffer){const view=new DataView(buffer);let offset=12,json,bin;while(offset<buffer.byteLength){const length=view.getUint32(offset,true),type=view.getUint32(offset+4,true),chunk=new Uint8Array(buffer,offset+8,length);if(type===0x4e4f534a)json=JSON.parse(new TextDecoder().decode(chunk));if(type===0x004e4942)bin=chunk;offset+=8+length;}const image=json?.images?.[0],imageView=json?.bufferViews?.[image?.bufferView];if(!image||!imageView||!bin)throw new Error('Penguin color texture is missing.');const imageBytes=bin.slice(imageView.byteOffset||0,(imageView.byteOffset||0)+imageView.byteLength);const url=URL.createObjectURL(new Blob([imageBytes],{type:image.mimeType||'image/jpeg'}));return new Promise((resolve,reject)=>new THREE.TextureLoader().load(url,texture=>{URL.revokeObjectURL(url);texture.colorSpace=THREE.SRGBColorSpace;texture.flipY=false;texture.needsUpdate=true;resolve(texture);},undefined,error=>{URL.revokeObjectURL(url);reject(error)}));}
async function installPudgyModel(){try{const [loader,buffer]=await Promise.all([getOptimizedGltfLoader(),fetch('assets/models/pudgy-penguin.optimized.glb?v=meshopt-1').then(response=>{if(!response.ok)throw new Error(`Penguin model returned ${response.status}.`);return response.arrayBuffer()})]);const colorTexture=await loadPudgyColorTexture(buffer);const gltf=await new Promise((resolve,reject)=>loader.parse(buffer,'',resolve,reject));const slot=prizeDisplay.getObjectByName('pudgy-model-slot');if(!slot)return;slot.clear();const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());model.position.sub(center);model.traverse(node=>{if(node.isMesh)node.material=new THREE.MeshStandardMaterial({map:colorTexture,roughness:.55,metalness:0,side:THREE.DoubleSide});});model.scale.setScalar(.58/Math.max(size.x,size.y,size.z));model.rotation.y=0;model.position.y=-.08;slot.add(model);}catch(error){console.warn('Pudgy model could not load.',error)}}
async function installFurthermoreModel(){try{const loader=await getOptimizedGltfLoader();loader.load('assets/models/furthermore.optimized.glb?v=meshopt-1',gltf=>{const slot=prizeDisplay.getObjectByName('furthermore-model-slot');if(!slot)return;slot.clear();const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());model.position.sub(center);model.traverse(node=>{if(!node.isMesh)return;const materials=Array.isArray(node.material)?node.material:[node.material];for(const material of materials){if(material?.emissive){material.emissive.set(0x1a1209);material.emissiveIntensity=.1;}}});model.scale.setScalar(1.05/Math.max(size.x,size.y,size.z));model.rotation.y=-Math.PI/2;model.position.set(0,-.2,.18);slot.add(model);},undefined,error=>console.warn('Furthermore model could not load.',error));}catch(error){console.warn('Furthermore model loader could not initialize.',error)}}
async function installEnterpriseModel(){try{const loader=await getOptimizedGltfLoader();loader.load('assets/models/enterprise.optimized.glb?v=meshopt-1',gltf=>{const slot=prizeDisplay.getObjectByName('enterprise-model-slot');if(!slot)return;slot.clear();const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());model.position.sub(center);model.scale.setScalar(.76/Math.max(size.x,size.y,size.z));model.rotation.y=Math.PI/2;model.position.y=.02;slot.add(model);},undefined,error=>console.warn('Enterprise model could not load.',error));}catch(error){console.warn('Enterprise model loader could not initialize.',error)}}
async function installKurackModel(){try{const loader=await getOptimizedGltfLoader();loader.load('assets/models/kurack.optimized.glb?v=meshopt-1',gltf=>{const slot=prizeDisplay.getObjectByName('kurack-model-slot');if(!slot)return;slot.clear();const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3()),scale=.72/Math.max(size.x,size.y,size.z);model.scale.setScalar(scale);model.rotation.y=Math.PI*1.5;model.position.set(-center.x*scale,0,-center.z*scale);const scaledBounds=new THREE.Box3().setFromObject(model);model.position.y=-scaledBounds.min.y-.18;slot.add(model);},undefined,error=>console.warn('Kurack model could not load.',error));}catch(error){console.warn('Kurack model loader could not initialize.',error)}}
async function installGangsterPepe(){try{const loader=await getOptimizedGltfLoader();loader.load('assets/models/pepe-gangster-animated.optimized.glb?v=meshopt-1',gltf=>{const model=gltf.scene,bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3()),scale=.016/Math.max(size.x,size.y,size.z);model.scale.setScalar(scale);model.position.set(-center.x*scale,0,-center.z*scale);const scaledBounds=new THREE.Box3().setFromObject(model);model.position.y-=scaledBounds.min.y;gangsterPepeMount.add(model);if(gltf.animations.length){const mixer=new THREE.AnimationMixer(model);gltf.animations.forEach(clip=>mixer.clipAction(clip).play());animatedMixers.push(mixer);}},undefined,error=>console.warn('Animated gangster Pepe model could not load.',error));}catch(error){console.warn('Animated gangster Pepe loader could not initialize.',error)}}
let prizeModelsStarted=false,megaManStatuesStarted=false,chaoGardenModelStarted=false,silentHillBuildingsStarted=false,pokemonCenterStarted=false,pokemonRosterStarted=false,nextHeavyAssetCheck=0;
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
  }if(!prizeModelsStarted&&playerPosition.distanceToSquared(prizeDisplay.position)<144){prizeModelsStarted=true;installPepeModel();installPudgyModel();installFurthermoreModel();installEnterpriseModel();installKurackModel();installGangsterPepe();}if(!megaManStatuesStarted&&playerPosition.x<-18.6&&playerPosition.z<24&&playerPosition.z>-6){megaManStatuesStarted=true;installMegaManStatues();}if(!chaoGardenModelStarted&&playerPosition.z>8){chaoGardenModelStarted=true;installChaoGardenModel();}if(!templeOfTimeStarted&&playerPosition.z>8){templeOfTimeStarted=true;installTempleOfTime();}if(playerPosition.x<-14&&playerPosition.z<-12&&playerPosition.z>-40){installPeachsCastle();}if(!silentHillBuildingsStarted&&playerPosition.x<-14&&playerPosition.z<-28){silentHillBuildingsStarted=true;installSilentHillBuildings();installSilentHillCast();}if(!pokemonCenterStarted&&playerPosition.x>8&&playerPosition.z<-6){pokemonCenterStarted=true;installPokemonCenter();installPikomat();}if(!pokemonRosterStarted&&playerPosition.z<-64&&playerPosition.x>-12&&playerPosition.x<66){pokemonRosterStarted=true;installPokemonRoster();}}
/**
 * Everything heavy, loaded behind the avatar screen instead of underfoot.
 *
 * The regions used to arrive on a distance test while the player was walking
 * into them, so 77MB of glTF was parsed on the main thread mid-stride: that is
 * the hitch. The avatar screen is a free window — the scene is already built by
 * then (app-bootstrap awaits arcade.js before avatar-selection), the render
 * loop is already spinning, and the player is reading and typing rather than
 * moving. Nothing here blocks entry: the button stays live, and anyone who goes
 * in early simply meets the regions arriving the way they always did.
 *
 * The visibility culling is untouched. This changes only WHEN things load, not
 * what draws; updateNearbyLights and updateChaoSkyVisibility never knew about
 * loading in the first place.
 */
let scenePreloadStarted=false;
function warmSceneGpu(){
  // Shader programs link and textures upload on the first frame a material is
  // drawn, which is its own spike on top of the parse. compile() walks only
  // what is visible and the regions are hidden until someone is near them, so
  // each is forced on for the pass and put back exactly as it was. r0.160 has
  // no compileAsync, so this is synchronous by necessity — which is precisely
  // why it belongs behind the avatar screen and not after it.
  const regions=[silentHillWorld,pokemonRosterWorld,chaoWorld,templeMount,castleMount,stadiumArenaWorld,prizeDisplay].filter(Boolean);
  const wasVisible=regions.map(region=>region.visible);
  for(const region of regions)region.visible=true;
  try{renderer.compile(scene,camera)}catch(error){console.warn('The GPU warm-up pass did not finish.',error)}
  regions.forEach((region,index)=>{region.visible=wasVisible[index]});
}
function preloadSceneModels(onProgress){
  if(scenePreloadStarted)return Promise.resolve();
  scenePreloadStarted=true;
  // Nearest the spawn first, so an impatient player who enters early already
  // has what is in front of them.
  const steps=[
    ['the garden',()=>{chaoGardenModelStarted=true;installChaoGardenModel()}],
    ['the temple',()=>{templeOfTimeStarted=true;installTempleOfTime()}],
    ['the castle',()=>installPeachsCastle()],
    ['the statues',()=>{megaManStatuesStarted=true;installMegaManStatues()}],
    ['the cabinets',()=>{for(const system of ['psx','n64','gamecube'])installControllerModel(system)}],
    ['the cabinet art',()=>{for(const cabinet of cabinets)if(cabinet.artSlug&&!cabinet.artApplied)applyCabinetArt(cabinet,cabinet.artSlug)}],
    ['the prizes',()=>{prizeModelsStarted=true;installPepeModel();installPudgyModel();installFurthermoreModel();installEnterpriseModel();installKurackModel();installGangsterPepe()}],
    ['the centre',()=>{pokemonCenterStarted=true;installPokemonCenter();installPikomat()}],
    ['the arena',()=>{pokemonRosterStarted=true;installPokemonRoster()}],
    ['the street',()=>{silentHillBuildingsStarted=true;installSilentHillBuildings();installSilentHillCast()}]
  ];
  return (async()=>{
    for(let index=0;index<steps.length;index++){
      const [label,run]=steps[index];
      // One region at a time. Firing all nine at once saturates the main
      // thread and freezes the avatar screen itself, which is the same fault
      // moved rather than fixed.
      try{run()}catch(error){console.warn('A preload step failed; that region will simply arrive late.',error)}
      await settleSceneLoads();
      onProgress?.(index+1,steps.length,label);
    }
    warmSceneGpu();
    onProgress?.(steps.length,steps.length,null);
  })();
}
let nextLightCull=0;
// The barrier beacons are children of their barrier group, so light.position is
// a local offset near the origin rather than the corner the beacon actually
// occupies. Rank on the world position instead.
function managedLightPosition(light){
  if(!light.userData.worldPosition){light.updateWorldMatrix(true,false);light.userData.worldPosition=light.getWorldPosition(new THREE.Vector3())}
  return light.userData.worldPosition;
}
// The garden's sky is seventy metres across and carries no fog, so from
// Silent Hill's street its rim hung in the murk as a pale arc. It is drawn
// only for someone who could actually be under it.
function updateChaoSkyVisibility(){
  chaoWorld.visible=playerPosition.z>14;
  // The same trick for the other three outposts. Each bound is generous: it
  // covers everywhere the place can actually be seen from, including the
  // sightlines through its own doorway, so nothing pops into an open view.
  // Bounded in x as well as z. These gates were z-only, so standing seventy
  // metres west in Peach's Castle still drew Silent Hill's 110 meshes and the
  // roster's 83 whenever the camera swung east -- nearly 200 draw calls for
  // rooms in another building. Same for the stadium bowl and the prize counter,
  // which had no gate at all: 79 and 116 more.
  silentHillWorld.visible=playerPosition.z<-26&&playerPosition.x>-70;
  pokemonRosterWorld.visible=playerPosition.z<-44&&playerPosition.x>-16;
  if(stadiumArenaWorld)stadiumArenaWorld.visible=playerPosition.z<-30&&playerPosition.x>-16;
  prizeDisplay.visible=playerPosition.distanceToSquared(prizeDisplay.position)<5625;
  if(templeMount)templeMount.visible=playerPosition.z>14;
  // Generous on purpose. The castle's carpet now runs INSIDE the arcade room,
  // out to x -37, and the doorway at z -25.2 has a sightline from most of the
  // hall — so a tight cull does not save a distant object, it punches a black
  // hole through the doorway and deletes the carpet from a room the player is
  // standing in. That is what x<-14 did. The castle is ten meshes and 1,190
  // vertices; there was never much to save by cutting it fine.
  if(castleMount)castleMount.visible=playerPosition.x<HALL_HALF_WIDTH;
  if(pikomatMount)pikomatMount.visible=playerPosition.x>4&&playerPosition.z<-18;
}
function updateNearbyLights(now){if(now<nextLightCull)return;nextLightCull=now+250;updateChaoSkyVisibility();const cabinetDistances=cabinets.map(cabinet=>({cabinet,distanceSq:cabinet.g.position.distanceToSquared(playerPosition)})).sort((a,b)=>a.distanceSq-b.distanceSq);let litCabinets=0;for(const {cabinet,distanceSq} of cabinetDistances){cabinet.g.visible=distanceSq<(cabinet.cullSq??324);const lightsVisible=cabinet.g.visible&&distanceSq<64&&litCabinets<2;if(lightsVisible)litCabinets++;cabinet.renderLights.forEach(light=>{light.visible=lightsVisible});}const roomLights=[],accentLights=[],muralLights=[],solanaLights=[];for(const light of managedSceneLights){const position=managedLightPosition(light),dx=position.x-playerPosition.x,dz=position.z-playerPosition.z;(light.userData.solanaLight?solanaLights:light.userData.muralLight?muralLights:light.userData.accentLight?accentLights:roomLights).push({light,distanceSq:dx*dx+dz*dz})}
// Accent beacons only reach 2.8 units, so they are ranked against their own
// radius. Sharing one budget with the room lights let them win both slots from
// across the room and leave the floor unlit.
// Four, and reaching further. Two was tuned for a hall a third of this size,
// and in the ring it left the floor between rooms genuinely unlit.
roomLights.sort((a,b)=>a.distanceSq-b.distanceSq).forEach(({light,distanceSq},index)=>{light.visible=index<4&&distanceSq<400});
accentLights.sort((a,b)=>a.distanceSq-b.distanceSq).forEach(({light,distanceSq},index)=>{light.visible=index<2&&distanceSq<(light.userData.wideAccent?900:16)});
// A mural washes its wall from across the room, so it is ranked over the range
// it actually reaches. On the accent budget every one of these sat dark unless
// the player pressed into the wall, which is the one place you cannot see it.
muralLights.sort((a,b)=>a.distanceSq-b.distanceSq).forEach(({light,distanceSq},index)=>{light.visible=index<3&&distanceSq<225});
// The Solana signs carry their own cheap additive glow. Two nearby washes tint
// the player and floor without raising the live light budget as the arcade grows.
solanaLights.sort((a,b)=>a.distanceSq-b.distanceSq).forEach(({light,distanceSq},index)=>{light.visible=index<2&&distanceSq<400});
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
    pitch=Math.max(-LOOK_PITCH_LIMIT,Math.min(LOOK_PITCH_LIMIT,pitch-gamepadLook.y*delta*1.75));
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
document.addEventListener('mousemove',e=>{if(!locked)return;if(e.movementX||e.movementY)setGamepadEngaged(false);yaw-=e.movementX*.0025;pitch=Math.max(-LOOK_PITCH_LIMIT,Math.min(LOOK_PITCH_LIMIT,pitch-e.movementY*.0025))});
addEventListener('keydown',e=>{keys[e.code]=true;setGamepadEngaged(false);if(e.code==='KeyV'&&!e.repeat)toggleCameraMode();if(e.code==='KeyE'&&near&&(locked||mobileInputAvailable())&&!e.repeat)interactWithNearbyCabinet();if(e.code==='Escape'&&activeCabinet)closeMachine();else if(e.code==='Escape'&&socialFollowProvider)socialFollowProvider=null});addEventListener('keyup',e=>keys[e.code]=false);
if(mobileMoveZone&&mobileMoveThumb&&mobileLookZone){
  let movePointer=null,lookPointer=null,lastLookX=0,lastLookY=0;
  const updateMove=event=>{const rect=mobileMoveThumb.parentElement.getBoundingClientRect(),centerX=rect.left+rect.width/2,centerY=rect.top+rect.height/2,radius=rect.width*.34,dx=event.clientX-centerX,dy=event.clientY-centerY,length=Math.hypot(dx,dy)||1,scale=Math.min(1,radius/length),x=dx*scale,y=dy*scale;mobileMove.x=x/radius;mobileMove.y=y/radius;mobileMoveThumb.style.transform=`translate(calc(-50% + ${x}px),calc(-50% + ${y}px))`};
  mobileMoveZone.addEventListener('pointerdown',event=>{event.preventDefault();movePointer=event.pointerId;mobileMoveZone.setPointerCapture(event.pointerId);updateMove(event)});
  mobileMoveZone.addEventListener('pointermove',event=>{if(event.pointerId===movePointer)updateMove(event)});
  const endMove=event=>{if(event.pointerId!==movePointer)return;movePointer=null;resetMobileMove()};
  mobileMoveZone.addEventListener('pointerup',endMove);mobileMoveZone.addEventListener('pointercancel',endMove);
  mobileLookZone.addEventListener('pointerdown',event=>{event.preventDefault();lookPointer=event.pointerId;lastLookX=event.clientX;lastLookY=event.clientY;mobileLookZone.setPointerCapture(event.pointerId)});
  mobileLookZone.addEventListener('pointermove',event=>{if(event.pointerId!==lookPointer)return;const dx=event.clientX-lastLookX,dy=event.clientY-lastLookY;lastLookX=event.clientX;lastLookY=event.clientY;yaw-=dx*.006;pitch=Math.max(-LOOK_PITCH_LIMIT,Math.min(LOOK_PITCH_LIMIT,pitch-dy*.006))});
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
  import('./emulators/disc-range-cache.js?v=sh-seal-1')
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
  import('./emulators/disc-range-cache.js?v=sh-seal-1')
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
  // The garden's doorway used to force first person over a 12 by 15 metre box,
  // on the reasoning that a chase camera five metres back would sit outside the
  // shell looking at the void. The garden has its own ground and sky out there
  // now, so there is nothing to hide and the box was simply taking the camera
  // off the player for a third of the walk in.
  // The temple's doorway is the same kind of throat: a chase camera set back
  // five metres sits outside the facade, looking at the void beside it.
  // The temple is vaulted end to end and its passages are narrow: a chase
  // camera set back five metres clears the roof and shows the void outside.
  // Inside the building the view is the walker's own.
  const inTempleDoor=playerPosition.x>-124.5&&playerPosition.x<-40&&Math.abs(playerPosition.z-42)<17.5;
  if(cameraMode==='first-person'||inTempleDoor){
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
  // The chase camera rides up and down with pitch, so at the full look range it
  // would bury itself under the floor (2.15 - 1.45*2.1 is below the player's
  // feet). Clamp what the camera uses, not what the player sees: first person
  // gets the whole range, third person keeps exactly the arc it always had.
  const chasePitch=Math.max(-.42,Math.min(.58,pitch));
  if(inVomitory)followOffset.set(0,.72-chasePitch*1.2,2.5).applyAxisAngle(upAxis,yaw);
  else followOffset.set(0,2.15-chasePitch*2.1,4.55).applyAxisAngle(upAxis,yaw);
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
    // The pipe's mouth is wider than any door in the building, but only its
    // bore is open: stepping in anywhere else is stepping into the lip.
    if(wallX===PLAYSTATION_WALL_X&&Math.abs(crossingZ-CASTLE_APPROACH_Z)<CASTLE_PIPE_CHANNEL_HALF-PLAYER_COLLISION_RADIUS)continue;
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
/**
 * The warp pipe is solid.
 *
 * The Mario room is one tube from wall to wall, so the room's floor either side
 * of the bore is not a place to be: a player out there stands inside the pipe's
 * wall, walking through green. The mouth funnels into the channel and the
 * archway at the far end is cut to the same width, so there is nowhere in this
 * room a walker can legitimately be that is outside the pipe.
 *
 * Clamped rather than refused, so running at the wall slides along it the way
 * the partition walls do instead of stopping dead -- except when the step is
 * what brought the player into the narrow section at all. Coming east off the
 * castle approach they can legitimately be 5.06 off the centre line, and
 * clamping that to 1.86 is not a slide, it is a three metre sideways teleport:
 * a camera whip on its own, and a jump far enough past the authorities' own
 * speed check (1.1m per packet) to be refused and dragged back, which puts the
 * player straight back into it. The shoulders they are walking at are solid
 * brick to look at, so refuse the step in x and let them stand against it. z
 * still moves, so they slide along the shoulder into the mouth as expected.
 */
function resolveWarpPipeCollisions(previousX){
  if(playerPosition.x<CASTLE_ARCHWAY_WEST||playerPosition.x>CASTLE_PIPE_EAST)return;
  const offset=playerPosition.z-CASTLE_APPROACH_Z;
  if(Math.abs(offset)>ROOM_DEPTH/2)return;
  const limit=CASTLE_PIPE_CHANNEL_HALF-PLAYER_COLLISION_RADIUS;
  if(Math.abs(offset)<=limit)return;
  if(previousX<CASTLE_ARCHWAY_WEST){playerPosition.x=previousX;return;}
  playerPosition.z=CASTLE_APPROACH_Z+Math.sign(offset)*limit;
}
/**
 * The Zelda room's machines are solid.
 *
 * The temple has no lateral collision of any kind — it is raycast-as-floor and
 * nothing else, which is why the temple's own columns are walk-through today. A
 * ring of twelve cabinets you can stand inside would read as a bug rather than
 * as a style, so these carry their own colliders.
 *
 * Circles rather than boxes: every machine in the ring faces a different way,
 * and a box would need each one's rotation to test against.
 */
const ZELDA_CABINET_RADIUS=.82;
function resolveZeldaCabinetCollisions(previousX,previousZ){
  if(!zeldaCabinetSpots.length)return;
  const roomX=playerPosition.x-ZELDA_ROOM_CENTRE_X,roomZ=playerPosition.z-ZELDA_ROOM_CENTRE_Z;
  if(roomX*roomX+roomZ*roomZ>400)return;
  const reach=ZELDA_CABINET_RADIUS+PLAYER_COLLISION_RADIUS;
  for(const [x,z] of zeldaCabinetSpots){
    const offsetX=playerPosition.x-x,offsetZ=playerPosition.z-z;
    const distance=Math.hypot(offsetX,offsetZ);
    if(distance>=reach)continue;
    // Dead centre gives no direction to push along, which only happens if a
    // player is put there rather than walking there.
    if(distance<1e-4){playerPosition.x=previousX;playerPosition.z=previousZ;return}
    playerPosition.x=x+offsetX/distance*reach;
    playerPosition.z=z+offsetZ/distance*reach;
    return;
  }
}
/**
 * The castle's machines are solid, for the same reason the temple's are: the
 * castle is raycast-as-floor with no lateral collision of its own.
 */
/** The garden machines are solid; the meadow is raycast floor with no lateral rules. */
function resolveSonicCabinetCollisions(previousX,previousZ){
  if(!sonicCabinetSpots.length)return;
  if(playerPosition.x<44||playerPosition.z<33||playerPosition.z>46)return;
  const reach=ZELDA_CABINET_RADIUS+PLAYER_COLLISION_RADIUS;
  for(const [x,z] of sonicCabinetSpots){
    const offsetX=playerPosition.x-x,offsetZ=playerPosition.z-z;
    const distance=Math.hypot(offsetX,offsetZ);
    if(distance>=reach)continue;
    if(distance<1e-4){playerPosition.x=previousX;playerPosition.z=previousZ;return}
    playerPosition.x=x+offsetX/distance*reach;
    playerPosition.z=z+offsetZ/distance*reach;
    return;
  }
}
function resolveMarioCabinetCollisions(previousX,previousZ){
  if(!marioCabinetSpots.length)return;
  if(playerPosition.x>-84||playerPosition.x<-116)return;
  const reach=ZELDA_CABINET_RADIUS+PLAYER_COLLISION_RADIUS;
  // The castle stacks four walkable levels, and these circles are planar. A
  // machine on the 2F landing was a phantom barrier on the hall floor nine
  // metres under it, and Dr. Mario's -- standing at the head of the terrace
  // approach -- shoved climbers sideways off the edge from two levels down.
  // A collider exists only on the floor its machine stands on.
  const playerFloor=playerPosition.y-PLAYER_EYE_HEIGHT;
  for(const [x,z,floorY] of marioCabinetSpots){
    if(Math.abs(playerFloor-floorY)>1)continue;
    const offsetX=playerPosition.x-x,offsetZ=playerPosition.z-z;
    const distance=Math.hypot(offsetX,offsetZ);
    if(distance>=reach)continue;
    if(distance<1e-4){playerPosition.x=previousX;playerPosition.z=previousZ;return}
    playerPosition.x=x+offsetX/distance*reach;
    playerPosition.z=z+offsetZ/distance*reach;
    return;
  }
}
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
 * Silent Hill's blocks are solid.
 *
 * The buildings are facades with side returns, hollow behind and open above,
 * and they carried no collision at all — the street's only fences were the
 * region bounds, so the brickwork was scenery you could step through into the
 * dark. Their footprints are captured as each block is placed and every one is
 * axis-aligned (the mounts turn in quarter circles), so the test is a
 * rectangle. A step that ends inside one is refused outright rather than
 * projected: these are walls, and sliding along the inside of a wall is how a
 * player ends up in the void behind it.
 */
const silentHillBlocks=[];
function resolveSilentHillCollisions(previousX,previousZ){
  if(!silentHillBlocks.length)return;
  // Bounded on all four sides. The AABB loop below cannot false-fire, but the
  // old two-sided guard ran 26 box checks per frame from the castle and the
  // stadium -- the same loose-guard shape that produced two real walls.
  if(playerPosition.x>SILENT_HILL_EXPANSE.maxX+1||playerPosition.z>SILENT_HILL_EXPANSE.maxZ+1)return;
  if(playerPosition.x<SILENT_WEST_X-6.5||playerPosition.z<SILENT_HILL_EXPANSE.minZ-1)return;
  for(const block of silentHillBlocks){
    if(playerPosition.x<=block.minX-PLAYER_COLLISION_RADIUS||playerPosition.x>=block.maxX+PLAYER_COLLISION_RADIUS)continue;
    if(playerPosition.z<=block.minZ-PLAYER_COLLISION_RADIUS||playerPosition.z>=block.maxZ+PLAYER_COLLISION_RADIUS)continue;
    playerPosition.x=previousX;playerPosition.z=previousZ;
    return;
  }
}
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
const CHAO_GARDEN={doorZ:13.2+CHAO_DZ,laneHalfWidth:4.4,laneEndX:47.4};
// The fence is the geometry itself, and so is the floor: a step stands
// wherever a ray straight down finds ground within a stride's climb of the
// player's feet, and the player's height follows that ground. Slopes and
// shelves are walked, sheer cliffs and open sea are refused.

const chaoGroundRay=new THREE.Raycaster();
const chaoGroundOrigin=new THREE.Vector3(),chaoGroundDown=new THREE.Vector3(0,-1,0);
function chaoGroundAt(x,z,feetY){
  chaoGroundOrigin.set(x,42,z);
  chaoGroundRay.set(chaoGroundOrigin,chaoGroundDown);
  const hits=chaoGroundRay.intersectObject(chaoGardenMount,true);
  for(const hit of hits){
    const groundY=hit.point.y;
    if(groundY>-3.5&&groundY<=feetY+1.9)return groundY;
  }
  return null;
}

function resolveChaoGardenCollisions(previousX,previousZ){
  // The meadow reaches the shell wall now, so the doorway is the whole story:
  // past it the measured grass edge is the only fence, and a step that lands
  // on neither goes back where it began.
  // the shell wall has thickness: the arcade floor carries the step across it
  // and the meadow takes over on the far side
  // Bounded to the garden's own z-range: the Pokemon stadium bowl also reaches
  // past x 43.5 at z around -120, and an unbounded guard ran this resolver's
  // no-ground refusal as an invisible wall across the arena (BLOCK CHAO
  // @43,-120 on the HUD). Every region resolver is bounded to its region.
  if(playerPosition.x<43.5||playerPosition.z<CHAO_EXPANSE.minZ-.3||playerPosition.z>CHAO_EXPANSE.maxZ+.3)return;
  const inLane=Math.abs(playerPosition.z-CHAO_GARDEN.doorZ)<CHAO_GARDEN.laneHalfWidth&&playerPosition.x<CHAO_GARDEN.laneEndX;
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
  // Nothing in the top row exists west of Silent Hill. Without this guard,
  // bounding the Silent Hill branch below made castle positions fall through
  // to the ELSE-IF for the arcade's front wall at z -50.4 -- its only check is
  // x < 10.8 -- and the invisible wall moved west instead of dying: BLOCK
  // TOP-ROW @-91,-50, straight across the castle terrace. The server never had
  // this bug; its front-wall rule is bounded on both sides.
  if(playerPosition.x<SILENT_WEST_X)return;
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
  // The corner between the two wall lines. Everything else in this function
  // stops a player crossing a z line; this one stops them crossing an x line,
  // because the north boundary steps east here rather than running straight.
  if(playerPosition.z>TOP_BAND_MIN_Z&&playerPosition.z<POKEMON_SOUTH_Z){
    const westFace=POKEMON_WEST_X-wallGap,eastFace=POKEMON_WEST_X+wallGap;
    if(playerPosition.x>westFace&&playerPosition.x<eastFace){
      if(previousX<POKEMON_WEST_X)playerPosition.x=westFace;else playerPosition.x=eastFace;
      return;
    }
  }
  // The front wall at z=-50.4 runs between the two corner blocks: Silent Hill
  // took its west stretch the way the stadium took its east one.
  // Bounded on the west too. Silent Hill's south wall runs on z -42 and this
  // only ever checked that a player was east of -21.6 -- which is every point in
  // Peach's Castle, forty metres further west. The castle hall spans z -52..1.8,
  // so the wall of a different building was cutting it in half: Super Mario 64,
  // Paper Mario and Dr. Mario all stand south of that line and could not be
  // walked to at all.
  if(playerPosition.x<SILENT_EAST_X&&playerPosition.x>SILENT_WEST_X){
    // Silent Hill's south wall, with the entrance at its centre.
    const northFace=SILENT_SOUTH_Z-wallGap,southFace=SILENT_SOUTH_Z+wallGap;
    // The doorway is sealed while the district is rebuilt: the wall is solid
    // across where the entrance was, and the barrier out front says why.
    if(playerPosition.z>northFace&&playerPosition.z<southFace){
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
const ARCADE_BUILD='sh-seal-1';
if(performanceStats){
  const buildStamp=document.createElement('div');
  buildStamp.id='build-stamp';
  buildStamp.textContent='BUILD · '+ARCADE_BUILD.toUpperCase();
  buildStamp.style.cssText='color:#6b6486;font-size:9px;letter-spacing:.08em;margin-top:3px;text-align:right';
  performanceStats.insertAdjacentElement('afterend',buildStamp);
}
let performanceWindowStart=performance.now(),performanceFrames=0,slowWindows=0,fastWindows=0,latestPerformance={fps:0,frameMs:0,quality:'WARMING'};
/**
 * Which rule last stopped the player, on the HUD.
 *
 * Every invisible-wall report so far has come in as a screenshot, and the
 * screenshots always include the HUD. So when any resolver moves the player
 * against their input, its name goes up next to the build stamp for a few
 * seconds -- the report then names the culprit by itself instead of starting
 * another search through eleven resolvers. Costs nine coordinate compares per
 * moving frame; draws nothing at all unless something actually blocks.
 */
let lastBlockNote=0;
function runResolvers(previousX,previousZ){
  const chain=[
    ['partition',()=>resolvePartitionWallCollisions(previousX,previousZ)],
    ['warp-pipe',()=>resolveWarpPipeCollisions(previousX)],
    ['social',()=>resolveSocialLayoutCollisions(previousX,previousZ)],
    ['statues',()=>resolveStatueCollisions(previousX,previousZ)],
    ['pokebowl',()=>resolvePokemonBowlCollisions(previousX,previousZ)],
    ['chao',()=>resolveChaoGardenCollisions(previousX,previousZ)],
    ['zelda-cab',()=>resolveZeldaCabinetCollisions(previousX,previousZ)],
    ['mario-cab',()=>resolveMarioCabinetCollisions(previousX,previousZ)],
    ['sonic-cab',()=>resolveSonicCabinetCollisions(previousX,previousZ)],
    ['temple-floor',()=>resolveTempleFloor(previousX,previousZ)],
    ['castle-floor',()=>resolveCastleFloor(previousX,previousZ)],
    ['top-row',()=>resolveTopRowCollisions(previousX,previousZ)],
    ['silent-hill',()=>resolveSilentHillCollisions(previousX,previousZ)],
    ['world-bounds',()=>clampToWorld(previousX,previousZ)]
  ];
  for(const [name,run] of chain){
    const beforeX=playerPosition.x,beforeZ=playerPosition.z;
    run();
    if(Math.abs(playerPosition.x-beforeX)>.003||Math.abs(playerPosition.z-beforeZ)>.003){
      const now=performance.now();
      if(now>lastBlockNote+250){lastBlockNote=now;
        const stamp=document.getElementById('build-stamp');
        if(stamp)stamp.textContent='BUILD · '+ARCADE_BUILD.toUpperCase()+' · BLOCK '+name.toUpperCase()+' @'+playerPosition.x.toFixed(0)+','+playerPosition.z.toFixed(0);
        clearTimeout(runResolvers.reset);
        runResolvers.reset=setTimeout(()=>{const s=document.getElementById('build-stamp');if(s)s.textContent='BUILD · '+ARCADE_BUILD.toUpperCase()},4000);
      }
    }
  }
}
const getRendererStats=()=>{const memory=performance.memory;return{...latestPerformance,renderScale:currentPixelRatio,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,heapUsedMb:memory?Number((memory.usedJSHeapSize/1048576).toFixed(1)):null,heapLimitMb:memory?Number((memory.jsHeapSizeLimit/1048576).toFixed(1)):null}};
window.arcadeMultiplayer={scene,getCamera:()=>camera,getCanvas:()=>renderer.domElement,getLocalTransform:()=>({position:{x:playerPosition.x,y:playerPosition.y,z:playerPosition.z},rotationY:yaw}),getLocalAnimationState:()=>localAnimationState,isEmulatorActive:()=>emulatorRuntimeActive,isFirstPerson:()=>cameraMode==='first-person',getCameraMode:()=>cameraMode,isFollowingPlayer:()=>Boolean(socialFollowProvider),followPlayer:provider=>{socialFollowProvider=provider},clearPlayerFollow:()=>{socialFollowProvider=null},applyAuthoritativeTransform:({position,rotationY},strength=.12)=>{correctionTarget.set(position.x,playerPosition.y,position.z);playerPosition.lerp(correctionTarget,strength);const difference=Math.atan2(Math.sin(rotationY-yaw),Math.cos(rotationY-yaw));yaw+=difference*strength;},performanceProfile:{lowPower:lowPowerDevice,getRenderScale:()=>currentPixelRatio,getStats:getRendererStats},setCabinetState,setCabinetStates,showCabinetMessage,beginCabinetSession,forceCloseCabinetSession,debugInstallGarden:()=>installChaoGardenModel(),debugInstallTemple:()=>installTempleOfTime(),debugInstallCastle:()=>installPeachsCastle(),debugInstallPikomat:()=>installPikomat(),debugInstallRoster:()=>installPokemonRoster(),debugWorldTick:()=>{nextHeavyAssetCheck=0;nextLightCull=0;loadNearbySceneModels(performance.now());updateNearbyLights(performance.now())},debugInstallSilentHill:()=>{installSilentHillBuildings();installSilentHillCast()},onBeforeRender:callback=>{beforeRenderCallbacks.push(callback)}};
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
function tick(){requestAnimationFrame(tick);const d=Math.min(clock.getDelta(),.05);if(emulatorRuntimeActive)return;const now=performance.now();const gamepadActive=pollArcadeGamepad(d);updatePerformanceStats(now);updateNearbyLights(now);animatedMixers.forEach(mixer=>mixer.update(d));if(now-lastPrizeLedDraw>=200&&playerPosition.distanceToSquared(prizeDisplay.position)<400){drawPrizeLed(now);lastPrizeLedDraw=now}loadNearbySceneModels(now);const controlsActive=locked||mobileInputAvailable()&&start.style.display==='none'&&!activeCabinet||gamepadActive&&!activeCabinet;if(controlsActive){movementVector.set((keys.KeyD?1:0)-(keys.KeyA?1:0)+mobileMove.x+gamepadMove.x,0,(keys.KeyS?1:0)-(keys.KeyW?1:0)+mobileMove.y+gamepadMove.y);localAnimationState=movementVector.lengthSq()?'walk':'idle';if(movementVector.lengthSq()){const analogSpeed=Math.min(1,movementVector.length());movementVector.normalize().multiplyScalar(d*11.25*analogSpeed).applyAxisAngle(upAxis,yaw);const previousX=playerPosition.x,previousZ=playerPosition.z;playerPosition.add(movementVector);runResolvers(previousX,previousZ)}const planarReachSq=CABINET_PROMPT_RANGE*CABINET_PROMPT_RANGE-PLAYER_EYE_HEIGHT*PLAYER_EYE_HEIGHT;near=planarReachSq>0?(window.ARCADE_CABINET_SPATIAL_INDEX?.nearest(playerPosition.x,playerPosition.z,Math.sqrt(planarReachSq))?.payload??null):null;if(near&&Math.abs(near.g.position.y-(playerPosition.y-PLAYER_EYE_HEIGHT))>1.8)near=null;warmEmulatorCore(near);const constructionRoom=nearbyConstructionRoom();if(constructionRoom)updateConstructionPrompt(constructionRoom);else updateCabinetPrompt()}else{localAnimationState=activeCabinet?'interact':'idle';if(now>=cabinetMessageUntil)prompt.classList.remove('active')}updateFollowCamera();game();for(const callback of beforeRenderCallbacks)callback(now,d);renderer.render(scene,camera)}flushStaticBoxes();flushCabinetParts();tick();
document.addEventListener('visibilitychange',()=>{performanceWindowStart=performance.now();performanceFrames=0;slowWindows=0;fastWindows=0});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);currentPixelRatio=Math.min(currentPixelRatio,renderScaleCeiling());renderer.setPixelRatio(currentPixelRatio)});
// Start the preload the moment the scene exists. arcade.js is awaited before
// avatar-selection.js, so #avatar-screen is already in the document and the
// player is about to spend a few seconds on it either way.
(function preloadBehindTheAvatarScreen(){
  // Local testing only: with all 77MB resident a headless browser renders at
  // about nothing, which makes the scene impossible to inspect. ?skipPreload=1
  // leaves the regions to arrive on their distance triggers the way they used
  // to. Gated to localhost so it is never a switch anyone can throw in
  // production.
  const local=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  if(local&&new URLSearchParams(location.search).get('skipPreload')==='1'){
    console.info('[arcade] preload skipped: regions will load on approach.');
    return;
  }
  const screen=document.getElementById('avatar-form')??document.getElementById('avatar-screen');
  const line=document.createElement('p');
  line.id='preload-line';
  line.textContent='LOADING THE ARCADE · 0%';
  screen?.appendChild(line);
  void preloadSceneModels((done,total,label)=>{
    if(!label){line.textContent='THE ARCADE IS READY';line.dataset.ready='true';setTimeout(()=>line.remove(),2600);return}
    line.textContent='LOADING THE ARCADE · '+Math.round(done/total*100)+'% · '+label.toUpperCase();
  });
})();
