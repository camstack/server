/**
 * Capability-gated notification degrade engine (Apprise-style).
 *
 * PURE — no I/O. Given a kind's `TargetKind.caps` and a canonical
 * `Notification`, it transcodes the format down, resolves the native level,
 * filters + caps attachments, slices actions, gates scalar features, and
 * splits/truncates the body — producing a `PreparedNotification` the adapter
 * turns into an HTTP request. Attachment url→bytes fetching is expressed as a
 * `needsFetch` directive the adapter executes (the engine never fetches).
 *
 * Lives in `@camstack/types` because both the system `notifiers` addon and the
 * HA addon need it and addons may not cross-import.
 */
import type { z } from 'zod'
import type {
  AttachmentMediaType,
  NotificationAction,
  NotificationFormat,
  NotificationSchema,
  RenderedAs,
  TargetKindCaps,
  TargetKindLevel,
} from '../capabilities/notification-output.cap.js'
import { resolveFormat, transcodeBody } from './format-transcode.js'

type Notification = z.infer<typeof NotificationSchema>

/** The resolved native level the adapter maps onto its wire payload. */
export interface ResolvedLevel {
  readonly id: string
  readonly ordinal: number | null
  readonly flags?: {
    readonly critical?: boolean
    readonly silent?: boolean
    readonly noPush?: boolean
  }
  /** e.g. Pushover `emergency` → `['retry','expire']` — adapter injects config defaults. */
  readonly requires?: readonly string[]
}

/** An attachment after filtering, with a fetch directive for the adapter. */
export interface PreparedAttachment {
  readonly mediaType: AttachmentMediaType
  readonly url?: string
  readonly bytes?: Uint8Array
  readonly mime?: string
  readonly name?: string
  /** `true` when the adapter must fetch `url` into bytes (mode:'bytes', url-only). */
  readonly needsFetch: boolean
}

export type PreparedAction = NotificationAction

export interface PreparedNotification {
  readonly body: string
  readonly title?: string
  readonly format: NotificationFormat
  readonly level: ResolvedLevel | null
  readonly attachments: readonly PreparedAttachment[]
  readonly actions: readonly PreparedAction[]
  readonly clickUrl: string | null
  readonly sound: string | null
  readonly ttl: number | null
  readonly tag: string | null
  /** Overflow: `bodyParts[0]` is the truncate view; the full array is the split. */
  readonly bodyParts: readonly string[]
  readonly renderedAs: RenderedAs
}

function toResolvedLevel(level: TargetKindLevel): ResolvedLevel {
  return {
    id: level.id,
    ordinal: level.ordinal,
    ...(level.flags ? { flags: level.flags } : {}),
    ...(level.requires ? { requires: level.requires } : {}),
  }
}

function resolveLevel(levels: readonly TargetKindLevel[], n: Notification): ResolvedLevel | null {
  if (levels.length === 0) return null

  // 1. Explicit kind-native level id wins.
  if (n.level !== undefined) {
    const explicit = levels.find((l) => l.id === n.level)
    if (explicit) return toResolvedLevel(explicit)
  }

  // 2. Map the ordinal onto the nearest declared non-null ordinal.
  const withOrdinal = levels.filter((l) => l.ordinal !== null)
  if (withOrdinal.length === 0) {
    // Qualitative-only kind (e.g. Telegram) — fall back to the first level.
    return toResolvedLevel(levels[0]!)
  }
  const priority = n.priority
  const sorted = [...withOrdinal].sort((a, b) => {
    const da = Math.abs((a.ordinal ?? 0) - priority)
    const db = Math.abs((b.ordinal ?? 0) - priority)
    if (da !== db) return da - db
    // Tie-break to the higher (more severe) ordinal.
    return (b.ordinal ?? 0) - (a.ordinal ?? 0)
  })
  return toResolvedLevel(sorted[0]!)
}

function splitBody(body: string, maxLen: number): string[] {
  // A non-positive OR absent cap means "no cap". `bodyMaxLen` is a required
  // positive int in the schema, but caps reach this engine through a cap call
  // that skips the Zod parse (the same path that delivered an undefined
  // `format` and threw for a day, 2026-07-30) — and the bare `i += undefined`
  // below silently yields an EMPTY body, i.e. a notification with no text.
  if (!Number.isFinite(maxLen) || maxLen <= 0 || body.length <= maxLen) return [body]
  const parts: string[] = []
  for (let i = 0; i < body.length; i += maxLen) parts.push(body.slice(i, i + maxLen))
  return parts
}

