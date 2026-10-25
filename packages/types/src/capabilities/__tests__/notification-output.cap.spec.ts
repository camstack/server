import { describe, it, expect } from 'vitest'
import {
  AttachmentSchema,
  DiscoveredTargetSchema,
  NotificationSchema,
  SendResultSchema,
  TargetKindSchema,
  TargetSchema,
  notificationOutputCapability,
} from '../notification-output.cap.js'

describe('notification-output cap — NotificationSchema', () => {
  it('requires body, defaults format=text and priority=3', () => {
    const parsed = NotificationSchema.parse({ body: 'hello' })
    expect(parsed.body).toBe('hello')
    expect(parsed.format).toBe('text')
    expect(parsed.priority).toBe(3)
  })

  it('rejects a notification with no body', () => {
    expect(NotificationSchema.safeParse({ title: 'x' }).success).toBe(false)
  })

  it('enforces priority bounds 1..5 (ordinal)', () => {
    expect(NotificationSchema.safeParse({ body: 'b', priority: 1 }).success).toBe(true)
    expect(NotificationSchema.safeParse({ body: 'b', priority: 5 }).success).toBe(true)
    expect(NotificationSchema.safeParse({ body: 'b', priority: 0 }).success).toBe(false)
    expect(NotificationSchema.safeParse({ body: 'b', priority: 6 }).success).toBe(false)
    expect(NotificationSchema.safeParse({ body: 'b', priority: 2.5 }).success).toBe(false)
  })

  it('accepts the format enum and rejects unknown formats', () => {
    expect(NotificationSchema.safeParse({ body: 'b', format: 'markdown' }).success).toBe(true)
    expect(NotificationSchema.safeParse({ body: 'b', format: 'html' }).success).toBe(true)
    expect(NotificationSchema.safeParse({ body: 'b', format: 'rtf' }).success).toBe(false)
  })

  it('accepts an optional kind-native level id string', () => {
    const parsed = NotificationSchema.parse({ body: 'b', level: 'emergency' })
    expect(parsed.level).toBe('emergency')
  })

  it('accepts attachments, actions, clickUrl, sound, ttl, tag', () => {
    const parsed = NotificationSchema.parse({
      body: 'b',
      attachments: [{ mediaType: 'image', url: 'https://x/y.jpg' }],
      actions: [{ id: 'a', label: 'Open', url: 'https://x' }],
      clickUrl: 'https://x',
      sound: 'ping',
      ttl: 60,
      tag: 'motion-1',
    })
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.actions?.[0]?.id).toBe('a')
  })
})

describe('notification-output cap — AttachmentSchema (url|bytes union)', () => {
  it('accepts a url-only attachment', () => {
    expect(AttachmentSchema.safeParse({ mediaType: 'image', url: 'https://x' }).success).toBe(true)
  })

  it('accepts a bytes-only attachment', () => {
    expect(
      AttachmentSchema.safeParse({ mediaType: 'image', bytes: new Uint8Array([1, 2, 3]) }).success,
    ).toBe(true)
  })

  it('rejects an attachment with neither url nor bytes', () => {
    expect(AttachmentSchema.safeParse({ mediaType: 'image' }).success).toBe(false)
  })

  it('accepts every media type in the superset enum', () => {
    for (const mediaType of ['image', 'video', 'gif', 'audio', 'icon'] as const) {
      expect(AttachmentSchema.safeParse({ mediaType, url: 'https://x' }).success).toBe(true)
    }
    expect(AttachmentSchema.safeParse({ mediaType: 'pdf', url: 'https://x' }).success).toBe(false)
  })
})

