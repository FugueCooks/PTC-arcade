import type { Express, Response } from 'express';
import express from 'express';
import path from 'node:path';

export interface PublicRuntimeConfig {
  gameAssetBaseUrl: string;
  biosAssetUrl: string;
  realtimeUrl: string;
}

const ROOT_FILES = [
  'index.html',
  'player.html',
  'style.css',
  'app-bootstrap.js',
  'arcade.js',
  'avatar-selection.js',
  'multiplayer-client.js'
] as const;

const PUBLIC_DIRECTORIES = ['assets', 'avatars', 'cabinets', 'games', 'rooms', 'social', 'world', 'realtime'] as const;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

/** Build the small public configuration object injected before arcade.js. */
export function publicRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): PublicRuntimeConfig {
  return {
    gameAssetBaseUrl: normalizeBaseUrl(environment.GAME_ASSET_BASE_URL),
    biosAssetUrl: normalizeAssetUrl(environment.BIOS_ASSET_URL),
    realtimeUrl: normalizeAssetUrl(environment.REALTIME_URL)
  };
}

/** Serve only browser assets, never server source, tests, package metadata, or local tooling. */
export function installStaticHosting(app: Express, projectRoot: string, runtime = publicRuntimeConfig()): void {
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.get('/healthz', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ ok: true, service: 'roms-retro-arcade', now: Date.now() });
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

function sendRootFile(response: Response, projectRoot: string, file: typeof ROOT_FILES[number]): void {
  response.setHeader('Cache-Control', file.endsWith('.html') ? 'no-store' : 'public, max-age=300, must-revalidate');
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
  response.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
}
