// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-runtime-state-durability.ts
/* eslint-disable */

import type { RuntimeStateDurability } from '../capabilities/capability-definition.js'

/** The persistence policy one capability declares for its runtime-state slice. */
export interface RuntimeStatePolicy {
  /** `'restored'` slices reach disk; `'session'` slices stay in the RAM mirror. */
  readonly durability: RuntimeStateDurability
  /**
   * Clock fields — persisted, but ignored by the equality test that decides
   * whether a write is worth a SQLite commit. Declared by the cap.
   */
  readonly volatileFields: readonly string[]
}

/**
 * Per-cap runtime-state policy, projected from every `*.cap.ts` that declares
 * `runtimeState`. 73 caps: 38 `restored`, 35 `session`.
 *
 * A cap absent from this map has no runtime-state slice at all. A cap PRESENT
 * with `durability: 'session'` has one and has decided not to keep it.
 */
export const RUNTIME_STATE_POLICY: Readonly<Record<string, RuntimeStatePolicy>> = {
  'air-quality-sensor': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'alarm-panel': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'ambient-light-sensor': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'audio-metrics': { durability: 'session', volatileFields: [] },
  'automation-control': { durability: 'session', volatileFields: [] },
  'battery': { durability: 'restored', volatileFields: ['lastUpdated'] },
  'binary': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'brightness': { durability: 'session', volatileFields: [] },
  'camera-streams': { durability: 'session', volatileFields: [] },
  'carbon-monoxide': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'climate-control': { durability: 'session', volatileFields: [] },
  'color': { durability: 'session', volatileFields: [] },
  'connectivity': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'consumables': { durability: 'restored', volatileFields: ['lastChangedAt', 'lastFetchedAt'] },
  'contact': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'control': { durability: 'session', volatileFields: [] },
  'cover': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'day-night': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'device-discovery': { durability: 'session', volatileFields: [] },
  'device-status': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'dishwasher': { durability: 'session', volatileFields: [] },
  'doorbell': { durability: 'restored', volatileFields: [] },
  'enum-sensor': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'event-emitter': { durability: 'session', volatileFields: [] },
  'fan-control': { durability: 'session', volatileFields: [] },
  'feature-probe': { durability: 'session', volatileFields: [] },
  'flood': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'gas': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'group-status': { durability: 'session', volatileFields: [] },
  'heating-valve': { durability: 'session', volatileFields: ['lastFetchedAt'] },
  'humidifier': { durability: 'session', volatileFields: [] },
  'humidity-sensor': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'image': { durability: 'session', volatileFields: [] },
  'image-settings': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'intercom': { durability: 'session', volatileFields: [] },
  'lawn-mower-control': { durability: 'session', volatileFields: [] },
  'lock-control': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'media-player': { durability: 'session', volatileFields: [] },
  'motion': { durability: 'session', volatileFields: [] },
  'motion-trigger': { durability: 'session', volatileFields: [] },
  'motion-zones': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'native-object-detection': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'navigation': { durability: 'session', volatileFields: [] },
  'network-link': { durability: 'restored', volatileFields: ['lastUpdated'] },
  'notifier': { durability: 'session', volatileFields: [] },
  'numeric-sensor': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'pet-feeder': { durability: 'session', volatileFields: [] },
  'power-meter': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'presence': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'pressure-sensor': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'privacy-mask': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'ptz-autotrack': { durability: 'session', volatileFields: [] },
  'recording-onboard': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'recording-signal': { durability: 'session', volatileFields: [] },
  'running-state': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'scene-monitor': { durability: 'session', volatileFields: [] },
  'script-runner': { durability: 'session', volatileFields: [] },
  'smoke': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'stream-catalog': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'stream-params': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'stream-signals': { durability: 'session', volatileFields: [] },
  'switch': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'tamper': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'temperature-sensor': { durability: 'restored', volatileFields: ['lastFetchedAt'] },
  'update': { durability: 'session', volatileFields: [] },
  'vacuum-control': { durability: 'session', volatileFields: [] },
  'valve': { durability: 'session', volatileFields: [] },
  'vibration': { durability: 'restored', volatileFields: ['lastChangedAt'] },
  'water-heater': { durability: 'session', volatileFields: [] },
  'weather': { durability: 'session', volatileFields: [] },
  'zone-analytics': { durability: 'session', volatileFields: [] },
  'zone-rules': { durability: 'restored', volatileFields: [] },
  'zones': { durability: 'restored', volatileFields: [] },
}

/**
 * The policy for `capName`. An UNKNOWN cap resolves to `'session'` — an
 * addon-private slice the codegen has never seen is not persisted until its
 * capability says so, which is the safe direction: the cost of a lost session
 * value is a cold window, the cost of an unasked-for persist is a commit per
 * second on the fleet's busiest write path.
 */
export function runtimeStatePolicyFor(capName: string): RuntimeStatePolicy {
  return RUNTIME_STATE_POLICY[capName] ?? SESSION_ONLY_POLICY
}

/** Shared fallback instance — see {@link runtimeStatePolicyFor}. */
const SESSION_ONLY_POLICY: RuntimeStatePolicy = { durability: 'session', volatileFields: [] }

/** True when this cap's slice is written to disk. */
export function isRestoredCap(capName: string): boolean {
  return runtimeStatePolicyFor(capName).durability === 'restored'
}

/** Cap names whose slice survives a restart, sorted. */
export const RESTORED_CAP_NAMES: readonly string[] = [
  'air-quality-sensor',
  'alarm-panel',
  'ambient-light-sensor',
  'battery',
  'binary',
  'carbon-monoxide',
  'connectivity',
  'consumables',
  'contact',
  'cover',
  'day-night',
  'device-status',
  'doorbell',
  'enum-sensor',
  'flood',
  'gas',
  'humidity-sensor',
  'image-settings',
  'lock-control',
  'motion-zones',
  'native-object-detection',
  'network-link',
  'numeric-sensor',
  'power-meter',
  'presence',
  'pressure-sensor',
  'privacy-mask',
  'recording-onboard',
  'running-state',
  'smoke',
  'stream-catalog',
  'stream-params',
  'switch',
  'tamper',
  'temperature-sensor',
  'vibration',
  'zone-rules',
  'zones',
]
