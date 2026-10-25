/**
 * Hub mDNS advertisement (D838) — how `camstack login` / `camstack discover`
 * find a hub on the LAN.
 *
 * The hub publishes ONE `_camstack._tcp` service for its HTTPS endpoint. There
 * is no mesh channel in it (D826 retired mesh UDP discovery on purpose) and
 * nothing secret: the TXT record carries the node id, the version, the role
 * and the address URL — finding a hub grants nothing, every client still signs
 * in.
 *
 * The advertised address is NOT ranked here. It is the `internal` role of the
 * address book (the address flagged for LAN clients, else the automatic LAN
 * pick) — this module only reads the answer `local-network` already gives.
 *
 * The responder is injected so the logic is tested with a fake; the real one
 * wraps `@homebridge/ciao`.
 */
import { isIP } from 'node:net'

import type { HubAddressBook, IScopedLogger } from '@camstack/types'
import { HUB_MDNS_ROLE, HUB_MDNS_SERVICE_TYPE, HUB_MDNS_TXT_KEYS } from '@camstack/types'

/** What one published service says. Every value is public. */
export interface HubMdnsAnnouncement {
  /** Instance name (`camstack-<nodeId>`). */
  readonly name: string
  readonly type: string
  readonly port: number
  /** The IP literal the A/AAAA record is restricted to; null for a DNS name. */
  readonly address: string | null
  readonly txt: Readonly<Record<string, string>>
}

/** A published service the advertiser can withdraw. */
export interface HubMdnsHandle {
  stop(): Promise<void>
}

/** The responder seam: publish one announcement. */
export interface HubMdnsPublisher {
  publish(announcement: HubMdnsAnnouncement): Promise<HubMdnsHandle>
}

export interface HubMdnsInputs {
  readonly nodeId: string
  readonly version: string | null
  /** `getAddresses().roles.internal.resolved` — an https base URL or null. */
  readonly internalUrl: string | null
}

/** The announcement for the current address, or null when nothing qualifies. */
export function buildHubAnnouncement(inputs: HubMdnsInputs): HubMdnsAnnouncement | null {
  if (inputs.internalUrl === null) return null
  let url: URL
  try {
    url = new URL(inputs.internalUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const port = url.port === '' ? 443 : Number.parseInt(url.port, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const txt: Record<string, string> = {
    [HUB_MDNS_TXT_KEYS.nodeId]: inputs.nodeId,
    [HUB_MDNS_TXT_KEYS.role]: HUB_MDNS_ROLE,
    [HUB_MDNS_TXT_KEYS.url]: url.origin,
  }
  if (inputs.version !== null) txt[HUB_MDNS_TXT_KEYS.version] = inputs.version
  return {
    name: `camstack-${inputs.nodeId}`,
    type: HUB_MDNS_SERVICE_TYPE,
    port,
    address: isIP(host) !== 0 ? host : null,
    txt,
  }
}

function announcementKey(a: HubMdnsAnnouncement): string {
  return JSON.stringify([a.name, a.type, a.port, a.address, a.txt])
}

export interface HubMdnsAdvertiserOptions {
  readonly publisher: HubMdnsPublisher
  readonly logger: IScopedLogger
  readonly nodeId: string
  readonly version: string | null
  /** Reads the `internal` role from the address book; may throw. */
  readonly readInternalUrl: () => Promise<string | null>
}

/**
 * Keeps one mDNS service in step with the hub's `internal` address. `sync()`
 * is safe to call on any change; it never throws — a failure to advertise is
 * logged and the boot goes on.
 */
export class HubMdnsAdvertiser {
  private current: { readonly key: string; readonly handle: HubMdnsHandle } | null = null
  private running = false
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly options: HubMdnsAdvertiserOptions) {}

  async start(): Promise<void> {
    this.running = true
    await this.sync()
  }

  /** Re-read the address and re-announce when it changed. Serialised. */
  sync(): Promise<void> {
    this.chain = this.chain.then(() => this.syncOnce())
    return this.chain
  }

  async stop(): Promise<void> {
    this.running = false
    await (this.chain = this.chain.then(() => this.withdraw()))
  }

  private async syncOnce(): Promise<void> {
    if (!this.running) return
    const { logger } = this.options
    try {
      const internalUrl = await this.options.readInternalUrl()
      const next = buildHubAnnouncement({
        nodeId: this.options.nodeId,
        version: this.options.version,
        internalUrl,
      })
      if (next === null) {
        if (this.current !== null) {
          await this.withdraw()
          logger.info('hub mDNS: no internal address, advertisement withdrawn')
        }
        return
      }
      const key = announcementKey(next)
      if (this.current?.key === key) return
      await this.withdraw()
      const handle = await this.options.publisher.publish(next)
      this.current = { key, handle }
      logger.info('hub mDNS: advertising _camstack._tcp', {
        meta: { url: next.txt[HUB_MDNS_TXT_KEYS.url], port: next.port },
      })
    } catch (err: unknown) {
      logger.warn('hub mDNS: could not advertise the hub (logins still work with --server)', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private async withdraw(): Promise<void> {
    const held = this.current
    this.current = null
    if (held === null) return
    try {
      await held.handle.stop()
    } catch (err: unknown) {
      this.options.logger.warn('hub mDNS: withdraw failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}

/**
 * The address a hub advertises: the `internal` role's answer, exactly as the
 * address book resolved it. Never re-ranked here (D729, D732).
 */
export function internalUrlOf(book: Pick<HubAddressBook, 'roles'>): string | null {
  return book.roles.internal.resolved
}
