export class CabinetVisualState {
  constructor(arcade) { this.arcade = arcade; this.states = new Map(); this.ready = false; }
  applySnapshot(cabinets) {
    this.states.clear();
    cabinets.forEach((state) => this.states.set(state.cabinetId, state));
    this.ready = true;
    this.arcade.setCabinetStates?.(this.states, true);
  }
  apply(state) {
    this.states.set(state.cabinetId, state);
    this.arcade.setCabinetState?.(state);
  }
  reset() {
    this.states.clear(); this.ready = false;
    this.arcade.setCabinetStates?.(this.states, false);
  }
}