describe('notification-output cap — TargetKind levels (ordinal nullable)', () => {
  it('accepts a level with a numeric ordinal', () => {
    const kind = TargetKindSchema.parse({
      kind: 'ntfy',
      label: 'ntfy',
      icon: 'bell',
      addonId: 'notifiers',
      configSchema: { sections: [] },
      supportsDiscovery: false,
      caps: {
        attachments: { mediaTypes: ['image'], mode: 'both', max: 1 },
        actions: 3,
        levels: [{ id: 'max', label: 'Max', ordinal: 5, flags: { critical: true } }],
        format: ['text', 'markdown'],
        clickUrl: true,
        sound: true,
        ttl: false,
        bodyMaxLen: 4096,
      },
    })
    expect(kind.caps.levels[0]?.ordinal).toBe(5)
  })

  it('accepts a level with a null ordinal (qualitative-only, e.g. Telegram silent)', () => {
    const level = { id: 'silent', label: 'Silent', ordinal: null, flags: { silent: true } }
    const kind = TargetKindSchema.parse({
      kind: 'telegram',
      label: 'Telegram',
      icon: 'send',
      addonId: 'notifiers',
      configSchema: { sections: [] },
      supportsDiscovery: true,
      caps: {
        attachments: { mediaTypes: ['image', 'video'], mode: 'both', max: 1 },
        actions: 3,
        levels: [level],
        format: ['markdown', 'html'],
        clickUrl: true,
        sound: false,
        ttl: false,
        bodyMaxLen: 4096,
      },
    })
    expect(kind.caps.levels[0]?.ordinal).toBeNull()
  })

  it('rejects an ordinal outside 1..5', () => {
    const kind = {
      kind: 'x',
      label: 'x',
      icon: 'x',
      addonId: 'notifiers',
      configSchema: {},
      supportsDiscovery: false,
      caps: {
        attachments: { mediaTypes: [], mode: 'url', max: 0 },
        actions: 0,
        levels: [{ id: 'bad', label: 'Bad', ordinal: 9 }],
        format: ['text'],
        clickUrl: false,
        sound: false,
        ttl: false,
        bodyMaxLen: 100,
      },
    }
    expect(TargetKindSchema.safeParse(kind).success).toBe(false)
  })
})

describe('notification-output cap — records + results', () => {
  it('TargetSchema round-trips a stored target', () => {
    const target = TargetSchema.parse({
      id: 't1',
      name: 'My ntfy',
      kind: 'ntfy',
      addonId: 'notifiers',
      enabled: true,
      config: { topic: 'secret-topic' },
    })
    expect(target.enabled).toBe(true)
  })

  it('DiscoveredTargetSchema carries a suggestedName + partial config', () => {
    expect(
      DiscoveredTargetSchema.safeParse({
        kind: 'homeassistant',
        suggestedName: 'notify.mobile_app',
        config: { service: 'mobile_app' },
      }).success,
    ).toBe(true)
  })

  it('SendResultSchema carries renderedAs report', () => {
    const res = SendResultSchema.parse({
      success: true,
      renderedAs: {
        level: 'max',
        format: 'text',
        attachmentsSent: 1,
        actionsSent: 0,
        truncated: false,
        dropped: ['actions'],
      },
    })
    expect(res.renderedAs?.dropped).toEqual(['actions'])
  })
})

describe('notification-output cap — method surface', () => {
  it('declares the extended method set and drops sendTest', () => {
    const methods = notificationOutputCapability.methods
    for (const m of [
      'listTargetKinds',
      'listTargets',
      'discoverTargets',
      'send',
      'testTarget',
      'upsertTarget',
      'deleteTarget',
      'setTargetEnabled',
    ]) {
      expect(methods).toHaveProperty(m)
    }
    expect(methods).not.toHaveProperty('sendTest')
  })

  it('array-output queries return arrays (auto concat fan-out)', () => {
    expect(notificationOutputCapability.methods.listTargetKinds.output.safeParse([]).success).toBe(
      true,
    )
    expect(notificationOutputCapability.methods.listTargets.output.safeParse([]).success).toBe(true)
    expect(notificationOutputCapability.methods.discoverTargets.output.safeParse([]).success).toBe(
      true,
    )
  })
})
