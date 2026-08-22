import { socialStatusLabel } from './presence-client.js';

export class InspectionClient {
  constructor(arcade, renderer, presence, getRemote) {
    this.arcade = arcade; this.renderer = renderer; this.presence = presence; this.getRemote = getRemote; this.selectedId = undefined;
    this.panel = document.querySelector('#player-inspection');
    document.querySelector('#inspection-close').addEventListener('click', () => this.close());
    document.querySelector('#follow-player').addEventListener('click', () => this.toggleFollow());
    arcade.getCanvas().addEventListener('click', (event) => this.inspectAt(event));
  }

  inspectAt(event) {
    const id = this.renderer.pickPlayer(event.clientX, event.clientY, innerWidth, innerHeight);
    if (!id || id === this.presence.selfId) return;
    this.selectedId = id; this.refresh(); this.panel.hidden = false;
  }

  refresh() {
    const player = this.presence.get(this.selectedId); if (!player) return this.close();
    document.querySelector('#inspection-name').textContent = player.n;
    document.querySelector('#inspection-avatar').textContent = `AVATAR // ${this.renderer.registry.get(player.v)?.name ?? 'Fallback'}`;
    document.querySelector('#inspection-status').textContent = player.activeCabinetId ? `${socialStatusLabel(player.s)} // ${player.activeCabinetId}` : socialStatusLabel(player.s);
  }

  toggleFollow() {
    const remote = this.getRemote(this.selectedId); if (!remote) return;
    const following = this.arcade.isFollowingPlayer?.();
    if (following) this.arcade.clearPlayerFollow(); else this.arcade.followPlayer(() => remote.avatar.root);
    document.querySelector('#follow-player').textContent = following ? 'FOLLOW CAMERA' : 'STOP FOLLOWING';
  }

  close() { this.arcade.clearPlayerFollow?.(); this.selectedId = undefined; this.panel.hidden = true; document.querySelector('#follow-player').textContent = 'FOLLOW CAMERA'; }
}
