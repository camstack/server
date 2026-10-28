/**
 * The hub's agent-pairing service (D857): the agents it can see (mDNS, or an
 * address the operator typed), the pairings in progress, and unpairing.
 *
 * Discovery is a convenience, never an authority: an mDNS record only says "an
 * agent claims to be here". Everything that matters is decided by the pairing
 * itself (the code both operators confirm) and by the certificate it ends in.
 *
 * In-progress pairings advance on their own (the agent's operator may confirm
 * at any moment): a light timer polls the agents of active pairings, so the hub
 * completes as soon as both sides confirmed, whether or not a browser is open.
 */
import type { MdnsAgent } from '@camstack/develop/hub-discovery'
import type {
  AgentEndpoint,
  AgentPairingState,
  AgentPairingTransport,
  HubPairing,
  HubPairingView,
} from '@camstack/system'

export interface DiscoveredAgent {
  readonly nodeId: string
  readonly host: string
  readonly port: number
  readonly version: string | null
  /** The agent's display name; `null` when it does not tell (an older agent). */
  readonly name: string | null
  readonly state: AgentPairingState
  /** Short leaf fingerprint, once paired. */
  readonly fingerprint: string | null
  readonly source: 'mdns' | 'address'
  /** This hub has a certificate-verified connection to a node of this id right now. */
  readonly connected: boolean
  /** The pairing in progress with this agent, if any. */
  readonly pairing: HubPairingView | null
}

export interface HubAgentPairingDeps {
  readonly pairing: HubPairing
  readonly transport: AgentPairingTransport
  /** Browse mDNS for agents; never throws. */
  readonly browse: () => Promise<readonly MdnsAgent[]>
  readonly isNodeConnected: (nodeId: string) => boolean
  readonly now?: () => number
  readonly log: {
    info(message: string, extras?: { meta?: Record<string, unknown> }): void
    warn(message: string, extras?: { meta?: Record<string, unknown> }): void
  }
  /** How often active pairings are polled (default 2 s). */
  readonly pollMs?: number
}

/** A browse takes seconds; a list asked within this window reuses the last scan. */
const SCAN_REUSE_MS = 4_000
/** A typed address is remembered this long without being heard again. */
const ADDRESS_MEMORY_MS = 30 * 60_000
const DEFAULT_PORT = 4444

interface ManualAgent {
  readonly endpoint: AgentEndpoint
  readonly nodeId: string
  readonly version: string | null
  readonly name: string | null
  readonly state: AgentPairingState
  readonly seenAt: number
}

export class HubAgentPairing {
  private scanned: { readonly at: number; readonly agents: readonly MdnsAgent[] } | null = null
  private scanning: Promise<readonly MdnsAgent[]> | null = null
  private readonly manual = new Map<string, ManualAgent>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private readonly deps: HubAgentPairingDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Start advancing active pairings in the background. Idempotent. */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => void this.advanceActive(), this.deps.pollMs ?? 2_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** Agents found on the LAN plus the addresses the operator typed. */
  async listDiscovered(options: { readonly refresh?: boolean } = {}): Promise<{
    agents: DiscoveredAgent[]
    scannedAt: number | null
  }> {
    const found = await this.scan(options.refresh === true)
    const byKey = new Map<string, DiscoveredAgent>()
    for (const a of found) {
      byKey.set(`${a.host}:${a.port}`, this.describe(a.nodeId, a.host, a.port, a, 'mdns'))
    }
    const at = this.now()
    for (const [key, m] of this.manual) {
      if (at - m.seenAt > ADDRESS_MEMORY_MS) {
        this.manual.delete(key)
        continue
      }
      if (byKey.has(key)) continue
      byKey.set(
        key,
        this.describe(
          m.nodeId,
          m.endpoint.host,
          m.endpoint.port,
          { version: m.version, name: m.name, state: m.state, fingerprint: null },
          'address',
        ),
      )
    }
    return { agents: [...byKey.values()], scannedAt: this.scanned?.at ?? null }
  }

  /** Probe an address the operator typed; remembered so it shows in the list. */
  async addByAddress(host: string, port: number = DEFAULT_PORT): Promise<DiscoveredAgent> {
    const endpoint: AgentEndpoint = { host, port }
    const hello = await this.deps.transport.hello(endpoint)
    this.manual.set(`${host}:${port}`, {
      endpoint,
      nodeId: hello.nodeId,
      version: hello.version,
      name: hello.name ?? null,
      state: hello.state,
      seenAt: this.now(),
    })
    return this.describe(
      hello.nodeId,
      host,
      port,
      { version: hello.version, name: hello.name ?? null, state: hello.state, fingerprint: null },
      'address',
    )
  }

  async begin(endpoint: AgentEndpoint): Promise<HubPairingView> {
    const view = await this.deps.pairing.begin(endpoint)
    this.start()
    return view
  }

  get(pairingId: string): Promise<HubPairingView> {
    return this.deps.pairing.advance(pairingId)
  }

  list(): readonly HubPairingView[] {
    return this.deps.pairing.list()
  }

  confirm(pairingId: string, code: string): Promise<HubPairingView> {
    return this.deps.pairing.confirm(pairingId, code)
  }

  reject(pairingId: string): Promise<HubPairingView> {
    return this.deps.pairing.reject(pairingId)
  }

  private async advanceActive(): Promise<void> {
    for (const id of this.deps.pairing.activeIds()) {
      await this.deps.pairing.advance(id).catch((err: unknown) =>
        this.deps.log.warn('pairing could not be advanced', {
          meta: { pairingId: id, error: err instanceof Error ? err.message : String(err) },
        }),
      )
    }
  }

  private async scan(refresh: boolean): Promise<readonly MdnsAgent[]> {
    const last = this.scanned
    if (!refresh && last !== null && this.now() - last.at < SCAN_REUSE_MS) return last.agents
    if (this.scanning !== null) return this.scanning
    const running = this.deps
      .browse()
      .then((agents) => {
        this.scanned = { at: this.now(), agents }
        return agents
      })
      .finally(() => {
        this.scanning = null
      })
    this.scanning = running
    return running
  }

  private describe(
    nodeId: string,
    host: string,
    port: number,
    facts: Pick<MdnsAgent, 'version' | 'name' | 'state' | 'fingerprint'>,
    source: DiscoveredAgent['source'],
  ): DiscoveredAgent {
    const active = this.deps.pairing
      .list()
      .find(
        (p) =>
          p.nodeId === nodeId && (p.state === 'awaiting-confirmation' || p.state === 'completing'),
      )
    return {
      nodeId,
      host,
      port,
      version: facts.version,
      name: facts.name,
      state: facts.state,
      fingerprint: facts.fingerprint,
      source,
      connected: this.deps.isNodeConnected(nodeId),
      pairing: active ?? null,
    }
  }
}
