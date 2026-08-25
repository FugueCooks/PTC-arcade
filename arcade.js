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
const pixelRatioCap=lowPowerDevice ? .75 : 1;
const pixelRatioFloor=lowPowerDevice ? .5 : .6;
let currentPixelRatio=Math.min(devicePixelRatio,pixelRatioCap);
const renderer = new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance'}); renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(currentPixelRatio); renderer.shadowMap.enabled=false; document.body.appendChild(renderer.domElement);
const clock = new THREE.Clock(), keys = {}, cabinets = [], raycaster = new THREE.Raycaster(), animatedMixers = [];
const mobileMove={x:0,y:0};
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
const floor = new THREE.Mesh(new THREE.PlaneGeometry(28,34),new THREE.MeshStandardMaterial({map:floorTextures.map,roughnessMap:floorTextures.roughnessMap,emissive:0x10091c,emissiveIntensity:.42,roughness:.66,metalness:.14}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
function box(w,h,d,color,x,y,z,emissive=0){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:emissive,roughness:.43,metalness:.65}));m.position.set(x,y,z);m.castShadow=true;scene.add(m);return m}
// Tokyo-noir ceiling. A real ceiling plane closes off what used to be an open
// black void, and the full-width cyan light bars are replaced by short recessed
// troffers, so the room reads as a low-lit game centre rather than an arena.
// Every fixture here is emissive geometry only: none of it adds a real light,
// so the ceiling costs nothing against the per-frame light budget.
const ceiling=new THREE.Mesh(new THREE.PlaneGeometry(62,34),new THREE.MeshStandardMaterial({color:0x0c0a15,roughness:.95,metalness:.06}));
ceiling.rotation.x=Math.PI/2;ceiling.position.y=5.08;scene.add(ceiling);
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
for(const z of [-10,-3.5,3.5,10]){
  const cord=new THREE.Mesh(new THREE.BoxGeometry(.02,.62,.02),ceilingHousingMaterial);cord.position.set(0,4.55,z);scene.add(cord);
  const tube=new THREE.Mesh(new THREE.CylinderGeometry(.075,.075,.46,10),pendantMaterial);tube.position.set(0,4.02,z);scene.add(tube);
  const bloom=new THREE.Mesh(new THREE.SphereGeometry(.3,10,8),new THREE.MeshBasicMaterial({color:0xffa860,transparent:true,opacity:.11,depthWrite:false,blending:THREE.AdditiveBlending}));bloom.position.set(0,4.02,z);scene.add(bloom);
}
const MEGAMAN_ROOM_WALL_X=-31,MEGAMAN_ROOM_CENTER_X=-43,MEGAMAN_ROOM_CENTER_Z=-7,MEGAMAN_ROOM_SIZE=24,MEGAMAN_ROOM_DOOR_Z=-7;
// The doorway is cut into the exact outer PlayStation wall shown by the
// cabinet row: Gex and Tony Hawk flank the opening into the unsigned room.
box(.3,5,8.2,0x180d31,MEGAMAN_ROOM_WALL_X,2.5,-12.7);
box(.3,5,22.2,0x180d31,MEGAMAN_ROOM_WALL_X,2.5,5.7);
box(.3,5,34,0x180d31,31,2.5,0);
// The main room now reaches the true rear wall. Keeping this wall aligned with
// the two expansion-room back walls leaves open passages around both partition
// ends instead of creating a false wall in front of the walkways.
const rearWall=box(28,5,.3,0x15182a,0,2.5,-16.8,.18);rearWall.receiveShadow=true;
const rearPanelMaterial=new THREE.MeshStandardMaterial({color:0x17233a,emissive:0x08162b,emissiveIntensity:.5,roughness:.58,metalness:.38});
for(let x=-12;x<=12;x+=4){const panel=new THREE.Mesh(new THREE.BoxGeometry(3.82,4.62,.055),rearPanelMaterial);panel.position.set(x,2.42,-16.62);panel.receiveShadow=true;scene.add(panel)}
box(27.5,.09,.08,0xd18a52,0,4.78,-16.57,.85);box(27.5,.12,.08,0x251447,0,.1,-16.57,.55);
const gangsterPepeMount=new THREE.Group();gangsterPepeMount.position.set(0,.16,0);scene.add(gangsterPepeMount);
const gangsterPepeLight=new THREE.PointLight(0xb9f5ff,3,3.5,2);gangsterPepeLight.position.set(0,.82,.55);scene.add(gangsterPepeLight);
const PLAYSTATION_WALL_X=-14,N64_WALL_X=14,PARTITION_WALL_HALF_THICKNESS=.18,PLAYABLE_ROOM_DOOR_Z=-8,CONSTRUCTION_ROOM_DOOR_Z=8,PS2_ROOM_CENTER_X=-22.5,PS2_ROOM_CENTER_Z=-25.2,PS2_ROOM_DOOR_Z=-16.8,PS2_ROOM_BACK_Z=-33.6,ROOM_DOOR_HALF_WIDTH=1.6,SOCIAL_COUCH_OUTER_RADIUS=6.75,SOCIAL_COUCH_INNER_RADIUS=4.2,SOCIAL_COUCH_GAP_HALF_ANGLE=.34,SOCIAL_DISPLAY_RADIUS=2.07,PLAYER_COLLISION_RADIUS=.34;
function buildPartitionWall(wallX,accent){
  for(const [centerZ,depth] of [[-13.25,7.1],[-.0,12.8],[13.25,7.1]]){
    const wall=box(PARTITION_WALL_HALF_THICKNESS*2,5,depth,0x111425,wallX,2.5,centerZ,.08);wall.receiveShadow=true;
    box(.42,.08,depth,accent,wallX,4.86,centerZ,.9);box(.42,.1,depth,0x251447,wallX,.08,centerZ,.45);
  }
}
buildPartitionWall(PLAYSTATION_WALL_X,0xd18a52);
const playstationWallTexture=new THREE.TextureLoader().load('assets/art/playstation-wall.webp?v=webp-2');
playstationWallTexture.colorSpace=THREE.SRGBColorSpace;
playstationWallTexture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
const playstationWall=new THREE.Mesh(new THREE.PlaneGeometry(12.4,4.7),new THREE.MeshBasicMaterial({map:playstationWallTexture}));playstationWall.position.set(-22.5,2.5,-.16);playstationWall.rotation.y=Math.PI;scene.add(playstationWall);
buildPartitionWall(N64_WALL_X,0x36f9f6);
const n64WallTexture=new THREE.TextureLoader().load('assets/art/nintendo64-wall.webp?v=webp-2');
n64WallTexture.colorSpace=THREE.SRGBColorSpace;
n64WallTexture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
const n64WallGraphic=new THREE.Mesh(new THREE.PlaneGeometry(6.34,4.7),new THREE.MeshBasicMaterial({map:n64WallTexture}));
n64WallGraphic.position.set(22.5,2.5,-.16);n64WallGraphic.rotation.y=Math.PI;scene.add(n64WallGraphic);
// The old front-left PS2 bay is now a clean future expansion. Xbox remains
// behind its original barrier while PS2 gets a dedicated room beyond the
// PlayStation gallery below.
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
const futureConstructionBarrier=new THREE.Group();futureConstructionBarrier.position.set(PLAYSTATION_WALL_X,0,CONSTRUCTION_ROOM_DOOR_Z);futureConstructionBarrier.userData.roomName='Future Console';
const futureConstructionPanel=new THREE.Mesh(new THREE.PlaneGeometry(3.1,2.65),new THREE.MeshBasicMaterial({map:constructionTexture,side:THREE.FrontSide}));futureConstructionPanel.position.set(.205,1.48,0);futureConstructionPanel.rotation.y=Math.PI/2;futureConstructionBarrier.add(futureConstructionPanel);
for(const edgeZ of [-1.56,1.56]){const post=new THREE.Mesh(new THREE.BoxGeometry(.22,3.05,.18),new THREE.MeshStandardMaterial({color:0x161616,emissive:0x4b3600,emissiveIntensity:.35,metalness:.78,roughness:.28}));post.position.set(.18,1.52,edgeZ);futureConstructionBarrier.add(post);const beacon=new THREE.PointLight(0xffb000,1.7,2.8,2);beacon.position.set(.38,2.9,edgeZ);beacon.userData.accentLight=true;futureConstructionBarrier.add(beacon);managedSceneLights.push(beacon)}scene.add(futureConstructionBarrier);constructionBarriers.push(futureConstructionBarrier);
const xboxConstructionBarrier=new THREE.Group();xboxConstructionBarrier.position.set(N64_WALL_X,0,CONSTRUCTION_ROOM_DOOR_Z);xboxConstructionBarrier.userData.roomName='Xbox';
const xboxConstructionPanel=new THREE.Mesh(new THREE.PlaneGeometry(3.1,2.65),new THREE.MeshBasicMaterial({map:constructionTexture,side:THREE.FrontSide}));xboxConstructionPanel.position.set(-.205,1.48,0);xboxConstructionPanel.rotation.y=-Math.PI/2;xboxConstructionBarrier.add(xboxConstructionPanel);
for(const edgeZ of [-1.56,1.56]){const post=new THREE.Mesh(new THREE.BoxGeometry(.22,3.05,.18),new THREE.MeshStandardMaterial({color:0x161616,emissive:0x4b3600,emissiveIntensity:.35,metalness:.78,roughness:.28}));post.position.set(-.18,1.52,edgeZ);xboxConstructionBarrier.add(post);const beacon=new THREE.PointLight(0xffb000,1.7,2.8,2);beacon.position.set(-.38,2.9,edgeZ);beacon.userData.accentLight=true;xboxConstructionBarrier.add(beacon);managedSceneLights.push(beacon)}scene.add(xboxConstructionBarrier);constructionBarriers.push(xboxConstructionBarrier);
// The experimental GameCube runtime is isolated behind a matching barrier.
// Its room remains visible for atmosphere, while the existing z=16 movement
// boundary prevents local and multiplayer players from entering it.
const gamecubeConstructionBarrier=new THREE.Group();gamecubeConstructionBarrier.position.set(0,0,16.55);gamecubeConstructionBarrier.userData.roomName='GameCube';
const gamecubeConstructionPanel=new THREE.Mesh(new THREE.PlaneGeometry(3.1,2.65),new THREE.MeshBasicMaterial({map:constructionTexture,side:THREE.FrontSide}));gamecubeConstructionPanel.position.set(0,1.48,-.205);gamecubeConstructionPanel.rotation.y=Math.PI;gamecubeConstructionBarrier.add(gamecubeConstructionPanel);
for(const edgeX of [-1.56,1.56]){const post=new THREE.Mesh(new THREE.BoxGeometry(.22,3.05,.18),new THREE.MeshStandardMaterial({color:0x161616,emissive:0x4b3600,emissiveIntensity:.35,metalness:.78,roughness:.28}));post.position.set(edgeX,1.52,-.18);gamecubeConstructionBarrier.add(post);const beacon=new THREE.PointLight(0xffb000,1.7,2.8,2);beacon.position.set(edgeX,2.9,-.38);beacon.userData.accentLight=true;gamecubeConstructionBarrier.add(beacon);managedSceneLights.push(beacon)}scene.add(gamecubeConstructionBarrier);constructionBarriers.push(gamecubeConstructionBarrier);
// Opaque wall lining for the expansion hallway. The original structural walls
// were so dark that they read as empty space; these inset panels make both
// sides visibly solid while keeping the openings around the partition ends.
const hallwayWallMaterial=new THREE.MeshStandardMaterial({color:0x17233a,emissive:0x071527,emissiveIntensity:.42,roughness:.62,metalness:.3});
const hallwaySeamMaterial=new THREE.MeshStandardMaterial({color:0x29466d,emissive:0x12345b,emissiveIntensity:.9,roughness:.38,metalness:.55});
for(const wallX of [-30.81,30.81]){
  for(let z=-11.9;z<=11.9;z+=3.4){
    // Keep the decorative hallway lining out of the real MegaMan doorway.
    // The structural wall already has the correct opening at z=-7; without
    // this exclusion, two inset panels visually seal that otherwise walkable
    // opening.
    if(wallX<0&&Math.abs(z-MEGAMAN_ROOM_DOOR_Z)<3.3)continue;
    const panel=new THREE.Mesh(new THREE.BoxGeometry(.08,4.68,3.24),hallwayWallMaterial);
    panel.position.set(wallX,2.42,z);panel.receiveShadow=true;scene.add(panel);
  }
  for(let z=-13.6;z<=13.6;z+=3.4){
    if(wallX<0&&Math.abs(z-MEGAMAN_ROOM_DOOR_Z)<ROOM_DOOR_HALF_WIDTH)continue;
    const seam=new THREE.Mesh(new THREE.BoxGeometry(.095,4.68,.035),hallwaySeamMaterial);
    seam.position.set(wallX,2.42,z);scene.add(seam);
  }
  const baseTrim=new THREE.Mesh(new THREE.BoxGeometry(.11,.13,27.35),new THREE.MeshStandardMaterial({color:0x182d4a,emissive:0x133b64,emissiveIntensity:1.05,metalness:.7,roughness:.22}));
  baseTrim.position.set(wallX,.12,0);scene.add(baseTrim);
  const topTrim=new THREE.Mesh(new THREE.BoxGeometry(.11,.08,27.35),new THREE.MeshStandardMaterial({color:0xd18a52,emissive:0xd18a52,emissiveIntensity:.8,metalness:.5,roughness:.2}));
  topTrim.position.set(wallX,4.77,0);scene.add(topTrim);
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
// The MegaMan Room sits directly behind the PlayStation cabinet wall. It is a
// full square with an intentionally blank shell so future wall graphics can be
// installed without removing placeholder signage or decorative panels.
const megaManFloor=new THREE.Mesh(new THREE.PlaneGeometry(MEGAMAN_ROOM_SIZE,MEGAMAN_ROOM_SIZE),expansionFloorMaterial);megaManFloor.rotation.x=-Math.PI/2;megaManFloor.position.set(MEGAMAN_ROOM_CENTER_X,.002,MEGAMAN_ROOM_CENTER_Z);megaManFloor.receiveShadow=true;scene.add(megaManFloor);
const megaManCeiling=box(MEGAMAN_ROOM_SIZE,.12,MEGAMAN_ROOM_SIZE,0x090b18,MEGAMAN_ROOM_CENTER_X,5.08,MEGAMAN_ROOM_CENTER_Z,.08);megaManCeiling.receiveShadow=true;
box(.3,5,MEGAMAN_ROOM_SIZE,0x11182c,-55,2.5,MEGAMAN_ROOM_CENTER_Z,.06);
box(MEGAMAN_ROOM_SIZE,5,.3,0x11182c,MEGAMAN_ROOM_CENTER_X,2.5,-19,.06);
box(MEGAMAN_ROOM_SIZE,5,.3,0x11182c,MEGAMAN_ROOM_CENTER_X,2.5,5,.06);
// Keep both supplied murals together on the fully solid front wall. The
// doorway-side partition is intentionally avoided so the artwork remains
// visible from anywhere inside the room and cannot be hidden by the opening.
box(8.3,4.72,.08,0x050711,-48.1,2.5,4.81,.12);
const megaManMuralTexture=new THREE.TextureLoader().load('assets/art/megaman-room-mural.webp?v=megaman-mural-1');
megaManMuralTexture.colorSpace=THREE.SRGBColorSpace;
megaManMuralTexture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
const megaManMural=new THREE.Mesh(new THREE.PlaneGeometry(8,4.42),new THREE.MeshBasicMaterial({map:megaManMuralTexture,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4}));
megaManMural.position.set(-48.1,2.5,4.68);megaManMural.rotation.y=Math.PI;megaManMural.renderOrder=4;scene.add(megaManMural);
box(9.4,4.72,.08,0x050711,-37.7,2.5,4.81,.12);
const megaManMuralTwoTexture=new THREE.TextureLoader().load('assets/art/megaman-room-mural-2.webp?v=megaman-mural-2');
megaManMuralTwoTexture.colorSpace=THREE.SRGBColorSpace;
megaManMuralTwoTexture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
const megaManMuralTwo=new THREE.Mesh(new THREE.PlaneGeometry(9.1,4.43),new THREE.MeshBasicMaterial({map:megaManMuralTwoTexture,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4}));
megaManMuralTwo.position.set(-37.7,2.5,4.68);megaManMuralTwo.rotation.y=Math.PI;megaManMuralTwo.renderOrder=4;scene.add(megaManMuralTwo);
// The third supplied mural goes on the rear wall, which is solid across its
// whole width and faces anyone walking in through the east doorway.
box(7.7,4.5,.08,0x050711,MEGAMAN_ROOM_CENTER_X,2.4,-18.81,.12);
const megaManMuralThreeTexture=new THREE.TextureLoader().load('assets/art/megaman-room-mural-3.webp?v=megaman-mural-3');
megaManMuralThreeTexture.colorSpace=THREE.SRGBColorSpace;
megaManMuralThreeTexture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
const megaManMuralThree=new THREE.Mesh(new THREE.PlaneGeometry(7.41,4.3),new THREE.MeshBasicMaterial({map:megaManMuralThreeTexture,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4}));
megaManMuralThree.position.set(MEGAMAN_ROOM_CENTER_X,2.4,-18.68);megaManMuralThree.renderOrder=4;scene.add(megaManMuralThree);
for(let x=-53;x<=-33;x+=4)box(3.82,.055,.06,0xd18a52,x,4.66,-18.81,.75);
lightRoom(MEGAMAN_ROOM_CENTER_X,MEGAMAN_ROOM_CENTER_Z,MEGAMAN_ROOM_SIZE,MEGAMAN_ROOM_SIZE,0x4aa8ff);
// Each side annex is split into two near-square rooms. The rear pair contains
// the playable PlayStation and N64 galleries; the front pair remains available
// for future systems. PlayStation's rear wall has a centered doorway leading
// exclusively to the new PS2 room.
for(const roomX of [-22.5,22.5]){
  const expansionFloor=new THREE.Mesh(new THREE.PlaneGeometry(17,34),expansionFloorMaterial);expansionFloor.rotation.x=-Math.PI/2;expansionFloor.position.set(roomX,.002,0);expansionFloor.receiveShadow=true;scene.add(expansionFloor);
  if(roomX===PS2_ROOM_CENTER_X){
    box(6.9,5,.3,0x11182c,-27.55,2.5,PS2_ROOM_DOOR_Z,.05);
    box(6.9,5,.3,0x11182c,-17.45,2.5,PS2_ROOM_DOOR_Z,.05);
  }else box(17,5,.3,0x11182c,roomX,2.5,-16.8,.05);
  box(17,5,.3,0x11182c,roomX,2.5,16.8,.05);
  const divider=box(17,5,.3,0x11182c,roomX,2.5,0,.05);divider.receiveShadow=true;
  for(let z=-12;z<=12;z+=4)box(16.5,.035,.055,0x4e7ea8,roomX,4.65,z,.8);
}
// PS2 is a separate square gallery directly behind PlayStation. Its only
// doorway is cut into the PlayStation room's rear wall, so it cannot be entered
// from the hub, N64 room, or the reserved front-left expansion bay.
const ps2Floor=new THREE.Mesh(new THREE.PlaneGeometry(17,16.8),expansionFloorMaterial);ps2Floor.rotation.x=-Math.PI/2;ps2Floor.position.set(PS2_ROOM_CENTER_X,.002,PS2_ROOM_CENTER_Z);ps2Floor.receiveShadow=true;scene.add(ps2Floor);
const ps2Ceiling=box(17,.12,16.8,0x090b18,PS2_ROOM_CENTER_X,5.08,PS2_ROOM_CENTER_Z,.08);ps2Ceiling.receiveShadow=true;
box(.3,5,16.8,0x11182c,-31,2.5,PS2_ROOM_CENTER_Z,.06);box(.3,5,16.8,0x11182c,PLAYSTATION_WALL_X,2.5,PS2_ROOM_CENTER_Z,.06);box(17,5,.3,0x11182c,PS2_ROOM_CENTER_X,2.5,PS2_ROOM_BACK_Z,.06);
for(let z=-31.2;z<=-19.2;z+=4)box(16.5,.035,.055,0xd18a52,PS2_ROOM_CENTER_X,4.65,z,.8);
const ps2ConstructionBarrier=new THREE.Group();ps2ConstructionBarrier.position.set(PS2_ROOM_CENTER_X,0,PS2_ROOM_DOOR_Z-.25);ps2ConstructionBarrier.userData.roomName='PS2';
const ps2ConstructionPanel=new THREE.Mesh(new THREE.PlaneGeometry(3.1,2.65),new THREE.MeshBasicMaterial({map:constructionTexture,side:THREE.FrontSide}));ps2ConstructionPanel.position.set(0,1.48,.205);ps2ConstructionBarrier.add(ps2ConstructionPanel);
for(const edgeX of [-1.56,1.56]){const post=new THREE.Mesh(new THREE.BoxGeometry(.18,3.05,.22),new THREE.MeshStandardMaterial({color:0x161616,emissive:0x4b3600,emissiveIntensity:.35,metalness:.78,roughness:.28}));post.position.set(edgeX,1.52,.18);ps2ConstructionBarrier.add(post);const beacon=new THREE.PointLight(0xffb000,1.7,2.8,2);beacon.position.set(edgeX,2.9,.38);beacon.userData.accentLight=true;ps2ConstructionBarrier.add(beacon);managedSceneLights.push(beacon)}scene.add(ps2ConstructionBarrier);constructionBarriers.push(ps2ConstructionBarrier);
// The GameCube room is a full square beyond the hub, with free wall runs for
// future additions and a centered construction doorway.
const gamecubeFloorMaterial=(()=>{const map=floorTextures.map.clone(),roughnessMap=floorTextures.roughnessMap.clone();map.needsUpdate=roughnessMap.needsUpdate=true;map.repeat.set(7,3.5);roughnessMap.repeat.set(7,3.5);return new THREE.MeshStandardMaterial({map,roughnessMap,color:0x8fa8d8,emissive:0x0b1324,emissiveIntensity:.38,roughness:.7,metalness:.12})})();
const gamecubeFloor=new THREE.Mesh(new THREE.PlaneGeometry(24,24),gamecubeFloorMaterial);gamecubeFloor.rotation.x=-Math.PI/2;gamecubeFloor.position.set(0,.002,28.8);gamecubeFloor.receiveShadow=true;scene.add(gamecubeFloor);
const gamecubeCeiling=box(24,.12,24,0x090b18,0,5.08,28.8,.08);gamecubeCeiling.receiveShadow=true;
box(.3,5,24,0x11182c,-12,2.5,28.8,.06);box(.3,5,24,0x11182c,12,2.5,28.8,.06);box(24,5,.3,0x11182c,0,2.5,40.8,.06);
box(10.3,5,.3,0x11182c,-6.85,2.5,16.8,.06);box(10.3,5,.3,0x11182c,6.85,2.5,16.8,.06);
for(let x=-10;x<=10;x+=4)box(3.82,.055,.06,0x4e7ea8,x,4.66,40.61,.75);
lightRoom(0,28.8,24,24,0xffb066);
lightRoom(PS2_ROOM_CENTER_X,PS2_ROOM_CENTER_Z,17,16.8,0xff5fae);
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
  scene.add(g);cabinets.push({id,g,name,type:id.toUpperCase(),screen,hue,statusLight,controlSlot,controllerSystem:system,renderLights:[floorGlow,glow],status:'syncing',occupiedByDisplayName:null,enabled:true});
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
function configureHostedCabinet(cabinetId){const game=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);if(!game)return;const hostedDiscs=game.discs?.map(disc=>({...disc,url:gameAssetUrl(disc.file)}));Object.assign(cabinets[cabinets.length-1],{artSlug:game.id,system:game.system,gameName:game.name,gameId:game.emulatorId,gameRegistryId:game.id,gameFileName:game.file,gameSizeBytes:game.sizeBytes,hostedGame:gameAssetUrl(game.file),hostedDiscs})}
// The playable galleries wrap their seven cabinets around the exterior and
// rear walls. The open interior and unused wall spans are reserved for growth.
makeCabinet('silent-hill','SILENT HILL',-29.2,-13,0xc94c4c,false,false,'psx');cabinets[cabinets.length-1].g.rotation.y=Math.PI/2;configureHostedCabinet('silent-hill');
makeCabinet('pixel-rally',"TONY HAWK'S PRO SKATER 2",-29.2,-10,0x36f9f6,false,false,'psx');cabinets[cabinets.length-1].g.rotation.y=Math.PI/2;configureHostedCabinet('pixel-rally');
makeCabinet('gex-enter-the-gecko','GEX: ENTER THE GECKO',-29.2,-4,0x8de548,false,true,'psx');cabinets[cabinets.length-1].g.rotation.y=Math.PI/2;configureHostedCabinet('gex-enter-the-gecko');
makeCabinet('crash-bandicoot','CRASH BANDICOOT',-29.2,-1,0xffa62e,true,false,'psx');cabinets[cabinets.length-1].g.rotation.y=Math.PI/2;configureHostedCabinet('crash-bandicoot');
makeCabinet('dungeon-88','SPYRO - YEAR OF THE DRAGON',-24.5,-15.2,0x934dff,false,false,'psx');configureHostedCabinet('dungeon-88');
makeCabinet('turbo-grid','TWISTED METAL WORLD TOUR',-20.5,-15.2,0xff3cac,false,false,'psx');configureHostedCabinet('turbo-grid');
makeCabinet('metal-gear-solid','METAL GEAR SOLID',-16.5,-15.2,0x5d75d9,false,false,'psx');configureHostedCabinet('metal-gear-solid');
const megaManCabinetLayout=[
  [1,-53.2,-16,Math.PI/2,0x42a5ff],[2,-53.2,-11,Math.PI/2,0xff3cac],[3,-53.2,-6,Math.PI/2,0x36f9f6],[4,-53.2,-1,Math.PI/2,0xffb42e],[5,-53.2,4,Math.PI/2,0x7dff67],
  [6,-49,-17.2,0,0x934dff],[7,-45,-17.2,0,0x36f9f6],[8,-41,-17.2,0,0xff4da6],[9,-37,-17.2,0,0xffb42e],[10,-33,-17.2,0,0x5d75d9]
];
for(const [index,x,z,rotation,hue] of megaManCabinetLayout){
  const cabinetId=`megaman-cabinet-${String(index).padStart(2,'0')}`;
  const hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId),system=hosted?.system||'psx';
  makeCabinet(cabinetId,hosted?hosted.name.toUpperCase():`PLAYSTATION // READY ${String(index).padStart(2,'0')}`,x,z,hue,false,false,system);
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system,gameName:hosted?.name||`PlayStation Cabinet ${index}`,enabled:true,status:'available'});configureHostedCabinet(cabinetId);
}
const n64CabinetLayout=[[1,29.2,-13,-Math.PI/2,0x8b5cf6],[2,29.2,-9,-Math.PI/2,0xff4da6],[3,29.2,-5,-Math.PI/2,0x36f9f6],[4,29.2,-1,-Math.PI/2,0xffb42e],[5,16.5,-15.2,0,0x7dff67],[6,20.5,-15.2,0,0xff3cac],[7,24.5,-15.2,0,0x42a5ff]];
for(const [index,x,z,rotation,hue] of n64CabinetLayout){const cabinetId=`n64-cabinet-0${index}`,hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);makeCabinet(cabinetId,hosted?hosted.name.toUpperCase():`N64 // READY 0${index}`,x,z,hue,false,false,'n64');const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;configureHostedCabinet(cabinetId)}
// Five experimental GameCube cabinets sit inside their dedicated construction
// room, facing its doorway. Gecko remains available for later runtime work, but
// the cabinets cannot be reached while the room is blocked.
const gamecubeTitles=['THE LEGEND OF ZELDA: THE WIND WAKER','THE LEGEND OF ZELDA: TWILIGHT PRINCESS','PIKMIN','SUPER SMASH BROS. MELEE','SUPER MARIO SUNSHINE'];
const gamecubeCabinetLayout=[[1,-10.2,23,Math.PI/2,0x8b5cf6],[2,-10.2,31,Math.PI/2,0x36f9f6],[3,10.2,23,-Math.PI/2,0xff4da6],[4,10.2,31,-Math.PI/2,0x7dff67],[5,0,39.2,Math.PI,0xffb42e]];
for(const [index,x,z,rotation,hue] of gamecubeCabinetLayout){
  const cabinetId=`gamecube-cabinet-0${index}`;
  makeCabinet(cabinetId,gamecubeTitles[index-1],x,z,hue,false,false,'gamecube');
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system:'gamecube',emulator:'gecko',gameName:gamecubeTitles[index-1],enabled:!isMobileDevice,status:isMobileDevice?'disabled':'available',disabledReason:isMobileDevice?'desktop-only':undefined});configureHostedCabinet(cabinetId);
}
const expansionCabinetColors=[0xff3cac,0x36f9f6,0xffb42e,0x934dff,0x7dff67];
const ps2RoomTitles=['GOD OF WAR','KINGDOM HEARTS','GRAND THEFT AUTO: SAN ANDREAS','DBZ TENKAICHI 3','PS2 // READY 05'];
const ps2CabinetLayout=[[1,-29.2,-30,Math.PI/2],[2,-29.2,-25,Math.PI/2],[3,-29.2,-20,Math.PI/2],[4,-24.5,-32,0],[5,-18.5,-32,0]];
for(const [index,x,z,rotation] of ps2CabinetLayout){
  const cabinetId=`psx-back-cabinet-0${index}`,hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);
  makeCabinet(cabinetId,ps2RoomTitles[index-1],x,z,expansionCabinetColors[index-1],false,false,'ps2');
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system:'ps2',gameName:hosted?.name||ps2RoomTitles[index-1],gameId:hosted?.emulatorId||26000+index,enabled:Boolean(hosted),status:hosted?'available':'disabled'});configureHostedCabinet(cabinetId);
}
const xboxCabinetLayout=[[1,29.2,3,-Math.PI/2],[2,29.2,8,-Math.PI/2],[3,29.2,13,-Math.PI/2],[4,17,15.2,Math.PI],[5,23,15.2,Math.PI]];
for(const [index,x,z,rotation] of xboxCabinetLayout){
  const cabinetId=`xbox-cabinet-0${index}`;
  makeCabinet(cabinetId,`XBOX // READY 0${index}`,x,z,expansionCabinetColors[5-index],false,false,'xbox');
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=rotation;Object.assign(cabinet,{system:'xbox',gameName:`Xbox Cabinet ${index}`,enabled:false,status:'disabled'});
}
// Circular prize counter in the middle of the arcade.
const prizeCounter=new THREE.Group();prizeCounter.position.set(0,0,0);scene.add(prizeCounter);
const counterGlassMat=new THREE.MeshStandardMaterial({color:0x79dfff,emissive:0x123b66,emissiveIntensity:.34,transparent:true,opacity:.17,metalness:.45,roughness:.08,side:THREE.DoubleSide,depthWrite:false});
const counterBase=new THREE.Mesh(new THREE.CylinderGeometry(1.55,1.7,1.1,48),counterGlassMat);counterBase.position.y=.55;prizeCounter.add(counterBase);
const counterGlow=new THREE.Mesh(new THREE.CylinderGeometry(1.62,1.62,.08,48),new THREE.MeshStandardMaterial({color:0x36f9f6,emissive:0x36f9f6,emissiveIntensity:2.1,metalness:.5}));counterGlow.position.y=.12;prizeCounter.add(counterGlow);
const counterTop=new THREE.Mesh(new THREE.CylinderGeometry(1.7,1.7,.09,48),new THREE.MeshStandardMaterial({color:0xb8f3ff,emissive:0x1c4e6a,emissiveIntensity:.34,transparent:true,opacity:.32,metalness:.65,roughness:.07,side:THREE.DoubleSide,depthWrite:false}));counterTop.position.y=1.15;prizeCounter.add(counterTop);
const counterTopRim=new THREE.Mesh(new THREE.CylinderGeometry(1.73,1.73,.12,48,1,true),new THREE.MeshStandardMaterial({color:0x1a2d3a,emissive:0x0d1c28,emissiveIntensity:.45,metalness:.9,roughness:.12}));counterTopRim.position.y=1.15;prizeCounter.add(counterTopRim);
const counterDisplayLight=new THREE.PointLight(0xe8f9ff,5.4,4.2,2);counterDisplayLight.position.set(0,.82,0);prizeCounter.add(counterDisplayLight);
// A padded circular couch makes the centre a compact social lounge while
// preserving a clear view into Trench Pepe's glass display. Its outer radius
// is mirrored by authoritative collision below and on both multiplayer paths.
const socialCouch=new THREE.Group();socialCouch.position.set(0,0,0);scene.add(socialCouch);
const couchMaterial=new THREE.MeshStandardMaterial({color:0x33143f,emissive:0x2a0f45,emissiveIntensity:.5,roughness:.22,metalness:.62});
const couchBackMaterial=new THREE.MeshStandardMaterial({color:0x4a1c63,emissive:0x3a1156,emissiveIntensity:.6,roughness:.18,metalness:.58});
const couchToeMaterial=new THREE.MeshStandardMaterial({color:0x36f9f6,emissive:0x36f9f6,emissiveIntensity:1.35,roughness:.3,metalness:.55});
function couchSectionShape(start,end){const shape=new THREE.Shape();shape.absarc(0,0,6.32,start,end,false);shape.lineTo(4.65*Math.cos(end),4.65*Math.sin(end));shape.absarc(0,0,4.65,end,start,true);shape.closePath();return shape}
for(const [start,end] of [[SOCIAL_COUCH_GAP_HALF_ANGLE,Math.PI-SOCIAL_COUCH_GAP_HALF_ANGLE],[Math.PI+SOCIAL_COUCH_GAP_HALF_ANGLE,Math.PI*2-SOCIAL_COUCH_GAP_HALF_ANGLE]]){
  const seatGeometry=new THREE.ExtrudeGeometry(couchSectionShape(start,end),{depth:.42,steps:1,bevelEnabled:true,bevelThickness:.08,bevelSize:.08,bevelSegments:2,curveSegments:36});seatGeometry.rotateX(Math.PI/2);seatGeometry.translate(0,.62,0);
  const seat=new THREE.Mesh(seatGeometry,couchMaterial);seat.receiveShadow=true;socialCouch.add(seat);
  const backGeometry=new THREE.TorusGeometry(5.92,.34,12,64,end-start);backGeometry.rotateZ(start);const back=new THREE.Mesh(backGeometry,couchBackMaterial);back.rotation.x=Math.PI/2;back.position.y=.96;socialCouch.add(back);
  const toeGeometry=new THREE.TorusGeometry(5.62,.12,10,64,end-start);toeGeometry.rotateZ(start);const toeGlow=new THREE.Mesh(toeGeometry,couchToeMaterial);toeGlow.rotation.x=Math.PI/2;toeGlow.position.y=.16;socialCouch.add(toeGlow);
}
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
// Long unbroken wall slabs are what make the hall read as a box. Slim vertical
// fins with a lit inner edge give the walls a rhythm and catch the room colour
// without adding a single light.
const wallFinBody=new THREE.MeshStandardMaterial({color:0x141020,roughness:.34,metalness:.72});
const wallFinGeometry=roundedSlab(.16,4.5,.42,.07);
const finGlowGeometry=new THREE.BoxGeometry(.05,4.1,.03);
for(const [finX,direction,glowColor] of [[-13.72,1,0xd18a52],[13.72,-1,0x36f9f6]]){
  const glowMaterial=new THREE.MeshStandardMaterial({color:glowColor,emissive:glowColor,emissiveIntensity:1.15,roughness:.3,metalness:.4});
  for(let z=-15;z<=15;z+=3.75){
    if(Math.abs(z-PLAYABLE_ROOM_DOOR_Z)<2.4||Math.abs(z-CONSTRUCTION_ROOM_DOOR_Z)<2.4)continue;
    const fin=new THREE.Mesh(wallFinGeometry,wallFinBody);
    fin.position.set(finX+direction*.2,2.32,z);fin.rotation.y=Math.PI/2;scene.add(fin);
    const glow=new THREE.Mesh(finGlowGeometry,glowMaterial);
    glow.position.set(finX+direction*.42,2.32,z);scene.add(glow);
  }
}
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
beforeRenderCallbacks.push((now,delta)=>{
  if(playerPosition.x*playerPosition.x+playerPosition.z*playerPosition.z>900)return;
  for(const {ring,speed} of haloRings)ring.rotation.z+=speed*delta;
});
// Low, oversized glass prize display set flush against the true back wall.
const prizeDisplay=new THREE.Group();prizeDisplay.position.set(0,0,-15.65);scene.add(prizeDisplay);
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
let prizeModelsStarted=false,centerModelStarted=false,nextHeavyAssetCheck=0;
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
  }if(!prizeModelsStarted&&playerPosition.distanceToSquared(prizeDisplay.position)<144){prizeModelsStarted=true;installPepeModel();installPudgyModel();installFurthermoreModel();installEnterpriseModel();installKurackModel();}if(!centerModelStarted&&playerPosition.x*playerPosition.x+playerPosition.z*playerPosition.z<16){centerModelStarted=true;installGangsterPepe();}}
