import path from 'node:path'
import type { ConfigUISchema, ProviderRegistration } from '@camstack/types'
import { BaseAddon, logDestinationCapability } from '@camstack/types'
import { WinstonDestination } from './winston-destination.js'

interface WinstonConfig {
  readonly level: string
  readonly retentionDays: number
}

/**
 * Winston logging addon — rotated log files + console output.
 * Settings appear under Cluster → NodeDetail → Settings.
 */
export class WinstonLoggingAddon extends BaseAddon<WinstonConfig> {
  private destination: WinstonDestination | null = null

  constructor() {
    super({ level: 'info', retentionDays: 30 })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
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

  protected globalSettingsSchema(): ConfigUISchema {
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
