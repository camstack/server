import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Call {
  url: string
  body: string
}
const calls: Call[] = []
let replies: { status: number; body: unknown }[] = []
vi.mock('../http/hub-http.js', () => ({
  hubRequest: async (url: string, opts: { body?: string }) => {
    calls.push({ url, body: opts.body ?? '' })
    const next = replies.shift() ?? { status: 500, body: {} }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: 'x',
      headers: {},
      text: async () => JSON.stringify(next.body),
      json: async () => next.body,
    }
  },
}))

import { ApprovalFailedError, loginWithApproval } from '../commands/login-approval.js'

const SECRET = 'cda_supersecretvalue'
const ok = (json: unknown) => ({ status: 200, body: [{ result: { data: { json } } }] })
const begin = (expiresAt: number) =>
  ok({ userCode: 'ABCD-EFGH', deviceSecret: SECRET, expiresAt, intervalSec: 3 })
const approved = ok({
  status: 'approved',
  session: {
    token: 'jwt-token',
    refreshToken: 'refresh-token',
    expiresAt: 123,
    user: { id: 'u1', username: 'admin', isAdmin: true },
  },
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-ap-'))
  calls.length = 0
  replies = []
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function run(extra: { open?: boolean } = {}) {
  const printed: string[] = []
  const opened: string[] = []
  const promise = loginWithApproval({
    server: 'https://hub.example:3443',
    sessionDir: dir,
    print: (l) => printed.push(l),
    sleep: async () => undefined,
    openBrowser: (u) => opened.push(u),
    ...extra,
  })
  return { promise, printed, opened }
}

describe('camstack login by browser approval', () => {
  it('prints the url and the code separately, never the code in the url, never the secret', async () => {
    replies = [begin(Date.now() + 300_000), ok({ status: 'pending' }), approved]
    const { promise, printed, opened } = run()
    await promise
    const text = printed.join('\n')
    expect(text).toContain('https://hub.example:3443/approve')
    expect(text).toContain('ABCD-EFGH')
    expect(printed.filter((l) => l.includes('/approve')).every((l) => !l.includes('ABCD'))).toBe(
      true,
    )
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('jwt-token')
    expect(opened).toEqual([])
  })

  it('opens the browser only with --open', async () => {
    replies = [begin(Date.now() + 300_000), approved]
    const { promise, opened } = run({ open: true })
    await promise
    expect(opened).toEqual(['https://hub.example:3443/approve'])
  })

  it('saves the session 0600 with the refresh token, and polls with the secret in the body only', async () => {
    replies = [begin(Date.now() + 300_000), approved]
    const { promise } = run()
    const res = await promise
    expect(res.username).toBe('admin')
    const mode = fs.statSync(res.sessionFile).mode & 0o777
    expect(mode).toBe(0o600)
    const saved = JSON.parse(fs.readFileSync(res.sessionFile, 'utf8'))
    expect(saved.token).toBe('jwt-token')
    expect(saved.refreshToken).toBe('refresh-token')
    expect(calls.every((c) => !c.url.includes(SECRET))).toBe(true)
    expect(calls[1]?.body).toContain(SECRET)
  })

  it('a denial fails and writes no session', async () => {
    replies = [begin(Date.now() + 300_000), ok({ status: 'denied' })]
    await expect(run().promise).rejects.toMatchObject({ reason: 'denied' })
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('an expiry (401 on poll) fails with the token-file hint', async () => {
    replies = [
      begin(Date.now() + 300_000),
      { status: 401, body: { error: { json: { message: 'gone' } } } },
    ]
    const err = await run().promise.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApprovalFailedError)
    expect(String((err as Error).message)).toContain('--token-file')
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
