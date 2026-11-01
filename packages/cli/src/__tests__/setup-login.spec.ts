import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let replies: { status: number; body: unknown }[] = []
vi.mock('../http/hub-http.js', () => ({
  hubRequest: async () => {
    const next = replies.shift() ?? { status: 500, body: {} }
    return {
      ok: next.status < 300,
      status: next.status,
      statusText: 'x',
      headers: {},
      text: async () => JSON.stringify(next.body),
      json: async () => next.body,
    }
  },
}))

import { loginTool, loginWaitTool } from '../mcp/setup-login.js'
import { text } from '../mcp/tool-result.js'

const SECRET = 'cda_topsecret'
const ok = (json: unknown) => ({ status: 200, body: [{ result: { data: { json } } }] })
const begin = ok({
  userCode: 'ABCD-EFGH',
  deviceSecret: SECRET,
  expiresAt: Date.now() + 300_000,
  intervalSec: 3,
})
const sessionReply = ok({
  status: 'approved',
  session: {
    token: 'jwt-secret',
    refreshToken: 'rt-secret',
    user: { id: 'u', username: 'admin', isAdmin: true },
  },
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-login-'))
  replies = []
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const deps = () => ({ sessionDir: dir, sleep: async () => undefined, waitMs: 10_000 })

describe('setup_login / setup_login_wait', () => {
  it('returns url+code and no secret anywhere in the tool result', async () => {
    replies = [begin]
    const res = text(await loginTool('hub.example', deps()))
    const body = res.content[0]?.text ?? ''
    expect(body).toContain('ABCD-EFGH')
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain('?code')
  })

  it('wait returns approved status only; the session is on disk, not in the result', async () => {
    replies = [begin]
    await loginTool('hub.example', deps())
    replies = [ok({ status: 'pending' }), sessionReply]
    const res = text(await loginWaitTool('hub.example', deps()))
    const body = res.content[0]?.text ?? ''
    expect(body).toContain('approved')
    for (const secret of ['jwt-secret', 'rt-secret', SECRET]) expect(body).not.toContain(secret)
    expect(fs.readdirSync(dir).length).toBe(1)
  })

  it('an expiry is an isError result', async () => {
    replies = [begin]
    await loginTool('hub.example', deps())
    replies = [{ status: 401, body: {} }]
    const res = text(await loginWaitTool('hub.example', deps()))
    expect(res.isError).toBe(true)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
