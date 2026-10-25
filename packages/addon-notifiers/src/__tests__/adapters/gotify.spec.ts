/**
 * Table tests for the gotify adapter's PURE `buildRequest` seam.
 *
 * Every case drives a canonical `Notification` through the real degrade engine
 * (`prepareNotification(descriptor.caps, n)`) and asserts the exact wire plan
 * the adapter emits — no network. This proves the level→native-integer mapping,
 * the markdown / click / bigImageUrl `extras`, and the JSON body shape.
 */
import type { Notification } from '@camstack/types'
import { prepareNotification } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { HttpRequestPlan, TargetConfig } from '../../adapters/adapter.js'
import { GOTIFY_KIND, gotifyAdapter, gotifyDescriptor } from '../../adapters/gotify.js'

const CAPS = gotifyDescriptor().caps

const CONFIG: TargetConfig = {
  serverUrl: 'https://gotify.example.com',
  appToken: 'AppToken123',
}

function notification(overrides: Partial<Notification>): Notification {
  return { body: 'hello', format: 'text', priority: 3, ...overrides }
}

function planFor(overrides: Partial<Notification>, config: TargetConfig = CONFIG): HttpRequestPlan {
  const prepared = prepareNotification(CAPS, notification(overrides))
  return gotifyAdapter.buildRequest(config, prepared)
}

// ── descriptor ──────────────────────────────────────────────────────

describe('gotify descriptor', () => {
  it('declares the gotify caps from the matrix', () => {
    const d = gotifyDescriptor()
    expect(d.kind).toBe(GOTIFY_KIND)
    expect(d.supportsDiscovery).toBe(true)
    expect(d.caps.attachments).toEqual({ mediaTypes: ['image'], mode: 'url', max: 1 })
    expect(d.caps.actions).toBe(0)
    expect(d.caps.format).toEqual(['text', 'markdown'])
    expect(d.caps.clickUrl).toBe(true)
    expect(d.caps.sound).toBe(false)
    expect(d.caps.ttl).toBe(false)
    expect(d.caps.levels.map((l) => [l.id, l.ordinal])).toEqual([
      ['min', 1],
      ['low', 2],
      ['normal', 3],
      ['high', 5],
    ])
  })
})

// ── url + headers ───────────────────────────────────────────────────

describe('gotify buildRequest — endpoint', () => {
  it('POSTs to {serverUrl}/message with the X-Gotify-Key header', () => {
    const plan = planFor({})
    expect(plan.url).toBe('https://gotify.example.com/message')
    expect(plan.method).toBe('POST')
    expect(plan.headers).toEqual({ 'X-Gotify-Key': 'AppToken123' })
  })

  it('trims a trailing slash on the server URL', () => {
    const plan = planFor({}, { serverUrl: 'https://g.test/', appToken: 't' })
    expect(plan.url).toBe('https://g.test/message')
  })

  it('throws when serverUrl is missing', () => {
    const prepared = prepareNotification(CAPS, notification({}))
    expect(() => gotifyAdapter.buildRequest({ appToken: 't' }, prepared)).toThrow(/serverUrl/)
  })

  it('throws when appToken is missing', () => {
    const prepared = prepareNotification(CAPS, notification({}))
    expect(() => gotifyAdapter.buildRequest({ serverUrl: 'https://g.test' }, prepared)).toThrow(
      /appToken/,
    )
  })
})

// ── priority ordinal → native integer ───────────────────────────────

describe('gotify buildRequest — priority mapping', () => {
  const cases: ReadonlyArray<{ priority: number; native: number; note: string }> = [
    { priority: 1, native: 0, note: 'min' },
    { priority: 2, native: 3, note: 'low' },
    { priority: 3, native: 5, note: 'normal' },
    { priority: 4, native: 8, note: 'nearest → high (tie-break to higher ordinal)' },
    { priority: 5, native: 8, note: 'high' },
  ]

  for (const { priority, native, note } of cases) {
    it(`priority ${priority} → native ${native} (${note})`, () => {
      const plan = planFor({ priority })
      expect(plan.body).toEqual({
        kind: 'json',
        value: { message: 'hello', priority: native },
      })
    })
  }
})

// ── body / extras ───────────────────────────────────────────────────

describe('gotify buildRequest — body + extras', () => {
  it('plain text: title + message + priority, no extras', () => {
    const plan = planFor({ title: 'Motion', body: 'Front door', priority: 3 })
    expect(plan.body).toEqual({
      kind: 'json',
      value: { title: 'Motion', message: 'Front door', priority: 5 },
    })
  })

  it('omits title when absent', () => {
    const plan = planFor({ body: 'no title' })
    expect(plan.body).toEqual({
      kind: 'json',
      value: { message: 'no title', priority: 5 },
    })
  })

  it('markdown: sets client::display.contentType text/markdown', () => {
    const plan = planFor({ format: 'markdown', body: '**bold**' })
    expect(plan.body).toEqual({
      kind: 'json',
      value: {
        message: '**bold**',
        priority: 5,
        extras: { 'client::display': { contentType: 'text/markdown' } },
      },
    })
  })

  it('clickUrl: sets client::notification.click.url', () => {
    const plan = planFor({ clickUrl: 'https://cam/live' })
    expect(plan.body).toEqual({
      kind: 'json',
      value: {
        message: 'hello',
        priority: 5,
        extras: { 'client::notification': { click: { url: 'https://cam/live' } } },
      },
    })
  })

  it('first image → client::notification.bigImageUrl', () => {
    const plan = planFor({
      attachments: [{ mediaType: 'image', url: 'https://cam/snap.jpg' }],
    })
    expect(plan.body).toEqual({
      kind: 'json',
      value: {
        message: 'hello',
        priority: 5,
        extras: { 'client::notification': { bigImageUrl: 'https://cam/snap.jpg' } },
      },
    })
  })

  it('markdown + click + image merge into one extras map', () => {
    const plan = planFor({
      format: 'markdown',
      body: '**alert**',
      clickUrl: 'https://cam/live',
      attachments: [{ mediaType: 'image', url: 'https://cam/snap.jpg' }],
    })
    expect(plan.body).toEqual({
      kind: 'json',
      value: {
        message: '**alert**',
        priority: 5,
        extras: {
          'client::display': { contentType: 'text/markdown' },
          'client::notification': {
            click: { url: 'https://cam/live' },
            bigImageUrl: 'https://cam/snap.jpg',
          },
        },
      },
    })
  })

  it('caps attachments to the first image (max 1) — engine filters, adapter takes [0]', () => {
    const plan = planFor({
      attachments: [
        { mediaType: 'image', url: 'https://cam/one.jpg' },
        { mediaType: 'image', url: 'https://cam/two.jpg' },
      ],
    })
    expect(plan.body).toEqual({
      kind: 'json',
      value: {
        message: 'hello',
        priority: 5,
        extras: { 'client::notification': { bigImageUrl: 'https://cam/one.jpg' } },
      },
    })
  })

  it('uses config defaultPriority only as a fallback (a resolved level always wins)', () => {
    const plan = planFor({ priority: 1 }, { ...CONFIG, defaultPriority: 9 })
    // priority 1 resolves the 'min' level → native 0, ignoring the config default.
    expect(plan.body).toEqual({ kind: 'json', value: { message: 'hello', priority: 0 } })
  })
})
