import type { ConnectionOptions } from 'node:tls'
import { errMsg } from '@camstack/types'
import { Connection, Gateway } from 'klf-200-api'
import { loginFailure } from './klf-gateway-client.js'

/** The step of a probe that ran out of time. */
export type KlfProbePhase = 'tls' | 'password' | 'version' | 'logout'

/** Milliseconds each step of a probe may take. */
export interface KlfProbeTimeoutsMs {
  /** Opening the connection AND the TLS handshake. */
  readonly tls: number
  /** The password answer, counted from the moment the handshake finished. */
  readonly password: number
  /** The firmware version answer. */
  readonly version: number
  /** Closing the session. */
  readonly logout: number
}

/**
 * Defaults add up, worst case, to 12 + 3 + 1.5 + 1.5 = 18 s, which is the
 * wizard's `CONNECTION_TEST_TIMEOUT_MS` ceiling (20 s) minus the 2 s margin of
 * `DEFAULT_TEST_DEADLINE_MS`, so a stuck gateway is named here instead of the
 * wizard giving up unnamed. The handshake gets 12 s because a real KLF-200 needs
 * about 4.2 s for ONE handshake (TLSv1.2, DHE-RSA-AES256-SHA256 on a weak CPU).
 *
 * A probe opens exactly ONE connection: the gateway frees a closed slot very
 * slowly (measured 2026-11-01: a bare TCP connect and close before the TLS connect
 * left the real session without a handshake for 20 s), so no pre-check connects first.
 */
export const DEFAULT_KLF_PROBE_TIMEOUTS_MS: KlfProbeTimeoutsMs = {
  tls: 12_000,
  password: 3_000,
  version: 1_500,
  logout: 1_500,
}

/** Worst-case total of a probe's steps. */
export function klfProbeWorstCaseMs(limits: KlfProbeTimeoutsMs): number {
  return limits.tls + limits.password + limits.version + limits.logout
}

const PHASE_TEXT: Record<KlfProbePhase, string> = {
  tls: 'did not accept a connection or complete the TLS handshake on port 51200',
  password: 'did not answer the password',
  version: 'did not answer the version request',
  logout: 'did not close the session',
}

/** A probe step ran out of time. Names the step, so a bound is never a silent hang. */
export class KlfProbeTimeoutError extends Error {
  constructor(
    readonly phase: KlfProbePhase,
    readonly host: string,
    readonly limitMs: number,
  ) {
    super(
      `The gateway ${host} ${PHASE_TEXT[phase]} within ${Math.round(limitMs / 100) / 10}s (timed out)`,
    )
    this.name = 'KlfProbeTimeoutError'
  }
}

/** Options of {@link probeKlfGateway}. */
export interface KlfProbeOptions {
  readonly host: string
  readonly password: string
  /** Replaces the library's built-in certificate trust (spec seam). */
  readonly tls?: ConnectionOptions
  /** Per-step bounds; omitted steps use {@link DEFAULT_KLF_PROBE_TIMEOUTS_MS}. */
  readonly timeoutsMs?: Partial<KlfProbeTimeoutsMs>
}

async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** How often the login watcher checks whether the handshake has finished. */
const PHASE_POLL_MS = 20

/**
 * The library's `loginAsync` runs the TLS handshake and the password answer as one
 * call. `KLF200SocketProtocol` appears when the handshake is done and the password
 * is on its way, so watching it splits the call into two bounded, named steps.
 */
async function loginInPhases(
  connection: Connection,
  host: string,
  password: string,
  limits: KlfProbeTimeoutsMs,
): Promise<void> {
  let handshakeDone = false
  let passwordTimer: NodeJS.Timeout | undefined
  let tlsTimer: NodeJS.Timeout | undefined
  let poll: NodeJS.Timeout | undefined
  const tlsError = (): KlfProbeTimeoutError => new KlfProbeTimeoutError('tls', host, limits.tls)
  const passwordError = (): KlfProbeTimeoutError =>
    new KlfProbeTimeoutError('password', host, limits.password)
  const bounds = new Promise<never>((_resolve, reject) => {
    tlsTimer = setTimeout(() => reject(tlsError()), limits.tls)
    poll = setInterval(() => {
      if (handshakeDone || connection.KLF200SocketProtocol === undefined) return
      handshakeDone = true
      clearTimeout(tlsTimer)
      clearInterval(poll)
      passwordTimer = setTimeout(() => reject(passwordError()), limits.password)
    }, PHASE_POLL_MS)
  })
  // The library's own bound is the loosest of ours; ours always fires first.
  const libraryS = (limits.tls + limits.password) / 1000
  try {
    await Promise.race([connection.loginAsync(password, libraryS), bounds])
  } catch (err) {
    if (err instanceof KlfProbeTimeoutError) throw err
    if (/^timeout$/i.test(errMsg(err)) || (err instanceof Error && err.name === 'TimeoutError')) {
      throw handshakeDone ? passwordError() : tlsError()
    }
    throw err
  } finally {
    clearTimeout(tlsTimer)
    clearTimeout(passwordTimer)
    clearInterval(poll)
    bounds.catch(() => undefined)
  }
}

/** What a successful probe learned about the gateway. */
export interface KlfProbeResult {
  /** Firmware version, or null when the gateway logged us in but did not answer GW_GET_VERSION. */
  readonly firmware: string | null
}

/**
 * Opens ONE session, authenticates, reads the firmware version and closes the
 * session again, whatever happens. The gateway accepts two sessions in total, so
 * a probe never lingers and never keeps the house status monitor or the node
 * list. A refused password rejects with `VeluxLoginRefusedError`.
 */
export async function probeKlfGateway(options: KlfProbeOptions): Promise<KlfProbeResult> {
  const limits = { ...DEFAULT_KLF_PROBE_TIMEOUTS_MS, ...options.timeoutsMs }
  const connection =
    options.tls === undefined
      ? new Connection(options.host)
      : new Connection(options.host, options.tls)
  try {
    try {
      await loginInPhases(connection, options.host, options.password, limits)
    } catch (err) {
      if (err instanceof KlfProbeTimeoutError) throw err
      // A connect error keeps its Node `code` (ECONNREFUSED, EHOSTUNREACH ...) so it classifies as unreachable.
      if (err instanceof Error && typeof Reflect.get(err, 'code') === 'string') throw err
      throw loginFailure(err)
    }
    try {
      const { SoftwareVersion } = await withDeadline(
        new Gateway(connection).getVersionAsync(),
        limits.version,
        () => new KlfProbeTimeoutError('version', options.host, limits.version),
      )
      return { firmware: SoftwareVersion.toString() }
    } catch {
      // The login is what the probe proves; the version is a bonus.
      return { firmware: null }
    }
  } finally {
    try {
      await withDeadline(
        connection.logoutAsync(limits.logout / 1000),
        limits.logout + 500,
        () => new KlfProbeTimeoutError('logout', options.host, limits.logout),
      )
    } catch (err) {
      // The socket is being discarded either way: drop it so the session is freed.
      void errMsg(err)
      await connection[Symbol.asyncDispose]().catch(() => undefined)
    }
  }
}
