/**
 * Pure device-projection + small predicate helpers for the device-manager
 * addon. Extracted verbatim from `device-manager.addon.ts`. None of these
 * functions close over the addon instance — they take everything they need
 * as explicit parameters, so they are safe to share across the addon's
 * query / aggregation modules.
 */

import type {
  DeviceInfo,
  ICameraDevice,
  IDevice,
  IDeviceRegistry,
  SourceInfo,
} from '@camstack/types'
import { collectZodSecretPaths, DeviceFeature, DeviceRole, DeviceType } from '@camstack/types'
import type { PersistedDeviceMeta } from './device-meta-types.js'

/**
 * Return true when `err` is a transient Moleculer error that is worth
 * retrying — specifically any `MoleculerRetryableError` subclass
 * (ServiceNotAvailableError, ServiceNotFoundError, BrokerDisconnectedError,
 * RequestTimeoutError, …). Moleculer sets `retryable: true` on all of them.
 *
 * Falls back to a message-substring check for serialised errors that arrive
 * across the Moleculer transport as plain objects rather than real instances.
 */
export function isTransientMoleculerError(err: unknown): boolean {
  if (err !== null && typeof err === 'object') {
    const e = err as Record<string, unknown>
    if (e['retryable'] === true) return true
    const code = typeof e['code'] === 'string' ? e['code'] : ''
    if (
      code === 'SERVICE_NOT_FOUND' ||
      code === 'SERVICE_NOT_AVAILABLE' ||
      code === 'REQUEST_TIMEOUT' ||
      code === 'BAD_GATEWAY'
    )
      return true
  }
  if (err instanceof Error) {
    const msg = err.message
    if (
      msg.includes('is not available') ||
      msg.includes('is not found') ||
      msg.includes('transporter has disconnected') ||
      msg.includes('Request timed out')
    )
      return true
  }
  return false
}

export function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (a[k] !== b[k]) return false
  }
  return true
}

// ── Type guards ──────────────────────────────────────────────────────────────

/** Returns true when `x` is a non-null, non-array plain object. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function isCameraDevice(device: IDevice): device is ICameraDevice {
  return (
    'getStreamSources' in device && typeof (device as ICameraDevice).getStreamSources === 'function'
  )
}

const DEVICE_FEATURE_VALUES = new Set<string>(Object.values(DeviceFeature) as readonly string[])

/**
 * Validate persisted feature strings against the `DeviceFeature` enum
 * — workers serialise the live `device.features` array (so every entry
 * is a valid enum value at write time) but the persisted blob is loose
 * `string[]` on the wire. The narrow keeps unknown values out of the
 * `getDevice` response without losing the enum-typed contract.
 */
export function persistedFeatures(features: readonly string[] | undefined): DeviceFeature[] {
  if (!features) return []
  const out: DeviceFeature[] = []
  for (const f of features) {
    if (DEVICE_FEATURE_VALUES.has(f)) out.push(f as DeviceFeature)
  }
  return out
}

/**
 * Infer `isCamera` from a persisted DeviceType.
 *
 * Live projection uses method presence (`getStreamSources` via
 * `isCameraDevice`). Forked-worker devices have no `IDevice` on the hub, so
 * the persisted fallbacks in `listAll` / `getDevice` / `getChildren` share
 * this one inference — they must not drift (the 4263 Campanello contradiction
 * of 2026-08-31: `listAll` said camera, `getDevice` said not).
 */
export function persistedIsCamera(type: string | undefined): boolean {
  return type === DeviceType.Camera
}

// ── Source info helper ───────────────────────────────────────────────────────

/**
 * Build an identity-only `SourceInfo` from the persisted device config blob.
 *
 * Forked-worker accessory children (e.g. HA sensor entities) persist
 * `entityId` and `system` in their config blob at spawn time. The hub has no
 * live `IDevice` instance for these devices, so the persisted-fallback paths
 * in `listAll` / `getDevice` / `getChildren` must reconstruct the identity
 * `SourceInfo` from the config so dispatch routing keeps working.
 *
 * Rendering metadata (unit, precision) flows live through the cap STATUS SLICE
 * and must NOT be derived here. Only `id` + `system` (+ `uniqueId` when
 * present) are projected — purely identity, never rendering hints.
 *
 * Returns `undefined` when no identity anchor is resolvable (pure identity
 * devices like cameras/hubs that don't carry `entityId`/`system` in their
 * config blob) — the hub synthetic fallback applies in that case.
 */
