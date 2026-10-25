/**
 * Pushover notifier adapter.
 *
 * Wire contract: a single multipart/form-data POST to
 * `https://api.pushover.net/1/messages.json` (multipart because Pushover
 * accepts an inline image `attachment` file part alongside the message
 * fields). `buildRequest` is PURE — the provider degrades the canonical
 * notification (`prepareNotification`) and resolves any `needsFetch`
 * attachment url→bytes BEFORE calling this adapter, so here every attachment
 * is already `bytes`.
 *
 * Capability profile (matrix §1 / §2):
 *  - attachments: bytes only, first image, ≤5 MB (`mode:'bytes', max:1`).
 *  - actions: 0 (Pushover has no action buttons — only the 1 supplemental URL).
 *  - levels: lowest/low/normal/high/emergency → native priority −2..2
 *    (`emergency` = 2, `flags.critical`, `requires:['retry','expire']`).
 *  - format: text | html (`html=1`); markdown→html-lite is the engine's job.
 *  - clickUrl (`url`/`url_title`), sound, ttl (ignored @emergency) supported.
 *
 * Discovery (matrix §4, "full" tier): `POST /1/users/validate.json` returns
 * the account's device names — one adoptable candidate per device. Optional;
 * returns `[]` when credentials are absent or the call fails.
 */
import type {
  DiscoveredTarget,
  PreparedAttachment,
  PreparedNotification,
  TargetKind,
} from '@camstack/types'
import type { MultipartPart, HttpNotifierAdapter, TargetConfig } from './adapter.js'

const MESSAGES_URL = 'https://api.pushover.net/1/messages.json'
const VALIDATE_URL = 'https://api.pushover.net/1/users/validate.json'

/** Pushover's inline-image hard cap (bytes). */
const MAX_ATTACHMENT_BYTES = 5_242_880

/** Native emergency priority — requires `retry` + `expire`. */
const EMERGENCY_PRIORITY = 2
/** Pushover minimum `retry` seconds; default when the operator omits it. */
const DEFAULT_EMERGENCY_RETRY = 60
/** Pushover maximum `expire` is 10800s; default when the operator omits it. */
const DEFAULT_EMERGENCY_EXPIRE = 3600

// ── small typed config readers (config is Readonly<Record<string, unknown>>) ──

