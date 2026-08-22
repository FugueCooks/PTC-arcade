export class ReactionClient {
  constructor(socket, resolveAvatar) {
    this.socket = socket;
    this.resolveAvatar = resolveAvatar;
    document.querySelector('#reaction-bar').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-reaction]');
      if (!button || button.classList.contains('cooldown')) return;
      socket.emit('reaction:send', { emoji: button.dataset.reaction }, (result) => {
        if (result?.ok) this.cooldown(button);
      });
    });
    socket.on('reaction:shown', ({ playerId, emoji, durationMs }) => this.resolveAvatar(playerId)?.showReaction(emoji, durationMs));
  }

  cooldown(button) {
    button.classList.add('cooldown');
    setTimeout(() => button.classList.remove('cooldown'), 550);
  }
}
