import { platformOf } from './emulator-adapter.js';

/** Thin compatibility layer around the proven EmulatorJS, Play!, and Gecko launch path. */
export class LegacyEmulatorAdapter {
  id='legacy-browser-emulator';
  supportedPlatforms=['psx','n64','snes','ps2','gamecube'];
  version='1.0.0';
  capabilities=Object.freeze({saveStates:true,inputRecording:false,deterministicReplay:false,memoryInspection:false,
    screenshotCapture:false,scoreExtraction:false,pause:false,controllerRemapping:true,audioControl:true});
  constructor(hooks){this.hooks=hooks}
  async preflight(context){
    if(!this.supportedPlatforms.includes(platformOf(context.game)))return{ok:false,reason:'unsupported-platform'};
    if(!context.source)return{ok:false,reason:'missing-game-asset'};
    return{ok:true};
  }
  async createSession(context){return{...context,adapterId:this.id,started:false,disposed:false}}
  async start(session){if(session.disposed)throw new Error('Emulator session was disposed.');await this.hooks.start(session);session.started=true}
  async stop(session,reason){if(!session||session.disposed)return;await this.hooks.stop(session,reason);session.started=false}
  async dispose(session){if(!session||session.disposed)return;await this.hooks.dispose(session);session.disposed=true}
}
