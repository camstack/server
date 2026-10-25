/**
 * Table-driven unit tests for the caps-driven test composer (T15).
 *
 * Fixtures mirror the REAL kind descriptors shipped by `addon-notifiers`
 * (`packages/addon-notifiers/src/adapters/*.ts`) — admin-ui cannot
 * cross-import an addon, so the `caps` blocks are duplicated here as
 * fixtures. Keep them in sync with the adapters (source of truth =
 * `docs/superpowers/specs/2026-07-03-notification-output-notifier-matrix.md`).
 */

import type { TargetKindCaps } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  availablePresets,
  buildPreset,
  composeTestSample,
  criticalLevel,
  emptyForm,
  type TestFormState,
  visibleControls,
} from '../notification-test-composer'

// ── Real-kind caps fixtures ─────────────────────────────────────────

const ntfy: TargetKindCaps = {
  attachments: { mediaTypes: ['image', 'icon'], mode: 'both', max: 1 },
  actions: 3,
  levels: [
    { id: 'min', label: 'Min', ordinal: 1 },
    { id: 'low', label: 'Low', ordinal: 2 },
    { id: 'default', label: 'Default', ordinal: 3 },
    { id: 'high', label: 'High', ordinal: 4 },
    { id: 'max', label: 'Max', ordinal: 5, flags: { critical: true } },
  ],
  format: ['text', 'markdown'],
  clickUrl: true,
  sound: false,
  ttl: false,
  bodyMaxLen: 4096,
}

const pushover: TargetKindCaps = {
  attachments: { mediaTypes: ['image'], mode: 'bytes', max: 1, maxBytes: 5_242_880 },
  actions: 0,
  levels: [
    { id: 'lowest', label: 'Lowest', ordinal: 1 },
    { id: 'low', label: 'Low', ordinal: 2 },
    { id: 'normal', label: 'Normal', ordinal: 3 },
    { id: 'high', label: 'High', ordinal: 4 },
    {
      id: 'emergency',
      label: 'Emergency',
      ordinal: 5,
      flags: { critical: true },
      requires: ['retry', 'expire'],
    },
  ],
  format: ['text', 'html'],
  clickUrl: true,
  sound: true,
  ttl: true,
  bodyMaxLen: 1024,
}

const gotify: TargetKindCaps = {
  attachments: { mediaTypes: ['image'], mode: 'url', max: 1 },
  actions: 0,
  levels: [
    { id: 'min', label: 'Minimum', ordinal: 1 },
    { id: 'low', label: 'Low', ordinal: 2 },
    { id: 'normal', label: 'Normal', ordinal: 3 },
    { id: 'high', label: 'High', ordinal: 5 },
  ],
  format: ['text', 'markdown'],
  clickUrl: true,
  sound: false,
  ttl: false,
  bodyMaxLen: 4096,
}

const telegram: TargetKindCaps = {
  attachments: {
    mediaTypes: ['image', 'video', 'gif', 'audio'],
    mode: 'both',
    max: 1,
    maxBytes: 52_428_800,
  },
  actions: 3,
  levels: [
    { id: 'normal', label: 'Normal', ordinal: 3 },
    { id: 'silent', label: 'Silent', ordinal: null, flags: { silent: true } },
  ],
  format: ['text', 'markdown', 'html'],
  clickUrl: true,
  sound: true,
  ttl: false,
  bodyMaxLen: 4096,
}

const discord: TargetKindCaps = {
  attachments: { mediaTypes: ['image'], mode: 'both', max: 1 },
  actions: 0,
  levels: [
    { id: 'info', label: 'Info', ordinal: 1 },
    { id: 'success', label: 'Success', ordinal: 2 },
    { id: 'warning', label: 'Warning', ordinal: 3 },
    { id: 'error', label: 'Error', ordinal: 4 },
    { id: 'silent', label: 'Silent', ordinal: 5, flags: { silent: true } },
  ],
  format: ['text', 'markdown'],
  clickUrl: true,
  sound: false,
  ttl: false,
  bodyMaxLen: 2000,
}

const webhook: TargetKindCaps = {
  attachments: { mediaTypes: ['image', 'video', 'gif', 'audio', 'icon'], mode: 'url', max: 99 },
  actions: 99,
  levels: [
    { id: 'p1', label: 'Priority 1', ordinal: 1 },
    { id: 'p2', label: 'Priority 2', ordinal: 2 },
    { id: 'p3', label: 'Priority 3', ordinal: 3 },
    { id: 'p4', label: 'Priority 4', ordinal: 4 },
    { id: 'p5', label: 'Priority 5', ordinal: 5 },
  ],
  format: ['text', 'markdown', 'html'],
  clickUrl: true,
  sound: true,
  ttl: true,
  bodyMaxLen: 1_000_000,
}

