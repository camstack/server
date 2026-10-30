/**
 * Agent mDNS advertisement (D857) — how a hub finds agents to pair.
 *
 * Every agent publishes ONE `_camstack-agent._tcp` service for its API port,
 * paired or not. The TXT record carries only public facts: the node id, the
 * version, the pairing state and — once paired — a short fingerprint of its
 * mesh leaf. Finding an agent grants nothing: pairing still needs the code
 * confirmed on both screens. The state is re-announced when it changes, so the
 * hub's list never shows an agent as free that is already paired.
 *
 * The pairing key is generated per pairing attempt (a fresh key for every
 * offer), so before pairing there is no key to advertise; `fp` appears only
 * after, as the leaf fingerprint.
 *
 * The responder is injected, exactly as for the hub's own advertisement
 * (`hub-mdns.ts`); the real one is `createCiaoPublisher()`.
 */
import type { IScopedLogger } from '@camstack/types'
import { AGENT_MDNS_SERVICE_TYPE, AGENT_MDNS_TXT_KEYS } from '@camstack/types'
import type { AgentPairingState } from '../../kernel/moleculer/mesh-mtls/pairing/pairing-protocol.js'
import type { HubMdnsAnnouncement, HubMdnsHandle, HubMdnsPublisher } from './hub-mdns.js'

export interface AgentMdnsInputs {
  readonly nodeId: string
  readonly version: string | null
  /** The agent's display name; omitted from the record when absent. */
  readonly name?: string | null
  readonly port: number
  readonly state: AgentPairingState
  /** Short fingerprint of the agent's mesh leaf, `null` while unpaired. */
  readonly leafFingerprint: string | null
}

export function buildAgentAnnouncement(inputs: AgentMdnsInputs): HubMdnsAnnouncement {
  const txt: Record<string, string> = {
    [AGENT_MDNS_TXT_KEYS.nodeId]: inputs.nodeId,
    [AGENT_MDNS_TXT_KEYS.state]: inputs.state,
  }
  if (inputs.version !== null) txt[AGENT_MDNS_TXT_KEYS.version] = inputs.version
  if (inputs.name !== undefined && inputs.name !== null && inputs.name.length > 0)
    txt[AGENT_MDNS_TXT_KEYS.name] = inputs.name
  if (inputs.leafFingerprint !== null)
    txt[AGENT_MDNS_TXT_KEYS.keyFingerprint] = inputs.leafFingerprint
  return {
    name: `camstack-agent-${inputs.nodeId}`,
    type: AGENT_MDNS_SERVICE_TYPE,
    port: inputs.port,
    address: null,
    txt,
  }
}

function announcementKey(a: HubMdnsAnnouncement): string {
  return JSON.stringify([a.name, a.type, a.port, a.txt])
}

export interface AgentMdnsAdvertiserOptions {
  readonly publisher: HubMdnsPublisher
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

/**
 * Keeps one mDNS service in step with the agent's pairing state. `sync()` is safe
 * to call on any change; it never throws — a failure to advertise is logged and
 * the agent goes on (a typed address still pairs it).
 */
export class AgentMdnsAdvertiser {
  private current: { readonly key: string; readonly handle: HubMdnsHandle } | null = null
  private stopped = false
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly options: AgentMdnsAdvertiserOptions) {}

  /**
   * Announce `inputs` if they differ from what is announced. Serialised. The first
   * call advertises: there is no separate start, because a caller that only ever
   * syncs (the agent boot) must not be silently ignored.
   */
  sync(inputs: AgentMdnsInputs): Promise<void> {
    this.chain = this.chain.then(() => this.syncOnce(inputs))
    return this.chain
  }

  async stop(): Promise<void> {
    this.stopped = true
    await (this.chain = this.chain.then(() => this.withdraw()))
  }

  private async syncOnce(inputs: AgentMdnsInputs): Promise<void> {
    if (this.stopped) return
    const next = buildAgentAnnouncement(inputs)
    const key = announcementKey(next)
    if (this.current?.key === key) return
    try {
      await this.withdraw()
      const handle = await this.options.publisher.publish(next)
      this.current = { key, handle }
      this.options.logger.info('agent mDNS: advertising _camstack-agent._tcp', {
        meta: { state: inputs.state, port: inputs.port },
      })
    } catch (err: unknown) {
      this.options.logger.warn(
        'agent mDNS: could not advertise this agent (a hub can still pair it by address)',
        { meta: { error: err instanceof Error ? err.message : String(err) } },
      )
    }
  }

  private async withdraw(): Promise<void> {
    const held = this.current
    this.current = null
    if (held === null) return
    try {
      await held.handle.stop()
    } catch (err: unknown) {
      this.options.logger.warn('agent mDNS: withdraw failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
