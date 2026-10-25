/**
 * Zentik notifier adapter (matrix §1 "Zentik" row, plan task T12).
 *
 * ── docs-json findings (pulled from `https://notifier-api.zentik.app/api/docs-json`, 2026-07-03) ──
 * Endpoint:   POST `{baseUrl}/api/v1/messages` — body `CreateMessageDto`. Auth
 *             `security: [{ bearer: [] }]` (HTTP bearer, JWT). Magic-code path
 *             uses the SAME endpoint but the token moves into the body (see below).
 *
 * `CreateMessageDto` (relevant fields, verbatim names — limits per the backend
 *  class-validator decorators in `create-message.dto.ts`):
 *   - `title` (string, REQUIRED, `@MaxLength(100)`) — we ALWAYS emit a clamped,
 *     non-empty title (falls back to the body/app name), else the backend 400s.
 *   - `body` (string, optional) — no CamStack-side length cap (operator request;
 *     the historical `@MaxLength(500)` mirror was truncating alarm/AI bodies).
 *     `subtitle` (string, `@MaxLength(100)`).
 *   - `userIds` (string[], optional) — target specific users of a shared bucket
 *     (CSV or array; empty ⇒ omitted ⇒ all users).
 *   - `deliveryType` (string enum, REQUIRED): `SILENT | NORMAL | CRITICAL | NO_PUSH`.
 *   - `bucketId` (string) — "Bucket ID or name" (accepts either).
 *   - `magicCode` (string) — "Magic code for unauthenticated message creation.
 *     Alternative to bucketId + authentication." → the un-authed path: NO bearer
 *     header, `magicCode` in the body instead of `bucketId`.
 *   - `sound` (string).
 *   - `tapUrl` (string) — "If provided, will automatically set the tapAction to
 *     NAVIGATE with this URL." → we use the `tapUrl` shortcut for `clickUrl`
 *     rather than hand-building a `tapAction`.
 *   - `ephemeral` (boolean) — "When true, message is deleted automatically after
 *     1 hour by cleanup." → our only TTL lever (fixed ~1h, not a duration).
 *   - `attachments[]` = `NotificationAttachmentDto`: `{ mediaType (REQUIRED,
 *     `MediaType` enum `VIDEO | IMAGE | GIF | AUDIO | ICON | FILE`), url?, name?,
 *     mime?, attachmentUuid?, saveOnServer? }`. url-mode is what we emit.
 *     (Zentik also has `imageUrl` / `videoUrl` / `gifUrl` single-shortcuts, but
 *     the typed `attachments[]` array is the general, multi-item path.)
 *   - `actions[]` = `NotificationActionDto`: `{ type (REQUIRED,
 *     `NotificationActionType` enum `NAVIGATE | BACKGROUND_CALL | MARK_AS_READ |
 *     SNOOZE | POSTPONE | OPEN_NOTIFICATION | WEBHOOK | DELETE`), value?,
 *     destructive?, icon?, title? }`. NOTE: the button label field is `title`
 *     (NOT `label`), and the payload/target is `value` (NOT `url`). A tap-through
 *     URL button ⇒ `{ type: 'NAVIGATE', value: <url>, title: <label> }`; a plain
 *     button (no url) ⇒ `{ type: 'OPEN_NOTIFICATION', title: <label> }`.
 *   - `tapAction` (single `NotificationActionDto`) — not used (we prefer `tapUrl`).
 *
 * MARKDOWN: the spec documents NO markdown rendering for `body` → we advertise
 *           `format: ['text']` only (the degrade engine transcodes down).
 *
 * `GET {baseUrl}/api/v1/buckets` → `Bucket[]` (`{ id, name, ... }`) drives
 * discovery (one adoptable candidate per bucket).
 *
 * `buildRequest` is PURE — it never touches the network (the provider executes
 * the returned plan). Only `discover` performs I/O.
 */
