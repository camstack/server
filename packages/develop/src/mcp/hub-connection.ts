/**
 * How an MCP server reaches a hub: the `dominevo login` session, renewed
 * automatically, and nothing else (D1101). No token flag, no token file, no
 * credential in the environment. TLS is pinned or the system store, never
 * switched off.
 *
 * Shared by `dominevo mcp` and the private operator MCP so there is one chain.
 */
import { adminCredentialHint, sessionLoginCommand } from '../hub/login-hints.js'
import {
  MissingCredentialsError,
  type CredentialSource,
  type CredentialTier,
} from '../hub/credentials.js'
import { createHubClient, type HubClient, type HubTransport } from '../hub/hub-client.js'
import { refreshOnUnauthorized, resolveFreshCredentials } from '../hub/session-refresh.js'
import { loadSession } from '../hub/session-store.js'
import { resolveHubTls, type HubTlsConfig } from '../hub/hub-tls.js'
import { resolveHubUrl } from '../hub/hub-url.js'

export interface HubConnectOptions {
  /** A checkout whose `scratchpad/.hub-url` may name the hub (the CLI passes its cwd). */
  readonly workspaceRoot: string
  /** `--server` of the MCP entry. */
  readonly server?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The session cache directory (tests); defaults to `~/.camstack`. */
  readonly sessionDir?: string
  readonly transport?: HubTransport
  /** The exact `dominevo login` command to show (tests); default: derived from PATH. */
  readonly loginCommand?: string
}

/** The environment keys the MCP honours: addresses and PATHS, never a secret. */
const HONOURED_ENV = ['CAMSTACK_HUB_URL', 'CAMSTACK_SERVER', 'CAMSTACK_HUB_CA_FILE'] as const

function honouredEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const key of HONOURED_ENV) out[key] = env[key]
  return out
}

export interface HubConnection {
  readonly server: string
  readonly token: string
  readonly tier: CredentialTier
  readonly source: CredentialSource
  readonly tls: HubTlsConfig
  readonly client: HubClient
  readonly adminHint: string | null
  /** Why the tier could not be confirmed with the hub (then `tier` is not a verdict); absent otherwise. */
  readonly tierLookupFailure?: string
  readonly loginCommand: string
  /**
   * Who this connection acts as, stated to the caller so a reused saved
   * session is never silent: "using saved session <user>@<hub>, scope <x>".
   * Null when no saved session is recorded for the hub.
   */
  readonly actingAs?: string | null
}

/** "using saved session <user>@<host>, scope <x>", or null when the credential is not a saved session. */
export function describeSavedSession(
  source: CredentialSource,
  session: {
    readonly username: string
    readonly isAdmin?: boolean
    readonly scopes: readonly { type: string; target: string }[]
  } | null,
  server: string,
): string | null {
  if (source !== 'session' || session === null) return null
  const host = server.replace(/^https?:\/\//, '')
  const scope =
    session.isAdmin === true
      ? 'admin'
      : session.scopes.length > 0
        ? session.scopes.map((x) => `${x.type}:${x.target}`).join(', ')
        : 'none'
  return `using saved session ${session.username}@${host}, scope ${scope}`
}

export async function connectHub(options: HubConnectOptions): Promise<HubConnection> {
  const env = honouredEnv(options.env ?? process.env)
  const dir = options.sessionDir
  const session = loadSession(undefined, dir)
  const hub = resolveHubUrl({
    ...(options.server ? { explicit: options.server } : {}),
    env,
    workspaceRoot: options.workspaceRoot,
    session,
  })
  if (!hub) {
    throw new Error(
      'no hub address: pass --server, set CAMSTACK_HUB_URL, write <checkout>/scratchpad/.hub-url, or run `dominevo login`',
    )
  }
  const loginCommand = options.loginCommand ?? sessionLoginCommand()
  const tls = resolveHubTls(hub.url, env, dir)
  const credentials = await resolveFreshCredentials({
    server: hub.url,
    env: { CAMSTACK_SERVER: hub.url },
    loadSession: (server) => loadSession(server, dir),
    ...(dir ? { dir } : {}),
    tls,
    ...(options.transport ? { transport: options.transport } : {}),
  })
  const client = createHubClient({
    baseUrl: hub.url,
    token: credentials.token,
    tls,
    ...(options.transport ? { transport: options.transport } : {}),
    // A 401 on a login session renews it once and retries once.
    ...(credentials.source === 'session'
      ? {
          onUnauthorized: refreshOnUnauthorized({
            server: hub.url,
            ...(dir ? { dir } : {}),
            tls,
            ...(options.transport ? { transport: options.transport } : {}),
          }),
        }
      : {}),
  })
  const adminHint = credentials.tier === 'admin' ? null : adminCredentialHint(loginCommand)
  return {
    server: hub.url,
    token: credentials.token,
    tier: credentials.tier,
    source: credentials.source,
    tls,
    client,
    adminHint,
    ...(credentials.tierLookupFailure !== undefined
      ? { tierLookupFailure: credentials.tierLookupFailure }
      : {}),
    loginCommand,
    actingAs: describeSavedSession(credentials.source, loadSession(hub.url, dir), hub.url),
  }
}

/** A tool that needs a hub and finds no usable session: a result, never a throw. */
export interface NoSessionOutcome {
  readonly ok: false
  readonly reason: 'no-session'
  readonly message: string
  readonly action: string
}

export type ConnectOutcome =
  | { readonly ok: true; readonly connection: HubConnection }
  | NoSessionOutcome

/**
 * {@link connectHub}, with "no hub address" and "no credentials" turned into a
 * structured outcome that names the one command to run. Other failures (a TLS
 * problem, a refused refresh) still throw: they are not a missing login.
 */
export async function tryConnectHub(options: HubConnectOptions): Promise<ConnectOutcome> {
  const loginCommand = options.loginCommand ?? sessionLoginCommand()
  const action = `run \`${loginCommand} <host>\` in a terminal`
  try {
    return { ok: true, connection: await connectHub(options) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof MissingCredentialsError || message.startsWith('no hub address')) {
      return {
        ok: false,
        reason: 'no-session',
        message: `no usable hub session: ${message}`,
        action,
      }
    }
    throw err
  }
}
