import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  NotificationSchema,
  type TargetKindCaps,
} from '../../capabilities/notification-output.cap.js'
import { prepareNotification } from '../degrade-engine.js'
import { htmlToText, markdownToText, resolveFormat, transcodeBody } from '../format-transcode.js'

type Notification = z.infer<typeof NotificationSchema>

function note(overrides: Partial<Notification> = {}): Notification {
  return NotificationSchema.parse({ body: 'hello world', ...overrides })
}

/** Minimal caps builder — every field defaulted "permissive". */
function caps(overrides: Partial<TargetKindCaps> = {}): TargetKindCaps {
  return {
    attachments: { mediaTypes: ['image', 'video', 'gif', 'audio', 'icon'], mode: 'both', max: 99 },
    actions: 99,
    levels: [
      { id: 'p1', label: '1', ordinal: 1 },
      { id: 'p2', label: '2', ordinal: 2 },
      { id: 'p3', label: '3', ordinal: 3 },
      { id: 'p4', label: '4', ordinal: 4 },
      { id: 'p5', label: '5', ordinal: 5 },
    ],
    format: ['text', 'markdown', 'html'],
    clickUrl: true,
    sound: true,
    ttl: true,
    bodyMaxLen: 100000,
    ...overrides,
  }
}

// ── Dimension 1: format transcode ───────────────────────────────────
describe('format-transcode', () => {
  it('markdownToText strips markup', () => {
    expect(markdownToText('**bold** _em_ `code` [link](https://x)')).toBe('bold em code link')
    expect(markdownToText('# Heading\n- item')).toBe('Heading\nitem')
  })

  it('htmlToText strips tags + decodes entities + newlines', () => {
    expect(htmlToText('<b>hi</b><br>there &amp; you')).toBe('hi\nthere & you')
  })

  it.each<
    [
      import('../format-transcode.js').NotificationFormat,
      import('../format-transcode.js').NotificationFormat[],
      string,
    ]
  >([
    ['markdown', ['text', 'markdown', 'html'], 'markdown'], // supported → kept
    ['markdown', ['text', 'html'], 'html'], // pushover: md → html-lite
    ['markdown', ['text'], 'text'], // HA: md → strip
    ['html', ['text', 'markdown'], 'text'], // html → strip
    ['text', ['markdown'], 'markdown'], // text is valid markdown
    ['html', ['html'], 'html'],
  ])('resolveFormat(%s, %j) → %s', (source, supported, expected) => {
    expect(resolveFormat(source, supported)).toBe(expected)
  })

  it('transcodeBody md→text strips, text→html escapes', () => {
    expect(transcodeBody('**b**', 'markdown', 'text')).toBe('b')
    expect(transcodeBody('a & b\nc', 'text', 'html')).toBe('a &amp; b<br>c')
    expect(transcodeBody('x', 'text', 'text')).toBe('x')
  })

  it('prepareNotification transcodes body down to a supported format', () => {
    const p = prepareNotification(
      caps({ format: ['text'] }),
      note({ body: '**bold**', format: 'markdown' }),
    )
    expect(p.format).toBe('text')
    expect(p.body).toBe('bold')
    expect(p.renderedAs.dropped).toContain('format')
  })

  it('does not report a format drop when the source format is supported', () => {
    const p = prepareNotification(caps(), note({ body: '**bold**', format: 'markdown' }))
    expect(p.format).toBe('markdown')
    expect(p.renderedAs.dropped).not.toContain('format')
  })
})

