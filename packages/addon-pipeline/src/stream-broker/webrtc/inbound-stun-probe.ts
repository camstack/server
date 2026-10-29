/**
 * Did the remote peer ever send us an ICE connectivity check?
 *
 * A client-offer session that sits in ICE `checking` and closes 10 s later has
 * two very different causes: the peer never sends a check (its side gave up, or
 * never got our answer's candidates), or its checks reach us and OUR replies do
 * not get back (NAT / firewall). The ICE state alone cannot tell them apart.
 * This probe counts the binding requests werift receives, through werift's
 * `iceFilterStunResponse` option, which is called once per inbound request and
 * which this probe never vetoes: it observes, it does not change ICE.
 */

/** A transport address as werift passes it: `[host, port]`. */
export type StunSourceAddress = readonly [string, number]

export interface InboundStunSummary {
  /** Binding requests received from the peer since the probe was created. */
  readonly requests: number
  /** `host:port` of the first request, or null when none arrived. */
  readonly firstFrom: string | null
  /** Milliseconds from probe creation to the first request, or null. */
  readonly firstAfterMs: number | null
  /** Distinct source addresses seen (capped), as `host:port`. */
  readonly sources: readonly string[]
}

const MAX_SOURCES = 8

export class InboundStunProbe {
  private requests = 0
  private first: { from: string; atMs: number } | null = null
  private readonly sources = new Set<string>()
  private readonly createdAt: number

  constructor(
    private readonly onFirst: (from: string, afterMs: number) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.createdAt = now()
  }

  /** Pass as werift's `iceFilterStunResponse`. Always lets the request through. */
  readonly filter = (_message: unknown, addr: StunSourceAddress, _protocol: unknown): boolean => {
    const from = `${addr[0]}:${addr[1]}`
    this.requests += 1
    if (this.sources.size < MAX_SOURCES) this.sources.add(from)
    if (this.first === null) {
      const afterMs = this.now() - this.createdAt
      this.first = { from, atMs: afterMs }
      this.onFirst(from, afterMs)
    }
    return true
  }

  summary(): InboundStunSummary {
    return {
      requests: this.requests,
      firstFrom: this.first?.from ?? null,
      firstAfterMs: this.first?.atMs ?? null,
      sources: [...this.sources],
    }
  }
}
