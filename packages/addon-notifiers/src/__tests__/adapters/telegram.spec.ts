/**
 * Unit tests for the Telegram notifier adapter. `buildRequest` is PURE, so
 * every case asserts the exact url / method / body it emits against a manually
 * constructed `PreparedNotification` — no network, no degrade engine.
 */
import type { PreparedNotification, RenderedAs, ResolvedLevel } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { HttpRequestPlan, MultipartRequestBody, TargetConfig } from '../../adapters/adapter.js'
import { telegramAdapter } from '../../adapters/telegram.js'

// ── Fixtures ────────────────────────────────────────────────────────

const CONFIG: TargetConfig = { botToken: 'BOT:TOK', chatId: '12345' }

const NORMAL_LEVEL: ResolvedLevel = { id: 'normal', ordinal: 3 }
const SILENT_LEVEL: ResolvedLevel = { id: 'silent', ordinal: 1, flags: { silent: true } }

function renderedAs(over: Partial<RenderedAs> = {}): RenderedAs {
  return {
    level: 'normal',
    format: 'html',
    attachmentsSent: 0,
    actionsSent: 0,
    truncated: false,
    dropped: [],
    ...over,
  }
}

function prepared(over: Partial<PreparedNotification> = {}): PreparedNotification {
  const body = over.body ?? 'hello world'
  return {
    body,
    format: 'html',
    level: NORMAL_LEVEL,
    attachments: [],
    actions: [],
    clickUrl: null,
    sound: null,
    ttl: null,
    tag: null,
    bodyParts: [body],
    renderedAs: renderedAs(),
    ...over,
  }
}

function jsonValue(plan: HttpRequestPlan): Record<string, unknown> {
  expect(plan.body?.kind).toBe('json')
  return (plan.body as { kind: 'json'; value: Record<string, unknown> }).value
}

function multipart(plan: HttpRequestPlan): MultipartRequestBody {
  expect(plan.body?.kind).toBe('multipart')
  return plan.body as MultipartRequestBody
}

function field(body: MultipartRequestBody, name: string): string | undefined {
  const part = body.parts.find((p) => p.kind === 'field' && p.name === name)
  return part && part.kind === 'field' ? part.value : undefined
}

// ── descriptor ──────────────────────────────────────────────────────

describe('telegram descriptor', () => {
  it('declares kind, discovery, and Telegram-shaped caps', () => {
    const d = telegramAdapter.descriptor
    expect(d.kind).toBe('telegram')
    expect(d.supportsDiscovery).toBe(true)
    expect(d.caps.actions).toBe(3)
    expect(d.caps.bodyMaxLen).toBe(4096)
    expect(d.caps.attachments).toMatchObject({ mode: 'both', max: 1 })
    expect(d.caps.format).toEqual(['text', 'markdown', 'html'])
    // Two levels only: normal + silent (all other ordinals, incl. critical, → normal).
    expect(d.caps.levels.map((l) => l.id)).toEqual(['normal', 'silent'])
    expect(d.caps.levels.find((l) => l.id === 'silent')?.flags?.silent).toBe(true)
  })

  it('exposes botToken as a password field and a required chatId', () => {
    const fields = telegramAdapter.descriptor.configSchema.sections[0]?.fields ?? []
    const byKey = new Map(fields.map((f) => [f.key, f]))
    const chatId = byKey.get('chatId')
    expect(byKey.get('botToken')?.type).toBe('password')
    expect(chatId && 'required' in chatId ? chatId.required : undefined).toBe(true)
  })
})

// ── buildRequest table ──────────────────────────────────────────────

