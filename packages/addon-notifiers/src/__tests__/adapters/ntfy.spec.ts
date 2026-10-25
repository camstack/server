/**
 * Table-driven unit tests for the ntfy adapter's PURE `buildRequest`.
 *
 * Each case starts from a canonical `Notification`, runs it through the real
 * degrade engine (`prepareNotification`) against the adapter's own caps, then
 * asserts the EXACT `HttpRequestPlan` `buildRequest` emits — url / method /
 * headers / body. No network is touched.
 */
import type { Notification } from '@camstack/types'
import { prepareNotification } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { HttpRequestPlan, TargetConfig } from '../../adapters/adapter.js'
import { ntfyAdapter } from '../../adapters/ntfy.js'

// ── Helpers ──────────────────────────────────────────────────────────

const BASE_CONFIG: TargetConfig = { topic: 'alerts', token: 'tk_secret' }

function notification(overrides: Partial<Notification>): Notification {
  return {
    body: 'Hello world',
    format: 'text',
    priority: 3,
    ...overrides,
  }
}

/** Canonical → degrade (against the ntfy caps) → buildRequest. */
function planFor(config: TargetConfig, n: Notification): HttpRequestPlan {
  const prepared = prepareNotification(ntfyAdapter.descriptor.caps, n)
  return ntfyAdapter.buildRequest(config, prepared)
}

/** Narrow a plan body to its JSON value for assertions. */
function jsonBody(plan: HttpRequestPlan): Record<string, unknown> {
  if (plan.body?.kind !== 'json') throw new Error(`expected json body, got ${plan.body?.kind}`)
  const value = plan.body.value
  if (typeof value !== 'object' || value === null) throw new Error('json body is not an object')
  return value as Record<string, unknown>
}

// ── Descriptor ───────────────────────────────────────────────────────

describe('ntfy descriptor', () => {
  it('declares the ntfy caps contract', () => {
    const { descriptor } = ntfyAdapter
    expect(descriptor.kind).toBe('ntfy')
    expect(descriptor.addonId).toBe('notifiers')
    expect(descriptor.supportsDiscovery).toBe(false)
    expect(descriptor.caps.attachments).toEqual({
      mediaTypes: ['image', 'icon'],
      mode: 'both',
      max: 1,
    })
    expect(descriptor.caps.actions).toBe(3)
    expect(descriptor.caps.format).toEqual(['text', 'markdown'])
    expect(descriptor.caps.clickUrl).toBe(true)
    expect(descriptor.caps.sound).toBe(false)
    expect(descriptor.caps.ttl).toBe(false)
    expect(descriptor.caps.bodyMaxLen).toBe(4096)
    expect(descriptor.caps.levels.map((l) => [l.id, l.ordinal])).toEqual([
      ['min', 1],
      ['low', 2],
      ['default', 3],
      ['high', 4],
      ['max', 5],
    ])
    expect(descriptor.caps.levels[4]?.flags).toEqual({ critical: true })
  })

  it('marks every secret field as a password input', () => {
    const fields = ntfyAdapter.descriptor.configSchema.sections.flatMap((s) => s.fields)
    const byKey = new Map(fields.map((f) => [f.key, f.type]))
    expect(byKey.get('serverUrl')).toBe('text')
    expect(byKey.get('topic')).toBe('password')
    expect(byKey.get('token')).toBe('password')
    expect(byKey.get('user')).toBe('password')
    expect(byKey.get('pass')).toBe('password')
  })
})

// ── buildRequest — JSON path ─────────────────────────────────────────

