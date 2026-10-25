/**
 * Generic webhook notifier adapter — the reference / escape-hatch kind.
 *
 * It forwards the canonical notification to any HTTP endpoint with minimal
 * transformation: `buildRequest` emits the prepared notification as a single
 * JSON body (`title/body/format/priority/level/attachments/clickUrl/actions/
 * sound/ttl/tag`) plus any operator-configured static headers. Because it
 * mutates almost nothing, its capability descriptor is fully permissive — this
 * is the adapter every other adapter's tests are modelled on.
 *
 * Attachment contract: URL-only. There is no upload negotiation here, so the
 * caps declare `attachments.mode:'url'` and `buildRequest` drops any byte-only
 * attachment from the emitted payload (see the seam note on `urlAttachments`).
 */
import type {
  ConfigUISchema,
  NotificationFormat,
  PreparedAction,
  PreparedAttachment,
  PreparedNotification,
  TargetKind,
  TargetKindCaps,
} from '@camstack/types'
import type { HttpRequestPlan, HttpNotifierAdapter, TargetConfig } from './adapter.js'

/** The `kind` discriminator for the generic webhook. */
export const WEBHOOK_KIND = 'webhook'

/**
 * `bodyMaxLen` must be a positive int, so "no cap" is modelled as a large
 * sentinel — well beyond any realistic notification body, so the engine never
 * splits/truncates for this kind.
 */
const NO_BODY_CAP = 1_000_000

/** Everything permissive — the webhook forwards whatever the engine keeps. */
const WEBHOOK_CAPS: TargetKindCaps = {
  attachments: {
    mediaTypes: ['image', 'video', 'gif', 'audio', 'icon'],
    // URL-only: no upload contract. Byte-only attachments are dropped by
    // `buildRequest` (the engine still counts them in `renderedAs` — a webhook
    // cannot re-write that report from the pure `buildRequest` seam).
    mode: 'url',
    max: 99,
  },
  actions: 99,
  // A webhook forwards `actions` verbatim as JSON, so the icon reaches the
  // consumer intact and it is theirs to render. The only kind that can say
  // this honestly today.
  actionIcons: true,
  // Five plain ordinals — a straight 1..5 canonical-priority passthrough.
  levels: [
    { id: 'p1', label: 'P1', ordinal: 1 },
    { id: 'p2', label: 'P2', ordinal: 2 },
    { id: 'p3', label: 'P3', ordinal: 3 },
    { id: 'p4', label: 'P4', ordinal: 4 },
    { id: 'p5', label: 'P5', ordinal: 5 },
  ],
  format: ['text', 'markdown', 'html'],
  clickUrl: true,
  sound: true,
  ttl: true,
  bodyMaxLen: NO_BODY_CAP,
}

/** The admin FormBuilder tree for a webhook target: `url`, `method`, `headers`. */
function webhookConfigSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'webhook',
        title: 'Webhook',
        titleKey: 'notifiers:webhookConfig.s_webhook.title',
        tab: 'notifications',
        fields: [
          {
            // A PASSWORD, not a text field: a Home Assistant webhook id, a
            // Slack-style incoming-webhook path or a `?token=` query is a
            // credential, and a text field is returned verbatim by
            // `listTargets`. Redacted on read like any other secret; an editor
            // that leaves it untouched keeps the stored one.
            type: 'password',
            key: 'url',
            label: 'Endpoint URL',
            labelKey: 'notifiers:webhookConfig.s_webhook.url.label',
            showToggle: true,
            description:
              'HTTP(S) endpoint the canonical notification JSON is POSTed to. Treated as a secret: many webhook URLs carry their token in the path or query.',
            descriptionKey: 'notifiers:webhookConfig.s_webhook.url.description',
          },
          {
            type: 'select',
            key: 'method',
            label: 'HTTP method',
            labelKey: 'notifiers:webhookConfig.s_webhook.method.label',
            options: [
              {
                value: 'POST',
                label: 'POST',
                labelKey: 'notifiers:webhookConfig.s_webhook.method.o_POST.label',
              },
              {
                value: 'PUT',
                label: 'PUT',
                labelKey: 'notifiers:webhookConfig.s_webhook.method.o_PUT.label',
              },
              {
                value: 'PATCH',
                label: 'PATCH',
                labelKey: 'notifiers:webhookConfig.s_webhook.method.o_PATCH.label',
              },
            ],
            description: 'Defaults to POST.',
            descriptionKey: 'notifiers:webhookConfig.s_webhook.method.description',
          },
          {
            type: 'editable-array',
            key: 'headers',
            label: 'Static headers',
            labelKey: 'notifiers:webhookConfig.s_webhook.headers.label',
            description:
              'Sent verbatim on every request. Values are treated as secrets (e.g. an Authorization bearer token).',
            descriptionKey: 'notifiers:webhookConfig.s_webhook.headers.description',
            itemFields: [
              {
                type: 'text',
                key: 'name',
                label: 'Header',
                labelKey: 'notifiers:webhookConfig.s_webhook.headers.name.label',
              },
              {
                type: 'password',
                key: 'value',
                label: 'Value',
                labelKey: 'notifiers:webhookConfig.s_webhook.headers.value.label',
                showToggle: true,
              },
            ],
          },
        ],
      },
    ],
  }
}

