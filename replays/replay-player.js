export class ReplayPlayer {
  constructor({gameRegistry,adapterRegistry}){this.games=gameRegistry;this.adapters=adapterRegistry;this.runtime=null}
  async load(envelope){
    if(envelope?.replayFormatVersion!==1)throw new Error('Unsupported replay format.');
    const game=this.games.byId.get(envelope.gameId);if(!game)throw new Error('Replay game is unavailable.');
    const adapter=this.adapters.require(envelope.emulatorAdapterId);
    if(typeof adapter.createReplaySession!=='function')throw new Error('This emulator does not support replay playback.');
    this.runtime=await adapter.createReplaySession({game,envelope,liveInput:false,scoreSubmission:false});return this.runtime;
  }
  async start(){if(!this.runtime)throw new Error('Load a replay first.');await this.runtime.start()}
  async stop(){if(!this.runtime)return;await this.runtime.stop?.();await this.runtime.dispose?.();this.runtime=null}
}