describe('ntfy buildRequest — JSON POST to root', () => {
  it('maps a plain text notification', () => {
    const plan = planFor(BASE_CONFIG, notification({ body: 'Motion detected' }))
    expect(plan.url).toBe('https://ntfy.sh')
    expect(plan.method).toBe('POST')
    expect(plan.headers).toEqual({ authorization: 'Bearer tk_secret' })
    expect(jsonBody(plan)).toEqual({
      topic: 'alerts',
      message: 'Motion detected',
      priority: 3,
    })
  })

  it('sets title and markdown when the format is markdown', () => {
    const plan = planFor(
      BASE_CONFIG,
      notification({ title: 'Alert', body: '**bold**', format: 'markdown' }),
    )
    expect(jsonBody(plan)).toEqual({
      topic: 'alerts',
      message: '**bold**',
      priority: 3,
      title: 'Alert',
      markdown: true,
    })
  })

  it('maps an image URL attachment to `attach`', () => {
    const plan = planFor(
      BASE_CONFIG,
      notification({
        attachments: [{ mediaType: 'image', url: 'https://cdn.test/snap.jpg' }],
      }),
    )
    expect(jsonBody(plan).attach).toBe('https://cdn.test/snap.jpg')
    expect(jsonBody(plan).icon).toBeUndefined()
  })

  it('maps an icon URL attachment to `icon`', () => {
    const plan = planFor(
      BASE_CONFIG,
      notification({
        attachments: [{ mediaType: 'icon', url: 'https://cdn.test/logo.png' }],
      }),
    )
    expect(jsonBody(plan).icon).toBe('https://cdn.test/logo.png')
    expect(jsonBody(plan).attach).toBeUndefined()
  })

  it('declares no per-action icons, and REPORTS the drop instead of hiding it', () => {
    // ntfy's action object has no icon field at all. The engine strips it
    // centrally so the operator can see `actionIcons` in `dropped` rather than
    // find out by looking at a phone.
    const prepared = prepareNotification(
      ntfyAdapter.descriptor.caps,
      notification({
        actions: [{ id: 'a', label: 'Silenzia', url: 'https://x.test/a', icon: 'snooze' }],
      }),
    )
    expect(ntfyAdapter.descriptor.caps.actionIcons).toBe(false)
    expect(prepared.renderedAs.dropped).toContain('actionIcons')
    const plan = ntfyAdapter.buildRequest(BASE_CONFIG, prepared)
    const [action] = (jsonBody(plan).actions ?? []) as readonly Record<string, unknown>[]
    expect(action).toBeDefined()
    // The button survives; only its icon is gone. And no key named icon-ish
    // carries the token onto the wire.
    expect(JSON.stringify(action)).not.toContain('snooze')
  })

  it('passes clickUrl through as `click`', () => {
    const plan = planFor(BASE_CONFIG, notification({ clickUrl: 'https://app.test/event/1' }))
    expect(jsonBody(plan).click).toBe('https://app.test/event/1')
  })

  it('slices actions to 3 view buttons with label + url', () => {
    const plan = planFor(
      BASE_CONFIG,
      notification({
        actions: [
          { id: 'a', label: 'Open', url: 'https://x.test/a' },
          { id: 'b', label: 'Snooze', url: 'https://x.test/b' },
          { id: 'c', label: 'Dismiss', url: 'https://x.test/c' },
          { id: 'd', label: 'Extra', url: 'https://x.test/d' },
        ],
      }),
    )
    expect(jsonBody(plan).actions).toEqual([
      { action: 'view', label: 'Open', url: 'https://x.test/a' },
      { action: 'view', label: 'Snooze', url: 'https://x.test/b' },
      { action: 'view', label: 'Dismiss', url: 'https://x.test/c' },
    ])
  })

  it('sends a BACKGROUND action as an http POST that clears the notification', () => {
    const plan = planFor(
      BASE_CONFIG,
      notification({
        actions: [
          { id: 's', label: 'Silenzia 30 min', url: 'https://x.test/s', mode: 'background' },
          { id: 'o', label: 'Open', url: 'https://x.test/o' },
        ],
      }),
    )
    expect(jsonBody(plan).actions).toEqual([
      {
        action: 'http',
        label: 'Silenzia 30 min',
        url: 'https://x.test/s',
        method: 'POST',
        clear: true,
      },
      // CONTROL: an ordinary button is untouched.
      { action: 'view', label: 'Open', url: 'https://x.test/o' },
    ])
  })

  it('names the ACTION per button in the x-actions header too', () => {
    // The upload path builds the header by hand; emitting `view` for every
    // button there would turn a background call into a browser tab on exactly
    // the path nobody looks at.
    const plan = planFor(
      BASE_CONFIG,
      notification({
        attachments: [{ mediaType: 'image', bytes: new Uint8Array([1]), mime: 'image/jpeg' }],
        actions: [{ id: 's', label: 'Silenzia', url: 'https://x.test/s', mode: 'background' }],
      }),
    )
    expect(plan.headers?.['x-actions']).toBe(
      'http, Silenzia, https://x.test/s, method=POST, clear=true',
    )
  })

  it('emits default tags from config', () => {
    const plan = planFor({ ...BASE_CONFIG, tags: ['warning', 'camera'] }, notification({}))
    expect(jsonBody(plan).tags).toEqual(['warning', 'camera'])
  })

  it('parses a comma-separated tags string from config', () => {
    const plan = planFor({ ...BASE_CONFIG, tags: 'warning, camera ' }, notification({}))
    expect(jsonBody(plan).tags).toEqual(['warning', 'camera'])
  })

  it('strips a trailing slash from a custom serverUrl', () => {
    const plan = planFor(
      { topic: 'alerts', serverUrl: 'https://ntfy.example.com/' },
      notification({}),
    )
    expect(plan.url).toBe('https://ntfy.example.com')
  })

  it.each([
    [1, 1],
    [3, 3],
    [5, 5],
  ])('maps canonical priority %s to native priority %s', (canonical, native) => {
    const plan = planFor(BASE_CONFIG, notification({ priority: canonical }))
    expect(jsonBody(plan).priority).toBe(native)
  })
})

