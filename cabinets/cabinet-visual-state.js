export class CabinetVisualState {
  constructor(arcade) { this.arcade = arcade; this.states = new Map(); this.ready = false; this.revisions = new Map(); }
  applySnapshot(snapshot) {
    const cabinets=Array.isArray(snapshot)?snapshot:snapshot?.cabinets;
    if(!Array.isArray(cabinets))return false;
    const zoneId=Array.isArray(snapshot)?'legacy':snapshot.zoneId||'legacy',revision=Array.isArray(snapshot)?0:Number(snapshot.revision)||0;
    this.states.clear();
    cabinets.forEach((state) => this.states.set(state.cabinetId, state));
    this.revisions.set(zoneId,revision);
    this.ready = true;
    this.arcade.setCabinetStates?.(this.states, true);
    return true;
  }
  apply(state) {
    this.states.set(state.cabinetId, state);
    this.arcade.setCabinetState?.(state);
  }
  applyDelta(delta){
    if(!delta||!Array.isArray(delta.changes)||typeof delta.zoneId!=='string')return false;
    const current=this.revisions.get(delta.zoneId)??0;
    if(delta.previousRevision!==current){window.dispatchEvent(new CustomEvent('arcade:cabinet-resync-required',{detail:{zoneId:delta.zoneId,expectedRevision:current,receivedRevision:delta.revision}}));return false}
    delta.changes.forEach((state)=>this.apply(state));this.revisions.set(delta.zoneId,delta.revision);return true;
  }
  reset() {
    this.states.clear(); this.revisions.clear(); this.ready = false;
    this.arcade.setCabinetStates?.(this.states, false);
  }
}
