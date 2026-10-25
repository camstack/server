/**
 * Tests for `handleLwaTokensCallback` — bearer-only auth path.
 * The `/oauth/lwa-tokens` endpoint accepts only an `Authorization: Bearer`
 * oauth-access token; the former shared-secret fallback has been removed.
 */
import { describe, it, expect, vi, type MockedFunction } from 'vitest'
import {
  handleLwaTokensCallback,
  type LwaTokensCallbackDeps,
} from '../handlers/lwa-tokens-callback.js'
import type { AddonContext, AddonHttpReply, AddonHttpRequest } from '@camstack/types'

// ── Minimal mock helpers ──────────────────────────────────────────────

function makeRequest(overrides: {
  body?: Record<string, unknown>
  headers?: Record<string, string>
}): AddonHttpRequest {
  return {
    body: overrides.body ?? {
      lwaAccessToken: 'lwa-access',
      lwaRefreshToken: 'lwa-refresh',
      expiresAt: Date.now() + 3600_000,
    },
    headers: overrides.headers ?? {},
  } as unknown as AddonHttpRequest
}

function makeReply(): {
  code: MockedFunction<(n: number) => { send: MockedFunction<(body: unknown) => void> }>
  lastCode: number
  lastBody: unknown
} {
  const reply = {
    lastCode: 0,
    lastBody: undefined as unknown,
    code(n: number) {
      reply.lastCode = n
      return {
        send(body: unknown) {
          reply.lastBody = body
        },
      }
    },
  }
  return reply as ReturnType<typeof makeReply>
}

function makeDeps(oauthResult: unknown): LwaTokensCallbackDeps {
  const oauthVerifyAccessToken = { query: vi.fn().mockResolvedValue(oauthResult) }
  const ctx = {
    api: {
      userManagement: { oauthVerifyAccessToken },
    },
  } as unknown as AddonContext

  return {
    ctx,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as LwaTokensCallbackDeps['logger'],
    upsertToken: vi.fn().mockResolvedValue(undefined),
    recordLinkedAccount: vi.fn().mockResolvedValue(undefined),
  }
}

// ── Bearer auth (oauth-access token) tests ────────────────────────────

describe('handleLwaTokensCallback — bearer auth path', () => {
  const validBody = {
    lwaAccessToken: 'lwa-access-tok',
    lwaRefreshToken: 'lwa-refresh-tok',
    expiresAt: Date.now() + 3600_000,
  }

  it('returns 200 and stores tokens when oauthVerifyAccessToken resolves a valid userId', async () => {
    const oauthResult = { userId: 'user-123', username: 'alice', scopes: [] }
    const deps = makeDeps(oauthResult)
    const reply = makeReply()

    await handleLwaTokensCallback(
      makeRequest({
        body: validBody,
        headers: { authorization: 'Bearer valid-oauth-token' },
      }),
      reply as unknown as AddonHttpReply,
      deps,
    )

    expect(reply.lastCode).toBe(200)
    expect(reply.lastBody).toMatchObject({ ok: true })
    expect(deps.upsertToken).toHaveBeenCalledOnce()
    expect(deps.upsertToken).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-123' }))
    // Records the linked account so getStatus → 'linked' + the Event Gateway
    // has an audience for proactive doorbell/motion (cloud-mode path).
    expect(deps.recordLinkedAccount).toHaveBeenCalledWith({ userId: 'user-123', username: 'alice' })
  })

  it('queries oauthVerifyAccessToken with the extracted bearer token', async () => {
    const oauthResult = { userId: 'user-abc', username: 'bob', scopes: [] }
    const deps = makeDeps(oauthResult)
    const reply = makeReply()

    await handleLwaTokensCallback(
      makeRequest({
        body: validBody,
        headers: { authorization: 'Bearer my-oauth-access-token' },
      }),
      reply as unknown as AddonHttpReply,
      deps,
    )

    const { query } = (
      deps.ctx as unknown as {
        api: {
          userManagement: {
            oauthVerifyAccessToken: { query: MockedFunction<(args: unknown) => unknown> }
          }
        }
      }
    ).api.userManagement.oauthVerifyAccessToken
    expect(query).toHaveBeenCalledWith({ token: 'my-oauth-access-token' })
  })

  it('returns 401 when oauthVerifyAccessToken returns null (invalid token)', async () => {
    const deps = makeDeps(null)
    const reply = makeReply()

    await handleLwaTokensCallback(
      makeRequest({
        body: validBody,
        headers: { authorization: 'Bearer bad-token' },
      }),
      reply as unknown as AddonHttpReply,
      deps,
    )

    expect(reply.lastCode).toBe(401)
    expect(reply.lastBody).toMatchObject({ error: 'unauthorized' })
    expect(deps.upsertToken).not.toHaveBeenCalled()
  })

  it('returns 401 when no Authorization header is present', async () => {
    const deps = makeDeps(null)
    const reply = makeReply()

    await handleLwaTokensCallback(
      makeRequest({ body: validBody, headers: {} }),
      reply as unknown as AddonHttpReply,
      deps,
    )

    expect(reply.lastCode).toBe(401)
    expect(reply.lastBody).toMatchObject({ error: 'unauthorized' })
    expect(deps.upsertToken).not.toHaveBeenCalled()
  })

  it('returns 400 when the body is invalid', async () => {
    const deps = makeDeps({ userId: 'user-123', username: 'alice', scopes: [] })
    const reply = makeReply()

    await handleLwaTokensCallback(
      makeRequest({
        body: { lwaAccessToken: 'tok' }, // missing required fields
        headers: { authorization: 'Bearer valid-token' },
      }),
      reply as unknown as AddonHttpReply,
      deps,
    )

    expect(reply.lastCode).toBe(400)
    expect(reply.lastBody).toMatchObject({ error: 'invalid_body' })
  })
})