describe('telegram buildRequest', () => {
  it('plain text → sendMessage JSON with parse_mode HTML', () => {
    const plan = telegramAdapter.buildRequest(
      CONFIG,
      prepared({ format: 'text', body: 'hello world' }),
    )
    expect(plan.url).toBe('https://api.telegram.org/botBOT:TOK/sendMessage')
    expect(plan.method).toBe('POST')
    const value = jsonValue(plan)
    expect(value['chat_id']).toBe('12345')
    expect(value['text']).toBe('hello world')
    expect(value['parse_mode']).toBe('HTML')
    expect(value['disable_notification']).toBe(false)
    expect(value['reply_markup']).toBeUndefined()
    expect(value['link_preview_options']).toEqual({ is_disabled: true })
  })

  it('HTML-escapes a text/markdown body but passes an html body through', () => {
    const raw = 'a < b & c > d'
    const asText = jsonValue(
      telegramAdapter.buildRequest(CONFIG, prepared({ format: 'text', body: raw })),
    )
    expect(asText['text']).toBe('a &lt; b &amp; c &gt; d')

    const asMarkdown = jsonValue(
      telegramAdapter.buildRequest(CONFIG, prepared({ format: 'markdown', body: '**x** <y>' })),
    )
    expect(asMarkdown['text']).toBe('**x** &lt;y&gt;')

    const asHtml = jsonValue(
      telegramAdapter.buildRequest(CONFIG, prepared({ format: 'html', body: '<b>bold</b>' })),
    )
    expect(asHtml['text']).toBe('<b>bold</b>')
  })

  it('prepends the title as a bold first line', () => {
    const value = jsonValue(
      telegramAdapter.buildRequest(
        CONFIG,
        prepared({ format: 'text', body: 'body text', title: 'Motion & Alert' }),
      ),
    )
    expect(value['text']).toBe('<b>Motion &amp; Alert</b>\nbody text')
  })

  it('silent level sets disable_notification', () => {
    const value = jsonValue(telegramAdapter.buildRequest(CONFIG, prepared({ level: SILENT_LEVEL })))
    expect(value['disable_notification']).toBe(true)
  })

  it('config defaultSilent forces disable_notification even on a normal level', () => {
    const value = jsonValue(
      telegramAdapter.buildRequest(
        { ...CONFIG, defaultSilent: true },
        prepared({ level: NORMAL_LEVEL }),
      ),
    )
    expect(value['disable_notification']).toBe(true)
  })

  it('url actions become an inline keyboard; actions without a url are dropped', () => {
    const value = jsonValue(
      telegramAdapter.buildRequest(
        CONFIG,
        prepared({
          actions: [
            { id: 'view', label: 'View', url: 'https://cam/1' },
            { id: 'ack', label: 'Ack' },
            { id: 'clip', label: 'Clip', url: 'https://cam/clip' },
          ],
        }),
      ),
    )
    expect(value['reply_markup']).toEqual({
      inline_keyboard: [
        [
          { text: 'View', url: 'https://cam/1' },
          { text: 'Clip', url: 'https://cam/clip' },
        ],
      ],
    })
  })

  it('image URL attachment → sendPhoto JSON referencing the url as caption', () => {
    const plan = telegramAdapter.buildRequest(
      CONFIG,
      prepared({
        format: 'text',
        body: 'snap',
        attachments: [{ mediaType: 'image', url: 'https://cam/frame.jpg', needsFetch: false }],
      }),
    )
    expect(plan.url).toBe('https://api.telegram.org/botBOT:TOK/sendPhoto')
    const value = jsonValue(plan)
    expect(value['photo']).toBe('https://cam/frame.jpg')
    expect(value['caption']).toBe('snap')
    expect(value['text']).toBeUndefined()
    expect(value['link_preview_options']).toBeUndefined()
  })

  it('image bytes attachment → sendPhoto multipart upload', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const plan = telegramAdapter.buildRequest(
      CONFIG,
      prepared({
        format: 'text',
        body: 'snap',
        attachments: [
          { mediaType: 'image', bytes, needsFetch: false, mime: 'image/jpeg', name: 'f.jpg' },
        ],
      }),
    )
    expect(plan.url).toBe('https://api.telegram.org/botBOT:TOK/sendPhoto')
    const body = multipart(plan)
    expect(field(body, 'chat_id')).toBe('12345')
    expect(field(body, 'caption')).toBe('snap')
    expect(field(body, 'parse_mode')).toBe('HTML')
    const file = body.parts.find((p) => p.kind === 'file')
    expect(file).toMatchObject({ name: 'photo', filename: 'f.jpg', contentType: 'image/jpeg' })
  })

  it('oversized image bytes degrade from sendPhoto to sendDocument', () => {
    const bytes = new Uint8Array(11 * 1024 * 1024)
    const plan = telegramAdapter.buildRequest(
      CONFIG,
      prepared({ attachments: [{ mediaType: 'image', bytes, needsFetch: false }] }),
    )
    expect(plan.url).toBe('https://api.telegram.org/botBOT:TOK/sendDocument')
    expect(multipart(plan).parts.find((p) => p.kind === 'file')?.name).toBe('document')
  })

  it('gif URL attachment → sendAnimation referencing the url as animation', () => {
    const plan = telegramAdapter.buildRequest(
      CONFIG,
      prepared({
        attachments: [{ mediaType: 'gif', url: 'https://cam/clip.gif', needsFetch: false }],
      }),
    )
    expect(plan.url).toBe('https://api.telegram.org/botBOT:TOK/sendAnimation')
    expect(jsonValue(plan)['animation']).toBe('https://cam/clip.gif')
  })

  it('gif bytes attachment → sendAnimation multipart upload', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const plan = telegramAdapter.buildRequest(
      CONFIG,
      prepared({ attachments: [{ mediaType: 'gif', bytes, needsFetch: false }] }),
    )
    expect(plan.url).toBe('https://api.telegram.org/botBOT:TOK/sendAnimation')
    expect(multipart(plan).parts.find((p) => p.kind === 'file')?.name).toBe('animation')
  })

  it('video → sendVideo and any other media → sendDocument', () => {
    const video = telegramAdapter.buildRequest(
      CONFIG,
      prepared({
        attachments: [{ mediaType: 'video', url: 'https://cam/clip.mp4', needsFetch: false }],
      }),
    )
    expect(video.url).toBe('https://api.telegram.org/botBOT:TOK/sendVideo')
    expect(jsonValue(video)['video']).toBe('https://cam/clip.mp4')

    const audio = telegramAdapter.buildRequest(
      CONFIG,
      prepared({
        attachments: [{ mediaType: 'audio', url: 'https://cam/a.mp3', needsFetch: false }],
      }),
    )
    expect(audio.url).toBe('https://api.telegram.org/botBOT:TOK/sendDocument')
    expect(jsonValue(audio)['document']).toBe('https://cam/a.mp3')
  })

  it('clickUrl is appended as an html link and enables the link preview', () => {
    const value = jsonValue(
      telegramAdapter.buildRequest(
        CONFIG,
        prepared({ format: 'text', body: 'see', clickUrl: 'https://cam/live' }),
      ),
    )
    expect(value['text']).toBe('see\n<a href="https://cam/live">https://cam/live</a>')
    expect(value['link_preview_options']).toEqual({ is_disabled: false })
  })

  it('throws when required config is missing (provider turns this into SendResult.error)', () => {
    expect(() => telegramAdapter.buildRequest({ chatId: '1' }, prepared())).toThrow(/botToken/)
    expect(() => telegramAdapter.buildRequest({ botToken: 'x' }, prepared())).toThrow(/chatId/)
  })
})