/** The kind descriptor. `addonId` is re-stamped by the provider's catalog fan-out. */
export const webhookDescriptor: TargetKind = {
  kind: WEBHOOK_KIND,
  label: 'Webhook',
  icon: 'webhook',
  addonId: 'notifiers',
  configSchema: webhookConfigSchema(),
  supportsDiscovery: false,
  caps: WEBHOOK_CAPS,
}

// ── Payload shape (canonical notification, verbatim) ─────────────────

interface WebhookAttachment {
  readonly mediaType: PreparedAttachment['mediaType']
  readonly url: string
  readonly mime?: string
  readonly name?: string
}

interface WebhookPayload {
  readonly title?: string
  readonly body: string
  readonly format: NotificationFormat
  /** Canonical 1..5 ordinal (from the resolved level). `null` when unresolved. */
  readonly priority: number | null
  /** Kind-native level id (`p1`..`p5`). `null` when unresolved. */
  readonly level: string | null
  readonly attachments: readonly WebhookAttachment[]
  readonly clickUrl: string | null
  readonly actions: readonly PreparedAction[]
  readonly sound: string | null
  readonly ttl: number | null
  readonly tag: string | null
}

/**
 * URL-only attachments. Byte-only attachments (no `url`) have no upload
 * contract on a generic webhook, so they are dropped from the payload.
 */
function urlAttachments(attachments: readonly PreparedAttachment[]): WebhookAttachment[] {
  const out: WebhookAttachment[] = []
  for (const att of attachments) {
    if (att.url === undefined) continue
    out.push({
      mediaType: att.mediaType,
      url: att.url,
      ...(att.mime !== undefined ? { mime: att.mime } : {}),
      ...(att.name !== undefined ? { name: att.name } : {}),
    })
  }
  return out
}

function toPayload(prepared: PreparedNotification): WebhookPayload {
  return {
    ...(prepared.title !== undefined ? { title: prepared.title } : {}),
    body: prepared.body,
    format: prepared.format,
    priority: prepared.level?.ordinal ?? null,
    level: prepared.level?.id ?? null,
    attachments: urlAttachments(prepared.attachments),
    clickUrl: prepared.clickUrl,
    actions: prepared.actions,
    sound: prepared.sound,
    ttl: prepared.ttl,
    tag: prepared.tag,
  }
}

// ── Config extraction (defensive — config is an untyped blob) ────────

function readUrl(config: TargetConfig): string {
  const url = config.url
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('webhook target is missing a `url`')
  }
  return url
}

function readMethod(config: TargetConfig): string {
  const method = config.method
  return typeof method === 'string' && method.trim() !== '' ? method : 'POST'
}

/** Parse one `{ name, value }` header row; returns `null` when malformed. */
function parseHeader(entry: unknown): readonly [string, string] | null {
  if (typeof entry !== 'object' || entry === null) return null
  if (!('name' in entry) || !('value' in entry)) return null
  const name = entry.name
  const value = entry.value
  if (typeof name !== 'string' || name.trim() === '') return null
  if (typeof value !== 'string') return null
  return [name, value]
}

function readHeaders(config: TargetConfig): Record<string, string> {
  const raw = config.headers
  if (!Array.isArray(raw)) return {}
  const headers: Record<string, string> = {}
  for (const entry of raw) {
    const parsed = parseHeader(entry)
    if (parsed) headers[parsed[0]] = parsed[1]
  }
  return headers
}

function buildRequest(config: TargetConfig, prepared: PreparedNotification): HttpRequestPlan {
  const headers = readHeaders(config)
  return {
    url: readUrl(config),
    method: readMethod(config),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    body: { kind: 'json', value: toPayload(prepared) },
  }
}

/** The generic webhook adapter — descriptor + pure `buildRequest`, no discovery. */
export const webhookAdapter: HttpNotifierAdapter = {
  descriptor: webhookDescriptor,
  // `url` is a password field too: redacted it counts as unchanged, re-typed
  // it must not carry the stored header secrets along.
  destinationKeys: ['url'],
  buildRequest,
}
