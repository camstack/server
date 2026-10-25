/**
 * "Is this endpoint accepting connections?" — and deliberately nothing else.
 *
 * ## Why this exists as its own step
 *
 * The `llm` taxonomy has always claimed a CONNECT bound distinct from the
 * FIRST-TOKEN one, on the grounds that they are different faults with different
 * remedies. The implementation did not honour that: it armed the 10 s connect
 * timer around the wait for HTTP RESPONSE HEADERS. On the wire this repo talks
 * to most — LM Studio / llama-server — the headers are the LAST thing that
 * happens before the first token: the server accepts the socket, reads the
 * request, loads the model into the GPU (minutes for qwen3-vl), and only then
 * writes a status line. So a cold load was reported as
 * `unavailable: the endpoint did not accept the connection within 10s`, and the
 * operator was sent to check a base URL that was correct. It cost two live
 * debugging sessions.
 *
 * A TCP handshake is the only thing that answers the connect question without
 * ambiguity, so that is what this probes: a closed port fails at once with
 * `ECONNREFUSED`, a black-holed address burns the whole bound, and a listening
 * endpoint says yes in a millisecond on a LAN — whatever it plans to do next.
 *
 * The socket is closed immediately. This is a probe, not the request; the real
 * call dials its own connection through the library's `fetch` a moment later.
 * That gap is a theoretical race (the port could shut in between) and a real
 * one would surface as the ordinary network error it is.
 */
import { connect as netConnect } from 'node:net'

export interface TcpEndpoint {
  readonly host: string
  readonly port: number
}

export type ConnectProbeOutcome =
  /** The endpoint accepted a TCP connection. It says nothing about the model. */
  | { readonly kind: 'connected' }
  /** No answer within the bound — a black hole, a dropped SYN, a dead route. */
  | { readonly kind: 'timeout' }
  /** Refused, unreachable, unresolvable. `message` already names which. */
  | { readonly kind: 'error'; readonly message: string }

/**
 * Only what the probe reads. Structural on purpose: a `net.Socket` satisfies it
 * and so does a test double, without either side importing the other's shape.
 */
export interface ProbeSocket {
  once(event: 'connect', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  destroy(): unknown
}

export type ConnectImpl = (endpoint: TcpEndpoint) => ProbeSocket

export const defaultConnectImpl: ConnectImpl = (endpoint) =>
  netConnect({ host: endpoint.host, port: endpoint.port })

/**
 * The TCP endpoint a base URL points at, or `null` when there is not one.
 *
 * `null` is "do not probe", never "the endpoint is down": a profile whose URL
 * this cannot parse must fail on the real request with the real reason, not on
 * a guess made here.
 */
export function tcpEndpointOf(baseUrl: string): TcpEndpoint | null {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  // `URL.hostname` keeps the brackets on an IPv6 literal; `net.connect` refuses
  // them. One character each side, and a `[::1]` profile that would otherwise
  // fail to resolve at all.
  const host =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname
  return host.length === 0 ? null : { host, port }
}

/**
 * Dial, and report which of the three things happened.
 *
 * Never rejects — the caller is `LlmClient`, which owes its own callers a
 * RESULT rather than a throw. `signal` is honoured so that an operator who
 * closes the page does not leave a socket dialling for the rest of the bound.
 */
export function probeTcpConnect(
  endpoint: TcpEndpoint,
  timeoutMs: number,
  signal: AbortSignal,
  connectImpl: ConnectImpl = defaultConnectImpl,
): Promise<ConnectProbeOutcome> {
  return new Promise<ConnectProbeOutcome>((resolve) => {
    let settled = false
    let socket: ProbeSocket | null = null

    const settle = (outcome: ConnectProbeOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      socket?.destroy()
      resolve(outcome)
    }

    const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs)
    timer.unref?.()
    const onAbort = (): void =>
      settle({ kind: 'error', message: 'the connection attempt was cancelled' })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }

    try {
      socket = connectImpl(endpoint)
    } catch (error) {
      // A malformed host makes `net.connect` throw synchronously rather than
      // emit. Same fault, same bucket.
      settle({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      return
    }
    socket.once('connect', () => settle({ kind: 'connected' }))
    socket.once('error', (error) => settle({ kind: 'error', message: error.message }))
  })
}