function readString(config: TargetConfig, key: string): string | undefined {
  const value = config[key]
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

function readNumber(config: TargetConfig, key: string): number | undefined {
  const value = config[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Map the resolved level's canonical ordinal (1..5) onto Pushover's native
 * `-2..2` priority scale: 1→−2, 2→−1, 3→0, 4→1, 5→2 (i.e. `ordinal - 3`).
 */
function nativePriority(prepared: PreparedNotification): number {
  const ordinal = prepared.level?.ordinal ?? 3
  const native = ordinal - 3
  return Math.max(-2, Math.min(EMERGENCY_PRIORITY, native))
}

function firstImageAttachment(
  attachments: readonly PreparedAttachment[],
): PreparedAttachment | undefined {
  return attachments.find((att) => att.mediaType === 'image' && att.bytes !== undefined)
}

function descriptor(): TargetKind {
  return {
    kind: 'pushover',
    label: 'Pushover',
    icon: 'pushover',
    // Stamped by the provider on `listTargetKinds`; a placeholder keeps the
    // descriptor a complete `TargetKind` at rest.
    addonId: 'notifiers',
    supportsDiscovery: true,
    caps: {
      attachments: {
        mediaTypes: ['image'],
        mode: 'bytes',
        max: 1,
        maxBytes: MAX_ATTACHMENT_BYTES,
      },
      actions: 0,
      levels: [
        { id: 'lowest', label: 'Lowest', ordinal: 1, description: 'No sound or vibration (−2).' },
        { id: 'low', label: 'Low', ordinal: 2, description: 'Quiet notification (−1).' },
        { id: 'normal', label: 'Normal', ordinal: 3, description: 'Default priority (0).' },
        { id: 'high', label: 'High', ordinal: 4, description: 'Bypass quiet hours (1).' },
        {
          id: 'emergency',
          label: 'Emergency',
          ordinal: 5,
          flags: { critical: true },
          requires: ['retry', 'expire'],
          description: 'Repeats until acknowledged (2). Requires retry + expire.',
        },
      ],
      format: ['text', 'html'],
      clickUrl: true,
      sound: true,
      ttl: true,
      bodyMaxLen: 1024,
    },
    configSchema: {
      sections: [
        {
          id: 'pushover',
          title: 'Pushover',
          titleKey: 'notifiers:descriptor.s_pushover.title',
          tab: 'notifications',
          fields: [
            {
              type: 'password',
              key: 'appToken',
              label: 'Application API Token',
              labelKey: 'notifiers:descriptor.s_pushover.appToken.label',
              description: "Your Pushover application's API token/key.",
              descriptionKey: 'notifiers:descriptor.s_pushover.appToken.description',
              required: true,
              showToggle: true,
            },
            {
              type: 'password',
              key: 'userOrGroupKey',
              label: 'User or Group Key',
              labelKey: 'notifiers:descriptor.s_pushover.userOrGroupKey.label',
              description: 'The recipient user key or delivery group key.',
              descriptionKey: 'notifiers:descriptor.s_pushover.userOrGroupKey.description',
              required: true,
              showToggle: true,
            },
            {
              type: 'text',
              key: 'device',
              label: 'Device (optional)',
              labelKey: 'notifiers:descriptor.s_pushover.device.label',
              description: 'Restrict delivery to one device by name. Blank = all devices.',
              descriptionKey: 'notifiers:descriptor.s_pushover.device.description',
            },
            {
              type: 'text',
              key: 'defaultSound',
              label: 'Default Sound (optional)',
              labelKey: 'notifiers:descriptor.s_pushover.defaultSound.label',
              description: 'Sound name used when a notification omits its own.',
              descriptionKey: 'notifiers:descriptor.s_pushover.defaultSound.description',
            },
            {
              type: 'select',
              key: 'defaultPriority',
              label: 'Default Priority',
              labelKey: 'notifiers:descriptor.s_pushover.defaultPriority.label',
              default: 'normal',
              options: [
                {
                  value: 'lowest',
                  label: 'Lowest',
                  labelKey: 'notifiers:descriptor.s_pushover.defaultPriority.o_lowest.label',
                },
                {
                  value: 'low',
                  label: 'Low',
                  labelKey: 'notifiers:descriptor.s_pushover.defaultPriority.o_low.label',
                },
                {
                  value: 'normal',
                  label: 'Normal',
                  labelKey: 'notifiers:descriptor.s_pushover.defaultPriority.o_normal.label',
                },
                {
                  value: 'high',
                  label: 'High',
                  labelKey: 'notifiers:descriptor.s_pushover.defaultPriority.o_high.label',
                },
                {
                  value: 'emergency',
                  label: 'Emergency',
                  labelKey: 'notifiers:descriptor.s_pushover.defaultPriority.o_emergency.label',
                },
              ],
            },
            {
              type: 'number',
              key: 'retry',
              label: 'Emergency Retry (seconds)',
              labelKey: 'notifiers:descriptor.s_pushover.retry.label',
              description:
                'How often Pushover re-alerts until acknowledged. Emergency only. Min 30.',
              descriptionKey: 'notifiers:descriptor.s_pushover.retry.description',
              min: 30,
              default: DEFAULT_EMERGENCY_RETRY,
            },
            {
              type: 'number',
              key: 'expire',
              label: 'Emergency Expire (seconds)',
              labelKey: 'notifiers:descriptor.s_pushover.expire.label',
              description: 'How long emergency alerts keep retrying. Emergency only. Max 10800.',
              descriptionKey: 'notifiers:descriptor.s_pushover.expire.description',
              min: 0,
              max: 10800,
              default: DEFAULT_EMERGENCY_EXPIRE,
            },
          ],
        },
      ],
    },
  }
}

export const pushoverAdapter: HttpNotifierAdapter = {
  descriptor: descriptor(),
  // The API host is fixed; the RECIPIENT is `userOrGroupKey` (itself a secret,
  // so unchanged while redacted). A new recipient with the app token left
  // redacted would hand this account's token to someone else's inbox.
  // `device` picks one of the SAME user's devices, it does not redirect.
  destinationKeys: ['userOrGroupKey'],

  buildRequest(config, prepared) {
    const parts: MultipartPart[] = []
    const field = (name: string, value: string): void => {
      parts.push({ kind: 'field', name, value })
    }

    // Credentials + message.
    field('token', readString(config, 'appToken') ?? '')
    field('user', readString(config, 'userOrGroupKey') ?? '')
    field('message', prepared.body)
    if (prepared.title !== undefined) field('title', prepared.title)

    // Priority (native −2..2) + emergency retry/expire.
    const priority = nativePriority(prepared)
    field('priority', String(priority))
    if (priority === EMERGENCY_PRIORITY) {
      const retry = readNumber(config, 'retry') ?? DEFAULT_EMERGENCY_RETRY
      const expire = readNumber(config, 'expire') ?? DEFAULT_EMERGENCY_EXPIRE
      field('retry', String(retry))
      field('expire', String(expire))
    }

    // Format — Pushover renders an HTML-lite subset when `html=1`.
    if (prepared.format === 'html') field('html', '1')

    // Sound — per-notification value wins, else the target default.
    const sound = prepared.sound ?? readString(config, 'defaultSound')
    if (sound !== undefined) field('sound', sound)

    // Supplemental URL (Pushover's single tap-through) + its title.
    if (prepared.clickUrl !== null) {
      field('url', prepared.clickUrl)
      if (prepared.title !== undefined) field('url_title', prepared.title)
    }

    // TTL — Pushover ignores it for emergency priority, so only send otherwise.
    if (prepared.ttl !== null && priority !== EMERGENCY_PRIORITY) {
      field('ttl', String(prepared.ttl))
    }

    // Target device restriction.
    const device = readString(config, 'device')
    if (device !== undefined) field('device', device)

    // Inline image — first supported image, already resolved to bytes.
    const image = firstImageAttachment(prepared.attachments)
    if (image?.bytes !== undefined) {
      parts.push({
        kind: 'file',
        name: 'attachment',
        bytes: image.bytes,
        filename: image.name ?? 'attachment.jpg',
        contentType: image.mime ?? 'image/jpeg',
      })
    }

    return {
      url: MESSAGES_URL,
      method: 'POST',
      body: { kind: 'multipart', parts },
    }
  },

  async discover(config): Promise<readonly DiscoveredTarget[]> {
    const token = readString(config, 'appToken')
    const user = readString(config, 'userOrGroupKey')
    if (token === undefined || user === undefined) return []

    try {
      const body = new URLSearchParams({ token, user })
      const res = await fetch(VALIDATE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
      if (!res.ok) return []
      const json: unknown = await res.json()
      if (typeof json !== 'object' || json === null) return []
      const devices = (json as { devices?: unknown }).devices
      if (!Array.isArray(devices)) return []
      return devices
        .filter((device): device is string => typeof device === 'string' && device.length > 0)
        .map((device) => ({
          kind: 'pushover',
          suggestedName: `Pushover — ${device}`,
          config: { device },
        }))
    } catch {
      return []
    }
  },
}