let nextLightCull=0;
// The barrier beacons are children of their barrier group, so light.position is
// a local offset near the origin rather than the corner the beacon actually
// occupies. Rank on the world position instead.
function managedLightPosition(light){
  if(!light.userData.worldPosition){light.updateWorldMatrix(true,false);light.userData.worldPosition=light.getWorldPosition(new THREE.Vector3())}
  return light.userData.worldPosition;
}
function updateNearbyLights(now){if(now<nextLightCull)return;nextLightCull=now+250;const cabinetDistances=cabinets.map(cabinet=>({cabinet,distanceSq:cabinet.g.position.distanceToSquared(playerPosition)})).sort((a,b)=>a.distanceSq-b.distanceSq);let litCabinets=0;for(const {cabinet,distanceSq} of cabinetDistances){cabinet.g.visible=distanceSq<324;const lightsVisible=cabinet.g.visible&&distanceSq<64&&litCabinets<2;if(lightsVisible)litCabinets++;cabinet.renderLights.forEach(light=>{light.visible=lightsVisible});}const roomLights=[],accentLights=[];for(const light of managedSceneLights){const position=managedLightPosition(light),dx=position.x-playerPosition.x,dz=position.z-playerPosition.z;(light.userData.accentLight?accentLights:roomLights).push({light,distanceSq:dx*dx+dz*dz})}
// Accent beacons only reach 2.8 units, so they are ranked against their own
// radius. Sharing one budget with the room lights let them win both slots from
// across the room and leave the floor unlit.
roomLights.sort((a,b)=>a.distanceSq-b.distanceSq).forEach(({light,distanceSq},index)=>{light.visible=index<2&&distanceSq<144});
accentLights.sort((a,b)=>a.distanceSq-b.distanceSq).forEach(({light,distanceSq},index)=>{light.visible=index<2&&distanceSq<16});const centerDistanceSq=playerPosition.x*playerPosition.x+playerPosition.z*playerPosition.z;gangsterPepeLight.visible=centerDistanceSq<25;counterDisplayLight.visible=centerDistanceSq<49;const prizeVisible=playerPosition.distanceToSquared(prizeDisplay.position)<144;prizeDisplayLights.forEach(light=>{light.visible=prizeVisible});}
const prizeSignCanvas=document.createElement('canvas');prizeSignCanvas.width=1024;prizeSignCanvas.height=192;const psc=prizeSignCanvas.getContext('2d');const prizeLedTexture=new THREE.CanvasTexture(prizeSignCanvas);
function drawPrizeLed(time=0){psc.fillStyle='#05060b';psc.fillRect(0,0,1024,192);for(let x=8;x<1024;x+=16){for(let y=8;y<192;y+=16){psc.fillStyle=(x+y)%32?'#101527':'#1c2540';psc.fillRect(x,y,3,3)}}psc.font='bold 88px monospace';psc.textBaseline='middle';psc.shadowColor='#ff3cac';psc.shadowBlur=20;psc.fillStyle='#fff4cc';const text='  ✦  PRIZE COUNTER  ✦  ';const width=psc.measureText(text).width;const offset=(time*.14)%(width+1024);psc.fillText(text,1024-offset,98);psc.fillText(text,1024-offset+width+160,98);psc.shadowBlur=0;prizeLedTexture.needsUpdate=true;}
drawPrizeLed();
const jumbotron=new THREE.Group();jumbotron.position.set(0,3.46875,.04);prizeDisplay.add(jumbotron);const signBody=new THREE.Mesh(new THREE.BoxGeometry(3.25,.78,.86),new THREE.MeshStandardMaterial({color:0x090b16,metalness:.85,roughness:.16}));jumbotron.add(signBody);
for(const [z,rotation] of [[.436,0],[-.436,Math.PI]]){const face=new THREE.Mesh(new THREE.PlaneGeometry(3.05,.58),new THREE.MeshBasicMaterial({map:prizeLedTexture}));face.position.z=z;face.rotation.y=rotation;jumbotron.add(face);}
point(0x36f9f6,-2.6,2.3,0,2);point(0xff3cac,2.6,2.3,0,2);
const start=document.querySelector('#start-screen'), prompt=document.querySelector('#prompt'), modal=document.querySelector('#machine-modal'), hudStatus=document.querySelector('.status');
const mobileMoveZone=document.querySelector('#mobile-move-zone'),mobileMoveThumb=document.querySelector('#mobile-move-thumb'),mobileLookZone=document.querySelector('#mobile-look-zone');
function updateViewStatus(){if(hudStatus)hudStatus.textContent=mobileInputAvailable()?`LEFT STICK · MOVE   /   DRAG · LOOK   /   VIEW · ${cameraMode==='first-person'?'1ST':'3RD'} PERSON`:`WASD · MOVE   /   MOUSE · LOOK   /   V · ${cameraMode==='first-person'?'1ST':'3RD'} PERSON`}
function toggleCameraMode(){
  if(activeCabinet||start.style.display!=='none')return;
  cameraMode=cameraMode==='first-person'?'third-person':'first-person';
  updateViewStatus();
  window.dispatchEvent(new CustomEvent('arcade:camera-mode-changed',{detail:{mode:cameraMode}}));
}
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
document.addEventListener('mousemove',e=>{if(!locked)return;yaw-=e.movementX*.0025;pitch=Math.max(-.42,Math.min(.58,pitch-e.movementY*.0025))});
addEventListener('keydown',e=>{keys[e.code]=true;if(e.code==='KeyV'&&!e.repeat)toggleCameraMode();if(e.code==='KeyE'&&near&&(locked||mobileInputAvailable())&&!e.repeat){if(near.disabledReason==='desktop-only'){showCabinetMessage('DESKTOP ONLY — ABOUT 1 GB PER GAME')}else{window.dispatchEvent(new CustomEvent('arcade:cabinet-interact',{detail:{cabinetId:near.id}}))}};if(e.code==='Escape'&&activeCabinet)closeMachine();else if(e.code==='Escape'&&socialFollowProvider)socialFollowProvider=null});addEventListener('keyup',e=>keys[e.code]=false);
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
function openMachine(c){
  activeCabinet=c;
  document.body.classList.add('cabinet-open');resetMobileMove();
  const romInput=document.querySelector('#rom-file');romInput.value='';romLoaded=false;
  document.querySelector('#machine-type').textContent=c.system==='psx'?'PLAYSTATION // CABINET':(c.system==='n64'?'NINTENDO 64 // CABINET':(c.system==='snes'?'SUPER NINTENDO // CABINET':(c.system==='ps2'?'PLAYSTATION 2 // EXPERIMENTAL CABINET':(c.system==='gamecube'?'GAMECUBE // EXPERIMENTAL GECKO':c.type))));
  document.querySelector('#machine-name').textContent=c.name;
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
  if(c.system==='gamecube') document.querySelector('#rom-name').textContent=c.disabledReason==='desktop-only'
    ?'GAMECUBE GAMES ARE DESKTOP ONLY — ABOUT 1 GB EACH'
    :(c.hostedGame?'EXPERIMENTAL GAMECUBE IMAGE READY — PRESS PLAY':'GECKO READY — LOAD A LOCAL .RVZ, .ISO, OR .GCM IMAGE');
  document.querySelector('.legal').textContent=c.system==='n64'?'Nintendo 64 games run locally through EmulatorJS using its Mupen64Plus Next browser core. No ROM data is uploaded.':(c.system==='snes'?'Super Nintendo games run locally through EmulatorJS in your browser. No ROM data is uploaded.':(c.system==='ps2'?'Experimental Play! WebAssembly PS2 emulation runs locally in your browser. Compatibility and performance vary; no game data is uploaded.':(c.system==='gamecube'?'Experimental Gecko WebGPU emulation runs locally in your browser. Large GameCube images require substantial memory; no game data is sent through multiplayer.':'Use game images and BIOS files legally dumped from hardware you own. PlayStation emulation runs locally in your browser; no ROM data is uploaded.')));
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
  try {
    if(typeof window.EJS_terminate==='function') window.EJS_terminate();
    else if(typeof window.EJS_emulator?.exit==='function') window.EJS_emulator.exit();
  } catch(error) { console.warn('Could not terminate the emulator cleanly.', error); }
  document.querySelector('#emulator-host').replaceChildren();
  document.querySelector('#emulator-stage').style.display='none';
  document.querySelector('.screen-wrap .scanlines').style.display='block';
  cvs.style.display='block';
  activeEmulatorFrame=null;pendingPs2Source=null;pendingGameCubeSource=null;
  emulatorObjectUrls.forEach(url=>URL.revokeObjectURL(url));emulatorObjectUrls=[];
  setEmulatorRuntimeActive(false);
}
function closeMachine(notifyServer=true){const closing=activeCabinet;ps2CacheController?.abort();ps2CacheController=null;if(['psx','n64','snes','ps2','gamecube'].includes(closing?.system))stopEmulator();modal.style.display='none';modal.setAttribute('aria-hidden','true');activeCabinet=null;document.body.classList.remove('cabinet-open');if(notifyServer&&closing)window.dispatchEvent(new CustomEvent('arcade:cabinet-session-ended',{detail:{cabinetId:closing.id}}));if(!mobileInputAvailable())renderer.domElement.requestPointerLock()}
document.querySelector('.close').onclick=closeMachine;
const cvs=document.querySelector('#game-screen'),ctx=cvs.getContext('2d'); let romLoaded=false,ship={x:320,bullets:[]},stars=Array.from({length:80},()=>({x:Math.random()*640,y:Math.random()*440,s:1+Math.random()*2})),psxBios=null;
const hostedPsxBios=biosAssetUrl;
function drawAttract(c){ctx.fillStyle='#03050c';ctx.fillRect(0,0,640,440);ctx.fillStyle='#36f9f6';ctx.font='30px monospace';ctx.textAlign='center';ctx.fillText(c.name,320,100);ctx.fillStyle='#ff3cac';ctx.font='15px monospace';ctx.fillText('INSERT ROM TO INITIALIZE',320,150);ctx.fillStyle='#a99abe';ctx.font='12px monospace';ctx.fillText('Your game appears here',320,330)}
document.querySelector('#rom-file').addEventListener('change',e=>{const f=e.target.files[0];if(!f||!activeCabinet)return;document.querySelector('#rom-name').textContent=`LOADED: ${f.name.toUpperCase()} · ${Math.ceil(f.size/1024)} KB`;romLoaded=true;ship={x:320,bullets:[]};});
let emulatorObjectUrls=[],emulatorLoadTimer,activeEmulatorFrame=null,pendingPs2Source=null,pendingGameCubeSource=null;
const ps2Cache=window.ARCADE_PS2_CACHE,ps2CacheButton=document.querySelector('#cache-hosted-game');
let ps2CacheController=null;
const warmedEmulatorSystems=new Set();
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
const emulatorWarmTargets={
  psx:[['https://cdn.emulatorjs.org/stable/data/loader.js','script'],[biosAssetUrl,'fetch']],
  n64:[['https://cdn.emulatorjs.org/stable/data/loader.js','script']],
  snes:[['https://cdn.emulatorjs.org/stable/data/loader.js','script']],
  gamecube:[['emulators/gecko/pkg/web_bg.wasm','fetch'],['emulators/gecko/pkg/web.js','script'],['emulators/gecko/main.js','script']],
  ps2:[['emulators/play/Play.wasm','fetch'],['emulators/play/Play.js','script'],['emulators/play/main.js','script']]
};
function warmEmulatorCore(system){
  if(!system||warmedEmulatorSystems.has(system))return;
  const targets=emulatorWarmTargets[system];if(!targets)return;
  warmedEmulatorSystems.add(system);
  for(const [href,as] of targets){const link=document.createElement('link');link.rel='prefetch';link.href=href;link.as=as;if(as==='fetch')link.crossOrigin='anonymous';document.head.appendChild(link)}
}
function formatDownloadSize(bytes){if(!Number.isFinite(bytes)||bytes<=0)return'HOSTED';const mb=bytes/1048576;return mb>=100?`${Math.round(mb)} MB`:`${mb.toFixed(1)} MB`}
function launchEmulator(gameFile,options={}){
  const host=document.querySelector('#emulator-host'),stage=document.querySelector('#emulator-stage');
  const downloadBytes=options.sizeBytes??(typeof gameFile==='string'?activeCabinet?.gameSizeBytes:gameFile?.size),loadingLabel=options.label||activeCabinet?.gameName||'ARCADE GAME';
  setEmulatorRuntimeActive(true);cvs.style.display='none';document.querySelector('.screen-wrap .scanlines').style.display='none';stage.style.display='grid';stage.style.placeItems='center';stage.style.color='#36f9f6';stage.style.fontFamily='monospace';stage.style.letterSpacing='.12em';host.textContent=`LOADING ${loadingLabel.toUpperCase()} · ${formatDownloadSize(downloadBytes)}...`;
  const isPs2=activeCabinet?.system==='ps2',isGameCube=activeCabinet?.system==='gamecube';
  const gameUrl=typeof gameFile==='string'?gameFile:(isPs2||isGameCube?'':URL.createObjectURL(gameFile));
  const core=isPs2?'ps2':(activeCabinet?.system==='n64'?'n64':(activeCabinet?.system==='snes'?'snes9x':'psx'));
  const biosUrl=core==='psx'?(psxBios?URL.createObjectURL(psxBios):hostedPsxBios):'';
  emulatorObjectUrls=[gameUrl,biosUrl].filter(url=>url.startsWith('blob:'));
  const gameName=activeCabinet?.gameName||'Arcade Game',gameId=activeCabinet?.gameId||1;
  const player=document.createElement('iframe');player.title=`${gameName} player`;player.allow='autoplay; fullscreen';player.src=isPs2?'emulators/play/index.html?v=ps2-visual-1':(isGameCube?'emulators/gecko/index.html?v=gecko-hosted-clean-1':`player.html?core=${encodeURIComponent(core)}&game=${encodeURIComponent(gameUrl)}&bios=${encodeURIComponent(biosUrl)}&name=${encodeURIComponent(gameName)}&id=${gameId}`);player.style.cssText='border:0;width:100%;height:100%;background:#02030a';player.onerror=()=>{showCabinetMessage('EMULATOR COULD NOT LOAD.');closeMachine()};activeEmulatorFrame=player;pendingPs2Source=isPs2?(gameFile instanceof File?{file:gameFile}:{url:gameUrl,name:decodeURIComponent(new URL(gameUrl,location.href).pathname.split('/').pop()||`${gameName}.iso`),size:downloadBytes}):null;pendingGameCubeSource=isGameCube?(gameFile instanceof File?{file:gameFile}:{url:gameUrl,name:decodeURIComponent(new URL(gameUrl,location.href).pathname.split('/').pop()||`${gameName}.rvz`),size:downloadBytes}):null;host.replaceChildren(player);
  const estimatedTimeout=Math.max(20000,Math.min(180000,20000+(Number(downloadBytes)||0)/524288*1000));
  clearTimeout(emulatorLoadTimer);emulatorLoadTimer=setTimeout(()=>{if(activeCabinet){closeMachine();showCabinetMessage('EMULATOR LOAD TIMED OUT. CHECK YOUR CONNECTION.')}},estimatedTimeout);
}
document.querySelector('#bios-file').addEventListener('change',e=>{const file=e.target.files[0];if(!file)return;psxBios=file;document.querySelector('#bios-name').textContent=`BIOS READY: ${file.name.toUpperCase()}`;});
function formatRate(bytesPerSecond){
  if(!Number.isFinite(bytesPerSecond)||bytesPerSecond<=0)return '';
  const mb=bytesPerSecond/1048576;
  return mb>=1?`${mb.toFixed(1)} MB/S`:`${Math.round(bytesPerSecond/1024)} KB/S`;
}
function formatEta(seconds){
  if(!Number.isFinite(seconds)||seconds<=0||seconds>36000)return '';
  if(seconds<60)return `${Math.ceil(seconds)}S LEFT`;
  const minutes=Math.floor(seconds/60);
  return `${minutes}M ${String(Math.floor(seconds%60)).padStart(2,'0')}S LEFT`;
}
// Route the first launch through the local cache instead of letting the
// emulator stream the file. It is the same single download, but it reports
// progress while it runs and every later launch of that game starts from disk
// rather than the network. A GameCube image averages a gigabyte, so the second
// play going from minutes to instant is the difference testers actually feel.
// Anything the cache cannot take falls straight back to the hosted URL.
async function prepareHostedGame(cabinet){
  if(!CACHEABLE_SYSTEMS.has(cabinet.system)||!ps2Cache?.supported||!cabinet.gameSizeBytes)return null;
  const descriptor=ps2GameDescriptor(cabinet);
  const romName=document.querySelector('#rom-name');
  try{
    const cached=await ps2Cache.get(descriptor);
    if(cached)return cached;
  }catch{return null}
  if(ps2CacheController)return null;
  const playButton=document.querySelector('#play-hosted-game');
  ps2CacheController=new AbortController();
  playButton.disabled=true;ps2CacheButton.disabled=true;
  const startedAt=performance.now();
  try{
    const file=await ps2Cache.download(descriptor,cabinet.hostedGame,{
      signal:ps2CacheController.signal,
      onProgress:(progress,received,total)=>{
        if(activeCabinet!==cabinet)return;
        const elapsed=(performance.now()-startedAt)/1000;
        const rate=elapsed>0.5?received/elapsed:0;
        const eta=rate>0?(total-received)/rate:0;
        const parts=[`DOWNLOADING ${Math.floor(progress*100)}%`,formatRate(rate),formatEta(eta)].filter(Boolean);
        romName.textContent=parts.join(' · ');
      }
    });
    return file;
  }catch(error){
    if(error?.name==='AbortError')return null;
    // Out of storage, or the cache write failed. Streaming still works.
    console.warn('Falling back to streaming this game.',error);
    if(activeCabinet===cabinet)romName.textContent='STREAMING FROM CDN — NOT CACHED';
    return null;
  }finally{
    ps2CacheController=null;
    playButton.disabled=false;
    refreshPs2CacheButton(cabinet);
  }
}
document.querySelector('#play-hosted-game').addEventListener('click',async()=>{
  if(!activeCabinet?.hostedGame)return;
  const cabinet=activeCabinet;
  const prepared=await prepareHostedGame(cabinet);
  if(activeCabinet!==cabinet)return;
  launchEmulator(prepared||cabinet.hostedGame);
});
ps2CacheButton.addEventListener('click',async()=>{const cabinet=activeCabinet;if(!CACHEABLE_SYSTEMS.has(cabinet?.system)||!cabinet.hostedGame||!ps2Cache?.supported||ps2CacheController)return;ps2CacheController=new AbortController();ps2CacheButton.disabled=true;try{await ps2Cache.download(ps2GameDescriptor(cabinet),cabinet.hostedGame,{signal:ps2CacheController.signal,onProgress:progress=>{if(activeCabinet===cabinet){const percent=Math.floor(progress*100);ps2CacheButton.textContent=`CACHING ${percent}%`;document.querySelector('#rom-name').textContent=`DOWNLOADING LOCAL COPY · ${percent}%`}}});if(activeCabinet===cabinet){ps2CacheButton.dataset.cached='true';ps2CacheButton.textContent='CACHED LOCALLY';document.querySelector('#rom-name').textContent='LOCAL COPY READY — FUTURE LAUNCHES WILL START FASTER'}}catch(error){if(error?.name!=='AbortError'&&activeCabinet===cabinet){ps2CacheButton.textContent='CACHE FAILED — RETRY';ps2CacheButton.disabled=false;document.querySelector('#rom-name').textContent=error.message.toUpperCase()}}finally{ps2CacheController=null}});
document.querySelector('#rom-file').addEventListener('change',e=>{const file=e.target.files[0];if(['psx','n64','snes','ps2','gamecube'].includes(activeCabinet?.system)&&file)launchEmulator(file);});
addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==activeEmulatorFrame?.contentWindow)return;if(event.data?.type==='arcade:emulator-ready'){if(event.data?.core==='ps2-play'&&pendingPs2Source){const message=pendingPs2Source.file?{type:'arcade:ps2-load-file',file:pendingPs2Source.file}:{type:'arcade:ps2-load-remote',url:pendingPs2Source.url,name:pendingPs2Source.name,size:pendingPs2Source.size};activeEmulatorFrame.contentWindow?.postMessage(message,location.origin)}else if(event.data?.core==='gamecube-gecko'&&pendingGameCubeSource){const message=pendingGameCubeSource.file?{type:'arcade:gamecube-load-file',file:pendingGameCubeSource.file,name:pendingGameCubeSource.file.name,dspUrl:gameCubeDspAssetUrl}:{type:'arcade:gamecube-load-remote',url:pendingGameCubeSource.url,name:pendingGameCubeSource.name,size:pendingGameCubeSource.size,dspUrl:gameCubeDspAssetUrl};activeEmulatorFrame.contentWindow?.postMessage(message,location.origin)}else clearTimeout(emulatorLoadTimer)}if(event.data?.type==='arcade:gamecube-source-loading')clearTimeout(emulatorLoadTimer);if(event.data?.type==='arcade:gamecube-load-progress'&&activeCabinet?.system==='gamecube'&&Number.isFinite(event.data.percent))document.querySelector('#rom-name').textContent=`DOWNLOADING GAME DATA · ${event.data.percent}%`;if(event.data?.type==='arcade:ps2-source-accepted'){pendingPs2Source=null;clearTimeout(emulatorLoadTimer)}if(event.data?.type==='arcade:gamecube-source-accepted'){pendingGameCubeSource=null;clearTimeout(emulatorLoadTimer)}if(event.data?.type==='arcade:ps2-disc-error'&&activeCabinet){clearTimeout(emulatorLoadTimer);closeMachine();showCabinetMessage('GAME STREAM INTERRUPTED. RETRY OR CACHE IT LOCALLY.');return}if(['arcade:emulator-error','arcade:emulator-closed'].includes(event.data?.type)&&activeCabinet){clearTimeout(emulatorLoadTimer);closeMachine();showCabinetMessage(event.data.type.endsWith('error')?'EMULATOR COULD NOT LOAD.':'EMULATOR SESSION CLOSED.')}});
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
function nearbyConstructionRoom(){if(playerPosition.z>13.2&&Math.abs(playerPosition.x)<2.5)return 'GameCube';if(Math.abs(playerPosition.z-PS2_ROOM_DOOR_Z)<2.35&&Math.abs(playerPosition.x-PS2_ROOM_CENTER_X)<3.2)return 'PS2';if(Math.abs(playerPosition.z-CONSTRUCTION_ROOM_DOOR_Z)>2.35)return null;if(Math.abs(playerPosition.x-PLAYSTATION_WALL_X)<3.2)return 'Future Console';if(Math.abs(playerPosition.x-N64_WALL_X)<3.2)return 'Xbox';return null}
function updateConstructionPrompt(roomName){prompt.classList.add('active');prompt.querySelector('b').textContent='CAUTION';prompt.querySelector('span').textContent=`${roomName} Room Under Construction.`}
function setCabinetState(state){const cabinet=cabinets.find(candidate=>candidate.id===state.cabinetId);if(!cabinet)return;if(!cabinet.enabled){cabinet.status='disabled';cabinet.occupiedByDisplayName=null;cabinet.statusLight.material.color.setHex(0x6c7896);cabinet.statusLight.material.emissive.setHex(0x26304a);return}cabinet.status=state.status;cabinet.occupiedByDisplayName=state.occupiedByDisplayName;const color=state.status==='available'?0x50ff9a:(state.status==='reserved'?0xffb42e:0xff3c76);cabinet.statusLight.material.color.setHex(color);cabinet.statusLight.material.emissive.setHex(color)}
function setCabinetStates(states,ready){cabinetSnapshotReady=ready;states.forEach(state=>setCabinetState(state));if(!ready)cabinets.forEach(c=>{c.status=c.enabled?'syncing':'disabled';c.occupiedByDisplayName=null;c.statusLight.material.color.setHex(0x6c7896);c.statusLight.material.emissive.setHex(c.enabled?0x6c7896:0x26304a)})}
function updateCabinetPrompt(){if(performance.now()<cabinetMessageUntil)return;if(!near){prompt.classList.remove('active');return}prompt.classList.add('active');const title=prompt.querySelector('b'),detail=prompt.querySelector('span');if(!near.enabled||near.status==='disabled'){if(near.disabledReason==='desktop-only'){title.textContent='GAMECUBE // DESKTOP ONLY';detail.textContent='ABOUT 1 GB PER GAME — OPEN ON A COMPUTER';return}
    if(near.system==='gamecube'){title.textContent='GAMECUBE // GECKO';detail.textContent='BOOT VALIDATION IN PROGRESS'}else if(near.system==='xbox'){title.textContent='XBOX DISPLAY';detail.textContent='AWAITING GAME SETUP'}else{title.textContent='PS2 DISPLAY';detail.textContent='BROWSER CORE REQUIRED'}return}if(!cabinetSnapshotReady){title.textContent='SYNCING';detail.textContent='CABINET STATUS';return}if(near.status==='available'){title.textContent=mobileInputAvailable()?'TAP USE':'PRESS E';detail.textContent='TO ENTER CABINET';return}title.textContent=near.status==='reserved'?'RESERVED':'IN USE';detail.textContent=near.occupiedByDisplayName?`BY ${near.occupiedByDisplayName}`:'PLEASE WAIT'}
