const transitions={
  CREATED:['PREFLIGHT','FAILED','DISPOSED'],PREFLIGHT:['READY','FAILED','STOPPING'],READY:['STARTING','STOPPING','FAILED'],
  STARTING:['ACTIVE','FAILED','STOPPING'],ACTIVE:['PAUSED','STOPPING','COMPLETED','FAILED'],PAUSED:['ACTIVE','STOPPING','FAILED'],
  STOPPING:['COMPLETED','FAILED','DISPOSED'],COMPLETED:['DISPOSED'],FAILED:['DISPOSED'],DISPOSED:[]
};

export class GameSession {
  constructor(input,now=Date.now()){
    this.record={sessionId:crypto.randomUUID(),...input,status:'CREATED',createdAt:now,
      replayCaptureStatus:'NOT_REQUESTED',scoreSubmissionStatus:'NOT_REQUESTED'};
  }
  transition(next,now=Date.now(),reason){
    if(this.record.status===next)return this.snapshot();
    if(!transitions[this.record.status]?.includes(next))throw new Error(`Invalid game session transition: ${this.record.status} -> ${next}`);
    this.record.status=next;
    if(next==='READY')this.record.preflightCompletedAt=now;
    if(next==='ACTIVE'&&this.record.startedAt===undefined)this.record.startedAt=now;
    if(next==='PAUSED')this.record.pausedAt=now;
    if(['COMPLETED','FAILED','DISPOSED'].includes(next))this.record.endedAt??=now;
    if(reason)this.record.stopReason=reason;
    return this.snapshot();
  }
  stop(reason='player-exit',now=Date.now()){
    if(['COMPLETED','FAILED','DISPOSED'].includes(this.record.status))return this.snapshot();
    if(this.record.status!=='STOPPING')this.transition('STOPPING',now,reason);
    return this.transition('COMPLETED',now,reason);
  }
  dispose(now=Date.now()){
    if(this.record.status==='DISPOSED')return this.snapshot();
    if(!['COMPLETED','FAILED'].includes(this.record.status))this.stop('disposed',now);
    return this.transition('DISPOSED',now);
  }
  snapshot(){return structuredClone(this.record)}
}
