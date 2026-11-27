/**
 * Test-connection probe: open the frontend socket once and wait for the first `bridge/*` message the
 * server pushes on connect. A refused token is a definite no (`rejected`); anything else that stops
 * the probe (unreachable, timeout) is `inconclusive`, never a pass and never a verdict on the token.
 */
import type { IntegrationTestConnectionResult } from '@camstack/types'
import {
  buildZ2mUrl,
  nativeSocketFactory,
  type Z2mEndpoint,
  type Z2mSocketFactory,
  type Z2mTimers,
  z2mDisplayAddress,
} from './z2m-client.js'
import { parseEnvelope, Z2M_BRIDGE_PREFIX, Z2M_CLOSE_UNAUTHORIZED } from './z2m-protocol.js'

const DEFAULT_TIMEOUT_MS = 8000

const realTimers: Z2mTimers = {
  after: (run, ms) => {
    const handle = setTimeout(run, ms)
    return () => clearTimeout(handle)
  },
}

export interface Z2mProbeOptions {
  readonly factory?: Z2mSocketFactory
  readonly timers?: Z2mTimers
  readonly timeoutMs?: number
}

export function probeZ2m(
  endpoint: Z2mEndpoint,
  options: Z2mProbeOptions = {},
): Promise<IntegrationTestConnectionResult> {
  const factory = options.factory ?? nativeSocketFactory
  const timers = options.timers ?? realTimers
  const where = z2mDisplayAddress(endpoint)
  return new Promise((resolve) => {
    let settled = false
    let cancel: () => void = () => {}
    let socket: ReturnType<Z2mSocketFactory> | null = null
    const finish = (result: IntegrationTestConnectionResult): void => {
      if (settled) return
      settled = true
      cancel()
      socket?.close()
      resolve(result)
    }
    const inconclusive = (why: string): void =>
      finish({
        success: false,
        status: 'inconclusive',
        error: `${where}: ${why}`,
      })
    cancel = timers.after(() => inconclusive('no answer'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      socket = factory(buildZ2mUrl(endpoint), {
        open: () => {},
        message: (text) => {
          const envelope = parseEnvelope(text)
          if (envelope !== null && envelope.topic.startsWith(Z2M_BRIDGE_PREFIX)) {
            finish({ success: true, status: 'validated' })
          }
        },
        close: (code) =>
          code === Z2M_CLOSE_UNAUTHORIZED
            ? finish({
                success: false,
                status: 'rejected',
                error: 'The server refused the auth token',
              })
            : inconclusive(`closed (${code})`),
        error: (message) => inconclusive(message),
      })
    } catch {
      // The constructor error can echo the URL, which carries the token: report a fixed reason.
      inconclusive('the socket could not be opened')
    }
  })
}
