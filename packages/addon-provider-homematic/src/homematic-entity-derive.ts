import { DeviceType } from '@camstack/types'
import type { HmDevice } from 'nodehomematic'
import { mapHmDeviceChannels } from './homematic-mapping.js'
import { mapFirmwareUpdate, mapMaintenanceChannel } from './homematic-diagnostics-mapping.js'
import { ACTUATOR_CAP_NAMES } from './devices/hm-cold-start.js'

/**
 * Structural subset of `HmDevice` needed to derive per-entity previews. A
 * `Pick` keeps the signature tight while staying structurally compatible with
 * both live `HmDevice` instances and test fixtures — no cast at the call site.
 *
 * The firmware fields are required so {@link mapFirmwareUpdate} can decide
 * whether the device exposes a firmware-update entity.
 */
export type HmEntitySource = Pick<
  HmDevice,
  'channels' | 'firmware' | 'availableFirmware' | 'updatable' | 'firmwareUpdateState'
>

/**
 * One derived per-entity preview. `key` is the stable per-entity suffix —
 * the SAME scheme the Container's `getAccessoryChildren()` uses for
 * `stableIdSuffix`, so a preview child and the eventual spawned accessory
 * line up:
 *   - actuator  → `act-${channelAddress}`
 *   - sensor    → `sensor-${channelAddress}`
 *   - events    → `events`
 *   - diagnostic→ `maint-*` (the diagnostic entity key)
 *   - update    → `update`
 *
 * NOTE: actuator previews are derived from the raw channel mapping (not the
 * library's typed custom entities) — the discovery layer has no facade. The
 * preview is display-only (no control), so the channel-based derivation is
 * sufficient. The Container itself still uses `customEntities()` for the live
 * actuator children.
 */
export interface HmEntityPreview {
  readonly key: string
  readonly type: DeviceType
  readonly name: string
  readonly capabilities: readonly string[]
}

/**
 * Derive the per-entity preview list for a single Homematic device. Pure: no
 * facade, no network I/O. Mirrors the Container's `getAccessoryChildren()`
 * decomposition (actuators + sensors + ONE event-emitter + diagnostics +
 * firmware-update) so the adoption-panel accordion previews exactly what the
 * Container will spawn.
 */
export function deriveHmEntityPreviews(device: HmEntitySource): readonly HmEntityPreview[] {
  const out: HmEntityPreview[] = []

  // ── Actuators + sensors + the single event-emitter (from raw channels) ──
  const keyChannelPresent = (() => {
    let hasKeys = false
    for (const { channel, mapping } of mapHmDeviceChannels(device)) {
      const actuatorCaps: string[] = []
      const sensorCaps: string[] = []
      let isEvent = false
      for (const capName of mapping.capabilities) {
        if (capName === 'event-emitter') {
          isEvent = true
          continue
        }
        if (ACTUATOR_CAP_NAMES.has(capName)) {
          actuatorCaps.push(capName)
          continue
        }
        sensorCaps.push(capName)
      }
      if (isEvent) hasKeys = true
      if (actuatorCaps.length > 0) {
        out.push({
          key: `act-${channel.address}`,
          type: mapping.deviceType,
          name: `${mapping.deviceType} ${channel.address}`,
          capabilities: actuatorCaps,
        })
      }
      if (sensorCaps.length > 0) {
        out.push({
          key: `sensor-${channel.address}`,
          type: DeviceType.Sensor,
          name: `Sensor ${channel.address}`,
          capabilities: sensorCaps,
        })
      }
    }
    return hasKeys
  })()

  if (keyChannelPresent) {
    out.push({
      key: 'events',
      type: DeviceType.EventEmitter,
      name: 'Buttons',
      capabilities: ['event-emitter'],
    })
  }

  // ── Diagnostics (MAINTENANCE channel) ──────────────────────────────────
  for (const entity of mapMaintenanceChannel(device)) {
    out.push({
      key: entity.key,
      type: entity.deviceType,
      name: entity.name,
      capabilities: [...entity.capabilities],
    })
  }

  // ── Firmware update ────────────────────────────────────────────────────
  const update = mapFirmwareUpdate(device)
  if (update) {
    out.push({
      key: update.key,
      type: update.deviceType,
      name: update.name,
      capabilities: [...update.capabilities],
    })
  }

  return out
}
