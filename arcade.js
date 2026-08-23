const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x090611, .026);
const camera = new THREE.PerspectiveCamera(72, innerWidth/innerHeight, .1, 100);
camera.position.set(0, 1.65, 11);
const playerPosition = new THREE.Vector3(0, 1.65, 11), followOffset = new THREE.Vector3(), cameraTarget = new THREE.Vector3(), lookDirection = new THREE.Vector3(), movementVector = new THREE.Vector3(), correctionTarget = new THREE.Vector3(), upAxis = new THREE.Vector3(0,1,0);
const lowPowerDevice=matchMedia('(max-width: 900px)').matches||(navigator.deviceMemory&&navigator.deviceMemory<=4)||(navigator.hardwareConcurrency&&navigator.hardwareConcurrency<=4);
const pixelRatioCap=lowPowerDevice ? .75 : 1;
const pixelRatioFloor=lowPowerDevice ? .5 : .6;
let currentPixelRatio=Math.min(devicePixelRatio,pixelRatioCap);
const renderer = new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance'}); renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(currentPixelRatio); renderer.shadowMap.enabled=false; document.body.appendChild(renderer.domElement);
const clock = new THREE.Clock(), keys = {}, cabinets = [], raycaster = new THREE.Raycaster(), animatedMixers = [];
const gameAssetBaseUrl=(window.ARCADE_RUNTIME?.gameAssetBaseUrl||'assets/games').replace(/\/+$/,'');
const gameAssetUrl=fileName=>`${gameAssetBaseUrl}/${fileName}`;
const biosAssetUrl=window.ARCADE_RUNTIME?.biosAssetUrl||'assets/bios/SCPH1001.BIN';
let yaw=0,pitch=0, locked=false, activeCabinet=null, localAnimationState='idle', cameraMode='third-person', socialFollowProvider=null;
scene.add(new THREE.HemisphereLight(0x37266e,0x09030f,1.4));
const managedSceneLights=[];
const point = (color,x,y,z,intensity=6) => { const l=new THREE.PointLight(color,intensity,10,2);l.position.set(x,y,z);scene.add(l);managedSceneLights.push(l);return l };
point(0xff32b5,-5,3,2);point(0x26fff2,5,3,-4);point(0x7836ff,0,3,-9);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(28,34),new THREE.MeshStandardMaterial({color:0x100b22,roughness:.75,metalness:.35}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
const grid = new THREE.GridHelper(28,28,0x4a257d,0x251447);grid.position.y=.012;scene.add(grid);
function box(w,h,d,color,x,y,z,emissive=0){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:emissive,roughness:.43,metalness:.65}));m.position.set(x,y,z);m.castShadow=true;scene.add(m);return m}
// ceiling beams and wall stripes
for(let z=-14;z<14;z+=5){box(56,.18,.2,0x2c1954,0,5,z,.2);box(56,.04,.08,0x29eee8,0,4.88,z,2)}
box(.3,5,34,0x180d31,-28,2.5,0);
box(.3,5,34,0x180d31,28,2.5,0);
// The main room now reaches the true rear wall. Keeping this wall aligned with
// the two expansion-room back walls leaves open passages around both partition
// ends instead of creating a false wall in front of the walkways.
const rearWall=box(28,5,.3,0x15182a,0,2.5,-16.8,.18);rearWall.receiveShadow=true;
const rearPanelMaterial=new THREE.MeshStandardMaterial({color:0x17233a,emissive:0x08162b,emissiveIntensity:.5,roughness:.58,metalness:.38});
for(let x=-12;x<=12;x+=4){const panel=new THREE.Mesh(new THREE.BoxGeometry(3.82,4.62,.055),rearPanelMaterial);panel.position.set(x,2.42,-16.62);panel.receiveShadow=true;scene.add(panel)}
box(27.5,.09,.08,0x29eee8,0,4.78,-16.57,1.7);box(27.5,.12,.08,0x251447,0,.1,-16.57,.55);
const gangsterPepeMount=new THREE.Group();gangsterPepeMount.position.set(0,.16,0);scene.add(gangsterPepeMount);
const gangsterPepeLight=new THREE.PointLight(0xb9f5ff,3,3.5,2);gangsterPepeLight.position.set(0,.82,.55);scene.add(gangsterPepeLight);
const PLAYSTATION_WALL_X=-14,N64_WALL_X=14,PARTITION_WALL_HALF_LENGTH=13.7,PARTITION_WALL_HALF_THICKNESS=.18,PLAYER_COLLISION_RADIUS=.34;
const playstationWallBody=box(PARTITION_WALL_HALF_THICKNESS*2,5,PARTITION_WALL_HALF_LENGTH*2,0x111425,PLAYSTATION_WALL_X,2.5,0,.08);playstationWallBody.receiveShadow=true;
box(.42,.08,27.4,0x29eee8,PLAYSTATION_WALL_X,4.86,0,1.8);
box(.42,.1,27.4,0x251447,PLAYSTATION_WALL_X,.08,0,.45);
const playstationWallTexture=new THREE.TextureLoader().load('assets/art/playstation-wall.png?v=1');
const playstationWall=new THREE.Mesh(new THREE.PlaneGeometry(27.4,4.7),new THREE.MeshBasicMaterial({map:playstationWallTexture}));playstationWall.position.set(-13.805,2.5,0);playstationWall.rotation.y=Math.PI/2;scene.add(playstationWall);
const n64WallBody=box(PARTITION_WALL_HALF_THICKNESS*2,5,PARTITION_WALL_HALF_LENGTH*2,0x111425,N64_WALL_X,2.5,0,.08);n64WallBody.receiveShadow=true;
box(.42,.08,27.4,0x29eee8,N64_WALL_X,4.86,0,1.8);box(.42,.1,27.4,0x251447,N64_WALL_X,.08,0,.45);
// Opaque wall lining for the expansion hallway. The original structural walls
// were so dark that they read as empty space; these inset panels make both
// sides visibly solid while keeping the openings around the partition ends.
const hallwayWallMaterial=new THREE.MeshStandardMaterial({color:0x17233a,emissive:0x071527,emissiveIntensity:.42,roughness:.62,metalness:.3});
const hallwaySeamMaterial=new THREE.MeshStandardMaterial({color:0x29466d,emissive:0x12345b,emissiveIntensity:.9,roughness:.38,metalness:.55});
for(const wallX of [-27.81,-14.19,14.19,27.81]){
  for(let z=-11.9;z<=11.9;z+=3.4){
    const panel=new THREE.Mesh(new THREE.BoxGeometry(.08,4.68,3.24),hallwayWallMaterial);
    panel.position.set(wallX,2.42,z);panel.receiveShadow=true;scene.add(panel);
  }
  for(let z=-13.6;z<=13.6;z+=3.4){
    const seam=new THREE.Mesh(new THREE.BoxGeometry(.095,4.68,.035),hallwaySeamMaterial);
    seam.position.set(wallX,2.42,z);scene.add(seam);
  }
  const baseTrim=new THREE.Mesh(new THREE.BoxGeometry(.11,.13,27.35),new THREE.MeshStandardMaterial({color:0x182d4a,emissive:0x133b64,emissiveIntensity:1.05,metalness:.7,roughness:.22}));
  baseTrim.position.set(wallX,.12,0);scene.add(baseTrim);
  const topTrim=new THREE.Mesh(new THREE.BoxGeometry(.11,.08,27.35),new THREE.MeshStandardMaterial({color:0x29eee8,emissive:0x29eee8,emissiveIntensity:1.45,metalness:.5,roughness:.2}));
  topTrim.position.set(wallX,4.77,0);scene.add(topTrim);
}
// Mirrored expansion rooms sit behind the PlayStation and Nintendo 64 walls.
// Both partitions end before the front edge so players can walk around them.
for(const roomX of [-21,21]){
  const expansionFloor=new THREE.Mesh(new THREE.PlaneGeometry(14,34),new THREE.MeshStandardMaterial({color:0x090d1c,roughness:.78,metalness:.3}));expansionFloor.rotation.x=-Math.PI/2;expansionFloor.position.set(roomX,.002,0);expansionFloor.receiveShadow=true;scene.add(expansionFloor);
  for(const z of [-10,4]){const expansionGrid=new THREE.GridHelper(14,14,0x164d78,0x10233e);expansionGrid.position.set(roomX,.015,z);scene.add(expansionGrid)}
  box(14,5,.3,0x11182c,roomX,2.5,-16.8,.05);box(14,5,.3,0x11182c,roomX,2.5,16.8,.05);
  for(let z=-12;z<=12;z+=4)box(13.5,.035,.055,0x24bfff,roomX,4.65,z,1.7);
}
function addRoomSign(text,x,color){const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=192;const context=canvas.getContext('2d');context.fillStyle='#070914';context.fillRect(0,0,1024,192);context.strokeStyle=color;context.lineWidth=10;context.strokeRect(6,6,1012,180);context.fillStyle='#fff4cc';context.font='bold 72px monospace';context.textAlign='center';context.textBaseline='middle';context.fillText(text,512,100);const texture=new THREE.CanvasTexture(canvas);const sign=new THREE.Mesh(new THREE.PlaneGeometry(7,1.3),new THREE.MeshBasicMaterial({map:texture}));sign.position.set(x,3.55,-16.62);scene.add(sign)}
addRoomSign('PS2 ROOM',-21,'#ff3cac');addRoomSign('N64 ROOM',21,'#36f9f6');
const pepeToyTexture=new THREE.TextureLoader().load('assets/art/pepe-toy.png?v=1');
const pudgyToyTexture=new THREE.TextureLoader().load('assets/art/pudgy-penguin-toy.png?v=1');
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
function makeCabinet(id,name,x,z,hue,isCrash=false,isGex=false){
  const g=new THREE.Group();g.position.set(x,0,z);const shellColor=isCrash?0x542255:(isGex?0x123f37:hue);const secondaryAccent=isGex?0xff7024:hue;const dark=0x0c0f19;
  const plinth=new THREE.Mesh(new THREE.BoxGeometry(1.86,.12,1.28),new THREE.MeshStandardMaterial({color:0x161928,roughness:.18,metalness:.9}));plinth.position.y=.06;g.add(plinth);
  const underglowMat=new THREE.MeshBasicMaterial({color:hue,transparent:true,opacity:.88});
  for(const [w,d,px,pz] of [[1.52,.045,0,.52],[1.52,.045,0,-.52],[.045,.82,.72,0],[.045,.82,-.72,0]]){const rail=new THREE.Mesh(new THREE.BoxGeometry(w,.025,d),underglowMat);rail.position.set(px,.028,pz);g.add(rail)}
  const floorGlow=new THREE.PointLight(hue,1.15,2.2,2);floorGlow.position.set(0,.12,0);g.add(floorGlow);
  const lower=new THREE.Mesh(new THREE.BoxGeometry(1.68,1.45,1.08),new THREE.MeshStandardMaterial({color:dark,roughness:.22,metalness:.88}));lower.position.set(0,.78,0);g.add(lower);
  const lowerInset=new THREE.Mesh(new THREE.BoxGeometry(1.42,1.18,.01),new THREE.MeshStandardMaterial({color:shellColor,emissive:shellColor,emissiveIntensity:.16,roughness:.32,metalness:.55}));lowerInset.position.set(0,.79,.545);g.add(lowerInset);
  const upper=new THREE.Mesh(new THREE.BoxGeometry(1.56,1.28,.78),new THREE.MeshStandardMaterial({color:0x151a29,roughness:.18,metalness:.88}));upper.position.set(0,2.05,-.05);upper.rotation.x=-.1;g.add(upper);
  const trimMat=new THREE.MeshStandardMaterial({color:hue,emissive:hue,emissiveIntensity:2.25,metalness:.45});for(const sx of [-.79,.79]){const strip=new THREE.Mesh(new THREE.BoxGeometry(.035,2.54,.06),trimMat);strip.position.set(sx,1.32,.54);g.add(strip)}
  const art=isCrash?crashArt():null;
  const frontArtTexture=isCrash?new THREE.TextureLoader().load('assets/art/crash-bandicoot-front.png?v=2'):null;
  const sideArtTexture=isCrash?new THREE.TextureLoader().load('assets/art/crash-bandicoot-side.png'):null;
  const backArtTexture=isCrash?new THREE.TextureLoader().load('assets/art/crash-bandicoot-back.png'):null;
  const marqueeTexture=isCrash?new THREE.TextureLoader().load('assets/art/crash-bandicoot-marquee.png?v=3'):null;
  const gexMarqueeTexture=isGex?new THREE.TextureLoader().load('assets/art/gex-marquee.png?v=2'):null;
  const gexFrontTexture=isGex?new THREE.TextureLoader().load('assets/art/gex-front.png?v=1'):null;
  const gexSideTexture=isGex?new THREE.TextureLoader().load('assets/art/gex-side.png?v=1'):null;
  const gexBackTexture=isGex?new THREE.TextureLoader().load('assets/art/gex-back.png?v=1'):null;
  if(isCrash){
    const frontArt=new THREE.Mesh(new THREE.PlaneGeometry(1.04,1.04),new THREE.MeshBasicMaterial({map:frontArtTexture}));frontArt.position.set(0,.78,.558);g.add(frontArt);
    const artBorder=new THREE.Mesh(new THREE.BoxGeometry(1.16,1.16,.04),new THREE.MeshStandardMaterial({color:0xffb42e,emissive:0xe65b27,emissiveIntensity:1.2}));artBorder.position.set(0,.78,.535);g.add(artBorder);
    const backArt=new THREE.Mesh(new THREE.PlaneGeometry(1.38,.92),new THREE.MeshBasicMaterial({map:backArtTexture}));backArt.position.set(0,.88,-.548);backArt.rotation.y=Math.PI;g.add(backArt);
    const backBorder=new THREE.Mesh(new THREE.BoxGeometry(1.5,1.04,.04),new THREE.MeshStandardMaterial({color:0x26c9ff,emissive:0x26c9ff,emissiveIntensity:1.1}));backBorder.position.set(0,.88,-.528);g.add(backBorder);
    backArt.position.z=-.556;
    for(const side of [-1,1]){const sideArt=new THREE.Mesh(new THREE.PlaneGeometry(.9,1.66),new THREE.MeshBasicMaterial({map:sideArtTexture,side:THREE.DoubleSide}));sideArt.position.set(side*.846,1.12,-.05);sideArt.rotation.y=side*Math.PI/2;g.add(sideArt);}
  }
  if(isGex){
    const frontArt=new THREE.Mesh(new THREE.PlaneGeometry(1.05,1.16),new THREE.MeshBasicMaterial({map:gexFrontTexture}));frontArt.position.set(0,.79,.558);g.add(frontArt);
    const artBorder=new THREE.Mesh(new THREE.BoxGeometry(1.17,1.28,.04),new THREE.MeshStandardMaterial({color:0x8de548,emissive:0x8de548,emissiveIntensity:1.15,metalness:.6}));artBorder.position.set(0,.79,.535);g.add(artBorder);
    for(const side of [-1,1]){const sideArt=new THREE.Mesh(new THREE.PlaneGeometry(.7,1.58),new THREE.MeshBasicMaterial({map:gexSideTexture,side:THREE.DoubleSide}));sideArt.position.set(side*.846,1.05,-.05);sideArt.rotation.y=side*Math.PI/2;g.add(sideArt);}
    const backArt=new THREE.Mesh(new THREE.PlaneGeometry(1.05,1.16),new THREE.MeshBasicMaterial({map:gexBackTexture}));backArt.position.set(0,.79,-.558);backArt.rotation.y=Math.PI;g.add(backArt);
    const backBorder=new THREE.Mesh(new THREE.BoxGeometry(1.17,1.28,.04),new THREE.MeshStandardMaterial({color:0x9b43ff,emissive:0x9b43ff,emissiveIntensity:1.1,metalness:.6}));backBorder.position.set(0,.79,-.535);g.add(backBorder);
  }
  const bezel=new THREE.Mesh(new THREE.BoxGeometry(1.38,1.0,.075),new THREE.MeshStandardMaterial({color:0x03050c,metalness:.9,roughness:.12}));bezel.position.set(0,2.06,.335);bezel.rotation.x=-.1;g.add(bezel);
  const screen=new THREE.Mesh(new THREE.PlaneGeometry(1.24,.84),new THREE.MeshBasicMaterial({color:0x050710}));screen.position.set(0,2.06,.38);screen.rotation.x=-.1;g.add(screen);
  const deck=new THREE.Mesh(new THREE.BoxGeometry(1.5,.12,.56),new THREE.MeshStandardMaterial({color:0x101525,metalness:.92,roughness:.15}));deck.position.set(0,1.4,.47);deck.rotation.x=.16;g.add(deck);
  const deckLight=new THREE.Mesh(new THREE.BoxGeometry(1.22,.018,.035),new THREE.MeshStandardMaterial({color:secondaryAccent,emissive:secondaryAccent,emissiveIntensity:2.4}));deckLight.position.set(0,1.47,.72);deckLight.rotation.x=.16;g.add(deckLight);
  const glow=new THREE.PointLight(hue,3.4,3);glow.position.set(0,1.95,.8);g.add(glow);
  const joystickX=-.39;
  const gate=new THREE.Mesh(new THREE.CylinderGeometry(.14,.14,.032,32),new THREE.MeshStandardMaterial({color:0x02040a,metalness:1,roughness:.08}));gate.position.set(joystickX,1.49,.64);g.add(gate);
  const gateRing=new THREE.Mesh(new THREE.TorusGeometry(.1,.012,10,32),new THREE.MeshStandardMaterial({color:hue,emissive:hue,emissiveIntensity:.65,metalness:.7}));gateRing.rotation.x=Math.PI/2;gateRing.position.set(joystickX,1.51,.64);g.add(gateRing);
  const stem=new THREE.Mesh(new THREE.CylinderGeometry(.018,.023,.115,16),new THREE.MeshStandardMaterial({color:0xe0e5ef,metalness:1,roughness:.06}));stem.position.set(joystickX,1.57,.64);g.add(stem);
  const stick=new THREE.Mesh(new THREE.SphereGeometry(.052,20,20),new THREE.MeshStandardMaterial({color:0x111722,metalness:.55,roughness:.15}));stick.position.set(joystickX,1.65,.64);g.add(stick);
  for(const [bx,bz,bColor] of [[.08,.58,0xff3cac],[.28,.58,0x36f9f6],[.08,.72,0xffb42e],[.28,.72,0x934dff]]){
    const buttonWell=new THREE.Mesh(new THREE.CylinderGeometry(.075,.085,.025,24),new THREE.MeshStandardMaterial({color:0x03050b,metalness:1,roughness:.12}));buttonWell.position.set(bx,1.49,bz);g.add(buttonWell);
    const button=new THREE.Mesh(new THREE.CylinderGeometry(.052,.052,.035,24),new THREE.MeshStandardMaterial({color:bColor,emissive:bColor,emissiveIntensity:.55,metalness:.45,roughness:.18}));button.position.set(bx,1.522,bz);g.add(button);
  }
  let plate;
  if(isCrash){plate=new THREE.Mesh(new THREE.PlaneGeometry(1.54,.47),new THREE.MeshBasicMaterial({map:marqueeTexture}));plate.position.set(0,2.68,.43);}
  else if(isGex){plate=new THREE.Mesh(new THREE.PlaneGeometry(1.54,.47),new THREE.MeshBasicMaterial({map:gexMarqueeTexture}));plate.position.set(0,2.68,.43);}
  else {const label=document.createElement('canvas');label.width=512;label.height=128;const c=label.getContext('2d');c.fillStyle='#0a0713';c.fillRect(0,0,512,128);c.fillStyle='#fff4cc';c.font='bold 29px monospace';c.textAlign='center';c.fillText(name,256,77,480);plate=new THREE.Mesh(new THREE.PlaneGeometry(1.48,.28),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(label)}));plate.position.set(0,2.7,.43);}
  plate.rotation.x=-.1;g.add(plate);
  const statusMaterial=new THREE.MeshStandardMaterial({color:0x50ff9a,emissive:0x50ff9a,emissiveIntensity:2.4});
  const statusLight=new THREE.Mesh(new THREE.BoxGeometry(.18,.045,.035),statusMaterial);statusLight.position.set(.48,2.48,.43);statusLight.rotation.x=-.1;g.add(statusLight);
  scene.add(g);cabinets.push({id,g,name,type:id.toUpperCase(),screen,hue,statusLight,renderLights:[floorGlow,glow],status:'syncing',occupiedByDisplayName:null,enabled:true});
}
function configureHostedCabinet(cabinetId){const game=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);if(!game)return;Object.assign(cabinets[cabinets.length-1],{system:game.system,gameName:game.name,gameId:game.emulatorId,gameSizeBytes:game.sizeBytes,hostedGame:gameAssetUrl(game.file)})}
makeCabinet('pixel-rally',"TONY HAWK'S PRO SKATER 2",-10.2,-10,0x36f9f6);cabinets[cabinets.length-1].g.rotation.y=Math.PI/2;configureHostedCabinet('pixel-rally');
makeCabinet('gex-enter-the-gecko','GEX: ENTER THE GECKO',-10.2,-5,0x8de548,false,true);cabinets[cabinets.length-1].g.rotation.y=Math.PI/2;configureHostedCabinet('gex-enter-the-gecko');
makeCabinet('crash-bandicoot','CRASH BANDICOOT',-10.2,0,0xffa62e,true);cabinets[cabinets.length-1].g.rotation.y=Math.PI/2;configureHostedCabinet('crash-bandicoot');
makeCabinet('dungeon-88','SPYRO - YEAR OF THE DRAGON',-10.2,5,0x934dff);cabinets[cabinets.length-1].g.rotation.y=Math.PI/2;configureHostedCabinet('dungeon-88');
makeCabinet('turbo-grid','TWISTED METAL WORLD TOUR',-10.2,10,0xff3cac);cabinets[cabinets.length-1].g.rotation.y=Math.PI/2;configureHostedCabinet('turbo-grid');
const hostedN64Games={
  1:window.ARCADE_GAME_REGISTRY?.byCabinetId?.get('n64-cabinet-01'),
  2:window.ARCADE_GAME_REGISTRY?.byCabinetId?.get('n64-cabinet-02'),
  3:window.ARCADE_GAME_REGISTRY?.byCabinetId?.get('n64-cabinet-03'),
  4:window.ARCADE_GAME_REGISTRY?.byCabinetId?.get('n64-cabinet-04'),
  5:window.ARCADE_GAME_REGISTRY?.byCabinetId?.get('n64-cabinet-05')
};
for(const [index,z,hue] of [[1,-10,0x8b5cf6],[2,-5,0xff4da6],[3,0,0x36f9f6],[4,5,0xffb42e],[5,10,0x7dff67]]){const hosted=hostedN64Games[index];makeCabinet(`n64-cabinet-0${index}`,hosted?hosted.name.toUpperCase():`N64 // READY 0${index}`,10.2,z,hue);const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=-Math.PI/2;configureHostedCabinet(`n64-cabinet-0${index}`)}
const expansionCabinetColors=[0xff3cac,0x36f9f6,0xffb42e,0x934dff,0x7dff67];
const ps2RoomTitles=['GOD OF WAR','KINGDOM HEARTS','PS2 // READY 03','PS2 // READY 04','PS2 // READY 05'];
for(const [index,z] of [[1,-10],[2,-5],[3,0],[4,5],[5,10]]){
  makeCabinet(`psx-back-cabinet-0${index}`,ps2RoomTitles[index-1],-24.8,z,expansionCabinetColors[index-1]);
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=Math.PI/2;Object.assign(cabinet,{system:'ps2',gameName:ps2RoomTitles[index-1],gameId:26000+index,enabled:false,status:'disabled'});
}
for(const [index,z] of [[1,-10],[2,-5],[3,0],[4,5],[5,10]]){
  const cabinetId=`n64-back-cabinet-0${index}`,hosted=window.ARCADE_GAME_REGISTRY?.byCabinetId?.get(cabinetId);
  makeCabinet(cabinetId,hosted?hosted.name.toUpperCase():`N64 // EXPANSION 0${index}`,24.8,z,expansionCabinetColors[5-index]);
  const cabinet=cabinets[cabinets.length-1];cabinet.g.rotation.y=-Math.PI/2;Object.assign(cabinet,{system:'n64',gameName:hosted?.name||`Nintendo 64 Expansion ${index}`,gameId:hosted?.emulatorId||6410+index});configureHostedCabinet(cabinetId);
}
// Circular prize counter in the middle of the arcade.
const prizeCounter=new THREE.Group();prizeCounter.position.set(0,0,0);scene.add(prizeCounter);
const counterGlassMat=new THREE.MeshStandardMaterial({color:0x79dfff,emissive:0x123b66,emissiveIntensity:.34,transparent:true,opacity:.17,metalness:.45,roughness:.08,side:THREE.DoubleSide,depthWrite:false});
const counterBase=new THREE.Mesh(new THREE.CylinderGeometry(1.55,1.7,1.1,48),counterGlassMat);counterBase.position.y=.55;prizeCounter.add(counterBase);
const counterGlow=new THREE.Mesh(new THREE.CylinderGeometry(1.62,1.62,.08,48),new THREE.MeshStandardMaterial({color:0x36f9f6,emissive:0x36f9f6,emissiveIntensity:2.1,metalness:.5}));counterGlow.position.y=.12;prizeCounter.add(counterGlow);
const counterTop=new THREE.Mesh(new THREE.CylinderGeometry(1.7,1.7,.09,48),new THREE.MeshStandardMaterial({color:0xb8f3ff,emissive:0x1c4e6a,emissiveIntensity:.34,transparent:true,opacity:.32,metalness:.65,roughness:.07,side:THREE.DoubleSide,depthWrite:false}));counterTop.position.y=1.15;prizeCounter.add(counterTop);
const counterTopRim=new THREE.Mesh(new THREE.CylinderGeometry(1.73,1.73,.12,48,1,true),new THREE.MeshStandardMaterial({color:0x1a2d3a,emissive:0x0d1c28,emissiveIntensity:.45,metalness:.9,roughness:.12}));counterTopRim.position.y=1.15;prizeCounter.add(counterTopRim);
const counterDisplayLight=new THREE.PointLight(0xe8f9ff,5.4,4.2,2);counterDisplayLight.position.set(0,.82,0);prizeCounter.add(counterDisplayLight);
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
function loadNearbySceneModels(now){if(now<nextHeavyAssetCheck)return;nextHeavyAssetCheck=now+500;if(!prizeModelsStarted&&playerPosition.distanceToSquared(prizeDisplay.position)<144){prizeModelsStarted=true;installPepeModel();installPudgyModel();installFurthermoreModel();installEnterpriseModel();installKurackModel();}if(!centerModelStarted&&playerPosition.x*playerPosition.x+playerPosition.z*playerPosition.z<16){centerModelStarted=true;installGangsterPepe();}}
let nextLightCull=0;
function updateNearbyLights(now){if(now<nextLightCull)return;nextLightCull=now+250;const cabinetDistances=cabinets.map(cabinet=>({cabinet,distanceSq:cabinet.g.position.distanceToSquared(playerPosition)})).sort((a,b)=>a.distanceSq-b.distanceSq);let litCabinets=0;for(const {cabinet,distanceSq} of cabinetDistances){cabinet.g.visible=distanceSq<324;const lightsVisible=cabinet.g.visible&&distanceSq<64&&litCabinets<2;if(lightsVisible)litCabinets++;cabinet.renderLights.forEach(light=>{light.visible=lightsVisible});}const sceneLights=managedSceneLights.map(light=>{const dx=light.position.x-playerPosition.x,dz=light.position.z-playerPosition.z;return{light,distanceSq:dx*dx+dz*dz}}).sort((a,b)=>a.distanceSq-b.distanceSq);sceneLights.forEach(({light,distanceSq},index)=>{light.visible=index<2&&distanceSq<144});const centerDistanceSq=playerPosition.x*playerPosition.x+playerPosition.z*playerPosition.z;gangsterPepeLight.visible=centerDistanceSq<25;counterDisplayLight.visible=centerDistanceSq<49;const prizeVisible=playerPosition.distanceToSquared(prizeDisplay.position)<144;prizeDisplayLights.forEach(light=>{light.visible=prizeVisible});}
const prizeSignCanvas=document.createElement('canvas');prizeSignCanvas.width=1024;prizeSignCanvas.height=192;const psc=prizeSignCanvas.getContext('2d');const prizeLedTexture=new THREE.CanvasTexture(prizeSignCanvas);
function drawPrizeLed(time=0){psc.fillStyle='#05060b';psc.fillRect(0,0,1024,192);for(let x=8;x<1024;x+=16){for(let y=8;y<192;y+=16){psc.fillStyle=(x+y)%32?'#101527':'#1c2540';psc.fillRect(x,y,3,3)}}psc.font='bold 88px monospace';psc.textBaseline='middle';psc.shadowColor='#ff3cac';psc.shadowBlur=20;psc.fillStyle='#fff4cc';const text='  ✦  PRIZE COUNTER  ✦  ';const width=psc.measureText(text).width;const offset=(time*.14)%(width+1024);psc.fillText(text,1024-offset,98);psc.fillText(text,1024-offset+width+160,98);psc.shadowBlur=0;prizeLedTexture.needsUpdate=true;}
drawPrizeLed();
const jumbotron=new THREE.Group();jumbotron.position.set(0,3.46875,.04);prizeDisplay.add(jumbotron);const signBody=new THREE.Mesh(new THREE.BoxGeometry(3.25,.78,.86),new THREE.MeshStandardMaterial({color:0x090b16,metalness:.85,roughness:.16}));jumbotron.add(signBody);
for(const [z,rotation] of [[.436,0],[-.436,Math.PI]]){const face=new THREE.Mesh(new THREE.PlaneGeometry(3.05,.58),new THREE.MeshBasicMaterial({map:prizeLedTexture}));face.position.z=z;face.rotation.y=rotation;jumbotron.add(face);}
point(0x36f9f6,-2.6,2.3,0,2);point(0xff3cac,2.6,2.3,0,2);
const start=document.querySelector('#start-screen'), prompt=document.querySelector('#prompt'), modal=document.querySelector('#machine-modal'), hudStatus=document.querySelector('.status');
function updateViewStatus(){if(hudStatus)hudStatus.textContent=`WASD · MOVE   /   MOUSE · LOOK   /   V · ${cameraMode==='first-person'?'1ST':'3RD'} PERSON`}
function toggleCameraMode(){
  if(activeCabinet||start.style.display!=='none')return;
  cameraMode=cameraMode==='first-person'?'third-person':'first-person';
  updateViewStatus();
  window.dispatchEvent(new CustomEvent('arcade:camera-mode-changed',{detail:{mode:cameraMode}}));
}
function beginArcade(){
  start.style.display='none';
  // Pointer lock is optional: the floor still appears if a browser declines it.
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
  if (!activeCabinet && start.style.display === 'none' && !locked) renderer.domElement.requestPointerLock();
});
window.addEventListener('blur', ()=>{ Object.keys(keys).forEach(key=>keys[key]=false); });
document.addEventListener('pointerlockchange',()=>{locked=document.pointerLockElement===renderer.domElement;document.querySelector('#crosshair').style.opacity=locked?'1':'0'});
document.addEventListener('mousemove',e=>{if(!locked)return;yaw-=e.movementX*.0025;pitch=Math.max(-.42,Math.min(.58,pitch-e.movementY*.0025))});
addEventListener('keydown',e=>{keys[e.code]=true;if(e.code==='KeyV'&&!e.repeat)toggleCameraMode();if(e.code==='KeyE'&&near&&locked&&!e.repeat)window.dispatchEvent(new CustomEvent('arcade:cabinet-interact',{detail:{cabinetId:near.id}}));if(e.code==='Escape'&&activeCabinet)closeMachine();else if(e.code==='Escape'&&socialFollowProvider)socialFollowProvider=null});addEventListener('keyup',e=>keys[e.code]=false);
let near=null;
function openMachine(c){
  activeCabinet=c;
  document.querySelector('#machine-type').textContent=c.system==='psx'?'PLAYSTATION // CABINET':(c.system==='n64'?'NINTENDO 64 // CABINET':c.type);
  document.querySelector('#machine-name').textContent=c.name;
  document.querySelector('#bios-control').style.display=c.system==='psx'?'flex':'none';
  const playButton=document.querySelector('#play-hosted-game');
  playButton.style.display=c.hostedGame?'inline-block':'none';
  if(c.hostedGame) playButton.textContent=`PLAY ${c.gameName.toUpperCase()} · ${formatDownloadSize(c.gameSizeBytes)}`;
  if(c.system==='psx') document.querySelector('#rom-name').textContent=c.hostedGame?'LICENSED GAME READY — PRESS PLAY':(c.assetNote||`LOAD A ${c.gameName.toUpperCase()} GAME FILE`);
  if(c.system==='psx') document.querySelector('#bios-name').textContent=psxBios?`BIOS READY: ${psxBios.name.toUpperCase()}`:'HOSTED BIOS READY: SCPH1001.BIN';
  if(c.system==='n64') document.querySelector('#rom-name').textContent=c.hostedGame?'LICENSED N64 GAME READY — PRESS PLAY':'N64 EMULATOR READY — LOAD A .Z64, .N64, OR .V64 ROM';
  document.querySelector('.legal').textContent=c.system==='n64'?'Nintendo 64 games run locally through EmulatorJS using its Mupen64Plus Next browser core. No ROM data is uploaded.':'Use game images and BIOS files legally dumped from hardware you own. PlayStation emulation runs locally in your browser; no ROM data is uploaded.';
  modal.style.display='grid';modal.setAttribute('aria-hidden','false');document.exitPointerLock();drawAttract(c);
}
function stopEmulator(){
  clearTimeout(emulatorLoadTimer);
  try {
    if(typeof window.EJS_terminate==='function') window.EJS_terminate();
    else if(typeof window.EJS_emulator?.exit==='function') window.EJS_emulator.exit();
  } catch(error) { console.warn('Could not terminate the emulator cleanly.', error); }
  document.querySelector('#emulator-host').replaceChildren();
  document.querySelector('#emulator-stage').style.display='none';
  cvs.style.display='block';
  emulatorObjectUrls.forEach(url=>URL.revokeObjectURL(url));emulatorObjectUrls=[];
}
function closeMachine(notifyServer=true){const closing=activeCabinet;if(['psx','n64'].includes(closing?.system))stopEmulator();modal.style.display='none';modal.setAttribute('aria-hidden','true');activeCabinet=null;if(notifyServer&&closing)window.dispatchEvent(new CustomEvent('arcade:cabinet-session-ended',{detail:{cabinetId:closing.id}}));renderer.domElement.requestPointerLock()}
document.querySelector('.close').onclick=closeMachine;
const cvs=document.querySelector('#game-screen'),ctx=cvs.getContext('2d'); let romLoaded=false,ship={x:320,bullets:[]},stars=Array.from({length:80},()=>({x:Math.random()*640,y:Math.random()*440,s:1+Math.random()*2})),psxBios=null;
const hostedPsxBios=biosAssetUrl;
function drawAttract(c){ctx.fillStyle='#03050c';ctx.fillRect(0,0,640,440);ctx.fillStyle='#36f9f6';ctx.font='30px monospace';ctx.textAlign='center';ctx.fillText(c.name,320,100);ctx.fillStyle='#ff3cac';ctx.font='15px monospace';ctx.fillText('INSERT ROM TO INITIALIZE',320,150);ctx.fillStyle='#a99abe';ctx.font='12px monospace';ctx.fillText('Your game appears here',320,330)}
document.querySelector('#rom-file').addEventListener('change',e=>{const f=e.target.files[0];if(!f||!activeCabinet)return;document.querySelector('#rom-name').textContent=`LOADED: ${f.name.toUpperCase()} · ${Math.ceil(f.size/1024)} KB`;romLoaded=true;ship={x:320,bullets:[]};});
let emulatorObjectUrls=[],emulatorLoadTimer;
function formatDownloadSize(bytes){if(!Number.isFinite(bytes)||bytes<=0)return'HOSTED';const mb=bytes/1048576;return mb>=100?`${Math.round(mb)} MB`:`${mb.toFixed(1)} MB`}
function launchEmulator(gameFile){
  const host=document.querySelector('#emulator-host'),stage=document.querySelector('#emulator-stage');
  const downloadBytes=typeof gameFile==='string'?activeCabinet?.gameSizeBytes:gameFile?.size;
  cvs.style.display='none';stage.style.display='grid';stage.style.placeItems='center';stage.style.color='#36f9f6';stage.style.fontFamily='monospace';stage.style.letterSpacing='.12em';host.textContent=`LOADING ${(activeCabinet?.gameName||'ARCADE GAME').toUpperCase()} · ${formatDownloadSize(downloadBytes)}...`;
  const gameUrl=typeof gameFile==='string'?gameFile:URL.createObjectURL(gameFile);
  const core=activeCabinet?.system==='n64'?'n64':'psx';
  const biosUrl=core==='psx'?(psxBios?URL.createObjectURL(psxBios):hostedPsxBios):'';
  emulatorObjectUrls=[gameUrl,biosUrl].filter(url=>url.startsWith('blob:'));
  const gameName=activeCabinet?.gameName||'Arcade Game',gameId=activeCabinet?.gameId||1;
  const player=document.createElement('iframe');player.title=`${gameName} player`;player.allow='autoplay; fullscreen';player.src=`player.html?core=${encodeURIComponent(core)}&game=${encodeURIComponent(gameUrl)}&bios=${encodeURIComponent(biosUrl)}&name=${encodeURIComponent(gameName)}&id=${gameId}`;player.style.cssText='border:0;width:100%;height:100%;background:#02030a';player.onerror=()=>{showCabinetMessage('EMULATOR COULD NOT LOAD.');closeMachine()};host.replaceChildren(player);
  const estimatedTimeout=Math.max(20000,Math.min(180000,20000+(Number(downloadBytes)||0)/524288*1000));
  clearTimeout(emulatorLoadTimer);emulatorLoadTimer=setTimeout(()=>{if(activeCabinet){closeMachine();showCabinetMessage('EMULATOR LOAD TIMED OUT. CHECK YOUR CONNECTION.')}},estimatedTimeout);
}
document.querySelector('#bios-file').addEventListener('change',e=>{const file=e.target.files[0];if(!file)return;psxBios=file;document.querySelector('#bios-name').textContent=`BIOS READY: ${file.name.toUpperCase()}`;});
document.querySelector('#play-hosted-game').addEventListener('click',()=>{if(activeCabinet?.hostedGame)launchEmulator(activeCabinet.hostedGame);});
document.querySelector('#rom-file').addEventListener('change',e=>{const file=e.target.files[0];if(['psx','n64'].includes(activeCabinet?.system)&&file)launchEmulator(file);});
addEventListener('message',event=>{if(event.origin!==location.origin)return;if(event.data?.type==='arcade:emulator-ready')clearTimeout(emulatorLoadTimer);if(['arcade:emulator-error','arcade:emulator-closed'].includes(event.data?.type)&&activeCabinet){clearTimeout(emulatorLoadTimer);closeMachine();showCabinetMessage(event.data.type.endsWith('error')?'EMULATOR COULD NOT LOAD.':'EMULATOR SESSION CLOSED.')}});
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
  followOffset.set(0,2.15+pitch*2.1,4.55).applyAxisAngle(upAxis,yaw);
  camera.position.copy(playerPosition).add(followOffset);
  cameraTarget.set(playerPosition.x,playerPosition.y+.78,playerPosition.z);
  camera.lookAt(cameraTarget);
}
let cabinetSnapshotReady=false,cabinetMessageUntil=0;
function showCabinetMessage(message){prompt.querySelector('b').textContent='CABINET';prompt.querySelector('span').textContent=message;prompt.classList.add('active');cabinetMessageUntil=performance.now()+2600}
function setCabinetState(state){const cabinet=cabinets.find(candidate=>candidate.id===state.cabinetId);if(!cabinet)return;if(!cabinet.enabled){cabinet.status='disabled';cabinet.occupiedByDisplayName=null;cabinet.statusLight.material.color.setHex(0x6c7896);cabinet.statusLight.material.emissive.setHex(0x26304a);return}cabinet.status=state.status;cabinet.occupiedByDisplayName=state.occupiedByDisplayName;const color=state.status==='available'?0x50ff9a:(state.status==='reserved'?0xffb42e:0xff3c76);cabinet.statusLight.material.color.setHex(color);cabinet.statusLight.material.emissive.setHex(color)}
function setCabinetStates(states,ready){cabinetSnapshotReady=ready;states.forEach(state=>setCabinetState(state));if(!ready)cabinets.forEach(c=>{c.status=c.enabled?'syncing':'disabled';c.occupiedByDisplayName=null;c.statusLight.material.color.setHex(0x6c7896);c.statusLight.material.emissive.setHex(c.enabled?0x6c7896:0x26304a)})}
function updateCabinetPrompt(){if(performance.now()<cabinetMessageUntil)return;if(!near){prompt.classList.remove('active');return}prompt.classList.add('active');const title=prompt.querySelector('b'),detail=prompt.querySelector('span');if(!near.enabled||near.status==='disabled'){title.textContent='PS2 DISPLAY';detail.textContent='BROWSER CORE REQUIRED';return}if(!cabinetSnapshotReady){title.textContent='SYNCING';detail.textContent='CABINET STATUS';return}if(near.status==='available'){title.textContent='PRESS E';detail.textContent='TO ENTER CABINET';return}title.textContent=near.status==='reserved'?'RESERVED':'IN USE';detail.textContent=near.occupiedByDisplayName?`BY ${near.occupiedByDisplayName}`:'PLEASE WAIT'}
function beginCabinetSession(cabinetId,alignment){const cabinet=cabinets.find(candidate=>candidate.id===cabinetId);if(!cabinet||activeCabinet)return false;if(alignment?.position){playerPosition.set(...alignment.position);yaw=alignment.rotationY}openMachine(cabinet);return true}
function forceCloseCabinetSession(cabinetId){if(activeCabinet?.id===cabinetId)closeMachine(false)}
function resolvePartitionWallCollisions(previousX){
  if(Math.abs(playerPosition.z)>PARTITION_WALL_HALF_LENGTH+PLAYER_COLLISION_RADIUS)return;
  for(const wallX of [PLAYSTATION_WALL_X,N64_WALL_X]){
    const leftFace=wallX-PARTITION_WALL_HALF_THICKNESS-PLAYER_COLLISION_RADIUS;
    const rightFace=wallX+PARTITION_WALL_HALF_THICKNESS+PLAYER_COLLISION_RADIUS;
    if(previousX<wallX&&playerPosition.x>leftFace)playerPosition.x=leftFace;
    else if(previousX>=wallX&&playerPosition.x<rightFace)playerPosition.x=rightFace;
  }
}
window.arcadeMultiplayer={scene,getCamera:()=>camera,getCanvas:()=>renderer.domElement,getLocalTransform:()=>({position:{x:playerPosition.x,y:playerPosition.y,z:playerPosition.z},rotationY:yaw}),getLocalAnimationState:()=>localAnimationState,isFirstPerson:()=>cameraMode==='first-person',getCameraMode:()=>cameraMode,isFollowingPlayer:()=>Boolean(socialFollowProvider),followPlayer:provider=>{socialFollowProvider=provider},clearPlayerFollow:()=>{socialFollowProvider=null},applyAuthoritativeTransform:({position,rotationY},strength=.12)=>{correctionTarget.set(position.x,position.y,position.z);playerPosition.lerp(correctionTarget,strength);const difference=Math.atan2(Math.sin(rotationY-yaw),Math.cos(rotationY-yaw));yaw+=difference*strength;},performanceProfile:{lowPower:lowPowerDevice,getRenderScale:()=>currentPixelRatio},setCabinetState,setCabinetStates,showCabinetMessage,beginCabinetSession,forceCloseCabinetSession};
let lastPrizeLedDraw=0;
const performanceStats=document.querySelector('#performance-stats');
let performanceWindowStart=performance.now(),performanceFrames=0,slowWindows=0,fastWindows=0;
function updatePerformanceStats(now){performanceFrames++;const elapsed=now-performanceWindowStart;if(elapsed<1000)return;const fps=Math.round(performanceFrames*1000/elapsed),frameMs=Math.round(elapsed/performanceFrames),quality=currentPixelRatio<=pixelRatioFloor+.01?'LOW':currentPixelRatio<.9?'MED':'HIGH';if(performanceStats)performanceStats.textContent=`${fps} FPS · ${frameMs} MS · ${quality}`;if(fps<48){slowWindows++;fastWindows=0}else if(fps>57){fastWindows++;slowWindows=0}else{slowWindows=0;fastWindows=0}if(slowWindows>=1&&currentPixelRatio>pixelRatioFloor){currentPixelRatio=Math.max(pixelRatioFloor,currentPixelRatio-(fps<30?.2:.12));renderer.setPixelRatio(currentPixelRatio);slowWindows=0}else if(fastWindows>=10&&currentPixelRatio<Math.min(devicePixelRatio,pixelRatioCap)){currentPixelRatio=Math.min(Math.min(devicePixelRatio,pixelRatioCap),currentPixelRatio+.08);renderer.setPixelRatio(currentPixelRatio);fastWindows=0}performanceWindowStart=now;performanceFrames=0;}
function tick(){requestAnimationFrame(tick);const d=Math.min(clock.getDelta(),.05),now=performance.now();updatePerformanceStats(now);updateNearbyLights(now);animatedMixers.forEach(mixer=>mixer.update(d));if(now-lastPrizeLedDraw>=200&&playerPosition.distanceToSquared(prizeDisplay.position)<400){drawPrizeLed(now);lastPrizeLedDraw=now}loadNearbySceneModels(now);if(locked){movementVector.set((keys.KeyD?1:0)-(keys.KeyA?1:0),0,(keys.KeyS?1:0)-(keys.KeyW?1:0));localAnimationState=movementVector.lengthSq()?'walk':'idle';if(movementVector.lengthSq()){movementVector.normalize().multiplyScalar(d*5).applyAxisAngle(upAxis,yaw);const previousX=playerPosition.x;playerPosition.add(movementVector);resolvePartitionWallCollisions(previousX);playerPosition.x=Math.max(-27,Math.min(27,playerPosition.x));playerPosition.z=Math.max(-16,Math.min(16,playerPosition.z))}near=null;let md=2.25;cabinets.forEach(c=>{const dist=c.g.position.distanceTo(playerPosition);if(dist<md){near=c;md=dist}});updateCabinetPrompt()}else{localAnimationState=activeCabinet?'interact':'idle';if(now>=cabinetMessageUntil)prompt.classList.remove('active')}updateFollowCamera();game();renderer.render(scene,camera)}tick();
document.addEventListener('visibilitychange',()=>{performanceWindowStart=performance.now();performanceFrames=0;slowWindows=0;fastWindows=0});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);currentPixelRatio=Math.min(currentPixelRatio,devicePixelRatio,pixelRatioCap);renderer.setPixelRatio(currentPixelRatio)});