// ── buildRequest — auth ──────────────────────────────────────────────

describe('ntfy buildRequest — auth', () => {
  it('uses HTTP Basic when only user/pass are set', () => {
    const plan = planFor({ topic: 'alerts', user: 'bob', pass: 'secret' }, notification({}))
    const expected = Buffer.from('bob:secret', 'utf8').toString('base64')
    expect(plan.headers).toEqual({ authorization: `Basic ${expected}` })
  })

  it('prefers the token over user/pass', () => {
    const plan = planFor(
      { topic: 'alerts', token: 'tk_1', user: 'bob', pass: 'secret' },
      notification({}),
    )
    expect(plan.headers).toEqual({ authorization: 'Bearer tk_1' })
  })

  it('omits the auth header when no credentials are set', () => {
    const plan = planFor({ topic: 'alerts' }, notification({}))
    expect(plan.headers).toEqual({})
  })
})

// ── buildRequest — bytes-only upload path ────────────────────────────

describe('ntfy buildRequest — raw PUT upload for bytes-only attachments', () => {
  it('PUTs the bytes to {server}/{topic} with X-* headers', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const plan = planFor(
      BASE_CONFIG,
      notification({
        title: 'Snap',
        body: 'Motion',
        format: 'markdown',
        priority: 5,
        clickUrl: 'https://app.test/e',
        attachments: [{ mediaType: 'image', bytes, mime: 'image/jpeg', name: 'snap.jpg' }],
        actions: [{ id: 'a', label: 'Open', url: 'https://x.test/a' }],
      }),
    )
    expect(plan.url).toBe('https://ntfy.sh/alerts')
    expect(plan.method).toBe('PUT')
    expect(plan.headers).toEqual({
      authorization: 'Bearer tk_secret',
      'x-priority': '5',
      'x-title': 'Snap',
      'x-message': 'Motion',
      'x-markdown': 'true',
      'x-click': 'https://app.test/e',
      'x-filename': 'snap.jpg',
      'x-actions': 'view, Open, https://x.test/a',
    })
    expect(plan.body).toEqual({ kind: 'raw', value: bytes, contentType: 'image/jpeg' })
  })

  it('still uses the JSON path when the attachment carries a URL', () => {
    const plan = planFor(
      BASE_CONFIG,
      notification({ attachments: [{ mediaType: 'image', url: 'https://cdn.test/x.jpg' }] }),
    )
    expect(plan.method).toBe('POST')
    expect(plan.body?.kind).toBe('json')
  })
})
