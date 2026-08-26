export class GhostSession {
  constructor({type,source,onUpdate}){if(!['input','timing','score-progress','positional','checkpoint'].includes(type))throw new Error('Unsupported ghost type.');this.type=type;this.source=structuredClone(source);this.onUpdate=onUpdate;this.active=false}
  start(){this.active=true}
  update(progress){if(this.active)this.onUpdate?.(structuredClone(progress),structuredClone(this.source))}
  stop(){this.active=false}
  /** Ghost data is copied on both boundaries so it cannot mutate official session state. */
  snapshot(){return structuredClone({type:this.type,source:this.source,active:this.active})}
}
