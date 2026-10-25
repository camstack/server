import type { AlexaAppliance, AlexaStateValue } from './alexa-client.js'

/**
 * Per-broker in-process resolver device classes use to reach the live Alexa
 * appliance inventory + the latest polled state values for an account. Mirrors
 * the Ecowitt / Matter facade resolver: the integration manager publishes the
 * live snapshot here on each poll, and device classes read through the resolver
 * so they transparently pick up the new state.
 */

/** Key for a single appliance property value: `appliance:interface:property`. */
function stateKey(v: Pick<AlexaStateValue, 'applianceId' | 'interfaceName' | 'property'>): string {
  return `${v.applianceId}:${v.interfaceName}:${v.property}`
}

export class AlexaAccountResolver {
  /** Latest appliance inventory per broker. */
  readonly #appliances: Map<string, ReadonlyMap<string, AlexaAppliance>> = new Map()
  /** Latest polled state per broker → stateKey → value. */
  readonly #states: Map<string, Map<string, unknown>> = new Map()

  /** Publish (replace) the appliance inventory for a broker. `null` removes it. */
  setAppliances(brokerId: string, appliances: readonly AlexaAppliance[] | null): void {
    if (appliances === null) {
      this.#appliances.delete(brokerId)
      this.#states.delete(brokerId)
      return
    }
    const byId = new Map<string, AlexaAppliance>()
    for (const a of appliances) byId.set(a.applianceId, a)
    this.#appliances.set(brokerId, byId)
  }

  /** Record a batch of polled state values for a broker. */
  recordStates(brokerId: string, values: readonly AlexaStateValue[]): void {
    let perBroker = this.#states.get(brokerId)
    if (perBroker === undefined) {
      perBroker = new Map<string, unknown>()
      this.#states.set(brokerId, perBroker)
    }
    for (const v of values) perBroker.set(stateKey(v), v.value)
  }

  /** All appliances for a broker, or [] when unknown. */
  getAppliances(brokerId: string): readonly AlexaAppliance[] {
    const byId = this.#appliances.get(brokerId)
    return byId === undefined ? [] : Array.from(byId.values())
  }

  /** A single appliance for a broker, or null. */
  getAppliance(brokerId: string, applianceId: string): AlexaAppliance | null {
    return this.#appliances.get(brokerId)?.get(applianceId) ?? null
  }

  /** Latest value for a specific property, or undefined when never polled. */
  getState(
    brokerId: string,
    applianceId: string,
    interfaceName: string,
    property: string,
  ): unknown {
    return this.#states.get(brokerId)?.get(stateKey({ applianceId, interfaceName, property }))
  }

  /** True when the broker has a live (published) inventory. */
  has(brokerId: string): boolean {
    return this.#appliances.has(brokerId)
  }

  /** Remove everything for a broker (on stop/remove). */
  remove(brokerId: string): void {
    this.#appliances.delete(brokerId)
    this.#states.delete(brokerId)
  }

  /** Remove all state (full shutdown). */
  clear(): void {
    this.#appliances.clear()
    this.#states.clear()
  }
}

/** The single in-process per-broker account resolver shared across the addon. */
export const alexaAccounts = new AlexaAccountResolver()

/**
 * In-process command sink: device classes invoke outbound Alexa commands through
 * this resolver, which the addon wires to each broker's live client. Keeps device
 * classes decoupled from the client/registry.
 */
export class AlexaCommandSink {
  #invoke:
    | ((brokerId: string, command: import('./alexa-client.js').AlexaCommand) => Promise<void>)
    | null = null

  setDispatcher(
    fn: (brokerId: string, command: import('./alexa-client.js').AlexaCommand) => Promise<void>,
  ): void {
    this.#invoke = fn
  }

  async invoke(brokerId: string, command: import('./alexa-client.js').AlexaCommand): Promise<void> {
    if (this.#invoke === null) {
      throw new Error('import-alexa: command sink has no dispatcher wired')
    }
    await this.#invoke(brokerId, command)
  }

  clear(): void {
    this.#invoke = null
  }
}

/** The single in-process command sink shared across the addon. */
export const alexaCommands = new AlexaCommandSink()
