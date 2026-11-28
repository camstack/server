/**
 * The Reolink NVR / Home Hub connection test (planning#581): log in over Baichuan with the
 * connection as the form holds it — the same login the hub session makes — and answer a typed
 * verdict with a reason.
 *
 * The library reports failures only by message. What they tell apart:
 *   - a socket that never connected, or a login that timed out — the hub did not answer;
 *   - `Baichuan login failed: empty reply` after the nonce exchange succeeded — the hub is there
 *     and refused the username or password (a mains-powered hub does not sleep, and the test's
 *     socket is fresh, so the library's other two guesses for this message do not apply);
 *   - anything else — the login failed with the library's own words, inconclusive.
 * Whether the host is an NVR / Home Hub rather than a single camera is NOT a reason here: a hub
 * with no camera paired answers zero channels just like a camera would.
 */
import { ReolinkBaichuanApi } from '@apocaliss92/nodelink-js'
import { errMsg, type IntegrationTestConnectionResult } from '@dominevo/types'
import type { ReolinkHubConnection } from './hub-connection.js'
import { isConnectivityFailure } from './reachability-offline.js'

/** The bound on login plus the channel read; the test logs in once (no library retry). */
export const REOLINK_HUB_TEST_DEADLINE_MS = 20_000

/** The slice of a Baichuan session the test drives; a spec supplies a fake. */
export interface ReolinkHubProbe {
  login(): Promise<void>
  /** The channels the hub reports, or null when the read failed (the login already proved it). */
  channelCount(): Promise<number | null>
  close(): Promise<void>
}

export type ReolinkHubProbeFactory = (connection: ReolinkHubConnection) => ReolinkHubProbe

/** A real Baichuan session, dialled the way `connectReolinkHub` dials one. */
export const liveReolinkHubProbe: ReolinkHubProbeFactory = (connection) => {
  const api = new ReolinkBaichuanApi({
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password,
    transport: connection.transport,
    ...(connection.uid ? { uid: connection.uid } : {}),
  })
  return {
    // One attempt: a refused password is sent once, never counted three times toward a lockout.
    login: () => api.login(undefined, { maxAttempts: 1 }),
    channelCount: async () => {
      try {
        const summary = await api.getNvrChannelsSummary({ timeoutMs: 5000 })
        return summary.devices.length
      } catch {
        return null
      }
    },
    close: () => api.close({ reason: 'connection-test' }),
  }
}

/** The verdict for a failed login. */
export function reolinkHubFailureOf(
  err: unknown,
  connection: ReolinkHubConnection,
): IntegrationTestConnectionResult {
  const where = `${connection.host}:${connection.port}`
  const message = errMsg(err)
  if (message.includes('login failed: empty reply')) {
    return {
      success: false,
      status: 'rejected',
      error: `reolink: the NVR / Home Hub refused the username or password (user "${connection.username}")`,
    }
  }
  if (isConnectivityFailure(err) || message.includes('connect timeout')) {
    return {
      success: false,
      status: 'inconclusive',
      error: `reolink: the NVR / Home Hub did not answer on ${where} (${message}) — check the host and the Baichuan port (9000 by default)`,
    }
  }
  return {
    success: false,
    status: 'inconclusive',
    error: `reolink: the login to ${where} failed: ${message}`,
  }
}

type LoginOutcome =
  | { readonly kind: 'ok' }
  | { readonly kind: 'error'; readonly err: unknown }
  | { readonly kind: 'deadline' }

export async function testReolinkHubConnection(
  connection: ReolinkHubConnection,
  makeProbe: ReolinkHubProbeFactory,
  deadlineMs: number = REOLINK_HUB_TEST_DEADLINE_MS,
): Promise<IntegrationTestConnectionResult> {
  const started = Date.now()
  const probe = makeProbe(connection)
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<LoginOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'deadline' }), deadlineMs)
  })
  const login = probe.login().then(
    (): LoginOutcome => ({ kind: 'ok' }),
    (err: unknown): LoginOutcome => ({ kind: 'error', err }),
  )
  try {
    const outcome = await Promise.race([login, deadline])
    if (outcome.kind === 'error') return reolinkHubFailureOf(outcome.err, connection)
    if (outcome.kind === 'deadline') {
      return {
        success: false,
        status: 'inconclusive',
        error: `reolink: the NVR / Home Hub did not complete a login on ${connection.host}:${connection.port} within ${Math.round(deadlineMs / 1000)} s — check the host and the port`,
      }
    }
    const channels = await probe.channelCount()
    return {
      success: true,
      status: 'validated',
      latencyMs: Date.now() - started,
      ...(channels !== null ? { detail: `${channels} channels` } : {}),
    }
  } finally {
    if (timer !== null) clearTimeout(timer)
    await probe.close().catch((): null => null)
  }
}
