const controls=new Set(['UP','DOWN','LEFT','RIGHT','ACTION_1','ACTION_2','START','SELECT']);
export class InputRecorder {
  constructor({tickRate=60,now=()=>performance.now()}={}){this.tickRate=tickRate;this.now=now;this.events=[];this.startedAt=0;this.active=false;this.states=new Map()}
  start(){this.events=[];this.states.clear();this.startedAt=this.now();this.active=true}
  record(control,pressed,playerIndex=0){
    if(!this.active||!controls.has(control)||typeof pressed!=='boolean'||!Number.isInteger(playerIndex)||playerIndex<0)return false;
    const key=`${playerIndex}:${control}`;if(this.states.get(key)===pressed)return false;this.states.set(key,pressed);
    this.events.push({control,pressed,tick:Math.max(0,Math.round((this.now()-this.startedAt)/1000*this.tickRate)),playerIndex});return true;
  }
  stop(){this.active=false;return this.snapshot()}
  snapshot(){return this.events.map(event=>({...event}))}
}