// ── Dimension 2: attachments ────────────────────────────────────────
describe('attachment filter / cap / needsFetch / maxBytes', () => {
  it('filters attachments to caps.mediaTypes', () => {
    const p = prepareNotification(
      caps({ attachments: { mediaTypes: ['image'], mode: 'both', max: 5 } }),
      note({
        attachments: [
          { mediaType: 'image', url: 'https://x/a.jpg' },
          { mediaType: 'video', url: 'https://x/b.mp4' },
        ],
      }),
    )
    expect(p.attachments).toHaveLength(1)
    expect(p.attachments[0]!.mediaType).toBe('image')
    expect(p.renderedAs.dropped).toContain('attachment:video')
  })

  it('caps the number of attachments to caps.max', () => {
    const p = prepareNotification(
      caps({ attachments: { mediaTypes: ['image'], mode: 'url', max: 1 } }),
      note({
        attachments: [
          { mediaType: 'image', url: 'https://x/1.jpg' },
          { mediaType: 'image', url: 'https://x/2.jpg' },
        ],
      }),
    )
    expect(p.attachments).toHaveLength(1)
    expect(p.renderedAs.attachmentsSent).toBe(1)
    expect(p.renderedAs.dropped).toContain('attachment:max')
  })

  it('sets needsFetch when mode:bytes and only a url is present', () => {
    const p = prepareNotification(
      caps({ attachments: { mediaTypes: ['image'], mode: 'bytes', max: 1, maxBytes: 5_000_000 } }),
      note({ attachments: [{ mediaType: 'image', url: 'https://x/a.jpg' }] }),
    )
    expect(p.attachments[0]!.needsFetch).toBe(true)
  })

  it('does not set needsFetch when bytes are already present', () => {
    const p = prepareNotification(
      caps({ attachments: { mediaTypes: ['image'], mode: 'bytes', max: 1 } }),
      note({ attachments: [{ mediaType: 'image', bytes: new Uint8Array([1, 2, 3]) }] }),
    )
    expect(p.attachments[0]!.needsFetch).toBe(false)
  })

  it('drops an inline attachment exceeding maxBytes', () => {
    const p = prepareNotification(
      caps({ attachments: { mediaTypes: ['image'], mode: 'bytes', max: 1, maxBytes: 2 } }),
      note({ attachments: [{ mediaType: 'image', bytes: new Uint8Array([1, 2, 3, 4]) }] }),
    )
    expect(p.attachments).toHaveLength(0)
    expect(p.renderedAs.dropped).toContain('attachment:maxBytes')
  })

  it.each<[TargetKindCaps['attachments']['mode'], boolean]>([
    ['url', false], // url-mode target can't upload bytes → dropped
    ['bytes', true], // bytes-mode keeps it (it's the raw payload)
    ['both', true], // both-mode keeps it
  ])('mode:%s keeps a bytes-only attachment = %s', (mode, kept) => {
    const p = prepareNotification(
      caps({ attachments: { mediaTypes: ['image'], mode, max: 5 } }),
      note({ attachments: [{ mediaType: 'image', bytes: new Uint8Array([1, 2, 3]) }] }),
    )
    expect(p.attachments).toHaveLength(kept ? 1 : 0)
    expect(p.renderedAs.attachmentsSent).toBe(kept ? 1 : 0)
    if (!kept) expect(p.renderedAs.dropped).toContain('attachment:noUrl')
  })

  it('url-mode keeps a url-bearing attachment (only bytes-only is unsendable)', () => {
    const p = prepareNotification(
      caps({ attachments: { mediaTypes: ['image'], mode: 'url', max: 5 } }),
      note({ attachments: [{ mediaType: 'image', url: 'https://x/a.jpg' }] }),
    )
    expect(p.attachments).toHaveLength(1)
    expect(p.renderedAs.dropped).not.toContain('attachment:noUrl')
  })
})

