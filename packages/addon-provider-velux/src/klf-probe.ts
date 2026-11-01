import { connect as tcpConnect } from 'node:net'
import type { ConnectionOptions } from 'node:tls'
import { errMsg } from '@camstack/types'
import { Connection, Gateway } from 'klf-200-api'
import { loginFailure } from './klf-gateway-client.js'

/** The gateway's TLS API port. */
const KLF_PORT = 51200

/** The step of a probe that ran out of time. */
export type KlfProbePhase = 'tcp' | 'login' | 'version' | 'logout'

/** Milliseconds each step of a probe may take. */
export interface KlfProbeTimeoutsMs {
  /** Opening the TCP connection to the gateway port. */
  readonly tcp: number
  /** The TLS handshake, and again the password answer (each gets this long). */
  readonly login: number
  /** The firmware version answer. */
  readonly version: number
  /** Closing the session. */
  readonly logout: number
}

/**
 * Defaults add up, worst case, to 3 + 2 x 5 + 2 + 2 = 17 s, under the
 * `CONNECTION_TEST_TIMEOUT_MS` ceiling of the wizard, so a stuck gateway is named
 * here instead of the wizard giving up unnamed.
 */
export const DEFAULT_KLF_PROBE_TIMEOUTS_MS: KlfProbeTimeoutsMs = {
  tcp: 3_000,
  login: 5_000,
  version: 2_000,
  logout: 2_000,
}

const PHASE_TEXT: Record<KlfProbePhase, string> = {
  tcp: 'did not accept a TCP connection on port 51200',
  login: 'did not complete the secure login (TLS handshake or password answer)',
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

/** A bare TCP connect to the gateway port: tells "nothing listens" from "TLS is stuck". */
function tcpReachable(host: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port: KLF_PORT })
    socket.setTimeout(ms, () => {
      socket.destroy()
      reject(new KlfProbeTimeoutError('tcp', host, ms))
    })
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', (err) => {
      socket.destroy()
      reject(err)
    })
  })
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
  await tcpReachable(options.host, limits.tcp)
  const connection =
    options.tls === undefined
      ? new Connection(options.host)
      : new Connection(options.host, options.tls)
  const loginError = (): KlfProbeTimeoutError =>
    new KlfProbeTimeoutError('login', options.host, limits.login)
  try {
    try {
      await withDeadline(
        connection.loginAsync(options.password, limits.login / 1000),
        limits.login * 2 + 500,
        loginError,
      )
    } catch (err) {
      if (err instanceof KlfProbeTimeoutError) throw err
      if (/^timeout$/i.test(errMsg(err)) || (err instanceof Error && err.name === 'TimeoutError')) {
        throw loginError()
      }
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
