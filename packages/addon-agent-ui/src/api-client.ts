/**
 * Agent API client — the ONE door every panel in this UI goes through.
 *
 * Remote access requires a hub unlock session token (D821); there is no cluster
 * secret any more (D857). Loopback (Electron) is exempt. The session lives in
 * sessionStorage only: per-tab, gone on close.
 */

/** Tab session after redeeming a hub unlock ticket (D821). */
export const AGENT_SESSION_STORAGE_KEY = 'camstack_agent_ui_session'

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized — unlock required')
  }
}

/** The unlock session, when this tab holds one. */
export function authHeaders(): Record<string, string> {
  const session = sessionStorage.getItem(AGENT_SESSION_STORAGE_KEY)
  return session ? { Authorization: `Bearer ${session}` } : {}
}

/**
 * Redeem a hub unlock ticket for a tab session. No prior Bearer — the ticket
 * is the proof. Stores the session.
 */
export async function redeemUnlockTicket(ticket: string): Promise<void> {
  const res = await fetch('/api/agent/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string
    } | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  const data = (await res.json()) as { token?: string }
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new Error('unlock session missing token')
  }
  sessionStorage.setItem(AGENT_SESSION_STORAGE_KEY, data.token)
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() })
  if (res.status === 401) throw new UnauthorizedError()
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  if (res.status === 401) throw new UnauthorizedError()
  return res.json() as Promise<T>
}
