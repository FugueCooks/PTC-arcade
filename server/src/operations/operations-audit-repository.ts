import { randomUUID } from 'node:crypto';
import type { SafeJson } from '../../../shared/platform-contracts.js';

export interface OperationsAuditEvent { id:string;operatorId:string;action:string;targetType:string;targetId:string;reason?:string;
  previousState?:Record<string,SafeJson>;resultingState?:Record<string,SafeJson>;timestamp:number;requestId:string;success:boolean;deploymentVersion:string }
export interface OperationsAuditRepository { append(event:Omit<OperationsAuditEvent,'id'|'timestamp'>):Promise<OperationsAuditEvent>; list(limit:number):Promise<OperationsAuditEvent[]> }
export class InMemoryOperationsAuditRepository implements OperationsAuditRepository {
  private readonly events:OperationsAuditEvent[]=[];
  async append(event:Omit<OperationsAuditEvent,'id'|'timestamp'>):Promise<OperationsAuditEvent>{const stored={...structuredClone(event),id:randomUUID(),timestamp:Date.now()};this.events.unshift(stored);if(this.events.length>1_000)this.events.length=1_000;return structuredClone(stored)}
  async list(limit:number):Promise<OperationsAuditEvent[]>{return this.events.slice(0,Math.max(1,Math.min(limit,100))).map(event=>structuredClone(event))}
}
