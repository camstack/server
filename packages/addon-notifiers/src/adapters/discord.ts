/**
 * Discord notifier adapter — webhook path (plan task T10, v1).
 *
 * POSTs to a Discord `webhookUrl` (the URL embeds the webhook token, so it is a
 * `type:'password'` secret). One canonical notification maps onto:
 *   - `content`      — the (≤2000) message body (`prepared.body`, already
 *                      truncated by the degrade engine to `bodyMaxLen`).
 *   - `embeds[0]`    — a single embed carrying `title`, the body overflow beyond
 *                      2000 as `description` (≤4096), `url` (clickUrl), a
 *                      level-mapped `color`, and the first image (`image.url`).
 *   - `flags`        — `4096` (SUPPRESS_NOTIFICATIONS) for the `silent` level.
 *   - `allowed_mentions` — `{ parse: [] }` so a body can never inject an
 *                      `@everyone` / `@here` / role ping.
 *
 * The webhook path CANNOT render interactive components (buttons) — those need
 * a bot token — so `caps.actions` is `0`. Levels are cosmetic: they only pick
 * the embed colour (plus the one `silent` flag); there is no real priority.
 *
 * When any prepared attachment carries `bytes`, the request becomes a
 * `multipart/form-data` upload: each byte attachment is a `files[n]` part, the
 * JSON payload travels as `payload_json`, and the embed image references the
 * uploaded file via `attachment://<name>`. URL-only attachments stay as
 * `image.url` on the embed (no upload).
 *
 * `buildRequest` is PURE — it never touches the network (see `adapter.ts`).
 */
import type {
  ConfigUISchema,
  PreparedNotification,
  ResolvedLevel,
  TargetKind,
  TargetKindCaps,
} from '@camstack/types'
import type {
  HttpRequestPlan,
  MultipartPart,
  HttpNotifierAdapter,
  TargetConfig,
} from './adapter.js'

// ── Wire constants ──────────────────────────────────────────────────

/** Discord message `content` hard limit. */
const CONTENT_MAX_LEN = 2000
/** Discord embed `description` hard limit. */
const EMBED_DESCRIPTION_MAX_LEN = 4096
/** Message flag: SUPPRESS_NOTIFICATIONS (the "silent" send). */
const FLAG_SUPPRESS_NOTIFICATIONS = 4096

/**
 * Embed colour per declared level ordinal (cosmetic — the ONLY thing a level
 * changes on the webhook path). info=blue, success=green, warning=orange,
 * error=red, silent=grey.
 */
const LEVEL_COLOR_BY_ORDINAL: Readonly<Record<number, number>> = {
  1: 0x3498db, // info — blue
  2: 0x2ecc71, // success — green
  3: 0xe67e22, // warning — orange
  4: 0xe74c3c, // error — red
  5: 0x95a5a6, // silent — grey
}

/** Fallback colour when no level resolves (info blue). */
const DEFAULT_COLOR = 0x3498db

function colorForLevel(level: ResolvedLevel | null): number {
  if (level?.ordinal != null) {
    return LEVEL_COLOR_BY_ORDINAL[level.ordinal] ?? DEFAULT_COLOR
  }
  return DEFAULT_COLOR
}

// ── Capability descriptor ───────────────────────────────────────────

/**
 * NOTE (seam): the matrix §7 draft listed `mediaTypes` including `'document'`,
 * but the canonical `AttachmentMediaType` enum
 * (`image|video|gif|audio|icon`) has no `'document'` member, so this declares
 * the representable superset Discord accepts for uploads.
 */
const DISCORD_CAPS: TargetKindCaps = {
  attachments: { mediaTypes: ['image', 'video', 'gif', 'audio'], mode: 'both', max: 10 },
  actions: 0,
  levels: [
    { id: 'info', label: 'Info', ordinal: 1, description: 'embed colour only' },
    { id: 'success', label: 'Success', ordinal: 2, description: 'embed colour only' },
    { id: 'warning', label: 'Warning', ordinal: 3, description: 'embed colour only' },
    { id: 'error', label: 'Error', ordinal: 4, description: 'embed colour only' },
    {
      id: 'silent',
      label: 'Silent',
      ordinal: 5,
      flags: { silent: true },
      description: 'suppress push notification (embed colour only)',
    },
  ],
  format: ['text', 'markdown'],
  clickUrl: true,
  sound: false,
  ttl: false,
  bodyMaxLen: CONTENT_MAX_LEN,
}

function discordConfigSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'discord',
        title: 'Discord Webhook',
        titleKey: 'notifiers:discordConfig.s_discord.title',
        fields: [
          {
            type: 'password',
            key: 'webhookUrl',
            label: 'Webhook URL',
            labelKey: 'notifiers:discordConfig.s_discord.webhookUrl.label',
            required: true,
            description:
              'Full Discord webhook URL. The token is embedded in the URL, so it is stored as a secret.',
            descriptionKey: 'notifiers:discordConfig.s_discord.webhookUrl.description',
          },
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'notifiers:discordConfig.s_discord.username.label',
            description: 'Optional override for the webhook display name.',
            descriptionKey: 'notifiers:discordConfig.s_discord.username.description',
          },
          {
            type: 'text',
            key: 'avatarUrl',
            label: 'Avatar URL',
            labelKey: 'notifiers:discordConfig.s_discord.avatarUrl.label',
            inputType: 'url',
            description: 'Optional override for the webhook avatar image.',
            descriptionKey: 'notifiers:discordConfig.s_discord.avatarUrl.description',
          },
        ],
      },
    ],
  }
}

