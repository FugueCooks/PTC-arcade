import { AnimationMixer } from 'three';

export class AvatarAnimationController {
  constructor(root, clips, mappings, options = {}) {
    this.mixer = new AnimationMixer(root);
    this.actions = new Map(clips.map((clip) => [clip.name, this.mixer.clipAction(clip)]));
    this.mappings = mappings ?? {};
    this.options = options ?? {};
    this.current = undefined;
    this.setState('idle', true);
  }

  setState(state, immediate = false) {
    const logicalState = this.mappings[state] ? state : 'idle';
    const clipName = this.mappings[logicalState];
    if (!clipName) {
      if (state === 'idle' && this.current) {
        this.current.fadeOut(0.16);
        this.current = undefined;
      }
      return;
    }
    const next = clipName ? this.actions.get(clipName) : undefined;
    if (!next || this.current === next) return;
    const previous = this.current;
    this.current = next;
    const holdTime = this.options[logicalState]?.holdTime;
    next.reset().setEffectiveWeight(1).play();
    next.paused = false;
    if (Number.isFinite(holdTime)) {
      next.time = holdTime;
      // Apply the selected action-pose frame once, then keep it perfectly
      // still while the movement system supplies the actual hover motion.
      this.mixer.update(0);
      next.paused = true;
    }
    if (previous) {
      if (immediate) previous.stop();
      else previous.crossFadeTo(next, 0.18, false);
    }
  }

  update(delta) { this.mixer.update(delta); }

  dispose(root) {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(root);
    this.actions.clear();
  }
}
