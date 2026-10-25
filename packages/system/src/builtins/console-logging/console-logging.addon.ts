import type { ConfigUISchema, ProviderRegistration } from '@camstack/types'
import { BaseAddon, logDestinationCapability } from '@camstack/types'
import { ConsoleDestination } from './console-destination.js'

interface ConsoleConfig {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
}

/**
 * Console logging addon — zero-dependency stdout/stderr sink that
 * produces the same canonical line format as the Winston built-in.
 * Registers as a `log-destination` capability provider so the shared
 * LogManager fans every entry to both sinks when both are active.
 *
 * Settings live under Cluster → NodeDetail → Settings alongside the
 * Winston addon. Disable one without disabling the other — the
 * LogManager keeps working as long as at least one destination is
 * registered.
 */
export class ConsoleLoggingAddon extends BaseAddon<ConsoleConfig> {
  private destination: ConsoleDestination | null = null

  constructor() {
    super({ level: 'info' })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.destination = new ConsoleDestination()
    await this.destination.initialize({ level: this.config.level })
    this.ctx.logger.info('Console logging initialized')
    return [{ capability: logDestinationCapability, provider: this.destination }]
  }

  protected async onShutdown(): Promise<void> {
    await this.destination?.shutdown()
  }

  getDestination(): ConsoleDestination {
    if (!this.destination) throw new Error('Console logging not initialized')
    return this.destination
  }

  protected globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'console-logging',
          title: 'Console Logging',
          titleKey: 'server:globalSettings.s_console-logging.title',
          description:
            'Minimum log level to emit on stdout/stderr. Independent from the rotated-file (Winston) destination.',
          descriptionKey: 'server:globalSettings.s_console-logging.description',
          columns: 2,
          fields: [
            this.field({
              type: 'select',
              key: 'level',
              label: 'Log Level',
              labelKey: 'server:globalSettings.s_console-logging.level.label',
              default: 'info',
              options: [
                {
                  value: 'debug',
                  label: 'Debug',
                  labelKey: 'server:globalSettings.s_console-logging.level.o_debug.label',
                },
                {
                  value: 'info',
                  label: 'Info',
                  labelKey: 'server:globalSettings.s_console-logging.level.o_info.label',
                },
                {
                  value: 'warn',
                  label: 'Warn',
                  labelKey: 'server:globalSettings.s_console-logging.level.o_warn.label',
                },
                {
                  value: 'error',
                  label: 'Error',
                  labelKey: 'server:globalSettings.s_console-logging.level.o_error.label',
                },
              ],
            }),
          ],
        },
      ],
    })
  }
}
