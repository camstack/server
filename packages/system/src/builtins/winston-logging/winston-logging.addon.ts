import path from 'node:path'
import type { ConfigUISchema, ProviderRegistration } from '@camstack/types'
import { BaseAddon, defineAddonMigrations, logDestinationCapability } from '@camstack/types'
import { ADDON_MIGRATIONS, WINSTON_LOGGING_ID } from './migrations/index.js'
import { clusterNodeIds, readRawKeys } from './migrations/node-fields.js'
import { WinstonDestination } from './winston-destination.js'

interface WinstonConfig {
  readonly level: string
  readonly retentionDays: number
}

/**
 * Winston logging addon — rotated log files + console output.
 * Its settings are node settings (D986): each node writes its own files, so the level and the
 * retention are rows `<key>@<nodeId>`, drawn under Cluster → NodeDetail → Settings.
 */
export class WinstonLoggingAddon extends BaseAddon<WinstonConfig> {
  private destination: WinstonDestination | null = null

  constructor() {
    super({ level: 'info', retentionDays: 30 })
  }

  /**
   * Copy the bare level and retention to a node row of every node (D986, D987), then re-resolve
   * the config so this boot opens its files with the node values.
   */
  private async migrateNodeFields(): Promise<void> {
    const report = await this.runMigrations(
      defineAddonMigrations(ADDON_MIGRATIONS, {
        readStored: (keys) =>
          readRawKeys((key) => this.readStoredGlobalKey(key), WINSTON_LOGGING_ID, keys),
        nodeIds: () =>
          clusterNodeIds(() => this.ctx.api.nodes.directory.query(), this.ctx.kernel.localNodeId),
      }),
    )
    if (report.applied.length > 0) await this.resolveConfig()
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    await this.migrateNodeFields()
    // Node-local logs dir — anchored at this node's data root (never the
    // hub-singleton `storage` cap, which would write to the hub's path).
    const logsDir = path.join(this.ctx.nodeDataDir, 'logs')
    this.destination = new WinstonDestination()
    await this.destination.initialize({ ...this.config, logsDir })
    // The hub's files are the cluster's log history (D898): index them now,
    // off-thread, so the first deep read skips. An agent's files are read by
    // nobody, so its reader thread stays unstarted.
    if (this.ctx.kernel.localNodeId === 'hub') this.destination.startBackgroundIndexing()
    this.ctx.logger.info('Winston logging initialized')
    return [{ capability: logDestinationCapability, provider: this.destination }]
  }

  protected async onShutdown(): Promise<void> {
    await this.destination?.shutdown()
  }

  getDestination(): WinstonDestination {
    if (!this.destination) throw new Error('Winston not initialized')
    return this.destination
  }

  protected override scopedSettingsCapabilities(): readonly string[] {
    return ['log-destination']
  }

  protected override async nodeSettingsSchema(cap: string): Promise<ConfigUISchema | null> {
    return cap === 'log-destination' ? this.nodeSchema() : null
  }

  private nodeSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'winston-logging',
          title: 'Logging',
          titleKey: 'server:globalSettings.s_winston-logging.title',
          description: 'Global log verbosity + retention for rotated log files on this node.',
          descriptionKey: 'server:globalSettings.s_winston-logging.description',
          columns: 2,
          fields: [
            this.field({
              type: 'select',
              key: 'level',
              perNode: true,
              label: 'Log Level',
              labelKey: 'server:globalSettings.s_winston-logging.level.label',
              default: 'info',
              options: [
                {
                  value: 'debug',
                  label: 'Debug',
                  labelKey: 'server:globalSettings.s_winston-logging.level.o_debug.label',
                },
                {
                  value: 'info',
                  label: 'Info',
                  labelKey: 'server:globalSettings.s_winston-logging.level.o_info.label',
                },
                {
                  value: 'warn',
                  label: 'Warn',
                  labelKey: 'server:globalSettings.s_winston-logging.level.o_warn.label',
                },
                {
                  value: 'error',
                  label: 'Error',
                  labelKey: 'server:globalSettings.s_winston-logging.level.o_error.label',
                },
              ],
            }),
            this.field({
              type: 'number',
              key: 'retentionDays',
              perNode: true,
              label: 'Retention (days)',
              labelKey: 'server:globalSettings.s_winston-logging.retentionDays.label',
              description: 'Number of days to keep rotated log files before deletion',
              descriptionKey: 'server:globalSettings.s_winston-logging.retentionDays.description',
              min: 1,
              max: 365,
              step: 1,
              default: 30,
              unit: 'days',
            }),
          ],
        },
      ],
    })
  }
}
