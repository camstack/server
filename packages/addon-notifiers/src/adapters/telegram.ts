/**
 * Telegram Bot API notifier adapter.
 *
 * One bot token + one chat id per target. `buildRequest` is PURE: it maps a
 * fully-prepared notification onto a single Bot-API call —
 *   - an `image` attachment → `sendPhoto`
 *   - a `gif` attachment    → `sendAnimation` (inline-rendered)
 *   - a `video` attachment  → `sendVideo`
 *   - any other attachment  → `sendDocument`
 *   - no attachment         → `sendMessage`
 * to `https://api.telegram.org/bot<token>/<method>`. Byte attachments become a
 * `multipart/form-data` upload; URL attachments are passed to Telegram as a
 * plain URL string in a JSON body (Telegram fetches them itself).
 *
 * PARSE MODE — we always emit `parse_mode: 'HTML'`. Telegram's other mode,
 * `MarkdownV2`, requires escaping a large, order-sensitive character class
 * (`_ * [ ] ( ) ~ \` > # + - = | { } . !`) inside AND outside entities — the
 * matrix §1 footgun. HTML needs only `& < >` escaped, so plain/markdown bodies
 * are HTML-escaped and HTML bodies pass through. The canonical `markdown`
 * format is therefore rendered as escaped text (its syntax shows literally) —
 * a safe, documented degradation, reported by the engine's `renderedAs`.
 *
 * LEVELS — Telegram has no priority scale, only a per-message "silent" flag
 * (`disable_notification`). We declare exactly two levels: `normal` (ordinal 3)
 * and `silent` (ordinal 1, `flags.silent`). Every other canonical ordinal —
 * including `critical` (5) — degrades to `normal` (documented, not an error).
 */
import type {
  AttachmentMediaType,
  DiscoveredTarget,
  PreparedNotification,
  TargetKind,
} from '@camstack/types'
import type {
  HttpRequestBody,
  HttpRequestPlan,
  MultipartPart,
  HttpNotifierAdapter,
  TargetConfig,
} from './adapter.js'

const TELEGRAM_API_BASE = 'https://api.telegram.org'

/** Bot-API hard limits we honour when shaping the request. */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024 // sendPhoto ceiling; larger images degrade to sendDocument
const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024 // sendDocument / sendVideo ceiling
const MESSAGE_MAX_LEN = 4096 // sendMessage text ceiling

/** The adapter's declared capability descriptor (`addonId` re-stamped by the provider). */
const descriptor: TargetKind = {
  kind: 'telegram',
  label: 'Telegram',
  icon: 'telegram',
  addonId: 'notifiers',
  supportsDiscovery: true,
  configSchema: {
    sections: [
      {
        id: 'telegram',
        title: 'Telegram',
        titleKey: 'notifiers:descriptor.s_telegram.title',
        description: 'Deliver notifications through a Telegram bot to one chat.',
        descriptionKey: 'notifiers:descriptor.s_telegram.description',
        fields: [
          {
            type: 'password',
            key: 'botToken',
            label: 'Bot Token',
            labelKey: 'notifiers:descriptor.s_telegram.botToken.label',
            description: 'The token from @BotFather (e.g. 123456:ABC-DEF…).',
            descriptionKey: 'notifiers:descriptor.s_telegram.botToken.description',
            required: true,
            showToggle: true,
          },
          {
            type: 'text',
            key: 'chatId',
            label: 'Chat ID',
            labelKey: 'notifiers:descriptor.s_telegram.chatId.label',
            description:
              'Numeric chat/user id, or @channelusername. DM the bot first, then use Discover.',
            descriptionKey: 'notifiers:descriptor.s_telegram.chatId.description',
            required: true,
          },
          {
            type: 'select',
            key: 'defaultParseMode',
            label: 'Parse Mode',
            labelKey: 'notifiers:descriptor.s_telegram.defaultParseMode.label',
            description:
              'HTML avoids the MarkdownV2 escaping pitfalls; it is the only supported mode.',
            descriptionKey: 'notifiers:descriptor.s_telegram.defaultParseMode.description',
            default: 'HTML',
            options: [
              {
                value: 'HTML',
                label: 'HTML',
                labelKey: 'notifiers:descriptor.s_telegram.defaultParseMode.o_HTML.label',
              },
            ],
          },
          {
            type: 'boolean',
            key: 'defaultSilent',
            label: 'Silent by default',
            labelKey: 'notifiers:descriptor.s_telegram.defaultSilent.label',
            description: 'Send with notification sound suppressed unless a message overrides it.',
            descriptionKey: 'notifiers:descriptor.s_telegram.defaultSilent.description',
            default: false,
            style: 'switch',
          },
        ],
      },
    ],
  },
  caps: {
    // 'both' → the degrade engine keeps URL attachments as URLs (Telegram
    // fetches them) and byte attachments as bytes (we upload multipart).
    attachments: {
      mediaTypes: ['image', 'video', 'gif', 'audio'],
      mode: 'both',
      max: 1,
      maxBytes: DOCUMENT_MAX_BYTES,
    },
    actions: 3, // inline url buttons; callback buttons are out of scope (no callback plumbing)
    levels: [
      { id: 'normal', label: 'Normal', ordinal: 3 },
      {
        id: 'silent',
        label: 'Silent',
        ordinal: 1,
        flags: { silent: true },
        description: 'Delivered with notification sound suppressed (disable_notification).',
      },
    ],
    format: ['text', 'markdown', 'html'],
    clickUrl: true,
    sound: true, // "sound" here means the silent flag toggle, not a sound-file selector
    ttl: false,
    bodyMaxLen: MESSAGE_MAX_LEN,
  },
}

