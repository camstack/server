/**
 * The retention knobs device-history owns, as the `retention-source` capability lists
 * them (D1084). A read of the policy the addon already resolves — nothing is stored
 * here. The two raw windows can be overridden per device (the addon's per-device store);
 * the rest are cluster-wide.
 */
import type { RetentionKnob } from '@camstack/types'
import { DEFAULT_RETENTION, type RawDeviceOverride, type RetentionPolicy } from './retention.js'

export const DEVICE_HISTORY_ADDON_ID = 'device-history'
const CAP = 'device-history'

type RawKey = 'rawDays' | 'rawDiscreteDays'
const RAW_KEYS: readonly RawKey[] = ['rawDays', 'rawDiscreteDays']

interface KnobSpec {
  readonly key: keyof RetentionPolicy
  readonly label: string
  readonly min: number
  readonly max: number
  readonly zeroMeansForever: boolean
}

const SPECS: readonly KnobSpec[] = [
  {
    key: 'rawDays',
    label: 'Raw points of measurements',
    min: 1,
    max: 60,
    zeroMeansForever: false,
  },
  {
    key: 'rawDiscreteDays',
    label: 'Raw points of states',
    min: 1,
    max: 365,
    zeroMeansForever: false,
  },
  {
    key: 'fiveMinuteDays',
    label: '5-minute rollup',
    min: 1,
    max: 365,
    zeroMeansForever: false,
  },
  {
    key: 'hourDays',
    label: '1-hour rollup',
    min: 7,
    max: 3650,
    zeroMeansForever: false,
  },
  {
    key: 'dayDays',
    label: '1-day rollup',
    min: 0,
    max: 36500,
    zeroMeansForever: true,
  },
  {
    key: 'transitionDays',
    label: 'Device commands',
    min: 7,
    max: 3650,
    zeroMeansForever: false,
  },
]

function isRawKey(key: string): key is RawKey {
  return key === 'rawDays' || key === 'rawDiscreteDays'
}

function knobFor(
  spec: KnobSpec,
  policy: RetentionPolicy,
  deviceId: number | undefined,
  override: RawDeviceOverride | undefined,
): RetentionKnob {
  const cluster = policy[spec.key]
  const base = {
    id: `${DEVICE_HISTORY_ADDON_ID}:${spec.key}`,
    owner: DEVICE_HISTORY_ADDON_ID,
    key: spec.key,
    labelKey: `retention.${DEVICE_HISTORY_ADDON_ID}.${spec.key}`,
    label: spec.label,
    group: 'history',
    unit: 'days' as const,
    defaultValue: DEFAULT_RETENTION[spec.key],
    min: spec.min,
    max: spec.max,
    zeroMeansForever: spec.zeroMeansForever,
  }
  if (!isRawKey(spec.key)) {
    return {
      ...base,
      value: cluster,
      scope: 'cluster',
      write: {
        method: 'updateScopedSettings',
        addonId: DEVICE_HISTORY_ADDON_ID,
        cap: CAP,
        scope: 'cluster',
        key: spec.key,
      },
    }
  }
  const own = override?.[spec.key]
  return {
    ...base,
    value: own ?? cluster,
    scope: 'device',
    ...(deviceId === undefined ? {} : { deviceId }),
    inherited: own === undefined,
    inheritedValue: cluster,
    write:
      deviceId === undefined
        ? {
            method: 'updateScopedSettings',
            addonId: DEVICE_HISTORY_ADDON_ID,
            cap: CAP,
            scope: 'cluster',
            key: spec.key,
          }
        : {
            method: 'updateDeviceSettings',
            addonId: DEVICE_HISTORY_ADDON_ID,
            key: spec.key,
          },
  }
}

/**
 * Without a device: every knob, a raw window listed with the cluster value it defaults to.
 * With one: only the device-scoped knobs, each saying whether the device follows the cluster.
 */
export function deviceHistoryKnobs(
  policy: RetentionPolicy,
  deviceId: number | undefined,
  override: RawDeviceOverride | undefined,
): readonly RetentionKnob[] {
  const specs =
    deviceId === undefined ? SPECS : SPECS.filter((s) => RAW_KEYS.some((k) => k === s.key))
  return specs.map((spec) => knobFor(spec, policy, deviceId, override))
}
