export class CabinetSpatialIndex {
  constructor(definitions,{cellSize=8}={}){
    if(!Number.isFinite(cellSize)||cellSize<=0)throw new Error('Cabinet cell size must be positive.');
    this.cellSize=cellSize;this.byId=new Map();this.byZone=new Map();this.byGame=new Map();this.byType=new Map();this.cells=new Map();
    for(const definition of definitions){
      if(this.byId.has(definition.id))throw new Error(`Duplicate cabinet ID: ${definition.id}`);
      this.byId.set(definition.id,definition);add(this.byZone,definition.zoneId,definition);add(this.byGame,definition.gameId,definition);
      add(this.byType,definition.cabinetType,definition);add(this.cells,this.#key(definition.interactionPosition.x,definition.interactionPosition.z),definition);
    }
  }
  get size(){return this.byId.size} get(id){return this.byId.get(id)}
  inZone(id){return this.byZone.get(id)||[]} forGame(id){return this.byGame.get(id)||[]} ofType(id){return this.byType.get(id)||[]}
  nearby(position,radius,zoneId){
    if(!Number.isFinite(radius)||radius<0)return[];const found=[],r2=radius*radius;
    const minX=Math.floor((position.x-radius)/this.cellSize),maxX=Math.floor((position.x+radius)/this.cellSize);
    const minZ=Math.floor((position.z-radius)/this.cellSize),maxZ=Math.floor((position.z+radius)/this.cellSize);
    for(let x=minX;x<=maxX;x+=1)for(let z=minZ;z<=maxZ;z+=1)for(const cabinet of this.cells.get(`${x}:${z}`)||[]){
      if(zoneId&&cabinet.zoneId!==zoneId)continue;const dx=cabinet.interactionPosition.x-position.x,dz=cabinet.interactionPosition.z-position.z;
      if(dx*dx+dz*dz<=r2)found.push(cabinet);
    }return found;
  }
  #key(x,z){return`${Math.floor(x/this.cellSize)}:${Math.floor(z/this.cellSize)}`}
}
function add(index,key,value){const values=index.get(key);if(values)values.push(value);else index.set(key,[value])}
