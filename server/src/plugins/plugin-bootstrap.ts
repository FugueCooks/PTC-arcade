import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerConfig } from '../config.js';
import { FilesystemPluginStorageBackend } from './filesystem-plugin-storage.js';
import { PluginHost, type ArcadePlugin } from './plugin-host.js';
import type { PluginHostServices } from './plugin-context.js';

/**
 * Milestone 11.7 — operator-controlled plugin installation.
 *
 * The registry below is a static map from plugin ID to factory. That is
 * deliberate and load-bearing: there is no directory scan and no dynamic import
 * of a computed path, so the set of code that can ever run is fixed at build
 * time and an operator only chooses which of it is enabled. Adding a plugin is
 * a code change and a review, never a runtime discovery.
 */
type PluginFactory = () => ArcadePlugin;

/**
 * Plugin ID to its entry file, relative to the project root. The set of paths
 * here is fixed in source: an operator chooses which of these IDs to enable,
 * never what path an ID points at, and no value from configuration, a request,
 * or a manifest ever reaches the import below. Only the project root is
 * resolved at runtime, because the build emits to dist/ and the plugin ships as
 * plain JavaScript beside it.
 */
const FIRST_PARTY_PLUGIN_PATHS: Readonly<Record<string, string>> = Object.freeze({
  'example-info-kiosk': 'plugins/example-info-kiosk/server.js'
});

const FACTORY_EXPORTS: Readonly<Record<string, string>> = Object.freeze({
  'example-info-kiosk': 'createInfoKioskPlugin'
});

async function loadFirstPartyPlugin(pluginId: string, projectRoot: string): Promise<PluginFactory | undefined> {
  const relativePath = FIRST_PARTY_PLUGIN_PATHS[pluginId];
  if (relativePath === undefined) return undefined;
  const specifier = pathToFileURL(path.resolve(projectRoot, relativePath)).href;
  const module = await import(specifier) as Record<string, unknown>;
  const factory = module[FACTORY_EXPORTS[pluginId]];
  return typeof factory === 'function' ? factory as PluginFactory : undefined;
}

export interface PluginBootstrapResult {
  host: PluginHost;
  /** Requested IDs that matched no known first-party plugin. */
  unknownPluginIds: readonly string[];
}

export async function bootstrapPlugins(
  config: ServerConfig,
  services: PluginHostServices,
  logger: (level: 'info' | 'warn' | 'error', event: string, details: Record<string, unknown>) => void
): Promise<PluginBootstrapResult> {
  const host = new PluginHost({
    services,
    storageBackend: new FilesystemPluginStorageBackend(path.resolve(process.cwd(), config.pluginStorageDirectory)),
    quota: {
      maxKeys: config.pluginStorageMaxKeys,
      maxValueBytes: 64 * 1024,
      maxTotalBytes: config.pluginStorageMaxTotalBytes
    },
    logger
  });

  const projectRoot = path.resolve(process.cwd());
  const unknownPluginIds: string[] = [];
  for (const pluginId of config.enabledPluginIds) {
    if (!Object.hasOwn(FIRST_PARTY_PLUGIN_PATHS, pluginId)) {
      // Named but unknown: reported, never silently ignored.
      unknownPluginIds.push(pluginId);
      logger('warn', 'plugin_unknown', { pluginId });
      continue;
    }
    try {
      const factory = await loadFirstPartyPlugin(pluginId, projectRoot);
      if (!factory) {
        logger('error', 'plugin_load_failed', { pluginId, error: 'entry file exported no factory' });
        continue;
      }
      const result = host.install({ plugin: factory(), approved: true });
      if (!result.ok) logger('warn', 'plugin_install_rejected', { pluginId, problems: result.problems });
    } catch (error) {
      // A plugin that cannot even be constructed must not stop the server.
      logger('error', 'plugin_load_failed', { pluginId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  await host.startAll();
  logger('info', 'plugins_started', { ...host.health(), unknownPluginIds });
  return { host, unknownPluginIds };
}
