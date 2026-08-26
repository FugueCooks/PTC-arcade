import type { SafeJson } from '../../../shared/platform-contracts.js';
import type { CabinetManager } from '../cabinets/cabinet-manager.js';
import type { HealthService } from '../health/health-service.js';
import type { RuntimeMetrics } from '../metrics/metrics.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type { RoomManager } from '../rooms/room-manager.js';
import type { GameLauncherService } from '../games/game-launcher-service.js';
import type { BackgroundJobQueue } from '../jobs/job-queue.js';
import type { OperationsAuditRepository } from './operations-audit-repository.js';

export interface OperationsAction { action:'cabinet.enable'|'cabinet.disable'|'room.maintenance'|'room.close-empty'|'plugin.disable';targetId:string;reason?:string;dryRun?:boolean }
export class OperationsService {
  constructor(private readonly dependencies:{rooms:RoomManager;cabinets:CabinetManager;plugins:PluginManager;games:GameLauncherService;jobs:BackgroundJobQueue;
    health:HealthService;metrics:RuntimeMetrics;audit:OperationsAuditRepository;deploymentVersion:string;serverId:string}){}
  async overview(){return{serverId:this.dependencies.serverId,deploymentVersion:this.dependencies.deploymentVersion,ready:this.dependencies.health.readiness(),
    rooms:this.dependencies.rooms.records,roomCount:this.dependencies.rooms.roomCount,activeGameSessions:this.dependencies.games.activeCount,
    cabinetDefinitions:this.dependencies.cabinets.index.size,plugins:this.dependencies.plugins.list(),backgroundQueueDepth:await this.dependencies.jobs.depth()}}
  async act(operatorId:string,requestId:string,input:OperationsAction){
    const previous=this.state(input);let success=false,resulting:Record<string,SafeJson>|undefined;
    if(!input.dryRun){
      if(input.action==='cabinet.enable')success=this.dependencies.cabinets.setEnabled(input.targetId,true);
      if(input.action==='cabinet.disable')success=this.dependencies.cabinets.setEnabled(input.targetId,false);
      if(input.action==='room.maintenance'){const room=this.dependencies.rooms.get(input.targetId);if(room){room.setStatus('draining');success=true}}
      if(input.action==='room.close-empty')success=this.dependencies.rooms.close(input.targetId);
      if(input.action==='plugin.disable')success=Boolean(await this.dependencies.plugins.stop(input.targetId,'disabled'));
      resulting=this.state(input);
    }else success=this.targetExists(input);
    await this.dependencies.audit.append({operatorId,action:input.action,targetType:input.action.split('.')[0],targetId:input.targetId,reason:input.reason,
      previousState:previous,resultingState:resulting,requestId,success,deploymentVersion:this.dependencies.deploymentVersion});
    if(success)this.dependencies.metrics.increment('operations_actions_total');return{ok:success,dryRun:Boolean(input.dryRun),previousState:previous,resultingState:resulting};
  }
  private targetExists(input:OperationsAction):boolean{if(input.action.startsWith('cabinet.'))return Boolean(this.dependencies.cabinets.index.get(input.targetId));if(input.action.startsWith('room.'))return Boolean(this.dependencies.rooms.get(input.targetId));return this.dependencies.plugins.list().some(plugin=>plugin.id===input.targetId)}
  private state(input:OperationsAction):Record<string,SafeJson>|undefined{if(input.action.startsWith('cabinet.')){const cabinet=this.dependencies.cabinets.index.get(input.targetId);return cabinet?{id:cabinet.id,enabled:this.dependencies.cabinets.isEnabled(cabinet.id)}:undefined}
    if(input.action.startsWith('room.')){const room=this.dependencies.rooms.get(input.targetId);return room?{id:room.id,status:room.status,population:room.memberCount}:undefined}
    const plugin=this.dependencies.plugins.list().find(value=>value.id===input.targetId);return plugin?{id:plugin.id,status:plugin.status}:undefined}
}