// ── Dimension 3: actions ────────────────────────────────────────────
describe('action slice', () => {
  it('slices actions to caps.actions', () => {
    const p = prepareNotification(
      caps({ actions: 2 }),
      note({
        actions: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
        ],
      }),
    )
    expect(p.actions).toHaveLength(2)
    expect(p.renderedAs.actionsSent).toBe(2)
    expect(p.renderedAs.dropped).toContain('actions')
  })

  it('STRIPS the icon for a kind that does not render one, and reports it', () => {
    // Left to the adapter this is invisible: it either ignores the field (and
    // the operator never learns the icon did nothing) or invents a mapping.
    const p = prepareNotification(
      caps({ actions: 2, actionIcons: false }),
      note({ actions: [{ id: 'a', label: 'A', icon: 'unlock' }] }),
    )
    expect(p.actions[0]?.icon).toBeUndefined()
    expect(p.renderedAs.dropped).toContain('actionIcons')
  })

  it('keeps the icon for a kind that declares support', () => {
    const p = prepareNotification(
      caps({ actions: 2, actionIcons: true }),
      note({ actions: [{ id: 'a', label: 'A', icon: 'unlock' }] }),
    )
    expect(p.actions[0]?.icon).toBe('unlock')
    expect(p.renderedAs.dropped).not.toContain('actionIcons')
  })

  it('treats an ABSENT actionIcons as unsupported', () => {
    // `.optional()` not `.default(false)` — a Zod default does not run on the
    // addon cap path, so absent must read as false HERE rather than being
    // assumed to have been filled in.
    const p = prepareNotification(
      caps({ actions: 2 }),
      note({ actions: [{ id: 'a', label: 'A', icon: 'unlock' }] }),
    )
    expect(p.actions[0]?.icon).toBeUndefined()
    expect(p.renderedAs.dropped).toContain('actionIcons')
  })

  it('does not report an icon drop when no action carried one', () => {
    const p = prepareNotification(
      caps({ actions: 2, actionIcons: false }),
      note({ actions: [{ id: 'a', label: 'A' }] }),
    )
    expect(p.renderedAs.dropped).not.toContain('actionIcons')
  })

  it('preserves `destructive` — it is a rendering hint, never a gate', () => {
    const p = prepareNotification(
      caps({ actions: 2, actionIcons: false }),
      note({ actions: [{ id: 'a', label: 'A', destructive: true, icon: 'unlock' }] }),
    )
    expect(p.actions[0]?.destructive).toBe(true)
  })

  it('drops all actions when caps.actions is 0', () => {
    const p = prepareNotification(
      caps({ actions: 0 }),
      note({ actions: [{ id: 'a', label: 'A' }] }),
    )
    expect(p.actions).toHaveLength(0)
    expect(p.renderedAs.dropped).toContain('actions')
  })
})

// ── Dimension 4: overflow ───────────────────────────────────────────
describe('body overflow truncate / split', () => {
  it('keeps a single part when body fits', () => {
    const p = prepareNotification(caps({ bodyMaxLen: 20 }), note({ body: 'short' }))
    expect(p.bodyParts).toEqual(['short'])
    expect(p.renderedAs.truncated).toBe(false)
  })

  it('splits into chunks of bodyMaxLen at exact boundaries', () => {
    const p = prepareNotification(caps({ bodyMaxLen: 5 }), note({ body: 'abcdefghij' }))
    expect(p.bodyParts).toEqual(['abcde', 'fghij'])
    expect(p.body).toBe('abcde') // truncate view = first part
    expect(p.renderedAs.truncated).toBe(true)
  })

  it('handles a trailing partial chunk', () => {
    const p = prepareNotification(caps({ bodyMaxLen: 4 }), note({ body: 'abcdefg' }))
    expect(p.bodyParts).toEqual(['abcd', 'efg'])
    expect(p.renderedAs.truncated).toBe(true)
  })
})

