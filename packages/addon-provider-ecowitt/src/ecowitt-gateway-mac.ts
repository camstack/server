/**
 * How a Gateway device reads and keeps its gateway's MAC on connect (D1059): the
 * addon wires the unicast probe and the write to the integration's record (the
 * same `mac` / `macHost` the LAN scan fills), the device decides when to ask.
 * Unset (the addon not initialised, a spec) means no read is attempted.
 */
import type { GatewayMacProbeResult } from './ecowitt-mac-probe.js'

export interface EcowittMacReader {
  /** Ask the gateway at `host` for its MAC: one unicast probe. */
  probe(host: string): Promise<GatewayMacProbeResult>
  /** Store the MAC read at `host` on the integration's connection. */
  persist(integrationId: string, mac: string, host: string): Promise<void>
}

class EcowittMacReaderSlot {
  #reader: EcowittMacReader | null = null
  set(reader: EcowittMacReader | null): void {
    this.#reader = reader
  }
  get(): EcowittMacReader | null {
    return this.#reader
  }
}

export const ecowittMacReader = new EcowittMacReaderSlot()
