/**
 * Unit tests for the generic webhook adapter — the reference adapter.
 *
 * `buildRequest` is PURE: every case asserts the exact url / method / headers /
 * JSON body it emits from a canonical `PreparedNotification`. No network.
 */
import type { PreparedNotification } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { TargetConfig } from '../../adapters/adapter.js'
import { webhookAdapter } from '../../adapters/webhook.js'

// ── Fixtures ────────────────────────────────────────────────────────

function basePrepared(over: Partial<PreparedNotification> = {}): PreparedNotification {
  return {
    body: 'Motion detected',
    title: 'Front Door',
    format: 'text',
    level: { id: 'p4', ordinal: 4 },
    attachments: [],
    actions: [],
    clickUrl: null,
    sound: null,
    ttl: null,
    tag: null,
    bodyParts: ['Motion detected'],
    renderedAs: {
      level: 'p4',
      format: 'text',
      attachmentsSent: 0,
      actionsSent: 0,
      truncated: false,
      dropped: [],
    },
    ...over,
  }
}

const URL = 'https://hooks.example.test/notify'

// ── Descriptor sanity ───────────────────────────────────────────────

describe('webhook descriptor', () => {
  it('declares a permissive, non-discoverable kind', () => {
    const d = webhookAdapter.descriptor
    expect(d.kind).toBe('webhook')
    expect(d.supportsDiscovery).toBe(false)
    expect(d.caps.actions).toBe(99)
    expect(d.caps.format).toEqual(['text', 'markdown', 'html'])
    expect(d.caps.clickUrl).toBe(true)
    expect(d.caps.sound).toBe(true)
    expect(d.caps.ttl).toBe(true)
    expect(d.caps.attachments.mode).toBe('url')
    expect(d.caps.attachments.max).toBe(99)
    expect(d.caps.attachments.mediaTypes).toEqual(['image', 'video', 'gif', 'audio', 'icon'])
    expect(d.caps.levels.map((l) => l.ordinal)).toEqual([1, 2, 3, 4, 5])
    expect(d.caps.levels.map((l) => l.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    // "no cap" body length — a large positive sentinel.
    expect(d.caps.bodyMaxLen).toBeGreaterThan(100_000)
  })
})

// ── buildRequest table ──────────────────────────────────────────────

interface Case {
  readonly name: string
  readonly config: TargetConfig
  readonly prepared: PreparedNotification
  readonly assert: (plan: ReturnType<typeof webhookAdapter.buildRequest>) => void
}

const cases: readonly Case[] = [
  {
    name: 'verbatim canonical JSON body, default POST',
    config: { url: URL },
    prepared: basePrepared({
      body: 'Person at the door',
      title: 'Doorbell',
      format: 'markdown',
      level: { id: 'p5', ordinal: 5 },
      clickUrl: 'https://cam.example.test/live',
      sound: 'chime',
      ttl: 3600,
      tag: 'door-1',
      actions: [{ id: 'ack', label: 'Acknowledge', url: 'https://cam.example.test/ack' }],
    }),
    assert: (plan) => {
      expect(plan.url).toBe(URL)
      expect(plan.method).toBe('POST')
      expect(plan.headers).toBeUndefined()
      expect(plan.body).toEqual({
        kind: 'json',
        value: {
          title: 'Doorbell',
          body: 'Person at the door',
          format: 'markdown',
          priority: 5,
          level: 'p5',
          attachments: [],
          clickUrl: 'https://cam.example.test/live',
          actions: [{ id: 'ack', label: 'Acknowledge', url: 'https://cam.example.test/ack' }],
          sound: 'chime',
          ttl: 3600,
          tag: 'door-1',
        },
      })
    },
  },
  {
    name: 'custom static headers are forwarded verbatim',
    config: {
      url: URL,
      headers: [
        { name: 'Authorization', value: 'Bearer s3cr3t' },
        { name: 'X-Source', value: 'camstack' },
        { name: '', value: 'dropped-empty-name' },
        { name: 'X-Bad', value: 42 },
      ],
    },
    prepared: basePrepared(),
    assert: (plan) => {
      // Empty-name and non-string-value rows are ignored.
      expect(plan.headers).toEqual({
        Authorization: 'Bearer s3cr3t',
        'X-Source': 'camstack',
      })
    },
  },
  {
    name: 'method override',
    config: { url: URL, method: 'PUT' },
    prepared: basePrepared(),
    assert: (plan) => {
      expect(plan.method).toBe('PUT')
    },
  },
  {
    name: 'url attachments pass through',
    config: { url: URL },
    prepared: basePrepared({
      attachments: [
        {
          mediaType: 'image',
          url: 'https://cam.example.test/snap.jpg',
          mime: 'image/jpeg',
          name: 'snap.jpg',
          needsFetch: false,
        },
        { mediaType: 'video', url: 'https://cam.example.test/clip.mp4', needsFetch: false },
      ],
    }),
    assert: (plan) => {
      expect(plan.body).toEqual({
        kind: 'json',
        value: expect.objectContaining({
          attachments: [
            {
              mediaType: 'image',
              url: 'https://cam.example.test/snap.jpg',
              mime: 'image/jpeg',
              name: 'snap.jpg',
            },
            { mediaType: 'video', url: 'https://cam.example.test/clip.mp4' },
          ],
        }),
      })
    },
  },
  {
    name: 'byte-only attachment dropped (no upload contract)',
    config: { url: URL },
    prepared: basePrepared({
      attachments: [
        { mediaType: 'image', url: 'https://cam.example.test/snap.jpg', needsFetch: false },
        // Byte-only: no `url`. The engine kept + counted it (url-mode never
        // drops bytes), but the webhook has nowhere to upload it → dropped.
        { mediaType: 'image', bytes: new Uint8Array([1, 2, 3]), needsFetch: false },
      ],
      renderedAs: {
        level: 'p4',
        format: 'text',
        attachmentsSent: 2,
        actionsSent: 0,
        truncated: false,
        dropped: [],
      },
    }),
    assert: (plan) => {
      expect(plan.body).toEqual({
        kind: 'json',
        value: expect.objectContaining({
          attachments: [{ mediaType: 'image', url: 'https://cam.example.test/snap.jpg' }],
        }),
      })
    },
  },
]

describe('webhook buildRequest', () => {
  for (const c of cases) {
    it(c.name, () => {
      c.assert(webhookAdapter.buildRequest(c.config, c.prepared))
    })
  }

  it('throws when the target has no url (provider catches → SendResult.error)', () => {
    expect(() => webhookAdapter.buildRequest({}, basePrepared())).toThrow(/url/)
  })

  it('maps an unresolved level to null priority/level', () => {
    const plan = webhookAdapter.buildRequest({ url: URL }, basePrepared({ level: null }))
    expect(plan.body).toEqual({
      kind: 'json',
      value: expect.objectContaining({ priority: null, level: null }),
    })
  })
})