// ── Dimension 5: level resolution ───────────────────────────────────
describe('level resolution', () => {
  it('explicit n.level id wins', () => {
    const c = caps({
      levels: [
        { id: 'normal', label: 'Normal', ordinal: 3 },
        {
          id: 'emergency',
          label: 'Emergency',
          ordinal: 5,
          flags: { critical: true },
          requires: ['retry', 'expire'],
        },
      ],
    })
    const p = prepareNotification(c, note({ priority: 1, level: 'emergency' }))
    expect(p.level?.id).toBe('emergency')
    expect(p.level?.requires).toEqual(['retry', 'expire'])
    expect(p.renderedAs.level).toBe('emergency')
  })

  it('maps priority to the exact ordinal when present', () => {
    const p = prepareNotification(caps(), note({ priority: 4 }))
    expect(p.level?.id).toBe('p4')
  })

  it('maps priority to the nearest declared ordinal, tie-break to higher', () => {
    const c = caps({
      levels: [
        { id: 'min', label: 'min', ordinal: 1 },
        { id: 'low', label: 'low', ordinal: 2 },
        { id: 'normal', label: 'normal', ordinal: 3 },
        { id: 'high', label: 'high', ordinal: 5 },
      ],
    })
    // priority 4 is equidistant to 3 and 5 → higher (5 = 'high') wins
    expect(prepareNotification(c, note({ priority: 4 })).level?.id).toBe('high')
  })

  it('falls back to the first declared level when no ordinal is non-null (Telegram-style)', () => {
    const c = caps({
      levels: [
        { id: 'normal', label: 'Normal', ordinal: null },
        { id: 'silent', label: 'Silent', ordinal: null, flags: { silent: true } },
      ],
    })
    const p = prepareNotification(c, note({ priority: 5 }))
    expect(p.level?.id).toBe('normal')
  })

  it('resolves an explicit level even when its ordinal is null', () => {
    const c = caps({
      levels: [
        { id: 'normal', label: 'Normal', ordinal: null },
        { id: 'silent', label: 'Silent', ordinal: null, flags: { silent: true } },
      ],
    })
    expect(prepareNotification(c, note({ level: 'silent', priority: 3 })).level?.id).toBe('silent')
  })

  it('emits a null level + empty renderedAs.level when no levels are declared', () => {
    const p = prepareNotification(caps({ levels: [] }), note({ priority: 3 }))
    expect(p.level).toBeNull()
    expect(p.renderedAs.level).toBe('')
  })
})

// ── Dimension 6: nulled scalar caps ─────────────────────────────────
describe('scalar cap gating (clickUrl / sound / ttl)', () => {
  it('nulls clickUrl / sound / ttl when the cap flag is false', () => {
    const p = prepareNotification(
      caps({ clickUrl: false, sound: false, ttl: false }),
      note({ clickUrl: 'https://x', sound: 'ping', ttl: 60 }),
    )
    expect(p.clickUrl).toBeNull()
    expect(p.sound).toBeNull()
    expect(p.ttl).toBeNull()
    expect(p.renderedAs.dropped).toEqual(expect.arrayContaining(['clickUrl', 'sound', 'ttl']))
  })

  it('keeps clickUrl / sound / ttl when supported', () => {
    const p = prepareNotification(caps(), note({ clickUrl: 'https://x', sound: 'ping', ttl: 60 }))
    expect(p.clickUrl).toBe('https://x')
    expect(p.sound).toBe('ping')
    expect(p.ttl).toBe(60)
  })

  it('never throws — renderedAs is always a report', () => {
    const p = prepareNotification(caps({ levels: [], format: [] }), note())
    expect(p.renderedAs).toBeDefined()
    expect(Array.isArray(p.renderedAs.dropped)).toBe(true)
  })
})

