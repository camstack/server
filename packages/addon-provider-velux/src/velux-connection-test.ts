import {
  errMsg,
  type ConnectionTestOutcome,
  type IConnectionTestProvider,
  type IScopedLogger,
} from '@camstack/types'
import { type KlfProbeResult, probeKlfGateway } from './klf-probe.js'
import { VeluxLoginRefusedError } from './velux-client-contract.js'

/** Sessions the KLF-200 accepts at once, per its API specification. */
export const KLF_MAX_SESSIONS = 2

const TEST_LABEL = 'Logs in to the gateway with this password, then closes the session'

export interface VeluxConnectionTestDeps {
  readonly logger: IScopedLogger
  /** One login attempt. Defaults to the real gateway probe. */
  readonly probe?: (input: { host: string; password: string }) => Promise<KlfProbeResult>
  /** How many sessions this addon already holds on `host`. Defaults to none. */
  readonly liveSessions?: (host: string) => number
}

/** Why a probe failed, as far as the error text and code tell. */
export type ProbeFailureKind = 'wrong-password' | 'unreachable' | 'tls' | 'other'

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EPIPE',
])
const UNREACHABLE_TEXT = /timeout|timed out|closed before|unreachable|refused|not found|reset/i
const TLS_TEXT = /cert|tls|ssl|self[- ]signed|handshake|authoriz|verify|fingerprint/i

/**
 * The library rejects some failures with a plain string (a TLS authorization
 * failure) and others with an Error carrying a Node `code`; both are read here.
 */
export function classifyProbeFailure(err: unknown): { kind: ProbeFailureKind; text: string } {
  if (err instanceof VeluxLoginRefusedError) return { kind: 'wrong-password', text: err.message }
  const text = typeof err === 'string' ? err : errMsg(err)
  const code = typeof err === 'object' && err !== null ? Reflect.get(err, 'code') : undefined
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return { kind: 'unreachable', text }
  if (typeof code === 'string' && TLS_TEXT.test(code)) return { kind: 'tls', text }
  if (TLS_TEXT.test(text)) return { kind: 'tls', text }
  if (UNREACHABLE_TEXT.test(text)) return { kind: 'unreachable', text }
  return { kind: 'other', text }
}

export function buildVeluxConnectionTestProvider(
  deps: VeluxConnectionTestDeps,
): IConnectionTestProvider {
  const { logger, probe = probeKlfGateway, liveSessions = () => 0 } = deps
  /** The tail of the test queue per host: a second test waits for the first to log out. */
  const queues = new Map<string, Promise<unknown>>()

  async function run(host: string, password: string): Promise<ConnectionTestOutcome> {
    if (liveSessions(host) >= KLF_MAX_SESSIONS) {
      logger.warn('Velux connection test skipped: the gateway sessions are in use', {
        meta: { host, live: liveSessions(host) },
      })
      return {
        outcome: 'inconclusive',
        error: `${host} already has ${KLF_MAX_SESSIONS} sessions open from CamStack, and the gateway accepts no more. Save the settings and check again later.`,
      }
    }
    const startedAt = Date.now()
    try {
      const result = await probe({ host, password })
      return {
        outcome: 'validated',
        latencyMs: Date.now() - startedAt,
        ...(result.firmware === null ? {} : { detail: `Firmware ${result.firmware}` }),
      }
    } catch (err) {
      const failure = classifyProbeFailure(err)
      logger.warn('Velux connection test failed', {
        meta: { host, kind: failure.kind, error: failure.text },
      })
      switch (failure.kind) {
        case 'wrong-password':
          return {
            outcome: 'rejected',
            error:
              'The gateway refused the password. Use the password printed on the back of the unit.',
          }
        case 'unreachable':
          return { outcome: 'inconclusive', error: `Could not reach ${host}: ${failure.text}` }
        case 'tls':
          return {
            outcome: 'inconclusive',
            error: `The secure connection to ${host} failed: ${failure.text}`,
          }
        case 'other':
          return {
            outcome: 'inconclusive',
            error: `The gateway test did not finish: ${failure.text}`,
          }
      }
    }
  }

  return {
    describeTest: async () => ({ label: TEST_LABEL }),

    testSettings: async ({ settings }) => {
      const host = readString(settings, 'host')
      if (host === null) {
        return { outcome: 'rejected', error: 'Enter the gateway host or IP address.' }
      }
      const password = readString(settings, 'password')
      if (password === null) {
        return {
          outcome: 'rejected',
          error: 'Enter the password printed on the back of the gateway.',
        }
      }
      const previous = queues.get(host) ?? Promise.resolve()
      const current = previous.then(() => run(host, password))
      const tail = current.catch(() => undefined)
      queues.set(host, tail)
      try {
        return await current
      } finally {
        if (queues.get(host) === tail) queues.delete(host)
      }
    },
  }
}

function readString(settings: unknown, key: string): string | null {
  if (settings === null || typeof settings !== 'object') return null
  const value = Reflect.get(settings, key)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
