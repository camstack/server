/**
 * ntfy notifier adapter (matrix §1 "ntfy" row).
 *
 * Publishes over ntfy's HTTP API. The primary path is a JSON POST to the
 * server root with `topic` in the body — this avoids header value encoding for
 * title / tags / actions and lets us pass an `attach` URL and inline `actions`
 * cleanly. When the (single) attachment arrives as bytes with no URL we fall
 * back to a raw `PUT {server}/{topic}` upload, moving every field into the
 * `X-*` headers (the only shape ntfy accepts for a binary body).
 *
 * Capabilities (see descriptor.caps):
 *   - attachments: image | icon, url OR bytes (mode 'both'), max 1. `icon`
 *     maps to ntfy's notification icon; `image` to the `attach` URL.
 *   - actions: up to 3 `view` buttons (label + url).
 *   - levels: min/low/default/high/max → native priority 1..5 (max = critical).
 *   - format: text or markdown (`markdown: true` / `X-Markdown`).
 *   - clickUrl: yes. sound: no. ttl: no (ntfy only exposes `X-Cache: no`, not
 *     a real TTL field — declared false, see descriptor description).
 *
 * `buildRequest` is PURE — it never touches the network (the provider executes
 * the returned plan).
 */
import type {
  ConfigUISchema,
  PreparedAttachment,
  PreparedNotification,
  TargetKind,
} from '@camstack/types'
import type { HttpRequestPlan, HttpNotifierAdapter, TargetConfig } from './adapter.js'

const DEFAULT_SERVER_URL = 'https://ntfy.sh'
const MAX_ACTIONS = 3

/**
 * One ntfy action button.
 *
 * `view` OPENS the url; `http` fires a request and leaves the notification
 * where it is. A "silence this for 30 minutes" button belongs in the second
 * family — being thrown into a browser to confirm a dismissal costs more
 * attention than the notification did.
 *
 * `clear: true` on the http action dismisses the notification after the call,
 * which is what an operator means by tapping it.
 */
interface NtfyAction {
  readonly action: 'view' | 'http'
  readonly label: string
  readonly url: string
  readonly method?: string
  readonly clear?: boolean
}

// ── Config readers (config is untrusted Record<string, unknown>) ─────

