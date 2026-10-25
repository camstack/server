import { userError } from '@camstack/types'
/**
 * Gotify notifier adapter (plan task T8).
 *
 * Gotify is a self-hosted push server. A message is a JSON POST to
 * `{serverUrl}/message` authenticated by an application token in the
 * `X-Gotify-Key` header:
 *
 *   { title, message, priority, extras }
 *
 * Priority is a client-importance band (integer). Gotify has no native action
 * buttons (Android intent only), no sound field (implied by priority) and no
 * TTL, so the descriptor advertises `actions:0`, `sound:false`, `ttl:false`.
 * Markdown, a click-through URL and one big image are all carried in the
 * `extras` map:
 *   - `client::display.contentType: 'text/markdown'`   → render body as markdown
 *   - `client::notification.click.url`                 → tap-through URL
 *   - `client::notification.bigImageUrl`               → first image attachment
 *
 * Levels: `min`/`low`/`normal`/`high` map to canonical ordinals 1/2/3/5 and to
 * native Gotify integers 0/3/5/8 (the degrade engine resolves the ordinal → a
 * declared level; this adapter maps that level id → the native integer).
 *
 * Discovery (optional): an admin token + `GET {serverUrl}/application` lists the
 * server's applications, each with its own message token → one candidate per
 * application. Manual add always works from `configSchema`.
 *
 * `buildRequest` is PURE (no network). The provider executes the plan; only the
 * optional `discover` touches the network.
 */
import type {
  ConfigUISchema,
  DiscoveredTarget,
  PreparedNotification,
  TargetKind,
} from '@camstack/types'
import { fetchWithTimeout } from '../http.js'
import type { HttpNotifierAdapter, TargetConfig } from './adapter.js'

/** The kind id advertised in the catalog + persisted on every gotify target. */
export const GOTIFY_KIND = 'gotify'

/** Native Gotify priority integer per declared level id (client-importance bands). */
const NATIVE_PRIORITY_BY_LEVEL_ID: Readonly<Record<string, number>> = {
  min: 0,
  low: 3,
  normal: 5,
  high: 8,
}

/** Fallback native priority when no level resolves and no config default is set. */
const DEFAULT_NATIVE_PRIORITY = 5

// ── Config accessors ────────────────────────────────────────────────

function readString(config: TargetConfig, key: string): string | undefined {
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(config: TargetConfig, key: string): number | undefined {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Strip trailing slashes so `{base}/message` never doubles up. */
function normalizeBaseUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '')
}

// ── Wire body shapes ────────────────────────────────────────────────

interface GotifyClientDisplay {
  readonly contentType: string
}

interface GotifyClick {
  readonly url: string
}

interface GotifyClientNotification {
  readonly click?: GotifyClick
  readonly bigImageUrl?: string
}

interface GotifyExtras {
  readonly 'client::display'?: GotifyClientDisplay
  readonly 'client::notification'?: GotifyClientNotification
}

interface GotifyMessageBody {
  readonly message: string
  readonly priority: number
  readonly title?: string
  readonly extras?: GotifyExtras
}

// ── Descriptor ──────────────────────────────────────────────────────

function configSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'connection',
        title: 'Connection',
        titleKey: 'notifiers:config.s_connection.title',
        fields: [
          {
            type: 'text',
            key: 'serverUrl',
            label: 'Server URL',
            labelKey: 'notifiers:config.s_connection.serverUrl.label',
            inputType: 'url',
            required: true,
            placeholder: 'https://gotify.example.com',
            description: 'Base URL of your Gotify server (no trailing /message).',
            descriptionKey: 'notifiers:config.s_connection.serverUrl.description',
          },
          {
            type: 'password',
            key: 'appToken',
            label: 'Application Token',
            labelKey: 'notifiers:config.s_connection.appToken.label',
            required: true,
            description: 'The message token of a Gotify application (Apps → your app).',
            descriptionKey: 'notifiers:config.s_connection.appToken.description',
          },
          {
            type: 'password',
            key: 'adminToken',
            label: 'Client/Admin Token (optional)',
            labelKey: 'notifiers:config.s_connection.adminToken.label',
            description:
              'A client token used only for discovery (GET /application). Leave blank to add applications manually.',
            descriptionKey: 'notifiers:config.s_connection.adminToken.description',
          },
        ],
      },
      {
        id: 'defaults',
        title: 'Defaults',
        titleKey: 'notifiers:config.s_defaults.title',
        fields: [
          {
            type: 'number',
            key: 'defaultPriority',
            label: 'Default priority',
            labelKey: 'notifiers:config.s_defaults.defaultPriority.label',
            min: 0,
            max: 10,
            step: 1,
            default: DEFAULT_NATIVE_PRIORITY,
            description:
              'Native Gotify priority used when a notification does not resolve a level.',
            descriptionKey: 'notifiers:config.s_defaults.defaultPriority.description',
          },
          {
            type: 'select',
            key: 'contentType',
            label: 'Default content type',
            labelKey: 'notifiers:config.s_defaults.contentType.label',
            default: 'text/plain',
            options: [
              {
                value: 'text/plain',
                label: 'Plain text',
                labelKey: 'notifiers:config.s_defaults.contentType.o_text_plain.label',
              },
              {
                value: 'text/markdown',
                label: 'Markdown',
                labelKey: 'notifiers:config.s_defaults.contentType.o_text_markdown.label',
              },
            ],
            description:
              'Advisory default. The per-notification format wins: markdown bodies always send text/markdown.',
            descriptionKey: 'notifiers:config.s_defaults.contentType.description',
          },
        ],
      },
    ],
  }
}