/**
 * Prepare a canonical notification for one kind. Never throws — degradation is
 * always reported in `renderedAs`, never surfaced as an error.
 */
export function prepareNotification(caps: TargetKindCaps, n: Notification): PreparedNotification {
  const dropped: string[] = []

  // ── Format ──────────────────────────────────────────────────────
  const sourceFormat = n.format
  const format = resolveFormat(sourceFormat, caps.format)
  if (format !== sourceFormat) dropped.push('format')
  const transcoded = transcodeBody(n.body, sourceFormat, format)

  // ── Level ───────────────────────────────────────────────────────
  const level = resolveLevel(caps.levels, n)

  // ── Attachments ─────────────────────────────────────────────────
  const inAttachments = n.attachments ?? []
  const attachments: PreparedAttachment[] = []
  for (const att of inAttachments) {
    if (!caps.attachments.mediaTypes.includes(att.mediaType)) {
      dropped.push(`attachment:${att.mediaType}`)
      continue
    }
    // A url-mode target links attachments by URL — it cannot upload raw bytes.
    // A bytes-only attachment is therefore unsendable there: drop it (and
    // record it) so `attachmentsSent` stays honest.
    if (caps.attachments.mode === 'url' && att.url === undefined) {
      dropped.push('attachment:noUrl')
      continue
    }
    if (
      att.bytes !== undefined &&
      caps.attachments.maxBytes !== undefined &&
      att.bytes.length > caps.attachments.maxBytes
    ) {
      dropped.push('attachment:maxBytes')
      continue
    }
    if (attachments.length >= caps.attachments.max) {
      dropped.push('attachment:max')
      continue
    }
    const needsFetch =
      caps.attachments.mode === 'bytes' && att.bytes === undefined && att.url !== undefined
    attachments.push({
      mediaType: att.mediaType,
      ...(att.url !== undefined ? { url: att.url } : {}),
      ...(att.bytes !== undefined ? { bytes: att.bytes } : {}),
      ...(att.mime !== undefined ? { mime: att.mime } : {}),
      ...(att.name !== undefined ? { name: att.name } : {}),
      needsFetch,
    })
  }

  // ── Actions ─────────────────────────────────────────────────────
  const inActions = n.actions ?? []
  const kept = inActions.slice(0, Math.max(0, caps.actions))
  if (inActions.length > kept.length) dropped.push('actions')
  // The icon is stripped HERE rather than left to each adapter. An adapter
  // that receives a field it cannot render either ignores it silently (and the
  // operator never learns the icon did nothing) or invents a mapping. Dropping
  // it centrally puts `actionIcons` in `renderedAs.dropped`, which is the only
  // way the loss is ever visible.
  const iconsSupported = caps.actionIcons === true
  const droppedAnIcon = !iconsSupported && kept.some((a) => a.icon !== undefined)
  if (droppedAnIcon) dropped.push('actionIcons')
  const actions: readonly PreparedAction[] = iconsSupported
    ? kept
    : kept.map(({ icon: _icon, ...rest }) => rest)

  // ── Scalar feature gating ───────────────────────────────────────
  let clickUrl: string | null = null
  if (n.clickUrl !== undefined) {
    if (caps.clickUrl) clickUrl = n.clickUrl
    else dropped.push('clickUrl')
  }
  let sound: string | null = null
  if (n.sound !== undefined) {
    if (caps.sound) sound = n.sound
    else dropped.push('sound')
  }
  let ttl: number | null = null
  if (n.ttl !== undefined) {
    if (caps.ttl) ttl = n.ttl
    else dropped.push('ttl')
  }
  // `tag` has no cap flag — passed through (dedup/replace is adapter-side).
  const tag: string | null = n.tag ?? null

  // ── Body overflow ───────────────────────────────────────────────
  const bodyParts = splitBody(transcoded, caps.bodyMaxLen)
  const truncated = bodyParts.length > 1

  const renderedAs: RenderedAs = {
    level: level?.id ?? '',
    format,
    attachmentsSent: attachments.length,
    actionsSent: actions.length,
    truncated,
    dropped,
  }

  return {
    body: bodyParts[0] ?? '',
    ...(n.title !== undefined ? { title: n.title } : {}),
    format,
    level,
    attachments,
    actions,
    clickUrl,
    sound,
    ttl,
    tag,
    bodyParts,
    renderedAs,
  }
}
