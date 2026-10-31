/**
 * `camstack login` / `logout` / `whoami` — local credential cache for
 * the deploy / push commands.
 *
 * The CLI never persists the admin password. `login` caches the login JWT
 * from `auth.login` / `auth.loginVerifyTotp` — the same session the hub
 * uses for admin or non-admin callers (`isAdmin` comes from the user record).
 *
 * Cache layout (`~/.camstack/<host>.json`):
 *   {
 *     server:   "https://hub.example.com:4443",
 *     username: "admin",
 *     tokenId:  "",            — empty for JWT sessions; set for a legacy record
 *     token:    "<jwt>",
 *     refreshToken: "csr_…", expiresAt: 1700000900000  — renewed by every tool
 *     isAdmin:  true,
 *     scopes:   [],
 *     createdAt: 1700000000000
 *   }
 *
 * One file per host so the operator can be logged in to multiple
 * camstack instances simultaneously (dev hub + prod hub + …).
 *
 * UI: prompts use `@clack/prompts` (text/password/select with arrow-key
 * navigation, masked input, Ctrl-C cancel). Spinners around network ops
 * give the operator feedback during the JWT round-trip + token mint.
 */
import * as clack from '@clack/prompts'
import {
  clearSession,
  defaultSession,
  jwtClaims,
  listSessions,
  loadSession,
  saveSession,
  type SessionFile,
} from '@camstack/develop'
import { describeHub, findHubs } from '../discovery/hub-finder.js'
import { pickHub } from '../discovery/hub-picker.js'
import { hubRequest } from '../http/hub-http.js'

/**
 * Clack wrappers: clack returns a `Symbol(cancel)` instead of throwing
 * when the user hits Ctrl-C. We centralise the check so callers stay
 * linear and the CLI always exits with the conventional SIGINT code.
 */
async function askText(message: string, defaultValue?: string): Promise<string> {
  const result = await clack.text({
    message,
    defaultValue: defaultValue ?? '',
    placeholder: defaultValue ?? '',
  })
  if (clack.isCancel(result)) {
    clack.cancel('Cancelled.')
    process.exit(130)
  }
  return result
}

async function askPassword(message: string): Promise<string> {
  const result = await clack.password({ message })
  if (clack.isCancel(result)) {
    clack.cancel('Cancelled.')
    process.exit(130)
  }
  return result
}

/**
 * Thin wrapper around `clack.select`. Returns the picked option's `value`
 * (always a `string` — clack's `Option<Value>` is conditional on
 * `Value extends Primitive` and tsc can't distribute generics through it,
 * so we keep this monomorphic and let callers carry their own enum/union
 * on the string side).
 */
async function askSelect(
  message: string,
  options: readonly { value: string; label: string; hint?: string }[],
): Promise<string> {
  const mutable = options.map((o) =>
    o.hint ? { value: o.value, label: o.label, hint: o.hint } : { value: o.value, label: o.label },
  )
  const result = await clack.select({ message, options: mutable })
  if (clack.isCancel(result)) {
    clack.cancel('Cancelled.')
    process.exit(130)
  }
  return result
}

/**
 * Issue a tRPC mutation against `<server>/trpc/<procedure>?batch=1` and return
 * the inner `result.data.json` payload, validated by the supplied predicate.
 *
 * tRPC v11 batched mutations always return an array; single calls return an
 * object. We normalise to the first entry, then walk the envelope safely:
 *   `[{ result: { data: { json: <payload> } } }]`
 * The predicate is the only place we surface a concrete payload type — every
 * intermediate hop is `unknown` so we never reach for an `as any` cast.
 *
 * TLS note: camstack hubs typically serve a self-signed cert on the LAN.
 * Hub calls go through `hubRequest` (node:https + the hub's pinned CA) so a self-signed
 * hub is trusted WITHOUT disabling TLS verification.
 */
