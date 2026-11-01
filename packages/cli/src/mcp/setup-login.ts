/**
 * `setup_login` / `setup_login_wait` — sign in by browser approval from an
 * assistant (D988). The device secret stays in this process's memory, keyed by
 * hub; a tool result carries only the URL, the short code and a status. The
 * session lands in `~/.camstack` (0600) and is never returned.
 */
import {
  beginApproval,
  pollApproval,
  type ApprovalEnv,
  type ApprovalRequest,
} from '../commands/login-approval.js'

export const LOGIN_WAIT_MAX_MS = 60_000

export interface LoginStarted {
  readonly status: 'started'
  readonly url: string
  readonly code: string
  readonly expiresAt: number
  readonly next: string
}

export type LoginWaitResult =
  | { readonly status: 'approved'; readonly username: string; readonly server: string }
  | { readonly status: 'pending'; readonly next: string }
  | { readonly status: 'denied' }
  | { readonly status: 'expired'; readonly next: string }
  | { readonly status: 'no-request'; readonly next: string }

export interface LoginDeps extends ApprovalEnv {
  readonly sleep?: (ms: number) => Promise<void>
  readonly waitMs?: number
}

const pendingByServer = new Map<string, ApprovalRequest>()

export async function loginTool(server: string, deps: LoginDeps = {}): Promise<LoginStarted> {
  const request = await beginApproval(server, deps)
  pendingByServer.set(request.server, request)
  return {
    status: 'started',
    url: request.approvalUrl,
    code: request.userCode,
    expiresAt: request.expiresAt,
    next: 'Tell the operator to open the url in a browser where they are signed in to CamStack and type the code, then call setup_login_wait.',
  }
}

export async function loginWaitTool(
  server: string,
  deps: LoginDeps = {},
): Promise<LoginWaitResult> {
  const { normalizeHubAddress } = await import('@camstack/develop')
  const key = normalizeHubAddress(server)
  const request = pendingByServer.get(key)
  if (!request) {
    return { status: 'no-request', next: 'Call setup_login first.' }
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now
  const deadline = now() + (deps.waitMs ?? LOGIN_WAIT_MAX_MS)
  let intervalSec = request.intervalSec
  for (;;) {
    const outcome = await pollApproval(request, deps)
    if (outcome.status === 'approved') {
      pendingByServer.delete(key)
      return { status: 'approved', username: outcome.username, server: key }
    }
    if (outcome.status === 'denied') {
      pendingByServer.delete(key)
      return { status: 'denied' }
    }
    if (outcome.status === 'expired') {
      pendingByServer.delete(key)
      return {
        status: 'expired',
        next: 'Call setup_login again, or sign in without a browser: camstack login <host> --token-file <path>.',
      }
    }
    intervalSec = outcome.intervalSec
    if (now() + intervalSec * 1000 >= deadline) {
      return { status: 'pending', next: 'Not approved yet; call setup_login_wait again.' }
    }
    await sleep(intervalSec * 1000)
  }
}
