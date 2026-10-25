/**
 * Table-driven unit tests for the Zentik adapter's PURE `buildRequest`.
 *
 * Each case starts from a canonical `Notification`, runs it through the real
 * degrade engine (`prepareNotification`) against the adapter's own caps, then
 * asserts the exact `HttpRequestPlan` `buildRequest` emits — url / method /
 * headers / JSON body. No network is touched (discovery is not exercised here).
 */
import type { Notification } from '@camstack/types'
import { NotificationActionIconSchema, prepareNotification } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { HttpRequestPlan, TargetConfig } from '../../adapters/adapter.js'
import { zentikActionIcon, zentikAdapter } from '../../adapters/zentik.js'

// ── Helpers ──────────────────────────────────────────────────────────

const TOKEN_CONFIG: TargetConfig = { accessToken: 'tok_secret', bucketId: 'bucket-1' }
const MAGIC_CONFIG: TargetConfig = { authMode: 'magicCode', magicCode: 'mc_secret' }

function notification(overrides: Partial<Notification>): Notification {
  return {
    body: 'Hello world',
    format: 'text',
    priority: 3,
    ...overrides,
  }
}

/** Canonical → degrade (against the zentik caps) → buildRequest. */
function planFor(config: TargetConfig, n: Notification): HttpRequestPlan {
  const prepared = prepareNotification(zentikAdapter.descriptor.caps, n)
  return zentikAdapter.buildRequest(config, prepared)
}

/** Narrow a plan body to its JSON value for assertions. */
function jsonBody(plan: HttpRequestPlan): Record<string, unknown> {
  if (plan.body?.kind !== 'json') throw new Error(`expected json body, got ${plan.body?.kind}`)
  const value = plan.body.value
  if (typeof value !== 'object' || value === null) throw new Error('json body is not an object')
  return value as Record<string, unknown>
}

// ── Descriptor ───────────────────────────────────────────────────────

describe('zentik descriptor', () => {
  it('declares the zentik caps contract', () => {
    const { descriptor } = zentikAdapter
    expect(descriptor.kind).toBe('zentik')
    expect(descriptor.addonId).toBe('notifiers')
    expect(descriptor.supportsDiscovery).toBe(true)
    expect(descriptor.caps.attachments).toEqual({
      mediaTypes: ['image', 'video', 'gif', 'audio', 'icon'],
      mode: 'url',
      max: 5,
    })
    expect(descriptor.caps.actions).toBe(4)
    expect(descriptor.caps.format).toEqual(['text'])
    expect(descriptor.caps.clickUrl).toBe(true)
    // Pass-through claim: the intent name travels verbatim (webhook precedent),
    // so the engine stops stripping it centrally.
    expect(descriptor.caps.actionIcons).toBe(true)
    expect(descriptor.caps.sound).toBe(true)
    expect(descriptor.caps.ttl).toBe(true)
    // No CamStack body truncate (operator: alarm/AI bodies must not clip).
    expect(descriptor.caps.bodyMaxLen).toBeGreaterThan(100_000)
    expect(descriptor.caps.levels.map((l) => [l.id, l.ordinal])).toEqual([
      ['SILENT', 1],
      ['NORMAL', 3],
      ['CRITICAL', 5],
      ['NO_PUSH', null],
    ])
    expect(descriptor.caps.levels[0]?.flags).toEqual({ silent: true })
    expect(descriptor.caps.levels[2]?.flags).toEqual({ critical: true })
    expect(descriptor.caps.levels[3]?.flags).toEqual({ noPush: true })
  })

  it('gates each auth field on its authMode and marks secrets as passwords', () => {
    const fields = zentikAdapter.descriptor.configSchema.sections.flatMap((s) => s.fields)
    const byKey = new Map(fields.map((f) => [f.key, f]))
    const showWhenOf = (key: string): unknown => {
      const f = byKey.get(key)
      return f && 'showWhen' in f ? f.showWhen : undefined
    }
    expect(byKey.get('baseUrl')?.type).toBe('text')
    expect(byKey.get('authMode')?.type).toBe('select')
    expect(byKey.get('accessToken')?.type).toBe('password')
    expect(byKey.get('magicCode')?.type).toBe('password')
    expect(byKey.get('bucketId')?.type).toBe('text')
    expect(byKey.get('userIds')?.type).toBe('text')
    expect(showWhenOf('accessToken')).toEqual({ field: 'authMode', equals: 'accessToken' })
    expect(showWhenOf('magicCode')).toEqual({ field: 'authMode', equals: 'magicCode' })
  })
})

// ── buildRequest — access-token path ─────────────────────────────────

