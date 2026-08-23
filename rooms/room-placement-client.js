const runtime = window.ARCADE_RUNTIME ?? {};

export class RoomPlacementClient {
  constructor(baseUrl = runtime.matchmakingUrl || '') { this.baseUrl = String(baseUrl).replace(/\/$/, ''); }

  async rooms(signal) {
    const response = await fetch(`${this.baseUrl}/api/rooms`, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Room list is temporarily unavailable.');
    return (await response.json()).rooms ?? [];
  }

  async quickJoin(roomId, { signal, attempts = 4, onWaiting, resumeToken } = {}) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}/api/rooms/quick-join`, {
          method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId: roomId || undefined, resumeToken })
        });
        const result = await response.json();
        if (response.ok && result.ok) return result;
        if (response.status !== 429 && response.status !== 503) throw new Error('The selected arcade is unavailable.');
        const delay = Math.min(5_000, Number(result.retryAfterMs) || 1_500) * (attempt + 1);
        onWaiting?.({ attempt: attempt + 1, delay });
        await wait(delay, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        // A deployment without the Phase 7 API keeps the established direct
        // connection path, so the current Cloudflare rollback remains usable.
        if (!this.baseUrl) return undefined;
        throw error;
      }
    }
    throw new Error('All arcade rooms are busy. Please try again shortly.');
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Canceled', 'AbortError')); }, { once: true });
  });
}
