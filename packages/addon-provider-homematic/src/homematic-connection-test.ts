import {
  type ConnectionTestOutcome,
  errMsg,
  type IConnectionTestProvider,
  type IScopedLogger,
} from '@camstack/types'
import { connectionFromSettings, enabledInterfaces } from './config.js'

const TEST_LABEL =
  'Asks each enabled XML-RPC interface of the CCU for its methods, and signs in to the WebUI when credentials are set'

/** How long one request to the CCU may take before the test gives up on it. */
const PROBE_TIMEOUT_MS = 5_000

/** The ports the wrapped library binds each interface on (plain, TLS) and the path it serves. */
const INTERFACE_ENDPOINTS: Readonly<
  Record<string, { readonly port: number; readonly tlsPort: number; readonly path: string }>
> = {
  'HmIP-RF': { port: 2010, tlsPort: 42010, path: '/' },
  'BidCos-RF': { port: 2001, tlsPort: 42001, path: '/' },
  'BidCos-Wired': { port: 2000, tlsPort: 42000, path: '/' },
  VirtualDevices: { port: 9292, tlsPort: 49292, path: '/groups' },
}

const JSON_RPC_PATH = '/api/homematic.cgi'
const XML_RPC_PROBE =
  '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params/></methodCall>'
/** The WebUI answers a refused login with one of these JSON-RPC codes, or an "access denied" text. */
const AUTH_ERROR_CODES: ReadonlySet<number> = new Set([401, -32001])

/** One HTTP POST. Resolves with whatever the server answered; rejects on a transport failure. */
export type CcuPost = (
  url: string,
  body: string,
  contentType: string,
) => Promise<{ readonly status: number; readonly text: string }>

/** Production {@link CcuPost}: one bounded `fetch`. */
export const httpPost: CcuPost = async (url, body, contentType) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  })
  return { status: response.status, text: await response.text() }
}

/** What the probe needs from the form. */
export interface CcuProbeInput {
  readonly host: string
  readonly tls: boolean
  readonly username: string
  readonly password: string
  /** Interface names to ask, from {@link enabledInterfaces}. */
  readonly interfaces: readonly string[]
}

/** What a successful probe learned. */
export interface CcuProbeResult {
  /** The interfaces that answered. */
  readonly interfaces: readonly string[]
  /** True when the WebUI accepted the credentials (names, rooms and system variables are available). */
  readonly namesUnlocked: boolean
}

/** Why a probe failed. */
export type CcuProbeFailureKind = 'bad-credentials' | 'not-a-ccu' | 'unreachable' | 'other'

export class CcuProbeError extends Error {
  readonly kind: CcuProbeFailureKind
  constructor(kind: CcuProbeFailureKind, message: string) {
    super(message)
    this.name = 'CcuProbeError'
    this.kind = kind
  }
}

function isXmlRpcAnswer(status: number, text: string): boolean {
  return status === 200 && text.includes('<methodResponse')
}

/** A refused login: an "access denied" message or one of the library's auth codes. */
function isAuthRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const message = Reflect.get(error, 'message')
  const code = Reflect.get(error, 'code')
  if (typeof message === 'string' && message.toLowerCase().startsWith('access denied')) return true
  return typeof code === 'number' && AUTH_ERROR_CODES.has(code)
}

function jsonRpcEnvelope(method: string, params: Record<string, string>): string {
  return JSON.stringify({ method, params, jsonrpc: '1.1', id: 0 })
}

/**
 * Ask a real CCU: every enabled interface is asked for its XML-RPC methods (the
 * channel the library pushes events over), and the WebUI JSON-RPC is signed in
 * to when credentials are set (the layer that unlocks names and rooms).
 * `post` is the only I/O, so the classification is testable without a CCU.
 */
export async function probeCcu(
  input: CcuProbeInput,
  post: CcuPost = httpPost,
): Promise<CcuProbeResult> {
  const scheme = input.tls ? 'https' : 'http'
  const answered: string[] = []
  const foreign: string[] = []
  const failures: string[] = []
  for (const name of input.interfaces) {
    const endpoint = INTERFACE_ENDPOINTS[name]
    if (endpoint === undefined) continue
    const port = input.tls ? endpoint.tlsPort : endpoint.port
    try {
      const reply = await post(
        `${scheme}://${input.host}:${port}${endpoint.path}`,
        XML_RPC_PROBE,
        'text/xml',
      )
      if (isXmlRpcAnswer(reply.status, reply.text)) answered.push(name)
      else foreign.push(name)
    } catch (err) {
      failures.push(`${name}: ${errMsg(err)}`)
    }
  }
  if (answered.length === 0) {
    if (foreign.length > 0) {
      throw new CcuProbeError(
        'not-a-ccu',
        `${input.host} answers on the ${foreign.join(', ')} port but not with XML-RPC`,
      )
    }
    throw new CcuProbeError('unreachable', failures.join('; '))
  }

  if (input.username.length === 0) return { interfaces: answered, namesUnlocked: false }
  await signIn(input, scheme, post)
  return { interfaces: answered, namesUnlocked: true }
}