export function buildSourceInfoFromConfig(
  persistedConfig: Record<string, unknown>,
  stableId: string,
  addonId: string,
): SourceInfo | undefined {
  const id =
    typeof persistedConfig['entityId'] === 'string' ? persistedConfig['entityId'] : undefined
  const system =
    typeof persistedConfig['system'] === 'string' ? persistedConfig['system'] : undefined

  // Only build a sourceInfo when at least one identity anchor is present.
  if (id === undefined && system === undefined) return undefined

  const uniqueId =
    typeof persistedConfig['uniqueId'] === 'string' ? persistedConfig['uniqueId'] : undefined

  return {
    id: id ?? stableId,
    system: system ?? addonId,
    ...(uniqueId !== undefined ? { uniqueId } : {}),
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEVICE_ROLE_VALUES: ReadonlySet<string> = new Set<string>(Object.values(DeviceRole))

/** Type guard: a string is a known `DeviceRole` enum member. */
export function isDeviceRole(value: string): value is DeviceRole {
  return DEVICE_ROLE_VALUES.has(value)
}

/** Narrow a persisted role string (sqlite TEXT column) to a `DeviceRole`.
 *  Unknown / null values resolve to `null` so a stale or unrecognised role
 *  never leaks an off-enum string onto the wire shape. */
export function toDeviceRole(value: string | null | undefined): DeviceRole | null {
  return value != null && isDeviceRole(value) ? value : null
}

/** The secret paths a live device's config schema declares (D783), as a spreadable field. */
function liveSecretConfigPaths(device: IDevice): { secretConfigPaths?: string[] } {
  const schema = (device.config as { schema?: unknown } | undefined)?.schema
  if (schema === undefined || schema === null || typeof schema !== 'object') return {}
  const paths = collectZodSecretPaths(schema as Parameters<typeof collectZodSecretPaths>[0])
  return paths.length > 0 ? { secretConfigPaths: [...paths] } : {}
}

export function toDeviceInfo(
  addonId: string,
  device: IDevice,
  metadata: Record<string, unknown> | null = null,
  metaRow: PersistedDeviceMeta | null = null,
): DeviceInfo {
  const configValues: Record<string, unknown> = {}
  for (const entry of device.config.entries()) {
    configValues[entry.key] = entry.value
  }
  // Operator-organisational fields (`name` / `location` / `disabled`)
  // are mutated through `setName` / `setLocation` / `setDisabled`,
  // which write to the persisted `deviceMeta` row and emit
  // `DeviceMetaChanged`. The live `BaseDevice` instance reads these
  // from `ctx.deviceMeta` at CONSTRUCTION ONLY (see
  // `base-device.ts:140-142`), so its `device.name` / `device.location`
  // / `device.disabled` fields are stale until the device class is
  // re-instantiated. Reading from `metaRow` here guarantees the wire
  // response reflects the latest persisted value within one settings
  // round-trip — the UI's enable/disable toggle (and rename) flips
  // immediately after the mutation completes. Falls back to the live
  // device fields when no meta row was supplied (test fixtures, edge
  // paths) so existing behaviour is preserved.
  const name = metaRow?.name ?? device.name
  const location = metaRow?.location !== undefined ? metaRow.location : device.location
  const disabled = metaRow?.disabled ?? device.disabled
  // A device is probe-ready when it has NO `feature-probe` slice (no probe
  // is needed → ready) OR its slice's `lastProbedAt` has advanced past 0
  // (the initial probe landed). Only `false` while a `feature-probe` slice
  // EXISTS with `lastProbedAt === 0` — i.e. a probe is expected but hasn't
  // completed yet, so the exported shape is still mid-probe / partial.
  const probeSlice = device.runtimeState?.getCapState<{ lastProbedAt?: number }>('feature-probe')
  const probed = probeSlice === undefined ? true : (probeSlice.lastProbedAt ?? 0) > 0
  return {
    // Progressive system-wide id — bound on the live `IDevice` at
    // construction time (see `DeviceContext.id` / `BaseDevice.id`). The
    // hub allocates via `allocateDeviceId` BEFORE the device is
    // instantiated, so every live device exposes one.
    id: device.id,
    stableId: device.stableId,
    addonId,
    type: device.type,
    name,
    location,
    disabled,
    parentDeviceId: device.parentDeviceId,
    // `role` is set by the provider on accessory children (synthesized
    // via `getAccessoryChildren()` — Reolink siren/floodlight/PIR,
    // Hikvision supplemental light/siren). Top-level devices and
    // first-class hub-adopted children leave it `undefined`. Surfacing
    // it on `DeviceInfo` lets the UI distinguish accessory rows from
    // adopted-camera rows without re-deriving the heuristic from the
    // provider's `deviceClasses` map.
    role: device.role ?? null,
    online: device.online,
    probed,
    // Prefer the live device's features, but fall back to the persisted meta
    // when the live array is empty. The hub-registry entry for a forked-worker
    // accessory child can carry an empty `features` snapshot even though the
    // worker published the real flags (e.g. HA `lock-open`) into the meta row
    // via `refreshFeatures` — without this fallback those flags never reach the
    // UI (the lock "Open door" button stayed hidden despite a correct mapping).
    features:
      device.features.length > 0 ? [...device.features] : persistedFeatures(metaRow?.features),
    isCamera: isCameraDevice(device),
    config: configValues,
    // D783 — a live device answers from its own schema declaration.
    ...liveSecretConfigPaths(device),
    metadata,
    ...(metaRow?.integrationId !== undefined ? { integrationId: metaRow.integrationId } : {}),
    ...(metaRow?.linkDeviceId !== undefined ? { linkDeviceId: metaRow.linkDeviceId } : {}),
    ...(metaRow?.primaryChildEntityId !== undefined
      ? { primaryChildEntityId: metaRow.primaryChildEntityId }
      : {}),
    ...(metaRow?.childLayout !== undefined ? { childLayout: metaRow.childLayout } : {}),
    ...(metaRow?.display !== undefined ? { display: metaRow.display } : {}),
  }
}

export function resolveDeviceById(
  registry: IDeviceRegistry,
  deviceId: number,
): { addonId: string; device: IDevice } | null {
  const device = registry.getById(deviceId)
  if (!device) return null
  const addonId = registry.getAddonId(deviceId)
  if (!addonId) return null
  return { addonId, device }
}