import type {
  AttachmentMediaType,
  ConfigUISchema,
  DiscoveredTarget,
  NotificationActionIcon,
  PreparedNotification,
  TargetKind,
} from '@camstack/types'
import type { HttpRequestPlan, HttpNotifierAdapter, TargetConfig } from './adapter.js'

const DEFAULT_BASE_URL = 'https://notifier-api.zentik.app'
const MESSAGES_PATH = '/api/v1/messages'
const BUCKETS_PATH = '/api/v1/buckets'

/** Zentik `deliveryType` enum — mirrors our declared level ids 1:1. */
const DEFAULT_DELIVERY_TYPE = 'NORMAL'

/**
 * Backend `CreateMessageDto` title is REQUIRED and `@MaxLength(100)`.
 * Body has no CamStack truncate — model "no cap" like webhook (positive int).
 */
const TITLE_MAX_LEN = 100
/** Positive int required by caps; large enough that degrade never truncates. */
const NO_BODY_CAP = 1_000_000

/** Non-empty fallback title when a notification carries no title. */
const FALLBACK_TITLE = 'CamStack'

/** url-mode attachment ceiling (no hard doc limit; matrix §5 → 5). */
const MAX_ATTACHMENTS = 5

/** Push action-button ceiling (not doc-specified; typical push-surface limit). */
const MAX_ACTIONS = 4

/** Canonical media type → Zentik `MediaType` enum value. */
const MEDIA_TYPE: Readonly<Record<AttachmentMediaType, string>> = {
  image: 'IMAGE',
  video: 'VIDEO',
  gif: 'GIF',
  audio: 'AUDIO',
  icon: 'ICON',
}

// ── Config readers (config is untrusted Readonly<Record<string, unknown>>) ──

function readString(config: TargetConfig, key: string): string | undefined {
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** `'magicCode'` when explicitly selected, else the default `'accessToken'`. */
function authModeFrom(config: TargetConfig): 'accessToken' | 'magicCode' {
  return readString(config, 'authMode') === 'magicCode' ? 'magicCode' : 'accessToken'
}

function baseUrlFrom(config: TargetConfig): string {
  const raw = readString(config, 'baseUrl') ?? DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '')
}

// ── Field mapping ─────────────────────────────────────────────────────

/** The resolved level id IS the native `deliveryType`; fall back to config default. */
function deliveryType(config: TargetConfig, prepared: PreparedNotification): string {
  return prepared.level?.id ?? readString(config, 'defaultDeliveryType') ?? DEFAULT_DELIVERY_TYPE
}

/**
 * `title` is a REQUIRED, `@MaxLength(100)` backend field — always emit a
 * non-empty, clamped value: the notification title if present, else the body
 * (first 100 chars), else the app-name constant.
 */
function titleFor(prepared: PreparedNotification): string {
  const raw =
    prepared.title !== undefined && prepared.title.length > 0
      ? prepared.title
      : prepared.body.length > 0
        ? prepared.body
        : FALLBACK_TITLE
  return raw.slice(0, TITLE_MAX_LEN)
}

/**
 * Optional targeting of specific users of a shared bucket (backend `userIds`,
 * CSV or array of ids/usernames). Empty → omitted (backend defaults to all
 * users).
 */
function userIdsFrom(config: TargetConfig): readonly string[] {
  const raw = config['userIds']
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return []
}