async function callTrpcMutation<T>(
  url: string,
  authorization: string | undefined,
  payload: unknown,
  isPayload: (value: unknown) => value is T,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (authorization) headers['Authorization'] = authorization
  const res = await hubRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ '0': { json: payload } }),
  })
  const text = await res.text()
  const parseJson = (raw: string): unknown => {
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  const body = parseJson(text)
  if (!res.ok) {
    const errMsg =
      body !== null && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : text.slice(0, 200)
    throw new Error(`${res.status} ${res.statusText}: ${errMsg}`)
  }
  const first: unknown = Array.isArray(body) ? body[0] : body
  if (first === null || typeof first !== 'object')
    throw new Error(`${url}: response missing envelope`)
  const result = (first as { result?: unknown }).result
  if (result === null || result === undefined || typeof result !== 'object')
    throw new Error(`${url}: response missing result`)
  const data = (result as { data?: unknown }).data
  if (data === null || data === undefined || typeof data !== 'object')
    throw new Error(`${url}: response missing result.data`)
  const json = (data as { json?: unknown }).json
  if (!isPayload(json)) throw new Error(`${url}: response payload shape mismatch`)
  return json
}

interface LoginPayload {
  readonly token: string
  /** Present because login asked for `refreshable`: renews `token`. */
  readonly refreshToken?: string
  /** When `token` expires (epoch ms). */
  readonly expiresAt?: number
  readonly user: {
    readonly id: string
    readonly username: string
    readonly isAdmin?: boolean
  }
  /** Non-empty: `token` is a 5-minute challenge, not a session. */
  readonly secondFactors?: readonly string[]
}
function isLoginPayload(value: unknown): value is LoginPayload {
  if (value === null || typeof value !== 'object') return false
  const v = value as { token?: unknown; user?: unknown }
  if (typeof v.token !== 'string') return false
  if (v.user === null || typeof v.user !== 'object') return false
  const u = v.user as { id?: unknown; username?: unknown }
  return typeof u.id === 'string' && typeof u.username === 'string'
}

interface LogoutPayload {
  readonly success: true
  readonly revoked: number
}
function isLogoutPayload(value: unknown): value is LogoutPayload {
  if (value === null || typeof value !== 'object') return false
  return Reflect.get(value, 'success') === true && typeof Reflect.get(value, 'revoked') === 'number'
}

/** The hub-side call that ends a cached session, or `null` when there is nothing to end. */
export interface Revocation {
  readonly procedure: 'auth.revokeToken' | 'auth.logout'
  readonly input: Readonly<Record<string, unknown>>
  /** `self`: the session being ended authenticates the call; `fresh`: the new login does. */
  readonly bearer: 'self' | 'fresh'
}

/**
 * How a cached session is ended, decided from the FILE and the token's CLAIMS,
 * never from a token prefix: a record the hub holds by id is revoked by id; a
 * JWT session logs itself out; an opaque token with no id has nothing to end.
 */
export function revocationFor(session: SessionFile): Revocation | null {
  if (session.tokenId) {
    return {
      procedure: 'auth.revokeToken',
      input: { id: session.tokenId },
      bearer: 'fresh',
    }
  }
  if (jwtClaims(session.token) !== null) {
    return { procedure: 'auth.logout', input: {}, bearer: 'self' }
  }
  return null
}

async function performRevocation(
  server: string,
  session: SessionFile,
  freshJwt: string | undefined,
): Promise<void> {
  const r = revocationFor(session)
  if (!r) return
  const bearer = r.bearer === 'fresh' && freshJwt ? freshJwt : session.token
  await callTrpcMutation(
    `${server}/trpc/${r.procedure}?batch=1`,
    `Bearer ${bearer}`,
    r.input,
    isUnknown,
  )
}

async function revokePriorSession(
  server: string,
  prior: SessionFile,
  authJwt: string,
): Promise<void> {
  await performRevocation(server, prior, authJwt)
}

/**
 * A login that owes a second factor answered a challenge token, not a session.
 * Complete the TOTP leg (`auth.loginVerifyTotp`) with a prompted code; a
 * passkey-only account cannot finish here and is told so.
 */