describe('zentik buildRequest — access-token auth', () => {
  it('maps a plain NORMAL notification to a Bearer POST with bucketId', () => {
    const plan = planFor(TOKEN_CONFIG, notification({ title: 'Alert', body: 'Motion detected' }))
    expect(plan.url).toBe('https://notifier-api.zentik.app/api/v1/messages')
    expect(plan.method).toBe('POST')
    expect(plan.headers).toEqual({ authorization: 'Bearer tok_secret' })
    expect(jsonBody(plan)).toEqual({
      body: 'Motion detected',
      title: 'Alert',
      deliveryType: 'NORMAL',
      bucketId: 'bucket-1',
    })
  })

  it('strips a trailing slash from a custom baseUrl', () => {
    const plan = planFor(
      { ...TOKEN_CONFIG, baseUrl: 'https://zentik.example.com/' },
      notification({}),
    )
    expect(plan.url).toBe('https://zentik.example.com/api/v1/messages')
  })

  it.each([
    [1, 'SILENT'],
    // priority 2 is equidistant from SILENT(1) and NORMAL(3); the engine
    // tie-breaks to the higher (more severe) ordinal → NORMAL.
    [2, 'NORMAL'],
    [3, 'NORMAL'],
    [4, 'CRITICAL'],
    [5, 'CRITICAL'],
  ])('maps canonical priority %s to deliveryType %s', (priority, expected) => {
    const plan = planFor(TOKEN_CONFIG, notification({ priority }))
    expect(jsonBody(plan).deliveryType).toBe(expected)
  })

  it('honours an explicit NO_PUSH level (ordinal-less, level id only)', () => {
    const plan = planFor(TOKEN_CONFIG, notification({ level: 'NO_PUSH' }))
    expect(jsonBody(plan).deliveryType).toBe('NO_PUSH')
  })

  it('maps url attachments to the typed attachments[] with MediaType enum', () => {
    const plan = planFor(
      TOKEN_CONFIG,
      notification({
        attachments: [
          { mediaType: 'image', url: 'https://cdn.test/snap.jpg', name: 'snap.jpg' },
          { mediaType: 'video', url: 'https://cdn.test/clip.mp4' },
        ],
      }),
    )
    expect(jsonBody(plan).attachments).toEqual([
      { mediaType: 'IMAGE', url: 'https://cdn.test/snap.jpg', name: 'snap.jpg' },
      { mediaType: 'VIDEO', url: 'https://cdn.test/clip.mp4' },
    ])
  })

  it('passes clickUrl through as the tapUrl shortcut', () => {
    const plan = planFor(TOKEN_CONFIG, notification({ clickUrl: 'https://app.test/event/1' }))
    expect(jsonBody(plan).tapUrl).toBe('https://app.test/event/1')
  })

  it('forwards sound and flips ephemeral on when ttl is set', () => {
    const plan = planFor(TOKEN_CONFIG, notification({ sound: 'ping', ttl: 3600 }))
    expect(jsonBody(plan).sound).toBe('ping')
    expect(jsonBody(plan).ephemeral).toBe(true)
  })

  it('sends a BACKGROUND action as BACKGROUND_CALL with a POST:: target', () => {
    // A "silence this" button that opens a browser tab has already cost more
    // attention than the notification it was dismissing.
    const plan = planFor(
      TOKEN_CONFIG,
      notification({
        actions: [
          { id: 's', label: 'Silenzia 30 min', url: 'https://x.test/s', mode: 'background' },
          { id: 'n', label: 'Open', url: 'https://x.test/n' },
        ],
      }),
    )
    expect(jsonBody(plan).actions).toEqual([
      { type: 'BACKGROUND_CALL', title: 'Silenzia 30 min', value: 'POST::https://x.test/s' },
      // CONTROL: an ordinary button is still a NAVIGATE.
      { type: 'NAVIGATE', title: 'Open', value: 'https://x.test/n' },
    ])
  })

  it('carries destructive, and TRANSLATES the icon into an SF Symbol', () => {
    const plan = planFor(
      TOKEN_CONFIG,
      notification({
        actions: [
          { id: 'd', label: 'Disarma', url: 'https://x.test/d', destructive: true, icon: 'disarm' },
        ],
      }),
    )
    expect(jsonBody(plan).actions).toEqual([
      {
        // Without mode the adapter still NAVIGATEs; NC now mints background
        // for disarm — this unit only covers the adapter's default path.
        type: 'NAVIGATE',
        title: 'Disarma',
        value: 'https://x.test/d',
        destructive: true,
        // NOT the intent token: iOS feeds this string straight to
        // `UNNotificationActionIcon(systemImageName:)`, and `disarm` is not an
        // SF Symbol — which is exactly why the buttons arrived blank.
        icon: 'sfsymbols:shield.slash.fill',
      },
    ])
  })

  it('translates EVERY icon token in the closed vocabulary to an sfsymbols: name', () => {
    for (const token of NotificationActionIconSchema.options) {
      const plan = planFor(
        TOKEN_CONFIG,
        notification({ actions: [{ id: 'a', label: 'X', url: 'https://x.test/a', icon: token }] }),
      )
      const actions = jsonBody(plan).actions
      const [action] = actions as readonly { readonly icon?: string }[]
      expect(action?.icon, `icon token ${token} has no Zentik mapping`).toMatch(/^sfsymbols:\S+$/)
      // The raw intent token must NEVER reach the wire — iOS renders it as no
      // icon at all, which is indistinguishable from "the field did nothing".
      expect(action?.icon).not.toBe(token)
    }
  })

  it('OMITS an icon it cannot map rather than sending it raw', () => {
    // The boundary is exercised directly: an icon outside the vocabulary cannot
    // reach `buildRequest` in a type-safe program (the cap seam rejects it), but
    // an addon running against a NEWER hub vocabulary is exactly the version
    // skew this repo ships with. Absent is the honest answer; raw would be a
    // string iOS silently ignores — a blank button with no way to learn why.
    expect(zentikActionIcon('not-a-real-token')).toBeUndefined()
    expect(zentikActionIcon('')).toBeUndefined()
    // And nothing inherited from Object.prototype counts as a mapping.
    expect(zentikActionIcon('toString')).toBeUndefined()
    expect(zentikActionIcon('constructor')).toBeUndefined()
  })

  it('maps actions to NotificationActionDto (label→title, url→value, NAVIGATE/OPEN)', () => {
    const plan = planFor(
      TOKEN_CONFIG,
      notification({
        actions: [
          { id: 'a', label: 'Open', url: 'https://x.test/a' },
          { id: 'b', label: 'Acknowledge' },
          { id: 'c', label: 'Snooze', url: 'https://x.test/c' },
          { id: 'd', label: 'Details', url: 'https://x.test/d' },
          { id: 'e', label: 'Extra', url: 'https://x.test/e' },
        ],
      }),
    )
    // Engine slices to caps.actions (4) before the adapter sees them.
    expect(jsonBody(plan).actions).toEqual([
      { type: 'NAVIGATE', title: 'Open', value: 'https://x.test/a' },
      { type: 'OPEN_NOTIFICATION', title: 'Acknowledge' },
      { type: 'NAVIGATE', title: 'Snooze', value: 'https://x.test/c' },
      { type: 'NAVIGATE', title: 'Details', value: 'https://x.test/d' },
    ])
  })

  it('omits the Bearer header when the access token is missing', () => {
    const plan = planFor({ bucketId: 'bucket-1' }, notification({}))
    expect(plan.headers).toEqual({})
    expect(jsonBody(plan).bucketId).toBe('bucket-1')
  })

  it('always emits a title, falling back to the body clamped to 100 chars', () => {
    // No title on the notification → title derives from the body (backend
    // `title` is REQUIRED @MaxLength(100)).
    const longBody = 'x'.repeat(300)
    const plan = planFor(TOKEN_CONFIG, notification({ title: undefined, body: longBody }))
    const title = jsonBody(plan).title
    expect(typeof title).toBe('string')
    expect((title as string).length).toBe(100)
    expect(title).toBe('x'.repeat(100))
  })

  it('clamps a provided over-length title to 100 chars', () => {
    const plan = planFor(TOKEN_CONFIG, notification({ title: 'T'.repeat(250) }))
    expect((jsonBody(plan).title as string).length).toBe(100)
  })

  it('does not truncate a long body (no CamStack bodyMaxLen cap)', () => {
    const plan = planFor(TOKEN_CONFIG, notification({ body: 'b'.repeat(900) }))
    expect((jsonBody(plan).body as string).length).toBe(900)
  })

  it('maps a userIds CSV config field to a userIds string array', () => {
    const plan = planFor({ ...TOKEN_CONFIG, userIds: 'alice, bob ,  , charlie' }, notification({}))
    expect(jsonBody(plan).userIds).toEqual(['alice', 'bob', 'charlie'])
  })

  it('accepts a userIds array config field verbatim', () => {
    const plan = planFor({ ...TOKEN_CONFIG, userIds: ['u1', 'u2'] }, notification({}))
    expect(jsonBody(plan).userIds).toEqual(['u1', 'u2'])
  })

  it('omits userIds from the body when empty or unset', () => {
    expect('userIds' in jsonBody(planFor(TOKEN_CONFIG, notification({})))).toBe(false)
    expect('userIds' in jsonBody(planFor({ ...TOKEN_CONFIG, userIds: '' }, notification({})))).toBe(
      false,
    )
    expect(
      'userIds' in jsonBody(planFor({ ...TOKEN_CONFIG, userIds: '  ,  ' }, notification({}))),
    ).toBe(false)
  })
})

// ── buildRequest — magic-code path ───────────────────────────────────

describe('zentik buildRequest — magic-code auth', () => {
  it('sends magicCode in the body and NO Bearer header or bucketId', () => {
    const plan = planFor(MAGIC_CONFIG, notification({ body: 'Motion' }))
    expect(plan.headers).toEqual({})
    const body = jsonBody(plan)
    expect(body.magicCode).toBe('mc_secret')
    expect(body.bucketId).toBeUndefined()
    expect(body.deliveryType).toBe('NORMAL')
  })

  it('ignores accessToken/bucketId when authMode is magicCode', () => {
    const plan = planFor(
      { authMode: 'magicCode', magicCode: 'mc_secret', accessToken: 'tok', bucketId: 'b' },
      notification({}),
    )
    expect(plan.headers).toEqual({})
    expect(jsonBody(plan).bucketId).toBeUndefined()
    expect('authorization' in (plan.headers ?? {})).toBe(false)
  })
})
