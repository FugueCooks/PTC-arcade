import type { Express, Response } from 'express';
import express from 'express';
import path from 'node:path';

export interface PublicRuntimeConfig {
  gameAssetBaseUrl: string;
  biosAssetUrl: string;
  gameCubeDspAssetUrl: string;
  realtimeUrl: string;
  matchmakingUrl: string;
  solanaNetwork: string;
}

export const ROOT_FILES = [
  'index.html',
  'player.html',
  'style.css',
  'app-bootstrap.js',
  'arcade.js',
  'avatar-selection.js',
  'multiplayer-client.js'
] as const;

export const PUBLIC_DIRECTORIES = ['assets', 'avatars', 'cabinets', 'emulators', 'games', 'rooms', 'social', 'world', 'realtime', 'wallet'] as const;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

/** Build the small public configuration object injected before arcade.js. */
export function publicRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): PublicRuntimeConfig {
  return {
    gameAssetBaseUrl: normalizeBaseUrl(environment.GAME_ASSET_BASE_URL),
    biosAssetUrl: normalizeAssetUrl(environment.BIOS_ASSET_URL),
    gameCubeDspAssetUrl: normalizeAssetUrl(environment.GAMECUBE_DSP_ASSET_URL),
    realtimeUrl: normalizeAssetUrl(environment.REALTIME_URL),
    matchmakingUrl: normalizeAssetUrl(environment.MATCHMAKING_URL),
    solanaNetwork: normalizeSolanaNetwork(environment.SOLANA_NETWORK)
  };
}

/** Serve only browser assets, never server source, tests, package metadata, or local tooling. */
export function installStaticHosting(app: Express, projectRoot: string, runtime = publicRuntimeConfig()): void {
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Play!'s browser PS2 core uses SharedArrayBuffer workers. Credentialless
    // isolation keeps CDN-hosted emulator and model assets usable without cookies.
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    next();
  });

  app.get('/runtime-config.js', (_request, response) => {
    response.type('application/javascript');
    response.setHeader('Cache-Control', 'no-store');
    response.send(runtimeConfigScript(runtime));
  });

  for (const directory of PUBLIC_DIRECTORIES) {
    const immutableGames = directory === 'assets';
    app.use(`/${directory}`, express.static(path.join(projectRoot, directory), {
      acceptRanges: true,
      dotfiles: 'deny',
      etag: true,
      fallthrough: false,
      setHeaders: (response, filePath) => setAssetCacheHeaders(response, filePath, immutableGames)
    }));
  }

  app.get('/', (_request, response) => sendRootFile(response, projectRoot, 'index.html'));
  for (const file of ROOT_FILES) {
    app.get(`/${file}`, (_request, response) => sendRootFile(response, projectRoot, file));
  }
}

export function runtimeConfigScript(config: PublicRuntimeConfig): string {
  const serialized = JSON.stringify(config).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `window.ARCADE_RUNTIME = Object.freeze(${serialized});\n`;
}

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  return trimmed.replace(/\/+$/, '');
}

function normalizeAssetUrl(value: string | undefined): string {
  return value?.trim() ?? '';
}

function normalizeSolanaNetwork(value: string | undefined): string {
  return ['mainnet-beta', 'devnet', 'testnet', 'localnet'].includes(value ?? '') ? value! : 'mainnet-beta';
}

function sendRootFile(response: Response, projectRoot: string, file: typeof ROOT_FILES[number]): void {
  // arcade.js and app-bootstrap.js are application code, so they revalidate for
  // the same reason the module directories do — see setAssetCacheHeaders.
  response.setHeader('Cache-Control', file.endsWith('.html') ? 'no-store' : 'no-cache');
  response.sendFile(path.join(projectRoot, file));
}

function setAssetCacheHeaders(response: Response, filePath: string, includesGames: boolean): void {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase();
  if (includesGames && normalized.includes('/assets/games/')) {
    response.setHeader('Cache-Control', `public, max-age=${ONE_YEAR_MS / 1_000}, immutable`);
    return;
  }
  if (normalized.includes('/assets/')) {
    response.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return;
  }
  // Application code, not content. The `?v=` tokens in the import graph only
  // version the modules app-bootstrap.js names directly: everything they import
  // in turn — the emulator adapters among them — is requested at a plain URL. So
  // an hour of max-age, plus a day of stale-while-revalidate, meant a deployed
  // fix could sit unreachable behind a browser cache while the page looked
  // current. `no-cache` still stores the file and still sends the ETag; it just
  // asks first, and the answer is almost always a 304.
  response.setHeader('Cache-Control', 'no-cache');
}
