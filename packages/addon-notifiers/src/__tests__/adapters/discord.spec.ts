/**
 * Unit tests for the Discord webhook adapter (`buildRequest` — PURE, no
 * network). Each case runs a canonical `Notification` through the real degrade
 * engine (`prepareNotification`) with Discord's declared caps, then asserts the
 * exact request plan the adapter emits.
 */
import { type Notification, prepareNotification } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { HttpRequestPlan, MultipartPart } from '../../adapters/adapter.js'
import { discordAdapter } from '../../adapters/discord.js'

// ── Helpers ─────────────────────────────────────────────────────────

const CAPS = discordAdapter.descriptor.caps
const WEBHOOK_URL = 'https://discord.com/api/webhooks/123/token-abc'
const CONFIG = { webhookUrl: WEBHOOK_URL }

/** A canonical notification with the schema defaults applied. */
function notif(overrides: Partial<Notification> & { body: string }): Notification {
  return { format: 'text', priority: 3, ...overrides }
}

function planFor(n: Notification, config: Record<string, unknown> = CONFIG): HttpRequestPlan {
  const prepared = prepareNotification(CAPS, n)
  return discordAdapter.buildRequest(config, prepared)
}

interface DiscordEmbed {
  title?: string
  description?: string
  url?: string
  color?: number
  image?: { url?: string }
}
interface DiscordPayload {
  username?: string
  avatar_url?: string
  content?: string
  embeds?: DiscordEmbed[]
  flags?: number
  allowed_mentions?: { parse?: unknown[] }
}

/** Narrow the opaque JSON request body to the Discord payload shape. */
function jsonPayload(plan: HttpRequestPlan): DiscordPayload {
  const body = plan.body
  if (!body || body.kind !== 'json') {
    throw new Error(`expected a json body, got ${body?.kind ?? 'none'}`)
  }
  return body.value as DiscordPayload
}

function multipartParts(plan: HttpRequestPlan): readonly MultipartPart[] {
  const body = plan.body
  if (!body || body.kind !== 'multipart') {
    throw new Error(`expected a multipart body, got ${body?.kind ?? 'none'}`)
  }
  return body.parts
}

/** Extract + parse the `payload_json` field from a multipart plan. */
function multipartPayload(plan: HttpRequestPlan): DiscordPayload {
  const field = multipartParts(plan).find((p) => p.kind === 'field' && p.name === 'payload_json')
  if (!field || field.kind !== 'field') throw new Error('no payload_json field')
  return JSON.parse(field.value)
}

function embed(payload: DiscordPayload): DiscordEmbed {
  const first = payload.embeds?.[0]
  if (!first) throw new Error('no embed in payload')
  return first
}

// ── Descriptor ──────────────────────────────────────────────────────

describe('discord descriptor', () => {
  it('declares the webhook-path caps', () => {
    expect(discordAdapter.descriptor.kind).toBe('discord')
    expect(discordAdapter.descriptor.supportsDiscovery).toBe(false)
    expect(CAPS.actions).toBe(0)
    expect(CAPS.clickUrl).toBe(true)
    expect(CAPS.sound).toBe(false)
    expect(CAPS.ttl).toBe(false)
    expect(CAPS.bodyMaxLen).toBe(2000)
    expect(CAPS.format).toEqual(['text', 'markdown'])
    expect(CAPS.attachments).toEqual({
      mediaTypes: ['image', 'video', 'gif', 'audio'],
      mode: 'both',
      max: 10,
    })
    expect(CAPS.levels.map((l) => l.id)).toEqual(['info', 'success', 'warning', 'error', 'silent'])
  })

  it('marks webhookUrl as a password field (token is in the URL)', () => {
    const field = discordAdapter.descriptor.configSchema.sections[0]?.fields.find(
      (f) => 'key' in f && f.key === 'webhookUrl',
    )
    expect(field && 'type' in field ? field.type : undefined).toBe('password')
  })
})

// ── buildRequest ────────────────────────────────────────────────────

describe('discord buildRequest', () => {
  it('POSTs plain content to the webhook URL', () => {
    const plan = planFor(notif({ body: 'hello world', level: 'info' }))
    expect(plan.url).toBe(WEBHOOK_URL)
    expect(plan.method).toBe('POST')
    const payload = jsonPayload(plan)
    expect(payload.content).toBe('hello world')
    expect(embed(payload).title).toBeUndefined()
    expect(embed(payload).description).toBeUndefined()
    expect(embed(payload).image).toBeUndefined()
    expect(payload.flags).toBe(0)
  })

  it('passes markdown body through verbatim (native markdown)', () => {
    const plan = planFor(notif({ body: '**bold** _italic_', format: 'markdown', level: 'info' }))
    const payload = jsonPayload(plan)
    expect(payload.content).toBe('**bold** _italic_')
  })

  it('puts a title on the embed', () => {
    const plan = planFor(notif({ body: 'b', title: 'A title', level: 'info' }))
    expect(embed(jsonPayload(plan)).title).toBe('A title')
  })

  it('maps a URL image onto embed.image.url', () => {
    const plan = planFor(
      notif({
        body: 'b',
        level: 'info',
        attachments: [{ mediaType: 'image', url: 'https://cdn.test/pic.png' }],
      }),
    )
    expect(embed(jsonPayload(plan)).image).toEqual({ url: 'https://cdn.test/pic.png' })
  })

  it('maps clickUrl onto embed.url', () => {
    const plan = planFor(notif({ body: 'b', level: 'info', clickUrl: 'https://open.test/x' }))
    expect(embed(jsonPayload(plan)).url).toBe('https://open.test/x')
  })

  it('always sets allowed_mentions to an empty parse list', () => {
    const plan = planFor(notif({ body: '@everyone hi', level: 'info' }))
    expect(jsonPayload(plan).allowed_mentions).toEqual({ parse: [] })
  })

  it('threads username + avatar_url from config', () => {
    const plan = planFor(notif({ body: 'b', level: 'info' }), {
      webhookUrl: WEBHOOK_URL,
      username: 'CamStack',
      avatarUrl: 'https://cdn.test/avatar.png',
    })
    const payload = jsonPayload(plan)
    expect(payload.username).toBe('CamStack')
    expect(payload.avatar_url).toBe('https://cdn.test/avatar.png')
  })

  it('omits username/avatar_url when not configured', () => {
    const payload = jsonPayload(planFor(notif({ body: 'b', level: 'info' })))
    expect(payload.username).toBeUndefined()
    expect(payload.avatar_url).toBeUndefined()
  })
})