/** The gotify capability descriptor surfaced by `listTargetKinds`. */
export function gotifyDescriptor(): TargetKind {
  return {
    kind: GOTIFY_KIND,
    label: 'Gotify',
    icon: 'gotify',
    addonId: 'notifiers',
    configSchema: configSchema(),
    supportsDiscovery: true,
    caps: {
      attachments: { mediaTypes: ['image'], mode: 'url', max: 1 },
      actions: 0,
      levels: [
        {
          id: 'min',
          label: 'Minimum',
          ordinal: 1,
          description: 'Native priority 0 — no notification banner.',
        },
        { id: 'low', label: 'Low', ordinal: 2, description: 'Native priority 3.' },
        { id: 'normal', label: 'Normal', ordinal: 3, description: 'Native priority 5 (default).' },
        {
          id: 'high',
          label: 'High',
          ordinal: 5,
          description: 'Native priority 8 — high-importance banner.',
        },
      ],
      format: ['text', 'markdown'],
      clickUrl: true,
      sound: false,
      ttl: false,
      bodyMaxLen: 4096,
    },
  }
}

// ── buildRequest ────────────────────────────────────────────────────

function resolveNativePriority(prepared: PreparedNotification, config: TargetConfig): number {
  const fromLevel = prepared.level ? NATIVE_PRIORITY_BY_LEVEL_ID[prepared.level.id] : undefined
  if (fromLevel !== undefined) return fromLevel
  return readNumber(config, 'defaultPriority') ?? DEFAULT_NATIVE_PRIORITY
}

function buildExtras(prepared: PreparedNotification): GotifyExtras | undefined {
  const display: GotifyClientDisplay | undefined =
    prepared.format === 'markdown' ? { contentType: 'text/markdown' } : undefined

  const firstImageUrl = prepared.attachments.find((a) => a.mediaType === 'image' && a.url)?.url
  const click: GotifyClick | undefined = prepared.clickUrl ? { url: prepared.clickUrl } : undefined

  const notification: GotifyClientNotification | undefined =
    click || firstImageUrl
      ? {
          ...(click ? { click } : {}),
          ...(firstImageUrl ? { bigImageUrl: firstImageUrl } : {}),
        }
      : undefined

  if (!display && !notification) return undefined
  return {
    ...(display ? { 'client::display': display } : {}),
    ...(notification ? { 'client::notification': notification } : {}),
  }
}

const gotifyAdapter: HttpNotifierAdapter = {
  descriptor: gotifyDescriptor(),
  // `verifyTls` was a "Verify TLS certificate" switch nothing ever read (D272);
  // it is deleted rather than declared here. If TLS relaxation is ever wired,
  // it is a destination key: turning it off must re-ask for the token (D634).
  destinationKeys: ['serverUrl'],

  buildRequest: (config, prepared) => {
    const serverUrl = readString(config, 'serverUrl')
    if (!serverUrl)
      throw userError(
        'notifiers.gotify-server-url-required',
        undefined,
        'gotify: serverUrl is required',
      )
    const appToken = readString(config, 'appToken')
    if (!appToken)
      throw userError(
        'notifiers.gotify-app-token-required',
        undefined,
        'gotify: appToken is required',
      )

    const extras = buildExtras(prepared)
    const body: GotifyMessageBody = {
      message: prepared.body,
      priority: resolveNativePriority(prepared, config),
      ...(prepared.title !== undefined ? { title: prepared.title } : {}),
      ...(extras ? { extras } : {}),
    }

    return {
      url: `${normalizeBaseUrl(serverUrl)}/message`,
      method: 'POST',
      headers: { 'X-Gotify-Key': appToken },
      body: { kind: 'json', value: body },
    }
  },

  discover: async (config): Promise<readonly DiscoveredTarget[]> => {
    const serverUrl = readString(config, 'serverUrl')
    const adminToken = readString(config, 'adminToken')
    if (!serverUrl || !adminToken) return []

    const base = normalizeBaseUrl(serverUrl)
    const res = await fetchWithTimeout(`${base}/application`, {
      method: 'GET',
      headers: { 'X-Gotify-Key': adminToken },
    })
    if (!res.ok) return []

    const data: unknown = await res.json()
    if (!Array.isArray(data)) return []

    const out: DiscoveredTarget[] = []
    for (const entry of data) {
      if (typeof entry !== 'object' || entry === null) continue
      const record: Record<string, unknown> = { ...entry }
      const token = record['token']
      const name = record['name']
      if (typeof token !== 'string' || token.length === 0) continue
      out.push({
        kind: GOTIFY_KIND,
        suggestedName: typeof name === 'string' && name.length > 0 ? name : 'Gotify application',
        config: { serverUrl: base, appToken: token },
      })
    }
    return out
  },
}

export default gotifyAdapter
export { gotifyAdapter }