/** Escape the three characters Telegram's HTML parser treats as markup. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function requireString(config: TargetConfig, key: string): string {
  const raw = config[key]
  if (typeof raw === 'string' && raw.length > 0) return raw
  if (typeof raw === 'number') return String(raw)
  throw new Error(`telegram: missing required config '${key}'`)
}

/** The message text/caption: an optional bold title line, the body, an optional click-through link. */
function renderText(prepared: PreparedNotification): string {
  const bodyText = prepared.bodyParts[0] ?? prepared.body
  const renderedBody = prepared.format === 'html' ? bodyText : escapeHtml(bodyText)
  const titleLine = prepared.title ? `<b>${escapeHtml(prepared.title)}</b>\n` : ''
  const clickLine =
    prepared.clickUrl !== null
      ? `\n<a href="${escapeHtml(prepared.clickUrl)}">${escapeHtml(prepared.clickUrl)}</a>`
      : ''
  return `${titleLine}${renderedBody}${clickLine}`
}

/** Inline keyboard rows built from url-bearing actions (already capped by the engine). */
function replyMarkup(
  prepared: PreparedNotification,
): { readonly inline_keyboard: readonly { text: string; url: string }[][] } | undefined {
  const buttons = prepared.actions
    .filter((action) => typeof action.url === 'string' && action.url.length > 0)
    .map((action) => ({ text: action.label, url: action.url as string }))
  return buttons.length > 0 ? { inline_keyboard: [buttons] } : undefined
}

interface MethodChoice {
  readonly method: string
  /** The Bot-API field name for the media (`photo`/`video`/`document`), or null for a text message. */
  readonly mediaField: string | null
}

/** Pick the Bot-API method + media field for the (single) prepared attachment. */
function chooseMethod(prepared: PreparedNotification): MethodChoice {
  const att = prepared.attachments[0]
  if (!att) return { method: 'sendMessage', mediaField: null }

  const media: AttachmentMediaType = att.mediaType
  if (media === 'image') {
    // Images above the sendPhoto ceiling ship as a document instead of failing.
    const oversized = att.bytes !== undefined && att.bytes.byteLength > PHOTO_MAX_BYTES
    return oversized
      ? { method: 'sendDocument', mediaField: 'document' }
      : { method: 'sendPhoto', mediaField: 'photo' }
  }
  // GIFs render inline via sendAnimation; sendDocument would attach them
  // as a non-playing file.
  if (media === 'gif') return { method: 'sendAnimation', mediaField: 'animation' }
  if (media === 'video') return { method: 'sendVideo', mediaField: 'video' }
  return { method: 'sendDocument', mediaField: 'document' }
}

