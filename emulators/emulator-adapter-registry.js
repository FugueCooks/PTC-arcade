export class EmulatorAdapterRegistry {
  #adapters=new Map();
  register(adapter){
    if(!adapter||typeof adapter.id!=='string'||typeof adapter.preflight!=='function'||typeof adapter.createSession!=='function'
      ||typeof adapter.start!=='function'||typeof adapter.stop!=='function'||typeof adapter.dispose!=='function')throw new Error('Invalid emulator adapter.');
    if(this.#adapters.has(adapter.id))throw new Error(`Duplicate emulator adapter: ${adapter.id}`);
    this.#adapters.set(adapter.id,adapter);return this;
  }
  get(id){return this.#adapters.get(id)}
  require(id){const adapter=this.get(id);if(!adapter)throw new Error(`Unknown emulator adapter: ${id}`);return adapter}
  list(){return [...this.#adapters.values()]}
}
