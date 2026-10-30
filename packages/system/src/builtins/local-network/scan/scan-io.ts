/**
 * The two network primitives the scan engine stands on. The engine only sees
 * this interface, so a spec drives it with fakes and no socket is ever opened.
 */

export interface UdpTarget {
  readonly host: string
  readonly port: number
}

export interface UdpExchangeRequest {
  readonly payload: Buffer
  /** One socket, one burst: every target gets the payload. */
  readonly targets: readonly UdpTarget[]
  /** Source interface (multicast egress / directed broadcast). */
  readonly localAddress?: string
  /** Fixed source port: devices that answer to a port other than the sender's. */
  readonly bindPort?: number
  readonly broadcast?: boolean
  /** Offsets (ms after the first burst) at which the same burst is sent again. */
  readonly resendAtMs?: readonly number[]
  /** How long to keep listening after the first burst. */
  readonly listenMs: number
}

export interface UdpReply {
  readonly host: string
  readonly port: number
  readonly data: Buffer
}

export interface HttpProbeRequest {
  readonly host: string
  readonly port: number
  readonly path: string
  readonly method: 'GET' | 'POST'
  readonly bodyText?: string
  readonly contentType?: string
  readonly tls: boolean
  readonly timeoutMs: number
}

export type HttpProbeOutcome =
  | {
      readonly kind: 'response'
      readonly status: number
      readonly headers: Readonly<Record<string, string>>
      /** Already cut at {@link MAX_HIT_BODY_BYTES}. */
      readonly bodyText: string
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable' }

export interface ScanIo {
  /** Send to every target, collect replies; a socket error rejects. */
  udpExchange(request: UdpExchangeRequest): Promise<readonly UdpReply[]>
  /** Never rejects: a timeout and a refusal are outcomes. */
  httpProbe(request: HttpProbeRequest): Promise<HttpProbeOutcome>
}

/** A hit carries at most this much of a response body. */
export const MAX_HIT_BODY_BYTES: number = 16 * 1024