async function signIn(input: CcuProbeInput, scheme: string, post: CcuPost): Promise<void> {
  const url = `${scheme}://${input.host}${JSON_RPC_PATH}`
  let text: string
  try {
    const reply = await post(
      url,
      jsonRpcEnvelope('Session.login', { username: input.username, password: input.password }),
      'application/json',
    )
    text = reply.text
  } catch (err) {
    throw new CcuProbeError('unreachable', `WebUI JSON-RPC: ${errMsg(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CcuProbeError('other', 'The WebUI answered the login with something that is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CcuProbeError('other', 'The WebUI answered the login with an unexpected shape')
  }
  const error: unknown = Reflect.get(parsed, 'error')
  if (error !== null && error !== undefined && error !== false) {
    if (isAuthRefusal(error))
      throw new CcuProbeError('bad-credentials', 'The WebUI refused the login')
    throw new CcuProbeError('other', 'The WebUI returned an error to the login')
  }
  const sessionId: unknown = Reflect.get(parsed, 'result')
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new CcuProbeError('other', 'The WebUI accepted the login but returned no session')
  }
  try {
    await post(
      url,
      JSON.stringify({
        method: 'Session.logout',
        params: { _session_id_: sessionId },
        jsonrpc: '1.1',
        id: 0,
      }),
      'application/json',
    )
  } catch {
    // Best effort: the probe's own session expires on the CCU by itself.
  }
}

export interface HomematicConnectionTestDeps {
  readonly logger: IScopedLogger
  /** One probe of the CCU. Defaults to the real one. */
  readonly probe?: (input: CcuProbeInput) => Promise<CcuProbeResult>
}

function readHost(settings: unknown): string | null {
  if (settings === null || typeof settings !== 'object') return null
  const value = Reflect.get(settings, 'host')
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function describeSuccess(result: CcuProbeResult): string {
  const unlocked = result.namesUnlocked
    ? 'names and rooms unlocked'
    : 'no WebUI credentials, so devices keep their raw addresses as names'
  return `${result.interfaces.join(', ')} answered; ${unlocked}`
}

export function buildHomematicConnectionTestProvider(
  deps: HomematicConnectionTestDeps,
): IConnectionTestProvider {
  const { logger, probe = probeCcu } = deps

  return {
    describeTest: async () => ({ label: TEST_LABEL }),

    testSettings: async ({ settings }): Promise<ConnectionTestOutcome> => {
      const host = readHost(settings)
      if (host === null) {
        return { outcome: 'rejected', error: 'Enter the CCU host or IP address.' }
      }
      const connection = connectionFromSettings(settings)
      if (connection === null) {
        return { outcome: 'rejected', error: 'Some of the connection settings are not valid.' }
      }
      const interfaces = enabledInterfaces(connection)
      if (interfaces.length === 0) {
        return { outcome: 'rejected', error: 'Enable at least one interface.' }
      }

      const startedAt = Date.now()
      try {
        const result = await probe({
          host: connection.host,
          tls: connection.tls,
          username: connection.username,
          password: connection.password,
          interfaces,
        })
        return {
          outcome: 'validated',
          latencyMs: Date.now() - startedAt,
          detail: describeSuccess(result),
        }
      } catch (err) {
        const kind: CcuProbeFailureKind = err instanceof CcuProbeError ? err.kind : 'other'
        logger.warn('Homematic connection test failed', {
          meta: { host: connection.host, kind, error: errMsg(err) },
        })
        switch (kind) {
          case 'bad-credentials':
            return { outcome: 'rejected', error: 'The CCU refused the WebUI username or password.' }
          case 'not-a-ccu':
            return {
              outcome: 'rejected',
              error: `${connection.host} did not answer as a CCU3 or RaspberryMatic. Check the address.`,
            }
          case 'unreachable':
            return {
              outcome: 'inconclusive',
              error: `Could not reach the CCU at ${connection.host}: ${errMsg(err)}`,
            }
          case 'other':
            return {
              outcome: 'inconclusive',
              error: `The CCU test did not finish: ${errMsg(err)}`,
            }
        }
      }
    },
  }
}
