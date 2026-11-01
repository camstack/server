/**
 * `camstack login <host>` by browser approval (D988) — the default when there
 * is no TTY (an assistant's shell, a service) or with `--browser`.
 *
 * The CLI asks the hub for a sign-in request and shows the operator a URL and a
 * short code SEPARATELY (the URL never carries the code). The operator opens
 * the admin UI where they are already signed in, types the code and approves.
 * The CLI polls with a secret it holds only in memory; on approval the hub
 * answers with a normal refreshable session, saved 0600 exactly like
 * `login-token-file.ts`. No password, no token and no secret is ever printed.
 */
import { spawn } from 'node:child_process'
import { normalizeHubAddress, saveSession, type SessionFile } from '@camstack/develop'
import { z } from 'zod'
import { hubTrpcMutation } from '../http/hub-trpc.js'

const BeginSchema = z.object({
  userCode: z.string(),
  deviceSecret: z.string(),
  expiresAt: z.number(),
  intervalSec: z.number(),
})

const SessionResultSchema = z.object({
  token: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  user: z.object({ id: z.string(), username: z.string(), isAdmin: z.boolean() }),
})

const PollSchema = z.object({
  status: z.enum(['pending', 'slow_down', 'approved', 'denied', 'expired']),
  intervalSec: z.number().optional(),
  session: SessionResultSchema.optional(),
})

/** The fallback named when the approval cannot finish. */
export const TOKEN_FILE_HINT =
  'Run it again, or sign in without a browser: `camstack login <host> --token-file <path>` (a chmod 600 file).'

export interface ApprovalRequest {
  readonly server: string
  /** Where the operator opens the page. Never contains the code. */
  readonly approvalUrl: string
  readonly userCode: string
  readonly expiresAt: number
  readonly intervalSec: number
  /** Held in memory by the caller; never printed or returned to a tool. */
  readonly deviceSecret: string
}

export type ApprovalPoll =
  | { readonly status: 'pending'; readonly intervalSec: number }
  | {
      readonly status: 'approved'
      readonly username: string
      readonly isAdmin: boolean
      readonly sessionFile: string
    }
  | { readonly status: 'denied' }
  | { readonly status: 'expired' }

export interface ApprovalEnv {
  readonly sessionDir?: string
  readonly clientLabel?: string
  readonly now?: () => number
}

export async function beginApproval(
  serverInput: string,
  env: ApprovalEnv = {},
): Promise<ApprovalRequest> {
  const server = normalizeHubAddress(serverInput)
  const res = await hubTrpcMutation(
    server,
    'auth.cliLoginBegin',
    { client: env.clientLabel ?? 'camstack-cli' },
    BeginSchema,
    env.sessionDir ? { sessionDir: env.sessionDir } : {},
  )
  if (!res.ok) throw new Error(`The hub ${server} refused the sign-in request: ${res.message}`)
  return {
    server,
    approvalUrl: `${server}/approve`,
    userCode: res.data.userCode,
    expiresAt: res.data.expiresAt,
    intervalSec: res.data.intervalSec,
    deviceSecret: res.data.deviceSecret,
  }
}

/** One poll. An approval saves the session (0600) and returns who signed in. */
export async function pollApproval(
  request: Pick<ApprovalRequest, 'server' | 'deviceSecret'>,
  env: ApprovalEnv = {},
): Promise<ApprovalPoll> {
  const res = await hubTrpcMutation(
    request.server,
    'auth.cliLoginPoll',
    { deviceSecret: request.deviceSecret },
    PollSchema,
    env.sessionDir ? { sessionDir: env.sessionDir } : {},
  )
  if (!res.ok) {
    // 401: the hub no longer knows this request (expired and pruned, or already collected).
    if (res.status === 401) return { status: 'expired' }
    throw new Error(`The hub ${request.server} could not check the sign-in: ${res.message}`)
  }
  const { status, session, intervalSec } = res.data
  if (status === 'approved') {
    if (!session) throw new Error('The hub approved the sign-in but returned no session.')
    const now = env.now?.() ?? Date.now()
    const file: SessionFile = {
      server: request.server,
      username: session.user.username,
      tokenId: '',
      token: session.token,
      scopes: [],
      createdAt: now,
      ...(session.user.isAdmin ? { isAdmin: true } : {}),
      ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
      ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
    }
    const sessionFile = saveSession(file, env.sessionDir)
    return {
      status: 'approved',
      username: session.user.username,
      isAdmin: session.user.isAdmin,
      sessionFile,
    }
  }
  if (status === 'denied') return { status: 'denied' }
  if (status === 'expired') return { status: 'expired' }
  return { status: 'pending', intervalSec: intervalSec ?? 3 }
}

export interface ApprovalLoginOptions extends ApprovalEnv {
  readonly server: string
  /** Open the approval page in the default browser (`--open`). */
  readonly open?: boolean
  readonly print?: (line: string) => void
  readonly sleep?: (ms: number) => Promise<void>
  readonly openBrowser?: (url: string) => void
}

export interface ApprovalLoginResult {
  readonly server: string
  readonly username: string
  readonly isAdmin: boolean
  readonly sessionFile: string
}

const MAX_TRANSIENT_FAILURES = 4

export class ApprovalFailedError extends Error {
  constructor(
    readonly reason: 'denied' | 'expired',
    message: string,
  ) {
    super(message)
    this.name = 'ApprovalFailedError'
  }
}

export function defaultOpenBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => undefined)
  child.unref()
}

export async function loginWithApproval(opts: ApprovalLoginOptions): Promise<ApprovalLoginResult> {
  const print = opts.print ?? ((line: string) => console.log(line))
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const request = await beginApproval(opts.server, opts)
  print('Open this page in a browser where you are signed in to CamStack:')
  print(`  ${request.approvalUrl}`)
  print('Then type this code:')
  print(`  ${request.userCode}`)
  const minutes = Math.max(1, Math.round((request.expiresAt - now()) / 60_000))
  print(`Waiting for approval (the code expires in about ${minutes} min)...`)
  if (opts.open === true) (opts.openBrowser ?? defaultOpenBrowser)(request.approvalUrl)

  let intervalSec = request.intervalSec
  let failures = 0
  while (now() < request.expiresAt + intervalSec * 1000) {
    await sleep(intervalSec * 1000)
    let outcome: ApprovalPoll
    try {
      outcome = await pollApproval(request, opts)
      failures = 0
    } catch (err) {
      failures += 1
      if (failures >= MAX_TRANSIENT_FAILURES) throw err
      intervalSec = Math.min(intervalSec * 2, 30)
      continue
    }
    if (outcome.status === 'approved') {
      return {
        server: request.server,
        username: outcome.username,
        isAdmin: outcome.isAdmin,
        sessionFile: outcome.sessionFile,
      }
    }
    if (outcome.status === 'denied') {
      throw new ApprovalFailedError('denied', 'The sign-in was denied in the admin UI.')
    }
    if (outcome.status === 'expired') break
    intervalSec = outcome.intervalSec
  }
  throw new ApprovalFailedError(
    'expired',
    `The sign-in code expired before it was approved. ${TOKEN_FILE_HINT}`,
  )
}
