/**
 * Client of the broker kind's interactive sign-in contract (`signIn.basePath`
 * in `broker.cap.ts`): start a server-held session, poll it until the account
 * is captured, commit the credentials onto a broker, or cancel. The base path
 * comes from the kind's descriptor; nothing here knows which kind it serves.
 *
 * Addon routes have no tRPC hooks, so these are plain `fetch` calls against the
 * hub with the admin bearer token, every response narrowed by a guard.
 */
import { hubPath } from './mount'

/** A way to sign a broker kind in; the kind lists the ones it serves in preference order. */
export type BrokerSignInMethod = 'device-code' | 'proxy'

export type BrokerSignInPhase = 'starting' | 'awaiting-login' | 'captured' | 'error' | 'cancelled'

const PHASES: readonly string[] = ['starting', 'awaiting-login', 'captured', 'error', 'cancelled']

export interface BrokerSignInStarted {
  readonly sessionId: string
  readonly loginUrl: string
}

export interface DeviceCodeStarted {
  readonly sessionId: string
  readonly userCode: string
  readonly verificationUrl: string
  /** Epoch ms. */
  readonly expiresAt: number
}

export type DeviceCodePhase = 'awaiting-code' | 'captured' | 'expired' | 'error' | 'cancelled'

const DEVICE_CODE_PHASES: readonly string[] = [
  'awaiting-code',
  'captured',
  'expired',
  'error',
  'cancelled',
]

export interface DeviceCodeStatus {
  readonly sessionId: string
  readonly phase: DeviceCodePhase
  readonly userCode: string
  readonly verificationUrl: string
  readonly expiresAt: number
  readonly error: string | null
}

export interface BrokerSignInStatus {
  readonly sessionId: string
  readonly phase: BrokerSignInPhase
  readonly loginUrl: string
  readonly error: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isStarted(value: unknown): value is BrokerSignInStarted {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    typeof value['loginUrl'] === 'string'
  )
}

function isStatus(value: unknown): value is BrokerSignInStatus {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    typeof value['phase'] === 'string' &&
    PHASES.includes(value['phase'])
  )
}

function isDeviceCodeStarted(value: unknown): value is DeviceCodeStarted {
  return (
    isRecord(value) &&
    typeof value['sessionId'] === 'string' &&
    typeof value['userCode'] === 'string' &&
    typeof value['verificationUrl'] === 'string' &&
    typeof value['expiresAt'] === 'number'
  )
}

function isDeviceCodeStatus(value: unknown): value is DeviceCodeStatus {
  return (
    isDeviceCodeStarted(value) &&
    isRecord(value) &&
    typeof value['phase'] === 'string' &&
    DEVICE_CODE_PHASES.includes(value['phase'])
  )
}

function isCommitted(value: unknown): value is { readonly brokerId: string } {
  return isRecord(value) && typeof value['brokerId'] === 'string'
}

function headers(): Record<string, string> {
  const token = localStorage.getItem('camstack_admin_token') ?? ''
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

/** The JSON body of a response, or a readable error naming the step and the HTTP status when it is not JSON. */
async function readJson(res: Response, step: string): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new Error(`${step} failed: HTTP ${res.status}`)
  }
}

function failure(json: unknown): Error {
  const message =
    isRecord(json) && typeof json['error'] === 'string' ? json['error'] : 'Unknown error'
  return new Error(message)
}

async function post<T>(
  url: string,
  body: Record<string, unknown>,
  guard: (v: unknown) => v is T,
): Promise<T> {
  const res = await fetch(hubPath(url), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })
  const json: unknown = await readJson(res, `Sign-in ${url.split('/').pop() ?? 'request'}`)
  if (!res.ok) throw failure(json)
  if (!guard(json)) throw new Error('Unexpected response from server')
  return json
}

/** Start a session. `settings` is the form's current (non-credential) values. */
export function startBrokerSignIn(
  basePath: string,
  settings: Record<string, unknown>,
): Promise<BrokerSignInStarted> {
  return post(`${basePath}/start`, settings, isStarted)
}

/** Start a device-code session: the answer carries the code the operator types on the account's own page. */
export function startDeviceCodeSignIn(
  basePath: string,
  settings: Record<string, unknown>,
): Promise<DeviceCodeStarted> {
  return post(`${basePath}/code/start`, settings, isDeviceCodeStarted)
}

export async function getDeviceCodeStatus(
  basePath: string,
  sessionId: string,
): Promise<DeviceCodeStatus> {
  const params = new URLSearchParams({ sessionId })
  const res = await fetch(hubPath(`${basePath}/status?${params.toString()}`), {
    headers: { Authorization: headers()['Authorization'] ?? '' },
  })
  const json: unknown = await readJson(res, 'Sign-in status')
  if (!res.ok) throw failure(json)
  if (!isDeviceCodeStatus(json)) throw new Error('Unexpected status response from server')
  return json
}

export async function getBrokerSignInStatus(
  basePath: string,
  sessionId: string,
): Promise<BrokerSignInStatus> {
  const params = new URLSearchParams({ sessionId })
  const res = await fetch(hubPath(`${basePath}/status?${params.toString()}`), {
    headers: { Authorization: headers()['Authorization'] ?? '' },
  })
  const json: unknown = await readJson(res, 'Sign-in status')
  if (!res.ok) throw failure(json)
  if (!isStatus(json)) throw new Error('Unexpected status response from server')
  return json
}

/** Store the captured credentials on a new broker named `name`, or on `brokerId` when re-linking. */
export function commitBrokerSignIn(
  basePath: string,
  input: {
    readonly sessionId: string
    readonly name: string
    readonly brokerId?: string
  },
): Promise<{ readonly brokerId: string }> {
  return post(`${basePath}/commit`, { ...input }, isCommitted)
}

/** Best effort: a cancel that fails (navigation, offline) leaves the server to expire the session. */
export async function cancelBrokerSignIn(basePath: string, sessionId: string): Promise<void> {
  try {
    await fetch(hubPath(`${basePath}/cancel`), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ sessionId }),
    })
  } catch {
    // The session times out on the server; nothing to surface.
  }
}