function beginCabinetSession(cabinetId,alignment){const cabinet=cabinets.find(candidate=>candidate.id===cabinetId);if(!cabinet||activeCabinet)return false;if(alignment?.position){playerPosition.set(...alignment.position);yaw=alignment.rotationY}openMachine(cabinet);return true}
function forceCloseCabinetSession(cabinetId){if(activeCabinet?.id===cabinetId)closeMachine(false)}
function resolvePartitionWallCollisions(previousX,previousZ){
  for(const wallX of [PLAYSTATION_WALL_X,N64_WALL_X]){
    const minimumZ=wallX===PLAYSTATION_WALL_X?PS2_ROOM_BACK_Z:-16.8;
    if(playerPosition.z<minimumZ-PLAYER_COLLISION_RADIUS||playerPosition.z>16.8+PLAYER_COLLISION_RADIUS)continue;
    const crossedWall=(previousX-wallX)*(playerPosition.x-wallX)<=0&&previousX!==playerPosition.x;
    const crossing=(wallX-previousX)/(playerPosition.x-previousX);
    const crossingZ=crossedWall?previousZ+(playerPosition.z-previousZ)*crossing:playerPosition.z;
    const insidePlayableDoor=Math.abs(crossingZ-PLAYABLE_ROOM_DOOR_Z)<ROOM_DOOR_HALF_WIDTH-PLAYER_COLLISION_RADIUS;
    if(insidePlayableDoor)continue;
    const leftFace=wallX-PARTITION_WALL_HALF_THICKNESS-PLAYER_COLLISION_RADIUS;
    const rightFace=wallX+PARTITION_WALL_HALF_THICKNESS+PLAYER_COLLISION_RADIUS;
    if(previousX<wallX&&playerPosition.x>leftFace)playerPosition.x=leftFace;
    else if(previousX>=wallX&&playerPosition.x<rightFace)playerPosition.x=rightFace;
  }
}
function resolveMegaManRoomCollisions(previousX,previousZ){
  const wallX=MEGAMAN_ROOM_WALL_X;
  const crossedWall=(previousX-wallX)*(playerPosition.x-wallX)<=0&&previousX!==playerPosition.x;
  const crossing=(wallX-previousX)/(playerPosition.x-previousX);
  const crossingZ=crossedWall?previousZ+(playerPosition.z-previousZ)*crossing:playerPosition.z;
  const insideDoor=Math.abs(crossingZ-MEGAMAN_ROOM_DOOR_Z)<ROOM_DOOR_HALF_WIDTH-PLAYER_COLLISION_RADIUS;
  if(!insideDoor){
    const leftFace=wallX-PARTITION_WALL_HALF_THICKNESS-PLAYER_COLLISION_RADIUS,rightFace=wallX+PARTITION_WALL_HALF_THICKNESS+PLAYER_COLLISION_RADIUS;
    if(previousX<wallX&&playerPosition.x>leftFace)playerPosition.x=leftFace;
    else if(previousX>=wallX&&playerPosition.x<rightFace)playerPosition.x=rightFace;
  }
}
function resolveSocialLayoutCollisions(previousX,previousZ){
  if(Math.abs(playerPosition.x)>Math.abs(PLAYSTATION_WALL_X)+PLAYER_COLLISION_RADIUS&&playerPosition.x>-30.5){
    const rearFace=-PARTITION_WALL_HALF_THICKNESS-PLAYER_COLLISION_RADIUS,frontFace=PARTITION_WALL_HALF_THICKNESS+PLAYER_COLLISION_RADIUS;
    if(previousZ<0&&playerPosition.z>rearFace)playerPosition.z=rearFace;
    else if(previousZ>=0&&playerPosition.z<frontFace)playerPosition.z=frontFace;
  }
  const distance=Math.hypot(playerPosition.x,playerPosition.z);
  const previousDistance=Math.hypot(previousX,previousZ);
  if(distance<SOCIAL_DISPLAY_RADIUS){
    if(distance>.001){playerPosition.x*=SOCIAL_DISPLAY_RADIUS/distance;playerPosition.z*=SOCIAL_DISPLAY_RADIUS/distance}
    else if(previousDistance>.001){playerPosition.x=previousX;playerPosition.z=previousZ}
    else playerPosition.x=SOCIAL_DISPLAY_RADIUS;
    return;
  }
  const inSideGap=Math.abs(Math.sin(Math.atan2(playerPosition.z,playerPosition.x)))<=Math.sin(SOCIAL_COUCH_GAP_HALF_ANGLE);
  if(inSideGap||distance<SOCIAL_COUCH_INNER_RADIUS||distance>=SOCIAL_COUCH_OUTER_RADIUS)return;
  const boundary=previousDistance<=SOCIAL_COUCH_INNER_RADIUS?SOCIAL_COUCH_INNER_RADIUS:SOCIAL_COUCH_OUTER_RADIUS;
  playerPosition.x*=boundary/distance;playerPosition.z*=boundary/distance;
}
function resolveRearGalleryCollision(previousZ){
  if(playerPosition.x<-30.5||playerPosition.x>-14.5)return;
  const northFace=PS2_ROOM_DOOR_Z+PARTITION_WALL_HALF_THICKNESS+PLAYER_COLLISION_RADIUS;
  const southFace=PS2_ROOM_DOOR_Z-PARTITION_WALL_HALF_THICKNESS-PLAYER_COLLISION_RADIUS;
  if(previousZ>PS2_ROOM_DOOR_Z&&playerPosition.z<northFace)playerPosition.z=northFace;
  else if(previousZ<=PS2_ROOM_DOOR_Z&&playerPosition.z>southFace)playerPosition.z=southFace;
}
let lastPrizeLedDraw=0;
const performanceStats=document.querySelector('#performance-stats');
let performanceWindowStart=performance.now(),performanceFrames=0,slowWindows=0,fastWindows=0,latestPerformance={fps:0,frameMs:0,quality:'WARMING'};
const getRendererStats=()=>{const memory=performance.memory;return{...latestPerformance,renderScale:currentPixelRatio,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,heapUsedMb:memory?Number((memory.usedJSHeapSize/1048576).toFixed(1)):null,heapLimitMb:memory?Number((memory.jsHeapSizeLimit/1048576).toFixed(1)):null}};
window.arcadeMultiplayer={scene,getCamera:()=>camera,getCanvas:()=>renderer.domElement,getLocalTransform:()=>({position:{x:playerPosition.x,y:playerPosition.y,z:playerPosition.z},rotationY:yaw}),getLocalAnimationState:()=>localAnimationState,isEmulatorActive:()=>emulatorRuntimeActive,isFirstPerson:()=>cameraMode==='first-person',getCameraMode:()=>cameraMode,isFollowingPlayer:()=>Boolean(socialFollowProvider),followPlayer:provider=>{socialFollowProvider=provider},clearPlayerFollow:()=>{socialFollowProvider=null},applyAuthoritativeTransform:({position,rotationY},strength=.12)=>{correctionTarget.set(position.x,position.y,position.z);playerPosition.lerp(correctionTarget,strength);const difference=Math.atan2(Math.sin(rotationY-yaw),Math.cos(rotationY-yaw));yaw+=difference*strength;},performanceProfile:{lowPower:lowPowerDevice,getRenderScale:()=>currentPixelRatio,getStats:getRendererStats},setCabinetState,setCabinetStates,showCabinetMessage,beginCabinetSession,forceCloseCabinetSession,onBeforeRender:callback=>{beforeRenderCallbacks.push(callback)}};
function updatePerformanceStats(now){performanceFrames++;const elapsed=now-performanceWindowStart;if(elapsed<1000)return;const fps=Math.round(performanceFrames*1000/elapsed),frameMs=Math.round(elapsed/performanceFrames),quality=currentPixelRatio<=pixelRatioFloor+.01?'LOW':currentPixelRatio<.9?'MED':'HIGH';latestPerformance={fps,frameMs,quality};if(performanceStats)performanceStats.textContent=`${fps} FPS · ${frameMs} MS · ${quality}`;if(fps<48){slowWindows++;fastWindows=0}else if(fps>57){fastWindows++;slowWindows=0}else{slowWindows=0;fastWindows=0}if(slowWindows>=1&&currentPixelRatio>pixelRatioFloor){currentPixelRatio=Math.max(pixelRatioFloor,currentPixelRatio-(fps<30?.2:.12));renderer.setPixelRatio(currentPixelRatio);slowWindows=0}else if(fastWindows>=10&&currentPixelRatio<Math.min(devicePixelRatio,pixelRatioCap)){currentPixelRatio=Math.min(Math.min(devicePixelRatio,pixelRatioCap),currentPixelRatio+.08);renderer.setPixelRatio(currentPixelRatio);fastWindows=0}performanceWindowStart=now;performanceFrames=0;}
// Callbacks that must run after movement is resolved but before the draw call.
// Anything positioning a scene object from playerPosition belongs here: run
// from its own requestAnimationFrame it would land a frame late and stutter.
function tick(){requestAnimationFrame(tick);const d=Math.min(clock.getDelta(),.05);if(emulatorRuntimeActive)return;const now=performance.now();updatePerformanceStats(now);updateNearbyLights(now);animatedMixers.forEach(mixer=>mixer.update(d));if(now-lastPrizeLedDraw>=200&&playerPosition.distanceToSquared(prizeDisplay.position)<400){drawPrizeLed(now);lastPrizeLedDraw=now}loadNearbySceneModels(now);const controlsActive=locked||mobileInputAvailable()&&start.style.display==='none'&&!activeCabinet;if(controlsActive){movementVector.set((keys.KeyD?1:0)-(keys.KeyA?1:0)+mobileMove.x,0,(keys.KeyS?1:0)-(keys.KeyW?1:0)+mobileMove.y);localAnimationState=movementVector.lengthSq()?'walk':'idle';if(movementVector.lengthSq()){movementVector.normalize().multiplyScalar(d*5).applyAxisAngle(upAxis,yaw);const previousX=playerPosition.x,previousZ=playerPosition.z;playerPosition.add(movementVector);resolvePartitionWallCollisions(previousX,previousZ);resolveMegaManRoomCollisions(previousX,previousZ);resolveSocialLayoutCollisions(previousX,previousZ);resolveRearGalleryCollision(previousZ);playerPosition.x=Math.max(-54.5,Math.min(30.5,playerPosition.x));if(playerPosition.x<-30.5)playerPosition.z=Math.max(-18.5,Math.min(4.5,playerPosition.z));else playerPosition.z=Math.max(-33.2,Math.min(16,playerPosition.z))}near=null;let md=2.25;cabinets.forEach(c=>{const dist=c.g.position.distanceTo(playerPosition);if(dist<md){near=c;md=dist}});warmEmulatorCore(near?.system);const constructionRoom=nearbyConstructionRoom();if(constructionRoom)updateConstructionPrompt(constructionRoom);else updateCabinetPrompt()}else{localAnimationState=activeCabinet?'interact':'idle';if(now>=cabinetMessageUntil)prompt.classList.remove('active')}updateFollowCamera();game();for(const callback of beforeRenderCallbacks)callback(now,d);renderer.render(scene,camera)}tick();
document.addEventListener('visibilitychange',()=>{performanceWindowStart=performance.now();performanceFrames=0;slowWindows=0;fastWindows=0});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);currentPixelRatio=Math.min(currentPixelRatio,devicePixelRatio,pixelRatioCap);renderer.setPixelRatio(currentPixelRatio)});