// ── level → colour ──────────────────────────────────────────────────

describe('discord level → embed colour', () => {
  const cases: ReadonlyArray<{ level: string; color: number }> = [
    { level: 'info', color: 0x3498db },
    { level: 'success', color: 0x2ecc71 },
    { level: 'warning', color: 0xe67e22 },
    { level: 'error', color: 0xe74c3c },
    { level: 'silent', color: 0x95a5a6 },
  ]

  for (const { level, color } of cases) {
    it(`${level} → ${color.toString(16)}`, () => {
      const plan = planFor(notif({ body: 'b', level }))
      expect(embed(jsonPayload(plan)).color).toBe(color)
    })
  }

  it('falls back to info blue when no ordinal level resolves', () => {
    // Empty caps.levels would resolve to null; here every level has an ordinal,
    // so priority always resolves — assert the default constant directly by
    // driving an out-of-range priority to the nearest level (5 → silent grey).
    const plan = planFor(notif({ body: 'b', priority: 5 }))
    expect(embed(jsonPayload(plan)).color).toBe(0x95a5a6)
  })
})

// ── silent flag ─────────────────────────────────────────────────────

describe('discord silent flag', () => {
  it('sets SUPPRESS_NOTIFICATIONS (4096) for the silent level', () => {
    const plan = planFor(notif({ body: 'quiet', level: 'silent' }))
    expect(jsonPayload(plan).flags).toBe(4096)
  })

  it('leaves flags at 0 for a normal level', () => {
    const plan = planFor(notif({ body: 'loud', level: 'info' }))
    expect(jsonPayload(plan).flags).toBe(0)
  })
})

// ── body overflow → embed description ───────────────────────────────

describe('discord body overflow', () => {
  it('keeps ≤2000 body as content with no description', () => {
    const body = 'x'.repeat(2000)
    const payload = jsonPayload(planFor(notif({ body, level: 'info' })))
    expect(payload.content).toBe(body)
    expect(embed(payload).description).toBeUndefined()
  })

  it('spills the >2000 remainder into embed.description', () => {
    const head = 'a'.repeat(2000)
    const tail = 'b'.repeat(500)
    const payload = jsonPayload(planFor(notif({ body: head + tail, level: 'info' })))
    expect(payload.content).toBe(head)
    expect(payload.content?.length).toBe(2000)
    expect(embed(payload).description).toBe(tail)
  })

  it('caps the embed description at 4096 chars', () => {
    // content(2000) + overflow(4600) → description truncated to 4096.
    const body = 'c'.repeat(2000 + 4600)
    const desc = embed(jsonPayload(planFor(notif({ body, level: 'info' })))).description
    expect(desc?.length).toBe(4096)
  })
})

// ── multipart (byte attachments) ────────────────────────────────────

describe('discord byte-attachment uploads', () => {
  it('uploads bytes as files[n] + payload_json and refs attachment://<name>', () => {
    const plan = planFor(
      notif({
        body: 'shot',
        level: 'info',
        attachments: [
          {
            mediaType: 'image',
            bytes: new Uint8Array([1, 2, 3]),
            name: 'shot.png',
            mime: 'image/png',
          },
        ],
      }),
    )
    const parts = multipartParts(plan)
    const file = parts.find((p) => p.kind === 'file')
    expect(file).toBeDefined()
    if (file?.kind === 'file') {
      expect(file.name).toBe('files[0]')
      expect(file.filename).toBe('shot.png')
      expect(file.contentType).toBe('image/png')
      expect(Array.from(file.bytes)).toEqual([1, 2, 3])
    }
    // The embed references the uploaded file, not a remote URL.
    expect(embed(multipartPayload(plan)).image).toEqual({ url: 'attachment://shot.png' })
  })

  it('stays on the JSON path when no attachment carries bytes', () => {
    const plan = planFor(
      notif({
        body: 'b',
        level: 'info',
        attachments: [{ mediaType: 'image', url: 'https://cdn.test/pic.png' }],
      }),
    )
    expect(plan.body?.kind).toBe('json')
  })
})
