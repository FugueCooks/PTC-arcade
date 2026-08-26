export class ArcadeApiError extends Error{constructor(message,{status,code,requestId,details}={}){super(message);this.name='ArcadeApiError';this.status=status;this.code=code;this.requestId=requestId;this.details=details}}
export class ArcadeApiClient{
  constructor({baseUrl='',fetchImpl=fetch}={}){this.baseUrl=baseUrl.replace(/\/$/,'');this.fetchImpl=fetchImpl;this.inflight=new Map()}
  get(path,{signal,dedupe=true}={}){return this.request(path,{method:'GET',signal,dedupe})}
  post(path,body,{signal,idempotencyKey}={}){return this.request(path,{method:'POST',body,signal,idempotencyKey})}
  async request(path,{method='GET',body,signal,dedupe=method==='GET',idempotencyKey}={}){
    const key=`${method}:${path}`;if(dedupe&&this.inflight.has(key))return this.inflight.get(key);
    const operation=this.#execute(path,{method,body,signal,idempotencyKey});if(dedupe)this.inflight.set(key,operation);
    try{return await operation}finally{if(this.inflight.get(key)===operation)this.inflight.delete(key)}
  }
  async #execute(path,{method,body,signal,idempotencyKey}){
    const headers={Accept:'application/json'};if(body!==undefined)headers['Content-Type']='application/json';if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
    const response=await this.fetchImpl(`${this.baseUrl}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'include',signal});
    const requestId=response.headers.get('x-request-id')||undefined;let payload;try{payload=await response.json()}catch{throw new ArcadeApiError('The server returned an unreadable response.',{status:response.status,requestId})}
    if(!response.ok)throw new ArcadeApiError(payload?.error?.message||'The request failed.',{status:response.status,code:payload?.error?.code,requestId:payload?.error?.requestId||requestId,details:payload?.error?.details});return payload;
  }
}
