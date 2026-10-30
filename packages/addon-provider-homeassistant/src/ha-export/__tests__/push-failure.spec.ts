import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describePushFailure,
  postToHomeAssistant,
  PushHttpError,
  scrubBody,
} from '../push-failure.js'

describe('describePushFailure', () => {
  it('404 names the missing component in plain words and is permanent', () => {
    const f = describePushFailure(new PushHttpError(404, 'Not Found'))
    expect(f.kind).toBe('component-missing')
    expect(f.permanent).toBe(true)
    expect(f.text).toContain('HTTP 404')
    expect(f.text).toContain('no CamStack integration installed')
    expect(f.text).toContain('/api/camstack/push')
    expect(f.text).toContain('HACS')
  })

  it('401 and 403 say the token was rejected, apart from 404 and 413', () => {
    for (const status of [401, 403]) {
      const f = describePushFailure(new PushHttpError(status, ''))
      expect(f.kind).toBe('token-rejected')
      expect(f.text).toContain('token')
      expect(f.permanent).toBe(false)
    }
    expect(describePushFailure(new PushHttpError(413, '')).kind).toBe('too-large')
    expect(describePushFailure(new PushHttpError(413, '')).text).toContain('too large')
  })

  it('network errors are unreachable, other statuses carry the status and body', () => {
    const refused = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8123'), {
        code: 'ECONNREFUSED',
      }),
    })
    expect(describePushFailure(refused).kind).toBe('unreachable')
    expect(describePushFailure(new DOMException('timed out', 'TimeoutError')).kind).toBe(
      'unreachable',
    )
    const other = describePushFailure(new PushHttpError(500, 'boom'))
    expect(other.kind).toBe('other')
    expect(other.text).toContain('HTTP 500')
    expect(other.text).toContain('boom')
  })

  it('the body is cut to 200 chars and never carries a bearer token', () => {
    expect(scrubBody('x'.repeat(500)).length).toBe(200)
    expect(scrubBody('error Bearer abc.DEF-123 rejected')).not.toContain('abc.DEF-123')
  })
})

describe('postToHomeAssistant', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('throws PushHttpError with status and a bounded body on a non-2xx, never the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(500), { status: 404 })),
    )
    const err = await postToHomeAssistant('http://ha:8123/', 'SECRET-TOKEN', {
      type: 'heartbeat',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PushHttpError)
    if (!(err instanceof PushHttpError)) return
    expect(err.status).toBe(404)
    expect(err.body.length).toBe(200)
    expect(JSON.stringify([err.message, err.body])).not.toContain('SECRET-TOKEN')
  })

  it('resolves on 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    )
    await expect(postToHomeAssistant('http://ha:8123', 't', {})).resolves.toBeUndefined()
  })
})