/**
 * Canonical icon token → the string Zentik's client actually renders.
 *
 * ── EVIDENCE (read from the Zentik sources, not guessed) ────────────
 * `NotificationActionDto.icon` is `@IsOptional() @IsString()` — the BACKEND
 * validates nothing, so a wrong value is accepted, stored and delivered. The
 * rendering happens on the client, and both iOS paths do the same thing
 * (`ZentikNotificationService/NotificationService.swift`,
 * `ZentikNotificationContentExtension/NotificationViewController.swift`):
 *
 *     let actualIconName = iconName.hasPrefix("sfsymbols:")
 *       ? String(iconName.dropFirst("sfsymbols:".count)) : iconName
 *     icon = UNNotificationActionIcon(systemImageName: actualIconName)
 *
 * So the value is an **SF Symbol name**, with an optional `sfsymbols:` prefix
 * that is stripped. Zentik's own UI confirms the convention: its icon field
 * placeholder is "e.g., house.fill, heart, gear" and its picker writes
 * `sfsymbols:${iconName}`.
 *
 * `UNNotificationActionIcon(systemImageName:)` with a name iOS does not know
 * renders NOTHING — silently. That is the whole failure: we sent `silence`,
 * `arm` and `disarm`, none of which are SF Symbols, and every button arrived
 * blank with nothing anywhere saying why.
 *
 * The prefix is emitted explicitly even though bare names work, because the
 * bare form is indistinguishable from an un-translated intent token in a
 * captured payload — and telling those two apart is what cost the time.
 *
 * A `Record` over the closed enum, NOT a lookup with a fallback: adding a
 * vocabulary member without deciding its glyph fails the build here.
 *
 * Android: Zentik's Android client does not render per-action icons at all
 * (an Android notification action needs a bundled drawable, not a name), so
 * this is an iOS/watchOS enrichment and a no-op elsewhere — which is a
 * cosmetic loss, not a wrong glyph.
 */
const ZENTIK_ACTION_ICONS: Record<NotificationActionIcon, string> = {
  acknowledge: 'checkmark.circle',
  dismiss: 'xmark.circle',
  silence: 'bell.slash',
  // `zzz` IS the snooze glyph on Apple platforms, and it reads at button size
  // where a clock face does not.
  snooze: 'zzz',
  view: 'eye',
  play: 'play.fill',
  open: 'door.left.hand.open',
  close: 'door.left.hand.closed',
  lock: 'lock.fill',
  unlock: 'lock.open.fill',
  arm: 'shield.fill',
  'arm-home': 'house.fill',
  'arm-away': 'figure.walk',
  'arm-night': 'moon.fill',
  disarm: 'shield.slash.fill',
  light: 'lightbulb.fill',
  alert: 'exclamationmark.triangle.fill',
  camera: 'video.fill',
}

/** The `sfsymbols:` prefix Zentik's clients strip before resolving the symbol. */
const SFSYMBOLS_PREFIX = 'sfsymbols:'

/**
 * The Zentik value for one icon token, or `undefined` when there is none.
 *
 * Typed on `string`, not on `NotificationActionIcon`, because that is what this
 * boundary actually receives: an addon deployed against a hub whose vocabulary
 * moved on hands over a token this build has never heard of. Omitting it is the
 * honest answer — forwarding it raw would put a string iOS ignores on the wire
 * and produce exactly the blank button this map exists to fix.
 *
 * `Object.hasOwn` and not a truthiness check: an inherited `toString` must not
 * read as a mapping.
 */
export function zentikActionIcon(icon: string): string | undefined {
  const table: Readonly<Record<string, string | undefined>> = ZENTIK_ACTION_ICONS
  if (!Object.hasOwn(ZENTIK_ACTION_ICONS, icon)) return undefined
  const symbol = table[icon]
  return symbol === undefined ? undefined : `${SFSYMBOLS_PREFIX}${symbol}`
}

/** One Zentik notification action (label lives in `title`, target in `value`). */
interface ZentikAction {
  readonly type: string
  readonly title: string
  readonly value?: string
  readonly destructive?: boolean
  readonly icon?: string
}

/**
 * How a `BACKGROUND_CALL` names its request: `METHOD::url`.
 *
 * The whole reason the type exists here: a "silence this for 30 minutes"
 * button that opens a browser tab has already cost more attention than the
 * notification it was dismissing. `BACKGROUND_CALL` fires the callback and
 * leaves the phone where it is.
 */
const BACKGROUND_CALL_PREFIX = 'POST::'