function buildRequest(config: TargetConfig, prepared: PreparedNotification): HttpRequestPlan {
  const botToken = requireString(config, 'botToken')
  const chatId = requireString(config, 'chatId')
  const silent = prepared.level?.flags?.silent === true || config['defaultSilent'] === true
  const text = renderText(prepared)
  const markup = replyMarkup(prepared)
  const { method, mediaField } = chooseMethod(prepared)
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/${method}`
  const att = prepared.attachments[0]

  // Byte attachment → multipart upload.
  if (att && mediaField && att.bytes !== undefined) {
    const parts: MultipartPart[] = [
      { kind: 'field', name: 'chat_id', value: chatId },
      { kind: 'field', name: 'caption', value: text },
      { kind: 'field', name: 'parse_mode', value: 'HTML' },
      { kind: 'field', name: 'disable_notification', value: String(silent) },
    ]
    if (markup) {
      parts.push({ kind: 'field', name: 'reply_markup', value: JSON.stringify(markup) })
    }
    parts.push({
      kind: 'file',
      name: mediaField,
      bytes: att.bytes,
      ...(att.name !== undefined ? { filename: att.name } : {}),
      ...(att.mime !== undefined ? { contentType: att.mime } : {}),
    })
    const body: HttpRequestBody = { kind: 'multipart', parts }
    return { url, method: 'POST', body }
  }

  // JSON body — text message, or a media message that references the URL.
  const value: Record<string, unknown> = {
    chat_id: chatId,
    parse_mode: 'HTML',
    disable_notification: silent,
  }
  if (markup) value['reply_markup'] = markup

  if (att && mediaField && att.url !== undefined) {
    value['caption'] = text
    value[mediaField] = att.url
  } else {
    value['text'] = text
    // Link previews are only meaningful for text messages; show one only when
    // there is a click-through URL, otherwise keep the notification clean.
    value['link_preview_options'] = { is_disabled: prepared.clickUrl === null }
  }

  const body: HttpRequestBody = { kind: 'json', value }
  return { url, method: 'POST', body }
}

/**
 * Semi-tier discovery: after the user DMs the bot, `getUpdates` surfaces the
 * chats that have messaged it so the operator can adopt one without hunting
 * for the numeric id. Best-effort — any failure yields no candidates.
 */
async function discover(config: TargetConfig): Promise<readonly DiscoveredTarget[]> {
  const token = config['botToken']
  if (typeof token !== 'string' || token.length === 0) return []
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getUpdates`, { method: 'GET' })
    if (!res.ok) return []
    const payload = (await res.json()) as { result?: readonly TelegramUpdate[] }
    const seen = new Map<string, DiscoveredTarget>()
    for (const update of payload.result ?? []) {
      const chat = update.message?.chat
      if (!chat) continue
      const id = String(chat.id)
      if (seen.has(id)) continue
      const name =
        chat.title ??
        [chat.first_name, chat.last_name].filter(Boolean).join(' ') ??
        chat.username ??
        `Chat ${id}`
      seen.set(id, {
        kind: 'telegram',
        suggestedName: name.length > 0 ? name : `Chat ${id}`,
        config: { chatId: id },
      })
    }
    return [...seen.values()]
  } catch {
    return []
  }
}

/** Minimal shape of a Telegram update we read for discovery. */
interface TelegramUpdate {
  readonly message?: {
    readonly chat?: {
      readonly id: number | string
      readonly title?: string
      readonly first_name?: string
      readonly last_name?: string
      readonly username?: string
    }
  }
}

/** The Telegram notifier adapter. */
export const telegramAdapter: HttpNotifierAdapter = {
  descriptor,
  // The token only ever reaches api.telegram.org, but the chat decides who
  // reads what the bot sends.
  destinationKeys: ['chatId'],
  buildRequest,
  discover,
}