async function completeSecondFactor(server: string, login: LoginPayload): Promise<LoginPayload> {
  const factors = login.secondFactors ?? []
  if (factors.length === 0) return login
  if (!factors.includes('totp')) {
    throw new Error(
      'This account signs in with a passkey as its second factor, which the CLI cannot present. Enable TOTP on the account or use the admin UI.',
    )
  }
  const MAX_CODE_ATTEMPTS = 3
  for (let attempt = 1; ; attempt++) {
    const code = await askText('Authenticator code (6 digits)')
    try {
      return await callTrpcMutation(
        `${server}/trpc/auth.loginVerifyTotp?batch=1`,
        undefined,
        { challengeToken: login.token, code, refreshable: true },
        isLoginPayload,
      )
    } catch (err) {
      if (attempt >= MAX_CODE_ATTEMPTS) throw err
      clack.log.warn(`Code rejected: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function isUnknown(_value: unknown): _value is unknown {
  return true
}

/**
 * Interactive server picker (D838): the hubs the LAN announces over mDNS plus
 * the hubs this machine already knows (saved sessions,
 * `$CAMSTACK_HUB_URL`, the repo's `scratchpad/.hub-url`), reachable ones only.
 * One hub is used without asking; several show a picker with the source of each
 * and an "Enter an address…" entry; none is an error that names `--server`.
 */
async function resolveServerInteractive(): Promise<string> {
  const spinner = clack.spinner()
  spinner.start('Looking for a camstack hub (LAN mDNS + known hubs)')
  const hubs = await findHubs({
    workspaceRoot: process.cwd(),
    onProblem: (message) => clack.log.warn(`mDNS: ${message}`),
  })
  if (hubs.length === 0) {
    spinner.stop('No camstack hub found.')
  } else if (hubs.length === 1) {
    spinner.stop(`Hub: ${describeHub(hubs[0]!)}`)
  } else {
    spinner.stop(`Found ${hubs.length} hubs.`)
  }
  return pickHub(hubs, {
    select: askSelect,
    text: async (message, validate) => {
      const result = await clack.text({
        message,
        validate: (value) => validate(value ?? ''),
      })
      if (clack.isCancel(result)) {
        clack.cancel('Cancelled.')
        process.exit(130)
      }
      return result
    },
  })
}

/**
 * Sentinel returned by askText / askPassword wrappers when the operator
 * types `:back` (or `:b`). The outer state machine watches for it and
 * rewinds to the previous step. We use a string sentinel (not throw or
 * symbol) so the type stays `Promise<string>` — clack already owns the
 * cancellation channel via `isCancel`, and Ctrl-C still aborts the
 * whole command.
 */
const BACK_SENTINEL = '__back__'

async function askWithBack(
  label: string,
  defaultValue?: string,
): Promise<string | typeof BACK_SENTINEL> {
  const v = await askText(`${label} (or type :back)`, defaultValue)
  return v.trim() === ':back' || v.trim() === ':b' ? BACK_SENTINEL : v
}
async function askPasswordWithBack(): Promise<string | typeof BACK_SENTINEL> {
  const v = await askPassword('Password (or type :back to change username)')
  return v.trim() === ':back' || v.trim() === ':b' ? BACK_SENTINEL : v
}

/**
 * `camstack login` — prompts for credentials, caches the login JWT locally.
 * Idempotent: re-running best-effort revokes the prior session (if present).
 *
 * Resolution chain for the server URL:
 *   1. `--server` (or $CAMSTACK_SERVER) — explicit, skips discovery.
 *   2. neither — the hubs announced over mDNS plus the known ones, auto-picked
 *      when there is one, arrow-key select otherwise (D838).
 *
 * Steps are wired through a small state machine so the operator can
 * `:back` between username ↔ password ↔ server picker. `:back` at the
 * server picker re-runs the LAN scan; `:back` from password rewinds to
 * the username prompt; etc.
 */
export async function loginCommand(opts: {
  server?: string
  username?: string
  password?: string
  tokenName?: string
}): Promise<void> {
  clack.intro('camstack login')

  // Step machine: cycles until we have all three inputs without a back.
  type Step = 'server' | 'username' | 'password'
  let step: Step = opts.server ? 'username' : 'server'
  let server: string = opts.server ?? ''
  let username: string = opts.username ?? ''
  let password: string = opts.password ?? ''

  if (opts.server) clack.log.info(`Server: ${opts.server}`)

  // The picker / text steps support a `:back` sentinel; the outer loop
  // maps it to the previous step. CLI args (--username/--password)
  // short-circuit the prompt for that step but still allow back from
  // later steps to override.
  while (step !== 'password' || !password) {
    if (step === 'server') {
      server = await resolveServerInteractive()
      step = 'username'
      continue
    }
    if (step === 'username') {
      // If args supplied a username, accept it once but allow back to
      // revisit; clearing it sends us to server picker.
      const result =
        opts.username && !username
          ? opts.username
          : await askWithBack('Username', username || 'admin')
      if (result === BACK_SENTINEL) {
        // Back from username → server picker. Skipping if `--server`
        // was supplied (no picker to go back to).
        if (opts.server) {
          clack.log.warn(
            'Server was passed via --server; nothing to go back to. Re-enter username.',
          )
          continue
        }
        step = 'server'
        continue
      }
      username = result
      step = 'password'
      continue
    }
    // password step
    const result = opts.password && !password ? opts.password : await askPasswordWithBack()
    if (result === BACK_SENTINEL) {
      step = 'username'
      continue
    }
    password = result
    break
  }

  // Attempt loop: re-prompt for password on failure, up to MAX_ATTEMPTS.
  // We never re-prompt the username — typical mistake is a typo on the
  // password, not the user. After the cap we bail with the last error.
  // When `opts.password` is supplied (non-interactive), no retries — fail
  // immediately so scripts get a clean exit instead of looping forever.
  const MAX_ATTEMPTS = 3
  let attempt = 1
  let jwt: string
  let displayName: string
  let userId: string
  let isAdmin = false
  let refreshToken: string | undefined
  let expiresAt: number | undefined
  while (true) {
    const authSpinner = clack.spinner()
    authSpinner.start(
      `Authenticating as ${username}${attempt > 1 ? ` (attempt ${attempt}/${MAX_ATTEMPTS})` : ''}`,
    )
    try {
      const first = await callTrpcMutation(
        `${server}/trpc/auth.login?batch=1`,
        undefined,
        { username, password, refreshable: true },
        isLoginPayload,
      )
      const owesSecondFactor = (first.secondFactors ?? []).length > 0
      if (owesSecondFactor) authSpinner.stop('Password accepted')
      const login = await completeSecondFactor(server, first)
      jwt = login.token
      displayName = login.user.username
      userId = login.user.id
      isAdmin = login.user.isAdmin === true
      refreshToken = login.refreshToken
      expiresAt = login.expiresAt
      if (!owesSecondFactor) authSpinner.stop(`Authenticated as ${displayName}`)
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      authSpinner.stop(`Auth failed: ${msg}`)
      // Non-interactive mode (--password flag) or last attempt: surface error.
      if (opts.password !== undefined || attempt >= MAX_ATTEMPTS) {
        throw err
      }
      attempt++
      password = await askPassword('Password (retry)')
    }
  }

  // Revoke any prior session for this server so the local cache + the
  // server-side token row stay in sync. Best-effort — a stale row left
  // behind is harmless beyond the operator's token-list UI clutter.
  const prior = loadSession(server)
  if (prior) {
    try {
      await revokePriorSession(server, prior, jwt)
    } catch (err) {
      clack.log.warn(
        `Failed to revoke prior session: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  void opts.tokenName
  void userId
  const session: SessionFile = {
    server,
    username: displayName,
    tokenId: '',
    token: jwt,
    scopes: [],
    createdAt: Date.now(),
    ...(isAdmin ? { isAdmin: true } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
  const file = saveSession(session)
  const role = isAdmin ? 'administrator' : 'user'
  clack.outro(`✓ Logged in as ${displayName} (${role}) → ${server}\n  Cached at ${file}`)
}

export async function logoutCommand(opts: { server: string }): Promise<void> {
  const session = loadSession(opts.server)
  if (!session) {
    console.log(`[camstack] No active session for ${opts.server}.`)
    return
  }
  clack.intro('camstack logout')
  const spinner = clack.spinner()
  spinner.start(`Revoking token on ${session.server}`)
  try {
    await performRevocation(session.server, session, undefined)
    spinner.stop('Session revoked server-side.')
  } catch (err) {
    spinner.stop(
      `Server-side revoke failed (${err instanceof Error ? err.message : String(err)}). Removing local cache anyway.`,
    )
  }
  clearSession(session.server)
  clack.outro(`✓ Logged out of ${session.server}`)
}

/**
 * `whoami` with several saved sessions and no server: every session, the one a
 * command would use by default marked. The default rule lives in
 * `defaultSession` (`$CAMSTACK_SERVER`, else the most recently used).
 */
export function formatSessionList(
  sessions: readonly SessionFile[],
  defaultServer: string | undefined,
): string {
  const lines = [
    `[camstack] ${sessions.length} saved sessions (* = used when no --server is given):`,
  ]
  for (const s of sessions) {
    const mark = s.server === defaultServer ? '*' : ' '
    const scopes =
      s.scopes.length > 0 ? s.scopes.map((x) => `${x.type}:${x.target}`).join(', ') : '(login JWT)'
    lines.push(`${mark} ${s.server}`)
    lines.push(`    user: ${s.username}   admin: ${s.isAdmin === true ? 'yes' : 'no'}`)
    lines.push(`    scopes: ${scopes}`)
    lines.push(`    last used: ${new Date(s.lastUsedAt ?? s.createdAt).toISOString()}`)
  }
  lines.push('Default: $CAMSTACK_SERVER if set, else the most recently used session.')
  lines.push('Pick another with `camstack whoami --server <host>`.')
  return lines.join('\n')
}

/**
 * `whoami` now pings `/api/auth/whoami` to validate the cached token
 * against the server. Catches revocation done elsewhere (e.g. admin
 * UI revoke) + token expiry + cleanup orphans, which the local cache
 * couldn't detect on its own.
 */
export async function whoamiCommand(opts: { server?: string }): Promise<void> {
  if (!opts.server) {
    const sessions = listSessions()
    if (sessions.length > 1) {
      console.log(formatSessionList(sessions, defaultSession(sessions)?.server))
      return
    }
  }
  const session = loadSession(opts.server)
  if (!session) {
    console.log(`[camstack] Not logged in${opts.server ? ` to ${opts.server}` : ''}.`)
    process.exit(1)
  }
  console.log(`[camstack] Active session (local cache):`)
  console.log(`  server:    ${session.server}`)
  console.log(`  username:  ${session.username}`)
  console.log(`  token:     ${session.token.slice(0, 12)}…`)
  if (session.tokenId) console.log(`  tokenId:   ${session.tokenId}`)
  const scopeLine =
    session.scopes.length > 0
      ? session.scopes.map((s) => `${s.type}:${s.target}`).join(', ')
      : '(login JWT)'
  console.log(`  scopes:    ${scopeLine}`)
  const claims = jwtClaims(session.token)
  const admin = session.isAdmin === true || claims?.['isAdmin'] === true
  console.log(`  admin:     ${admin ? 'yes' : 'no'}`)
  const expiresAt =
    session.expiresAt ?? (typeof claims?.['exp'] === 'number' ? claims['exp'] * 1000 : undefined)
  if (expiresAt !== undefined) {
    console.log(
      `  expires:   ${new Date(expiresAt).toISOString()}${session.refreshToken ? ' (renewed automatically)' : ''}`,
    )
  }
  console.log(`  createdAt: ${new Date(session.createdAt).toISOString()}`)
  console.log('')

  // Server ping — confirms the token is still recognised. We pause
  // up to ~3s so an unreachable hub doesn't hang the CLI.
  console.log(`[camstack] Pinging ${session.server}/api/auth/whoami…`)
  try {
    const res = await hubRequest(`${session.server}/api/auth/whoami`, {
      headers: { Authorization: `Bearer ${session.token}` },
      timeoutMs: 3_000,
    })
    if (res.status === 401) {
      // The token is dead server-side (admin revoked it via UI, or boot
      // cleanup dropped it as orphan, or it expired). The local cache is
      // now lying — drop it so the next command can't tempt to re-use a
      // zombie token. We delete after printing so the operator still
      // sees which session got invalidated.
      clearSession(session.server)
      console.error(`[camstack] ✗ Token rejected by server (revoked / expired).`)
      console.error(`[camstack]   Local cache cleared. Run \`camstack login\` to issue a new one.`)
      process.exit(2)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[camstack] ✗ Server returned ${res.status}: ${body.slice(0, 160)}`)
      process.exit(2)
    }
    interface WhoamiResp {
      readonly kind?: string
      readonly username?: string
      readonly userId?: string
      readonly scopes?: readonly {
        readonly type: string
        readonly target: string
      }[]
    }
    const json = (await res.json()) as WhoamiResp
    console.log(`[camstack] ✓ Token valid on server.`)
    console.log(`  kind:     ${json.kind ?? 'unknown'}`)
    if (json.userId) console.log(`  userId:   ${json.userId}`)
    if (json.username) console.log(`  username: ${json.username}`)
    if (Array.isArray(json.scopes)) {
      const scopeList = json.scopes
        .map((s: { type: string; target: string }) => `${s.type}:${s.target}`)
        .join(', ')
      console.log(`  scopes:   ${scopeList}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[camstack] ⚠ Could not reach server: ${msg}`)
    console.error(
      `[camstack]   The local cache may be stale. Try \`camstack login\` once the server is reachable.`,
    )
    process.exit(2)
  }
}
