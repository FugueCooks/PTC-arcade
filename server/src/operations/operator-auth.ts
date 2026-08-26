import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RedisClientType } from 'redis';
import type { RedisKeys } from '../redis/redis-keys.js';

export interface OperatorSession { operatorId: string; permissions: string[]; expiresAt: number }
export interface OperatorSessionStore { put(tokenHash: string, session: OperatorSession, ttlMs: number): Promise<void>; get(tokenHash: string): Promise<OperatorSession|undefined>; delete(tokenHash: string): Promise<void> }
export class InMemoryOperatorSessionStore implements OperatorSessionStore {
  private readonly sessions=new Map<string,OperatorSession>();
  async put(hash:string,session:OperatorSession):Promise<void>{this.sessions.set(hash,{...session,permissions:[...session.permissions]})}
  async get(hash:string):Promise<OperatorSession|undefined>{const value=this.sessions.get(hash);if(!value)return undefined;if(value.expiresAt<=Date.now()){this.sessions.delete(hash);return undefined}return{...value,permissions:[...value.permissions]}}
  async delete(hash:string):Promise<void>{this.sessions.delete(hash)}
}
export class RedisOperatorSessionStore implements OperatorSessionStore {
  constructor(private readonly client:RedisClientType,private readonly keys:RedisKeys){}
  async put(hash:string,session:OperatorSession,ttlMs:number):Promise<void>{await this.client.set(this.keys.operatorSession(hash),JSON.stringify(session),{expiration:{type:'PX',value:ttlMs}})}
  async get(hash:string):Promise<OperatorSession|undefined>{const value=await this.client.get(this.keys.operatorSession(hash));if(!value)return undefined;try{const session=JSON.parse(value) as OperatorSession;return session.expiresAt>Date.now()?session:undefined}catch{return undefined}}
  async delete(hash:string):Promise<void>{await this.client.del(this.keys.operatorSession(hash))}
}
export class OperatorAuthService {
  constructor(private readonly store:OperatorSessionStore,private readonly bootstrapSecret:string|undefined,private readonly ttlMs:number){}
  get enabled():boolean{return Boolean(this.bootstrapSecret)}
  async login(secret:unknown):Promise<{token:string;session:OperatorSession}|undefined>{
    if(typeof secret!=='string'||!this.bootstrapSecret||!equal(secret,this.bootstrapSecret))return undefined;
    const token=randomBytes(32).toString('base64url'),session={operatorId:'bootstrap-operator',permissions:['operations:read','operations:write'],expiresAt:Date.now()+this.ttlMs};
    await this.store.put(hash(token),session,this.ttlMs);return{token,session};
  }
  async authenticate(token:string|undefined):Promise<OperatorSession|undefined>{if(!token)return undefined;return this.store.get(hash(token))}
  async logout(token:string|undefined):Promise<void>{if(token)await this.store.delete(hash(token))}
}
function hash(value:string):string{return createHash('sha256').update(value).digest('hex')}
function equal(left:string,right:string):boolean{const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b)}