const zentik: TargetKindCaps = {
  attachments: { mediaTypes: ['image', 'video', 'gif', 'audio', 'icon'], mode: 'url', max: 10 },
  actions: 4,
  levels: [
    { id: 'SILENT', label: 'Silent', ordinal: 1, flags: { silent: true } },
    { id: 'NORMAL', label: 'Normal', ordinal: 3 },
    { id: 'CRITICAL', label: 'Critical', ordinal: 5, flags: { critical: true } },
    { id: 'NO_PUSH', label: 'No push', ordinal: null, flags: { noPush: true } },
  ],
  format: ['text'],
  clickUrl: true,
  sound: true,
  ttl: true,
  bodyMaxLen: 1_000_000,
}

const whatsapp: TargetKindCaps = {
  attachments: { mediaTypes: ['image', 'video', 'audio'], mode: 'url', max: 1 },
  actions: 0,
  levels: [{ id: 'normal', label: 'Normal', ordinal: 3 }],
  format: ['text', 'markdown'],
  clickUrl: true,
  sound: false,
  ttl: false,
  bodyMaxLen: 4096,
}

const ALL_KINDS: ReadonlyArray<readonly [string, TargetKindCaps]> = [
  ['ntfy', ntfy],
  ['pushover', pushover],
  ['gotify', gotify],
  ['telegram', telegram],
  ['discord', discord],
  ['webhook', webhook],
  ['zentik', zentik],
  ['whatsapp', whatsapp],
]

// ── visibleControls ─────────────────────────────────────────────────

describe('visibleControls', () => {
  it.each(ALL_KINDS)('%s: shows exactly the caps-advertised controls', (_name, caps) => {
    const v = visibleControls(caps)
    expect(v.showActions).toBe(caps.actions > 0)
    expect(v.showClickUrl).toBe(caps.clickUrl)
    expect(v.showSound).toBe(caps.sound)
    expect(v.showTtl).toBe(caps.ttl)
    expect(v.maxActions).toBe(caps.actions)
    expect(v.attachmentSlots).toEqual(caps.attachments.mediaTypes)
    expect(v.attachmentMax).toBe(caps.attachments.max)
    expect(v.bodyMaxLen).toBe(caps.bodyMaxLen)
    expect(v.formats).toEqual(caps.format)
    // tag has no cap flag → always offered.
    expect(v.showTag).toBe(true)
  })

  it('pushover: no actions, bytes attachments with maxBytes', () => {
    const v = visibleControls(pushover)
    expect(v.showActions).toBe(false)
    expect(v.attachmentMode).toBe('bytes')
    expect(v.attachmentMaxBytes).toBe(5_242_880)
  })

  it('zentik: text-only format, no sound flag stays true', () => {
    const v = visibleControls(zentik)
    expect(v.formats).toEqual(['text'])
    expect(v.showSound).toBe(true)
  })
})

// ── composeTestSample ───────────────────────────────────────────────

function form(caps: TargetKindCaps, patch: Partial<TestFormState>): TestFormState {
  return { ...emptyForm(caps), ...patch }
}

describe('composeTestSample', () => {
  it('minimal body-only sample keeps only body/format/priority', () => {
    const s = composeTestSample(ntfy, form(ntfy, { body: 'hi' }))
    expect(s).toEqual({ body: 'hi', format: 'text', priority: 3 })
  })

  it('clamps format to the kind supported set', () => {
    // zentik supports only text — asking for markdown falls back to text.
    const s = composeTestSample(zentik, form(zentik, { body: 'x', format: 'markdown' }))
    expect(s.format).toBe('text')
  })

  it('drops attachments whose mediaType the kind does not accept', () => {
    // pushover only accepts image → a video url is dropped, image kept.
    const s = composeTestSample(
      pushover,
      form(pushover, { body: 'x', attachmentUrls: { image: 'u1', video: 'u2' } }),
    )
    expect(s.attachments).toEqual([{ mediaType: 'image', url: 'u1' }])
  })

  it('caps attachment count to caps.attachments.max', () => {
    // ntfy max 1 across [image, icon] → only the first filled slot survives.
    const s = composeTestSample(
      ntfy,
      form(ntfy, { body: 'x', attachmentUrls: { image: 'u1', icon: 'u2' } }),
    )
    expect(s.attachments).toEqual([{ mediaType: 'image', url: 'u1' }])
  })

  it('drops all actions when caps.actions === 0', () => {
    const s = composeTestSample(
      pushover,
      form(pushover, { body: 'x', actions: [{ label: 'a', url: 'http://x' }] }),
    )
    expect(s.actions).toBeUndefined()
  })

  it('slices actions to caps.actions and assigns ids', () => {
    const s = composeTestSample(
      ntfy,
      form(ntfy, {
        body: 'x',
        actions: [
          { label: 'a', url: 'http://a' },
          { label: 'b', url: 'http://b' },
          { label: 'c', url: 'http://c' },
          { label: 'd', url: 'http://d' },
        ],
      }),
    )
    expect(s.actions).toHaveLength(3)
    expect(s.actions?.map((a) => a.id)).toEqual(['test-1', 'test-2', 'test-3'])
  })

  it('nulls clickUrl/sound/ttl when the cap flag is false', () => {
    // ntfy: clickUrl true, sound false, ttl false.
    const s = composeTestSample(
      ntfy,
      form(ntfy, { body: 'x', clickUrl: 'http://c', sound: 'ding', ttl: '60' }),
    )
    expect(s.clickUrl).toBe('http://c')
    expect(s.sound).toBeUndefined()
    expect(s.ttl).toBeUndefined()
  })

  it('passes clickUrl/sound/ttl when the cap flag is true', () => {
    const s = composeTestSample(
      pushover,
      form(pushover, { body: 'x', clickUrl: 'http://c', sound: 'siren', ttl: '3600' }),
    )
    expect(s.clickUrl).toBe('http://c')
    expect(s.sound).toBe('siren')
    expect(s.ttl).toBe(3600)
  })

  it('only sets level when it matches a declared caps.levels id', () => {
    const good = composeTestSample(pushover, form(pushover, { body: 'x', level: 'emergency' }))
    expect(good.level).toBe('emergency')
    const bad = composeTestSample(pushover, form(pushover, { body: 'x', level: 'nope' }))
    expect(bad.level).toBeUndefined()
  })

  it('clamps priority into 1..5', () => {
    expect(composeTestSample(ntfy, form(ntfy, { body: 'x', priority: 9 })).priority).toBe(5)
    expect(composeTestSample(ntfy, form(ntfy, { body: 'x', priority: 0 })).priority).toBe(1)
  })

  it('always allows a tag (no cap flag gates it)', () => {
    const s = composeTestSample(pushover, form(pushover, { body: 'x', tag: 't1' }))
    expect(s.tag).toBe('t1')
  })
})