function readString(config: TargetConfig, key: string): string | undefined {
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Tags accept a stored string[] or a comma-separated string. */
function readTags(config: TargetConfig): readonly string[] {
  const value = config['tags']
  if (Array.isArray(value)) {
    return value.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
  }
  return []
}

function serverUrlFrom(config: TargetConfig): string {
  const raw = readString(config, 'serverUrl') ?? DEFAULT_SERVER_URL
  return raw.replace(/\/+$/, '')
}

/** Bearer token wins; else HTTP Basic from user/pass; else no auth. */
function authHeaders(config: TargetConfig): Readonly<Record<string, string>> {
  const token = readString(config, 'token')
  if (token !== undefined) {
    return { authorization: `Bearer ${token}` }
  }
  const user = readString(config, 'user')
  const pass = readString(config, 'pass')
  if (user !== undefined || pass !== undefined) {
    const encoded = Buffer.from(`${user ?? ''}:${pass ?? ''}`, 'utf8').toString('base64')
    return { authorization: `Basic ${encoded}` }
  }
  return {}
}

// ── Shared field mapping ─────────────────────────────────────────────

/** ntfy native priority is 1..5, matching our level ordinals; default 3. */
function nativePriority(prepared: PreparedNotification): number {
  return prepared.level?.ordinal ?? 3
}

function viewActions(prepared: PreparedNotification): readonly NtfyAction[] {
  const out: NtfyAction[] = []
  for (const action of prepared.actions.slice(0, MAX_ACTIONS)) {
    if (action.url === undefined || action.url.length === 0) continue
    if (action.mode === 'background') {
      out.push({
        action: 'http',
        label: action.label,
        url: action.url,
        method: 'POST',
        clear: true,
      })
      continue
    }
    out.push({ action: 'view', label: action.label, url: action.url })
  }
  return out
}

/** The single attachment (caps.max = 1), if any. */
function firstAttachment(prepared: PreparedNotification): PreparedAttachment | undefined {
  return prepared.attachments[0]
}

// ── Request builders ─────────────────────────────────────────────────

/** Default path: JSON POST to `{serverUrl}` with `topic` in the body. */
function buildJsonRequest(config: TargetConfig, prepared: PreparedNotification): HttpRequestPlan {
  const serverUrl = serverUrlFrom(config)
  const topic = readString(config, 'topic') ?? ''
  const tags = readTags(config)
  const actions = viewActions(prepared)
  const attachment = firstAttachment(prepared)

  const body: Record<string, unknown> = {
    topic,
    message: prepared.body,
    priority: nativePriority(prepared),
  }
  if (prepared.title !== undefined) body.title = prepared.title
  if (prepared.format === 'markdown') body.markdown = true
  if (tags.length > 0) body.tags = tags
  if (prepared.clickUrl !== null) body.click = prepared.clickUrl
  if (attachment?.url !== undefined) {
    if (attachment.mediaType === 'icon') body.icon = attachment.url
    else body.attach = attachment.url
  }
  if (actions.length > 0) body.actions = actions

  return {
    url: serverUrl,
    method: 'POST',
    headers: authHeaders(config),
    body: { kind: 'json', value: body },
  }
}

/**
 * Bytes-upload path: raw `PUT {serverUrl}/{topic}` with the attachment bytes as
 * the body and every field moved into `X-*` headers (ntfy's binary-body shape).
 */
function buildUploadRequest(
  config: TargetConfig,
  prepared: PreparedNotification,
  attachment: PreparedAttachment,
): HttpRequestPlan {
  const serverUrl = serverUrlFrom(config)
  const topic = readString(config, 'topic') ?? ''
  const tags = readTags(config)
  const actions = viewActions(prepared)

  const headers: Record<string, string> = {
    ...authHeaders(config),
    'x-priority': String(nativePriority(prepared)),
  }
  if (prepared.title !== undefined) headers['x-title'] = prepared.title
  if (prepared.body.length > 0) headers['x-message'] = prepared.body
  if (prepared.format === 'markdown') headers['x-markdown'] = 'true'
  if (tags.length > 0) headers['x-tags'] = tags.join(',')
  if (prepared.clickUrl !== null) headers['x-click'] = prepared.clickUrl
  if (attachment.name !== undefined) headers['x-filename'] = attachment.name
  if (actions.length > 0) {
    // The header form is `action, label, url[, extras]` — the ACTION word is
    // per button, not a constant: emitting `view` for an http action would
    // turn every background button into one that opens a browser, on exactly
    // the path (bytes upload) where nobody would notice.
    headers['x-actions'] = actions
      .map((a) =>
        a.action === 'http'
          ? `http, ${a.label}, ${a.url}, method=POST, clear=true`
          : `view, ${a.label}, ${a.url}`,
      )
      .join('; ')
  }

  return {
    url: `${serverUrl}/${topic}`,
    method: 'PUT',
    headers,
    body: {
      kind: 'raw',
      value: attachment.bytes ?? new Uint8Array(0),
      ...(attachment.mime !== undefined ? { contentType: attachment.mime } : {}),
    },
  }
}

// ── Descriptor ───────────────────────────────────────────────────────

function ntfyConfigSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        titleKey: 'notifiers:ntfyConfig.s_connection.title',
        fields: [
          {
            type: 'text',
            key: 'serverUrl',
            label: 'Server URL',
            labelKey: 'notifiers:ntfyConfig.s_connection.serverUrl.label',
            inputType: 'url',
            default: DEFAULT_SERVER_URL,
            placeholder: DEFAULT_SERVER_URL,
          },
          {
            type: 'password',
            key: 'topic',
            label: 'Topic',
            labelKey: 'notifiers:ntfyConfig.s_connection.topic.label',
            required: true,
            description:
              'The ntfy topic to publish to. Treat as a secret — anyone with it can post.',
            descriptionKey: 'notifiers:ntfyConfig.s_connection.topic.description',
          },
          {
            type: 'password',
            key: 'token',
            label: 'Access token',
            labelKey: 'notifiers:ntfyConfig.s_connection.token.label',
            description: 'Bearer token (tk_…). Takes precedence over username/password.',
            descriptionKey: 'notifiers:ntfyConfig.s_connection.token.description',
          },
          {
            type: 'password',
            key: 'user',
            label: 'Username',
            labelKey: 'notifiers:ntfyConfig.s_connection.user.label',
            description: 'HTTP Basic auth username (used when no access token is set).',
            descriptionKey: 'notifiers:ntfyConfig.s_connection.user.description',
          },
          {
            type: 'password',
            key: 'pass',
            label: 'Password',
            labelKey: 'notifiers:ntfyConfig.s_connection.pass.label',
            description: 'HTTP Basic auth password.',
            descriptionKey: 'notifiers:ntfyConfig.s_connection.pass.description',
          },
        ],
      },
      {
        id: 'defaults',
        title: 'Defaults',
        titleKey: 'notifiers:ntfyConfig.s_defaults.title',
        fields: [
          {
            type: 'tags',
            key: 'tags',
            label: 'Default tags',
            labelKey: 'notifiers:ntfyConfig.s_defaults.tags.label',
            description:
              'Emoji shortcodes or labels sent with every notification (e.g. "warning", "camera").',
            descriptionKey: 'notifiers:ntfyConfig.s_defaults.tags.description',
          },
        ],
      },
    ],
  }
}

