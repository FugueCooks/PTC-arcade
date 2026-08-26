/**
 * Client half of the example plugin. Renders the kiosk panel from data the
 * server half produced; it performs no privileged work of its own, which is the
 * intended shape for a plugin's client entrypoint.
 */
export function createInfoKioskClient({ mount } = {}) {
  return {
    id: 'example-info-kiosk',

    render(state) {
      const lines = [state.greeting];
      if (state.population !== null && state.population !== undefined) lines.push(`${state.population} PLAYER(S) IN THIS ROOM`);
      lines.push(`VIEWED ${state.views} TIME(S)`);
      const text = lines.join('\n');
      if (mount) mount.textContent = text;
      return text;
    }
  };
}