// ── Composite: the 8 real kinds ─────────────────────────────────────
describe('composite — 8 real kinds', () => {
  const KIND_CAPS: Record<string, TargetKindCaps> = {
    ntfy: caps({
      attachments: { mediaTypes: ['image', 'icon'], mode: 'both', max: 1 },
      actions: 3,
      levels: [
        { id: 'min', label: 'min', ordinal: 1 },
        { id: 'low', label: 'low', ordinal: 2 },
        { id: 'default', label: 'default', ordinal: 3 },
        { id: 'high', label: 'high', ordinal: 4 },
        { id: 'max', label: 'max', ordinal: 5, flags: { critical: true } },
      ],
      format: ['text', 'markdown'],
      clickUrl: true,
      sound: true,
      ttl: false,
      bodyMaxLen: 4096,
    }),
    pushover: caps({
      attachments: { mediaTypes: ['image'], mode: 'bytes', max: 1, maxBytes: 5_242_880 },
      actions: 0,
      levels: [
        { id: 'lowest', label: 'lowest', ordinal: 1 },
        { id: 'low', label: 'low', ordinal: 2 },
        { id: 'normal', label: 'normal', ordinal: 3 },
        { id: 'high', label: 'high', ordinal: 4 },
        {
          id: 'emergency',
          label: 'emergency',
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
    }),
    gotify: caps({
      attachments: { mediaTypes: ['image'], mode: 'url', max: 1 },
      actions: 0,
      levels: [
        { id: 'min', label: 'min', ordinal: 1 },
        { id: 'low', label: 'low', ordinal: 2 },
        { id: 'normal', label: 'normal', ordinal: 3 },
        { id: 'high', label: 'high', ordinal: 5 },
      ],
      format: ['text', 'markdown'],
      clickUrl: true,
      sound: false,
      ttl: false,
      bodyMaxLen: 4096,
    }),
    telegram: caps({
      attachments: { mediaTypes: ['image', 'video'], mode: 'both', max: 1 },
      actions: 3,
      levels: [
        { id: 'normal', label: 'Normal', ordinal: 3 },
        { id: 'silent', label: 'Silent', ordinal: null, flags: { silent: true } },
      ],
      format: ['markdown', 'html'],
      clickUrl: true,
      sound: false,
      ttl: false,
      bodyMaxLen: 4096,
    }),
    discord: caps({
      attachments: { mediaTypes: ['image'], mode: 'both', max: 1 },
      actions: 0,
      levels: [
        { id: 'normal', label: 'Normal', ordinal: 3 },
        { id: 'silent', label: 'Silent', ordinal: null, flags: { silent: true } },
      ],
      format: ['markdown'],
      clickUrl: true,
      sound: false,
      ttl: false,
      bodyMaxLen: 2000,
    }),
    homeassistant: caps({
      attachments: { mediaTypes: ['image', 'video', 'audio', 'icon'], mode: 'url', max: 1 },
      actions: 3,
      levels: [
        { id: 'default', label: 'Default', ordinal: 3 },
        { id: 'high', label: 'High', ordinal: 4 },
        { id: 'critical', label: 'Critical', ordinal: 5, flags: { critical: true } },
      ],
      format: ['text'],
      clickUrl: true,
      sound: true,
      ttl: true,
      bodyMaxLen: 4096,
    }),
    zentik: caps({
      attachments: { mediaTypes: ['image', 'video', 'gif', 'audio', 'icon'], mode: 'url', max: 5 },
      actions: 5,
      levels: [
        { id: 'SILENT', label: 'Silent', ordinal: null, flags: { silent: true } },
        { id: 'NORMAL', label: 'Normal', ordinal: 3 },
        { id: 'CRITICAL', label: 'Critical', ordinal: 5, flags: { critical: true } },
        { id: 'NO_PUSH', label: 'No push', ordinal: null, flags: { noPush: true } },
      ],
      format: ['text'],
      clickUrl: true,
      sound: true,
      ttl: true,
      bodyMaxLen: 4096,
    }),
    webhook: caps({
      attachments: {
        mediaTypes: ['image', 'video', 'gif', 'audio', 'icon'],
        mode: 'url',
        max: 999,
      },
      actions: 99,
      levels: [
        { id: 'p1', label: '1', ordinal: 1 },
        { id: 'p2', label: '2', ordinal: 2 },
        { id: 'p3', label: '3', ordinal: 3 },
        { id: 'p4', label: '4', ordinal: 4 },
        { id: 'p5', label: '5', ordinal: 5 },
      ],
      format: ['text', 'markdown', 'html'],
      clickUrl: true,
      sound: true,
      ttl: true,
      bodyMaxLen: 1_000_000,
    }),
  }

  const rich = (): Notification =>
    note({
      body: '**alert**',
      format: 'markdown',
      priority: 5,
      attachments: [
        { mediaType: 'image', url: 'https://x/a.jpg' },
        { mediaType: 'video', url: 'https://x/b.mp4' },
      ],
      actions: [
        { id: 'a', label: 'A', url: 'https://x' },
        { id: 'b', label: 'B', url: 'https://y' },
      ],
      clickUrl: 'https://x',
      sound: 'ping',
      ttl: 120,
    })

  it('never throws for any kind', () => {
    for (const [kind, c] of Object.entries(KIND_CAPS)) {
      expect(() => prepareNotification(c, rich()), kind).not.toThrow()
    }
  })

  it('pushover: drops actions, fetches image bytes, maps priority 5 → emergency (requires)', () => {
    const p = prepareNotification(KIND_CAPS.pushover!, rich())
    expect(p.actions).toHaveLength(0)
    expect(p.renderedAs.dropped).toContain('actions')
    expect(p.attachments[0]!.needsFetch).toBe(true)
    expect(p.level?.id).toBe('emergency')
    expect(p.level?.requires).toEqual(['retry', 'expire'])
    expect(p.format).toBe('html') // markdown → html-lite
  })

  it('telegram: critical(5) degrades to nearest declared (normal), keeps 2 actions', () => {
    const p = prepareNotification(KIND_CAPS.telegram!, rich())
    expect(p.level?.id).toBe('normal')
    expect(p.actions).toHaveLength(2)
    expect(p.format).toBe('markdown')
  })

  it('homeassistant: markdown → text, video attachment kept (url mode)', () => {
    const p = prepareNotification(KIND_CAPS.homeassistant!, rich())
    expect(p.format).toBe('text')
    expect(p.level?.id).toBe('critical')
    expect(p.attachments.map((a) => a.mediaType)).toEqual(['image']) // max 1, image first
  })

  it('webhook: keeps everything (escape hatch)', () => {
    const p = prepareNotification(KIND_CAPS.webhook!, rich())
    expect(p.format).toBe('markdown')
    expect(p.actions).toHaveLength(2)
    expect(p.attachments).toHaveLength(2)
    expect(p.renderedAs.dropped).toEqual([])
  })
})

// A cap call from ANOTHER ADDON never passes through the tRPC router, so the
// schema's `.default('text')` does not run and `format` arrives UNDEFINED.
// `prepareNotification` promises it never throws ("degradation is always
// reported, never surfaced as an error") — but `DEGRADE_ORDER[undefined]` threw
// `is not iterable`, which dead-lettered every Notification-Center delivery
// (2026-07-30 — the defect hiding behind the target-not-found one).
describe('prepareNotification — a notification that skipped schema defaults', () => {
  const caps: TargetKindCaps = {
    format: ['text'],
    levels: [],
    attachments: { mediaTypes: ['image'], mode: 'bytes', max: 1 },
    actions: 0,
    bodyMaxLen: 1024,
    clickUrl: false,
    sound: false,
    ttl: false,
  }

  it('degrades an ABSENT format instead of throwing', () => {
    const raw = { body: 'hello' } as unknown as Parameters<typeof prepareNotification>[1]
    expect(() => prepareNotification(caps, raw)).not.toThrow()
    expect(prepareNotification(caps, raw).body).toBe('hello')
  })

  it('keeps the body when the caps themselves lost bodyMaxLen on the wire', () => {
    const capsNoLen = { ...caps, bodyMaxLen: undefined } as unknown as TargetKindCaps
    const raw = { body: 'hello', format: 'text' } as unknown as Parameters<
      typeof prepareNotification
    >[1]
    // An absent cap means "no cap" — never an empty notification.
    expect(prepareNotification(capsNoLen, raw).body).toBe('hello')
  })

  it('degrades an UNRECOGNISED format instead of throwing', () => {
    const raw = { body: 'x', format: 'rtf' } as unknown as Parameters<typeof prepareNotification>[1]
    expect(() => prepareNotification(caps, raw)).not.toThrow()
  })
})