function actionsFor(prepared: PreparedNotification): readonly ZentikAction[] {
  const out: ZentikAction[] = []
  for (const action of prepared.actions.slice(0, MAX_ACTIONS)) {
    // `destructive` and `icon` are documented `NotificationActionDto` fields.
    // The icon is TRANSLATED, never forwarded: see `ZENTIK_ACTION_ICONS` for
    // why an intent token on this wire is a blank button.
    const symbol = action.icon === undefined ? undefined : zentikActionIcon(action.icon)
    const decoration = {
      ...(action.destructive !== undefined ? { destructive: action.destructive } : {}),
      ...(symbol !== undefined ? { icon: symbol } : {}),
    }
    if (action.url === undefined || action.url.length === 0) {
      out.push({ type: 'OPEN_NOTIFICATION', title: action.label, ...decoration })
      continue
    }
    if (action.mode === 'background') {
      out.push({
        type: 'BACKGROUND_CALL',
        title: action.label,
        value: `${BACKGROUND_CALL_PREFIX}${action.url}`,
        ...decoration,
      })
      continue
    }
    out.push({ type: 'NAVIGATE', title: action.label, value: action.url, ...decoration })
  }
  return out
}

interface ZentikAttachment {
  readonly mediaType: string
  readonly url: string
  readonly name?: string
  readonly mime?: string
}

function attachmentsFor(prepared: PreparedNotification): readonly ZentikAttachment[] {
  const out: ZentikAttachment[] = []
  for (const att of prepared.attachments.slice(0, MAX_ATTACHMENTS)) {
    if (att.url === undefined || att.url.length === 0) continue
    out.push({
      mediaType: MEDIA_TYPE[att.mediaType],
      url: att.url,
      ...(att.name !== undefined ? { name: att.name } : {}),
      ...(att.mime !== undefined ? { mime: att.mime } : {}),
    })
  }
  return out
}

// ── Descriptor ────────────────────────────────────────────────────────

function zentikConfigSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        titleKey: 'notifiers:zentikConfig.s_connection.title',
        tab: 'notifications',
        fields: [
          {
            type: 'text',
            key: 'baseUrl',
            label: 'Server URL',
            labelKey: 'notifiers:zentikConfig.s_connection.baseUrl.label',
            inputType: 'url',
            default: DEFAULT_BASE_URL,
            placeholder: DEFAULT_BASE_URL,
            description: 'Zentik API base URL. Change only for a self-hosted instance.',
            descriptionKey: 'notifiers:zentikConfig.s_connection.baseUrl.description',
          },
          {
            type: 'select',
            key: 'authMode',
            label: 'Authentication',
            labelKey: 'notifiers:zentikConfig.s_connection.authMode.label',
            default: 'accessToken',
            options: [
              {
                value: 'accessToken',
                label: 'Access token + bucket',
                labelKey: 'notifiers:zentikConfig.s_connection.authMode.o_accessToken.label',
              },
              {
                value: 'magicCode',
                label: 'Magic code (no login)',
                labelKey: 'notifiers:zentikConfig.s_connection.authMode.o_magicCode.label',
              },
            ],
          },
          {
            type: 'password',
            key: 'accessToken',
            label: 'Access token',
            labelKey: 'notifiers:zentikConfig.s_connection.accessToken.label',
            description: 'Personal access token (sent as a Bearer token).',
            descriptionKey: 'notifiers:zentikConfig.s_connection.accessToken.description',
            showToggle: true,
            showWhen: { field: 'authMode', equals: 'accessToken' },
          },
          {
            type: 'text',
            key: 'bucketId',
            label: 'Bucket ID or name',
            labelKey: 'notifiers:zentikConfig.s_connection.bucketId.label',
            description: 'Target bucket. Accepts a bucket id or its name.',
            descriptionKey: 'notifiers:zentikConfig.s_connection.bucketId.description',
            showWhen: { field: 'authMode', equals: 'accessToken' },
          },
          {
            type: 'password',
            key: 'magicCode',
            label: 'Magic code',
            labelKey: 'notifiers:zentikConfig.s_connection.magicCode.label',
            description:
              "A bucket's magic code — publishes without a login. Alternative to token + bucket.",
            descriptionKey: 'notifiers:zentikConfig.s_connection.magicCode.description',
            showToggle: true,
            showWhen: { field: 'authMode', equals: 'magicCode' },
          },
          {
            type: 'text',
            key: 'userIds',
            label: 'User IDs (or usernames)',
            labelKey: 'notifiers:zentikConfig.s_connection.userIds.label',
            description:
              'Optional. If the bucket is shared, target specific users (comma-separated ids or usernames). Leave blank to deliver to all users.',
            descriptionKey: 'notifiers:zentikConfig.s_connection.userIds.description',
          },
        ],
      },
      {
        id: 'defaults',
        title: 'Defaults',
        titleKey: 'notifiers:zentikConfig.s_defaults.title',
        tab: 'notifications',
        fields: [
          {
            type: 'select',
            key: 'defaultDeliveryType',
            label: 'Default delivery type',
            labelKey: 'notifiers:zentikConfig.s_defaults.defaultDeliveryType.label',
            default: DEFAULT_DELIVERY_TYPE,
            description: 'Used when a notification does not resolve to a specific level.',
            descriptionKey: 'notifiers:zentikConfig.s_defaults.defaultDeliveryType.description',
            options: [
              {
                value: 'SILENT',
                label: 'Silent',
                labelKey: 'notifiers:zentikConfig.s_defaults.defaultDeliveryType.o_SILENT.label',
              },
              {
                value: 'NORMAL',
                label: 'Normal',
                labelKey: 'notifiers:zentikConfig.s_defaults.defaultDeliveryType.o_NORMAL.label',
              },
              {
                value: 'CRITICAL',
                label: 'Critical',
                labelKey: 'notifiers:zentikConfig.s_defaults.defaultDeliveryType.o_CRITICAL.label',
              },
              {
                value: 'NO_PUSH',
                label: 'No push (in-app only)',
                labelKey: 'notifiers:zentikConfig.s_defaults.defaultDeliveryType.o_NO_PUSH.label',
              },
            ],
          },
        ],
      },
    ],
  }
}

const zentikDescriptor: TargetKind = {
  kind: 'zentik',
  label: 'Zentik',
  icon: 'bell-ring',
  // Stamped by the provider on `listTargetKinds`; a placeholder keeps the
  // descriptor a complete `TargetKind` at rest.
  addonId: 'notifiers',
  configSchema: zentikConfigSchema(),
  supportsDiscovery: true,
  caps: {
    attachments: {
      mediaTypes: ['image', 'video', 'gif', 'audio', 'icon'],
      mode: 'url',
      max: MAX_ATTACHMENTS,
    },
    actions: MAX_ACTIONS,
    levels: [
      {
        id: 'SILENT',
        label: 'Silent',
        ordinal: 1,
        flags: { silent: true },
        description: 'Delivered without sound/vibration.',
      },
      { id: 'NORMAL', label: 'Normal', ordinal: 3, description: 'Default push priority.' },
      {
        id: 'CRITICAL',
        label: 'Critical',
        ordinal: 5,
        flags: { critical: true },
        description: 'Breaks through Focus / Do Not Disturb.',
      },
      {
        id: 'NO_PUSH',
        label: 'No push',
        ordinal: null,
        flags: { noPush: true },
        description: 'Stored in-app only; no push is sent. Select explicitly via `level`.',
      },
    ],
    // The spec documents no markdown rendering for `body` → text only.
    format: ['text'],
    clickUrl: true,
    /**
     * A RENDERING claim, which it was not before.
     *
     * This used to say the intent name "travels verbatim … a name the app does
     * not know renders as no icon rather than as a wrong one" — true, and it
     * described a feature that never once drew an icon, because NO intent name
     * is an SF Symbol. The engine handed the icon over and the adapter put it
     * on the wire untranslated. `ZENTIK_ACTION_ICONS` is what makes this claim
     * honest; keep it exhaustive or this reverts to a pass-through that lies.
     */
    actionIcons: true,
    sound: true,
    // `ephemeral` is Zentik's only TTL lever: a fixed ~1h auto-cleanup, not a
    // configurable duration. We flip it on whenever a canonical `ttl` is set.
    ttl: true,
    // No CamStack body truncate (webhook precedent: large positive int).
    bodyMaxLen: NO_BODY_CAP,
  },
}