const ntfyDescriptor: TargetKind = {
  kind: 'ntfy',
  label: 'ntfy',
  icon: 'megaphone',
  addonId: 'notifiers',
  configSchema: ntfyConfigSchema(),
  supportsDiscovery: false,
  caps: {
    attachments: { mediaTypes: ['image', 'icon'], mode: 'both', max: 1 },
    actions: MAX_ACTIONS,
    /**
     * ntfy has NO per-action icon, and this says so out loud.
     *
     * Its action object is `{action, label, url, clear, headers, body}` and the
     * `X-Actions` header form is `action, label, url[, extras]` — there is no
     * icon field in either, and the `icon` ntfy does have is the NOTIFICATION's
     * icon (an attachment URL, handled above), not a per-button one.
     *
     * Left EXPLICIT rather than absent: absent and `false` behave identically
     * (the degrade engine reads a missing value as unsupported), but only one
     * of them proves somebody checked. The degrade engine then strips the icon
     * centrally and puts `actionIcons` in `renderedAs.dropped`, so the loss is
     * reported instead of being discovered on a phone.
     */
    actionIcons: false,
    levels: [
      { id: 'min', label: 'Min', ordinal: 1 },
      { id: 'low', label: 'Low', ordinal: 2 },
      { id: 'default', label: 'Default', ordinal: 3 },
      { id: 'high', label: 'High', ordinal: 4 },
      { id: 'max', label: 'Max', ordinal: 5, flags: { critical: true } },
    ],
    format: ['text', 'markdown'],
    clickUrl: true,
    sound: false,
    // ntfy has no per-message TTL — only `X-Cache: no` (skip server caching).
    ttl: false,
    bodyMaxLen: 4096,
  },
}

// ── Adapter ──────────────────────────────────────────────────────────

export const ntfyAdapter: HttpNotifierAdapter = {
  descriptor: ntfyDescriptor,
  // The topic is itself a secret; the server is where token/user/pass go.
  destinationKeys: ['serverUrl'],
  buildRequest(config, prepared) {
    // Prefer the JSON-to-root form (URL attachment); only a bytes-only
    // attachment forces the raw PUT-upload variant.
    const attachment = firstAttachment(prepared)
    if (
      attachment !== undefined &&
      attachment.url === undefined &&
      attachment.bytes !== undefined
    ) {
      return buildUploadRequest(config, prepared, attachment)
    }
    return buildJsonRequest(config, prepared)
  },
}