const DISCORD_DESCRIPTOR: TargetKind = {
  kind: 'discord',
  label: 'Discord',
  icon: 'discord',
  // Re-stamped by the provider; declared here to satisfy the descriptor shape.
  addonId: 'notifiers',
  configSchema: discordConfigSchema(),
  supportsDiscovery: false,
  caps: DISCORD_CAPS,
}

// ── Payload shaping ─────────────────────────────────────────────────

interface DiscordEmbed {
  title?: string
  description?: string
  url?: string
  color: number
  image?: { url: string }
}

interface DiscordPayload {
  username?: string
  avatar_url?: string
  content?: string
  embeds: DiscordEmbed[]
  flags: number
  allowed_mentions: { parse: readonly string[] }
}

interface ByteFile {
  readonly part: MultipartPart
  readonly filename: string
  readonly isImage: boolean
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The overflow past `content` (2000), joined and capped to the embed limit. */
function bodyOverflow(prepared: PreparedNotification): string | undefined {
  const overflow = prepared.bodyParts.slice(1).join('')
  if (overflow.length === 0) return undefined
  return overflow.slice(0, EMBED_DESCRIPTION_MAX_LEN)
}

function buildByteFiles(prepared: PreparedNotification): readonly ByteFile[] {
  const files: ByteFile[] = []
  let index = 0
  for (const att of prepared.attachments) {
    if (att.bytes === undefined) continue
    const filename = att.name ?? `attachment-${index}`
    files.push({
      part: {
        kind: 'file',
        name: `files[${index}]`,
        bytes: att.bytes,
        filename,
        ...(att.mime !== undefined ? { contentType: att.mime } : {}),
      },
      filename,
      isImage: att.mediaType === 'image',
    })
    index += 1
  }
  return files
}

/**
 * Resolve the embed `image.url`: a byte-image references its uploaded file via
 * `attachment://<name>`; otherwise fall back to the first URL image.
 */
function resolveEmbedImageUrl(
  prepared: PreparedNotification,
  byteFiles: readonly ByteFile[],
): string | undefined {
  const byteImage = byteFiles.find((f) => f.isImage)
  if (byteImage) return `attachment://${byteImage.filename}`
  const urlImage = prepared.attachments.find(
    (a) => a.mediaType === 'image' && a.url !== undefined && a.bytes === undefined,
  )
  return urlImage?.url
}

function buildPayload(
  config: TargetConfig,
  prepared: PreparedNotification,
  embedImageUrl: string | undefined,
): DiscordPayload {
  const silent = prepared.level?.flags?.silent === true
  const embed: DiscordEmbed = {
    ...(prepared.title !== undefined ? { title: prepared.title } : {}),
    ...(bodyOverflow(prepared) !== undefined ? { description: bodyOverflow(prepared) } : {}),
    ...(prepared.clickUrl !== null ? { url: prepared.clickUrl } : {}),
    color: colorForLevel(prepared.level),
    ...(embedImageUrl !== undefined ? { image: { url: embedImageUrl } } : {}),
  }

  const username = nonEmptyString(config['username'])
  const avatarUrl = nonEmptyString(config['avatarUrl'])

  return {
    ...(username !== undefined ? { username } : {}),
    ...(avatarUrl !== undefined ? { avatar_url: avatarUrl } : {}),
    ...(prepared.body.length > 0 ? { content: prepared.body } : {}),
    embeds: [embed],
    flags: silent ? FLAG_SUPPRESS_NOTIFICATIONS : 0,
    allowed_mentions: { parse: [] },
  }
}

// ── Adapter ─────────────────────────────────────────────────────────

export const discordAdapter: HttpNotifierAdapter = {
  descriptor: DISCORD_DESCRIPTOR,
  // The webhook URL IS the destination and the secret at once: re-typing it
  // restores nothing, and it is declared so the list can never be empty.
  destinationKeys: ['webhookUrl'],
  buildRequest(config: TargetConfig, prepared: PreparedNotification): HttpRequestPlan {
    const webhookUrl = String(config['webhookUrl'] ?? '')
    const byteFiles = buildByteFiles(prepared)
    const embedImageUrl = resolveEmbedImageUrl(prepared, byteFiles)
    const payload = buildPayload(config, prepared, embedImageUrl)

    if (byteFiles.length > 0) {
      const parts: MultipartPart[] = [
        { kind: 'field', name: 'payload_json', value: JSON.stringify(payload) },
        ...byteFiles.map((f) => f.part),
      ]
      return {
        url: webhookUrl,
        method: 'POST',
        body: { kind: 'multipart', parts },
      }
    }

    return {
      url: webhookUrl,
      method: 'POST',
      body: { kind: 'json', value: payload },
    }
  },
}