// ── Adapter ───────────────────────────────────────────────────────────

export const zentikAdapter: HttpNotifierAdapter = {
  descriptor: zentikDescriptor,
  destinationKeys: ['baseUrl', 'bucketId', 'userIds'],
  // The text field shows `userIds` as CSV; it is stored either way.
  normalizeDestination: (key, value) =>
    key === 'userIds' ? userIdsFrom({ userIds: value }).join(',') : value,

  buildRequest(config, prepared): HttpRequestPlan {
    const baseUrl = baseUrlFrom(config)
    const authMode = authModeFrom(config)

    const body: Record<string, unknown> = {
      // `title` is a required backend field — always emit a clamped, non-empty value.
      title: titleFor(prepared),
      body: prepared.body,
      deliveryType: deliveryType(config, prepared),
    }

    const userIds = userIdsFrom(config)
    if (userIds.length > 0) body.userIds = userIds

    const headers: Record<string, string> = {}
    if (authMode === 'magicCode') {
      // Un-authenticated path: the magic code carries both auth + bucket routing.
      const magicCode = readString(config, 'magicCode')
      if (magicCode !== undefined) body.magicCode = magicCode
    } else {
      // Access-token path: Bearer header + explicit bucket.
      const accessToken = readString(config, 'accessToken')
      if (accessToken !== undefined) headers.authorization = `Bearer ${accessToken}`
      const bucketId = readString(config, 'bucketId')
      if (bucketId !== undefined) body.bucketId = bucketId
    }

    const attachments = attachmentsFor(prepared)
    if (attachments.length > 0) body.attachments = attachments

    if (prepared.clickUrl !== null) body.tapUrl = prepared.clickUrl
    if (prepared.sound !== null) body.sound = prepared.sound
    // TTL → ephemeral (fixed ~1h auto-cleanup).
    if (prepared.ttl !== null) body.ephemeral = true

    const actions = actionsFor(prepared)
    if (actions.length > 0) body.actions = actions

    return {
      url: `${baseUrl}${MESSAGES_PATH}`,
      method: 'POST',
      headers,
      body: { kind: 'json', value: body },
    }
  },

  async discover(config): Promise<readonly DiscoveredTarget[]> {
    // Only the access-token path can enumerate buckets (magic code is scoped to
    // a single bucket). No token → nothing to surface.
    const accessToken = readString(config, 'accessToken')
    if (accessToken === undefined) return []

    try {
      const res = await fetch(`${baseUrlFrom(config)}${BUCKETS_PATH}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) return []
      const json: unknown = await res.json()
      if (!Array.isArray(json)) return []
      const out: DiscoveredTarget[] = []
      for (const entry of json) {
        if (typeof entry !== 'object' || entry === null) continue
        const bucket = entry as { id?: unknown; name?: unknown }
        if (typeof bucket.id !== 'string' || bucket.id.length === 0) continue
        const name =
          typeof bucket.name === 'string' && bucket.name.length > 0 ? bucket.name : bucket.id
        out.push({
          kind: 'zentik',
          suggestedName: `Zentik — ${name}`,
          config: { authMode: 'accessToken', bucketId: bucket.id },
        })
      }
      return out
    } catch {
      return []
    }
  },
}
