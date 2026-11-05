import type { ConfigUISchema } from '@camstack/types'
import type { HubChannelSnapshot } from './reolink-hub-session.js'

/**
 * A camera adopted under an NVR / Home Hub dials through the integration's session: the address
 * and the credentials belong to the integration, never to the camera. These are the per-camera
 * keys a hub child must refuse to change.
 */
export const HUB_CHILD_CONNECTION_KEYS = ['host', 'port', 'username', 'password'] as const

/**
 * Sections that act on the hub itself (no channel in the call) or on the per-camera connection,
 * hidden for a hub child:
 *  - `connection`: the per-camera address and credentials (the integration owns them);
 *  - `network-ports`: `setPortConfig` rewrites the NVR's own service ports;
 *  - `time-ntp`: `setNtp` / `setSystemGeneral` / `setDst` rewrite the NVR's clock.
 */
export const HUB_CHILD_HIDDEN_SECTION_IDS: readonly string[] = [
  'connection',
  'network-ports',
  'time-ntp',
]

/** Why a settings patch on a hub child was refused. */
export type HubChildPatchRefusal =
  | {
      readonly reason: 'connection-owned-by-integration'
      readonly keys: readonly string[]
    }
  | { readonly reason: 'channel-not-an-integer'; readonly value: unknown }
  | {
      readonly reason: 'channel-out-of-range'
      readonly value: number
      readonly channels: readonly number[]
    }

/** Thrown by `applySettingsPatch` for a refused hub-child patch; carries the typed reason. */
export class HubChildPatchRefusedError extends Error {
  constructor(readonly refusal: HubChildPatchRefusal) {
    super(describeRefusal(refusal))
    this.name = 'HubChildPatchRefusedError'
  }
}

function describeRefusal(refusal: HubChildPatchRefusal): string {
  switch (refusal.reason) {
    case 'connection-owned-by-integration':
      return `This camera is connected through its NVR / Home Hub integration: ${refusal.keys.join(', ')} can only be changed on the integration`
    case 'channel-not-an-integer':
      return `The hub channel must be a whole number, got ${String(refusal.value)}`
    case 'channel-out-of-range':
      return `Channel ${refusal.value} is not one of the hub's channels (${refusal.channels.join(', ')})`
  }
}

/**
 * Judge a settings patch against the hub-child rules. `channels` is the hub's last good channel
 * list (empty when unknown — then only the integer rule applies).
 */
export function judgeHubChildPatch(
  patch: Readonly<Record<string, unknown>>,
  channels: readonly number[],
): HubChildPatchRefusal | null {
  const touched = HUB_CHILD_CONNECTION_KEYS.filter((k) => patch[k] !== undefined)
  if (touched.length > 0) return { reason: 'connection-owned-by-integration', keys: touched }
  if (patch['channel'] === undefined) return null
  const value = patch['channel']
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { reason: 'channel-not-an-integer', value }
  }
  if (channels.length > 0 && !channels.includes(value)) {
    return { reason: 'channel-out-of-range', value, channels }
  }
  return null
}

type Section = ConfigUISchema['sections'][number]

/** What a hub child shows before its session has read the hub's channel list. */
export const EMPTY_HUB_CHANNEL_SNAPSHOT: HubChannelSnapshot = {
  channels: [],
  lastRefreshAt: null,
  lastError: null,
}

/** The hub-child "Hub" section: which hub, and the one editable connection field, the channel. */
export function buildHubChildSection(snapshot: HubChannelSnapshot): Section {
  const hasList = snapshot.channels.length > 0
  return {
    id: 'hub',
    tab: 'general',
    title: 'Hub',
    titleKey: 'provider-reolink:schema.s_hub.title',
    description:
      'This camera is connected through its NVR / Home Hub. Address and credentials belong to that integration; the channel is kept in line with the hub automatically.',
    descriptionKey: 'provider-reolink:schema.s_hub.description',
    columns: 2,
    fields: [
      {
        type: 'text',
        key: 'hubName',
        label: 'Connected to',
        labelKey: 'provider-reolink:schema.s_hub.hubName.label',
        disabled: true,
      },
      {
        type: 'number',
        key: 'channel',
        label: 'Hub channel',
        labelKey: 'provider-reolink:schema.s_hub.channel.label',
        min: 0,
        ...(hasList ? { max: Math.max(...snapshot.channels.map((c) => c.channel)) } : {}),
        step: 1,
      },
    ],
  }
}

/** Replace the connection/hub-acting sections of a standalone schema with the Hub section. */
export function applyHubChildSections(
  sections: readonly Section[],
  snapshot: HubChannelSnapshot,
): readonly Section[] {
  const kept = sections.filter((s) => !HUB_CHILD_HIDDEN_SECTION_IDS.includes(s.id))
  const at = kept.findIndex((s) => s.id === 'driver-refresh')
  const hub = buildHubChildSection(snapshot)
  return at < 0 ? [hub, ...kept] : [...kept.slice(0, at + 1), hub, ...kept.slice(at + 1)]
}
