import type { ProviderRegistration } from '@camstack/types'
import { BaseAddon, logDestinationCapability } from '@camstack/types'
import { HubForwarderDestination } from './hub-forwarder-destination.js'

/**
 * Agent-only addon that provides the `log-destination` capability.
 * Writes all logs to the console and forwards to the hub via Moleculer when
 * reachable. The broker is read from `ctx.kernel.cluster?.broker`; outbound
 * log replay on hub-connect is handled internally by the destination.
 */
export class HubForwarderAddon extends BaseAddon {
  private destination: HubForwarderDestination | null = null

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.destination = new HubForwarderDestination()
    await this.destination.initialize()
    // Status messages (discovery, disconnect) go through ctx.logger so they
    // appear in the structured log stream, not raw stdout.
    this.destination.setStatusLogger(this.ctx.logger)

    // Self-wire the broker when the kernel exposes one (agent + hub processes).
    // In-process unit tests may omit it — logs still go to the console.
    const broker = this.ctx.kernel.cluster?.broker
    if (broker) {
      this.destination.connectBroker(broker)
    } else {
      this.ctx.logger.warn('cluster.broker not available — hub forwarding disabled, console only')
    }

    this.ctx.logger.info('Hub forwarder log destination registered')
    return [{ capability: logDestinationCapability, provider: this.destination }]
  }

  getDestination(): HubForwarderDestination | null {
    return this.destination
  }

  protected async onShutdown(): Promise<void> {
    await this.destination?.shutdown()
    this.destination = null
  }
}
