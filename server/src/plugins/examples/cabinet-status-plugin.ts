import type { ArcadePluginManifest } from '../../../../shared/plugin-contracts.js';
import type { ArcadePlugin, PluginContext, PluginStopReason } from '../plugin-manager.js';

export class CabinetStatusPlugin implements ArcadePlugin {
  private context?: PluginContext;
  constructor(readonly manifest: ArcadePluginManifest) {}
  async initialize(context: PluginContext): Promise<void> { this.context = context;context.register('dashboard-widget', 'cabinet-status', { title: 'Cabinet Status', refreshSeconds: 15 }); }
  async start(): Promise<void> { this.context?.logger.info('cabinet_status_plugin_ready'); }
  async stop(reason: PluginStopReason): Promise<void> { this.context?.logger.info('cabinet_status_plugin_stopping', { reason }); }
  async dispose(): Promise<void> { this.context = undefined; }
}
