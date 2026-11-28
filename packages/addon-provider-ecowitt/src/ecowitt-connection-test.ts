/**
 * The Ecowitt connection test (planning#581): read the gateway's local API once with the
 * connection as the form holds it, and answer a typed verdict with a reason.
 *
 * nodewitt never throws into its caller: every failure arrives as an `error` event whose message
 * is the only signal. The reasons below are the ones those messages tell apart:
 *   - `Ecowitt local auth failed: invalid password` — the gateway refused the typed password;
 *   - `Ecowitt local auth expired: HTTP 401|403` — the gateway asks for a password (none typed,
 *     or the one typed was not taken);
 *   - `HTTP 404` / an unparseable body — something answered on host:port, but not the Ecowitt
 *     local API;
 *   - anything else (refused, timed out, DNS, 5xx) — the gateway did not answer.
 */
import { Ecowitt } from '@apocaliss92/nodewitt'
import { errMsg, type IntegrationTestConnectionResult } from '@dominevo/types'
import type { EcowittLocalConfig } from './config.js'

/** How long the test waits for the first reading or the first error. */
export const ECOWITT_TEST_DEADLINE_MS = 10_000

/** The slice of a nodewitt local client the test drives; a spec supplies a fake. */
export interface EcowittProbeClient {
  start(): Promise<void>
  stop(): Promise<void>
  onError(listener: (err: Error) => void): void
  /** One full reading: the number of sensors it carried. */
  onSnapshot(listener: (sensorCount: number) => void): void
}

export type EcowittProbeFactory = (connection: EcowittLocalConfig) => EcowittProbeClient

/** The real nodewitt local client, one poll is all the test needs. */
export const liveEcowittProbe: EcowittProbeFactory = (connection) => {
  const facade = Ecowitt.createLocal({
    host: connection.host,
    port: connection.port,
    ...(connection.password.length > 0 ? { password: connection.password } : {}),
  })
  return {
    start: () => facade.start(),
    stop: () => facade.stop(),
    onError: (listener) => {
      facade.on('error', listener)
    },
    onSnapshot: (listener) => {
      facade.on('snapshot', (snapshot) => listener(snapshot.sensors.length))
    },
  }
}

const NOT_ECOWITT = /HTTP 404|common_list|invalid json|unexpected token|ZodError|invalid_type/i

/** The verdict for the first error the gateway produced. */
export function ecowittFailureOf(
  err: Error,
  connection: EcowittLocalConfig,
): IntegrationTestConnectionResult {
  const where = `${connection.host}:${connection.port}`
  const message = err.message
  if (message.includes('invalid password')) {
    return {
      success: false,
      status: 'rejected',
      error: 'ecowitt: the gateway refused the password',
    }
  }
  if (message.includes('auth expired')) {
    return {
      success: false,
      status: 'rejected',
      error:
        connection.password.length === 0
          ? 'ecowitt: the gateway asks for a password — enter the one set in the gateway web page'
          : 'ecowitt: the gateway did not accept the password',
    }
  }
  if (NOT_ECOWITT.test(message) || err.name === 'ZodError' || err instanceof SyntaxError) {
    return {
      success: false,
      status: 'rejected',
      error: `ecowitt: something answered on ${where}, but not the Ecowitt local API — check the host and the port (80 by default)`,
    }
  }
  return {
    success: false,
    status: 'inconclusive',
    error: `ecowitt: the gateway did not answer on ${where} (${errMsg(err)}) — check the host, the port and that it is on`,
  }
}

type FirstOutcome =
  | { readonly kind: 'reading'; readonly sensors: number }
  | { readonly kind: 'error'; readonly err: Error }
  | { readonly kind: 'deadline' }

export async function testEcowittConnection(
  connection: EcowittLocalConfig,
  makeProbe: EcowittProbeFactory,
  deadlineMs: number = ECOWITT_TEST_DEADLINE_MS,
): Promise<IntegrationTestConnectionResult> {
  const started = Date.now()
  const probe = makeProbe(connection)
  let timer: ReturnType<typeof setTimeout> | null = null
  const first = new Promise<FirstOutcome>((resolve) => {
    probe.onSnapshot((sensors) => resolve({ kind: 'reading', sensors }))
    probe.onError((err) => resolve({ kind: 'error', err }))
    timer = setTimeout(() => resolve({ kind: 'deadline' }), deadlineMs) // not-a-state-poll: deadline of one connection test
    probe
      .start()
      .catch((err: unknown) =>
        resolve({ kind: 'error', err: err instanceof Error ? err : new Error(errMsg(err)) }),
      )
  })
  try {
    const outcome = await first
    if (outcome.kind === 'reading') {
      return {
        success: true,
        status: 'validated',
        latencyMs: Date.now() - started,
        detail: `${outcome.sensors} sensor readings`,
      }
    }
    if (outcome.kind === 'error') return ecowittFailureOf(outcome.err, connection)
    return {
      success: false,
      status: 'inconclusive',
      error: `ecowitt: the gateway did not answer on ${connection.host}:${connection.port} within ${Math.round(deadlineMs / 1000)} s — check the host, the port and that it is on`,
    }
  } finally {
    if (timer !== null) clearTimeout(timer)
    await probe.stop().catch((): null => null)
  }
}
