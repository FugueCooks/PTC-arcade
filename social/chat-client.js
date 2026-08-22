export class ChatClient {
  constructor(socket) {
    this.socket = socket;
    this.panel = document.querySelector('#chat-panel');
    this.messages = document.querySelector('#chat-messages');
    this.form = document.querySelector('#chat-form');
    this.input = document.querySelector('#chat-input');
    this.fadeTimer = 0;
    this.form.addEventListener('submit', (event) => this.submit(event));
    document.addEventListener('keydown', (event) => this.keydown(event));
    socket.on('chat:snapshot', ({ messages }) => { this.messages.replaceChildren(); messages.forEach((message) => this.add(message, false)); });
    socket.on('chat:message', (message) => this.add(message, true));
  }

  keydown(event) {
    if (event.code === 'Enter' && !this.isOpen() && !document.querySelector('#machine-modal')?.matches('[style*="display: grid"]')) {
      event.preventDefault();
      this.open();
    } else if (event.code === 'Escape' && this.isOpen()) {
      event.stopImmediatePropagation();
      this.close();
    }
  }

  open() {
    document.exitPointerLock?.();
    this.form.hidden = false;
    this.panel.classList.add('active');
    this.input.focus();
  }

  close() {
    this.form.hidden = true;
    this.input.value = '';
    this.input.blur();
    this.scheduleFade();
  }

  isOpen() { return !this.form.hidden; }

  submit(event) {
    event.preventDefault();
    const text = this.input.value.trim();
    if (!text) return this.close();
    this.socket.emit('chat:send', { text }, (result) => {
      if (result?.ok) { this.input.value = ''; this.close(); }
      else this.input.setCustomValidity(result?.reason === 'rate-limited' ? 'Please slow down.' : 'Message could not be sent.');
      this.input.reportValidity();
      setTimeout(() => this.input.setCustomValidity(''), 1200);
    });
  }

  add(message, announce) {
    const line = document.createElement('p');
    line.className = `chat-line ${message.kind}`;
    if (message.kind === 'chat') {
      const name = document.createElement('b');
      name.textContent = `${message.displayName}: `;
      line.append(name, document.createTextNode(message.text));
    } else line.textContent = message.text;
    this.messages.append(line);
    while (this.messages.children.length > 40) this.messages.firstElementChild.remove();
    this.messages.scrollTop = this.messages.scrollHeight;
    this.panel.classList.add('active');
    this.scheduleFade();
    if (announce && message.kind !== 'chat') line.animate([{ opacity: 0, transform: 'translateX(-12px)' }, { opacity: 1, transform: 'none' }], { duration: 250 });
  }

  scheduleFade() {
    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => { if (!this.isOpen()) this.panel.classList.remove('active'); }, 6500);
  }
}