// ── criticalLevel ───────────────────────────────────────────────────

describe('criticalLevel', () => {
  it('prefers an explicit flags.critical level', () => {
    expect(criticalLevel(pushover)?.id).toBe('emergency')
    expect(criticalLevel(zentik)?.id).toBe('CRITICAL')
    expect(criticalLevel(ntfy)?.id).toBe('max')
  })

  it('falls back to the highest ordinal when no critical flag exists', () => {
    // gotify has no critical flag → highest ordinal (high=5).
    expect(criticalLevel(gotify)?.id).toBe('high')
  })
})

// ── buildPreset ─────────────────────────────────────────────────────

describe('buildPreset', () => {
  it.each(ALL_KINDS)('%s: text preset composes to body-only', (_name, caps) => {
    const s = composeTestSample(caps, buildPreset(caps, 'text'))
    expect(s.attachments).toBeUndefined()
    expect(s.actions).toBeUndefined()
    expect(s.clickUrl).toBeUndefined()
  })

  it.each(ALL_KINDS)('%s: overflow preset exceeds bodyMaxLen', (_name, caps) => {
    const s = composeTestSample(caps, buildPreset(caps, 'overflow'))
    expect(s.body.length).toBeGreaterThan(caps.bodyMaxLen)
  })

  it.each(ALL_KINDS)('%s: critical preset selects the critical-most level', (_name, caps) => {
    const state = buildPreset(caps, 'critical')
    const s = composeTestSample(caps, state)
    expect(s.priority).toBe(5)
    const expected = criticalLevel(caps)
    if (expected) expect(s.level).toBe(expected.id)
  })

  // The whole point of the rewrite: a media preset must attach media the SERVER
  // can actually fetch. The previous set pointed at example.com and therefore
  // never verified anything.
  const MEDIA_PRESETS = ['image', 'gif', 'video', 'audio'] as const

  it.each(
    ALL_KINDS,
  )('%s: media presets attach a hub-served sample, never a third party', (_name, caps) => {
    for (const preset of MEDIA_PRESETS) {
      const s = composeTestSample(caps, buildPreset(caps, preset))
      for (const a of s.attachments ?? []) {
        expect(a.url).toMatch(/^\/addon\/notifiers\/samples\//)
      }
    }
  })

  it.each(ALL_KINDS)('%s: a media preset attaches exactly its own media type', (_name, caps) => {
    for (const preset of MEDIA_PRESETS) {
      const s = composeTestSample(caps, buildPreset(caps, preset))
      const attachments = s.attachments ?? []
      if (!caps.attachments.mediaTypes.includes(preset) || caps.attachments.max === 0) {
        // Unsupported by this kind — the preset degrades to text, it does not
        // silently attach something else.
        expect(attachments).toHaveLength(0)
        continue
      }
      expect(attachments).toHaveLength(1)
      expect(attachments[0]?.mediaType).toBe(preset)
    }
  })

  it.each(
    ALL_KINDS,
  )('%s: availablePresets never offers a preset the kind cannot honour', (_name, caps) => {
    const offered = availablePresets(caps)
    expect(offered).toContain('text')
    for (const preset of MEDIA_PRESETS) {
      const supported = caps.attachments.max > 0 && caps.attachments.mediaTypes.includes(preset)
      expect(offered.includes(preset)).toBe(supported)
    }
    expect(offered.includes('actions')).toBe(caps.actions > 0)
  })

  it('actions preset for a no-action kind yields no actions', () => {
    const s = composeTestSample(pushover, buildPreset(pushover, 'actions'))
    expect(s.actions).toBeUndefined()
  })
})
