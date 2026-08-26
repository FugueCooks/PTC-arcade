import { GameSession } from './game-session.js';

export class GameLauncher {
  #activeByCabinet=new Map();
  constructor({gameRegistry,adapterRegistry,contextProvider=()=>({})}){
    this.games=gameRegistry;this.adapters=adapterRegistry;this.contextProvider=contextProvider;
  }
  resolve(cabinet){return this.games.byId.get(cabinet.gameRegistryId)||this.games.byCabinetId.get(cabinet.id)}
  async launch(cabinet,source,options={}){
    if(this.#activeByCabinet.has(cabinet.id))await this.stop(cabinet.id,'replaced');
    const game=this.resolve(cabinet);if(!game?.enabled)throw new Error('Game is unavailable.');
    const adapter=this.adapters.require(game.emulatorAdapterId);
    const identity=this.contextProvider();
    const lifecycle=new GameSession({subjectId:identity.subjectId||'local',playerId:identity.playerId||'local',roomId:identity.roomId||'local',
      cabinetId:cabinet.id,gameId:game.id,emulatorAdapterId:adapter.id});
    const context={cabinet,game,source,options,lifecycle};
    try{
      lifecycle.transition('PREFLIGHT');const preflight=await adapter.preflight(context);
      if(!preflight?.ok)throw new Error(preflight?.reason||'Emulator preflight failed.');
      lifecycle.transition('READY');lifecycle.transition('STARTING');
      const runtime=await adapter.createSession(context);this.#activeByCabinet.set(cabinet.id,{adapter,runtime,lifecycle});
      await adapter.start(runtime);lifecycle.transition('ACTIVE');
      window.dispatchEvent(new CustomEvent('arcade:game-session-started',{detail:lifecycle.snapshot()}));
      return lifecycle.snapshot();
    }catch(error){
      if(!['FAILED','DISPOSED'].includes(lifecycle.record.status))lifecycle.transition('FAILED',Date.now(),error?.message||'launch-failed');
      this.#activeByCabinet.delete(cabinet.id);
      window.dispatchEvent(new CustomEvent('arcade:game-session-failed',{detail:lifecycle.snapshot()}));
      throw error;
    }
  }
  async stop(cabinetId,reason='player-exit'){
    const active=this.#activeByCabinet.get(cabinetId);if(!active)return false;
    this.#activeByCabinet.delete(cabinetId);
    try{active.lifecycle.stop(reason);await active.adapter.stop(active.runtime,reason)}finally{
      await active.adapter.dispose(active.runtime);active.lifecycle.dispose();
      window.dispatchEvent(new CustomEvent('arcade:game-session-ended',{detail:active.lifecycle.snapshot()}));
    }
    return true;
  }
  active(cabinetId){return this.#activeByCabinet.get(cabinetId)?.lifecycle.snapshot()}
}
