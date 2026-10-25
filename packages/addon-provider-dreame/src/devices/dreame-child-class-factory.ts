import type { DeviceContext, IDevice } from '@camstack/types'
import { classifyDreameModel } from '../dreame-mapping.js'
import { DreameAiSwitchDevice } from './dreame-ai-switch-device.js'
import { DreameAutoSelectDevice } from './dreame-auto-select-device.js'
import { DreameAutoSwitchDevice } from './dreame-auto-switch-device.js'
import { DreameButtonDevice } from './dreame-button-device.js'
import { DreameCameraDevice } from './dreame-camera-device.js'
import { DreameEnumSensorDevice } from './dreame-enum-sensor-device.js'
import { DreameMowerActionDevice } from './dreame-mower-action-device.js'
import { DreameMowerDevice } from './dreame-mower-device.js'
import { DreameMowerMapDevice } from './dreame-mower-map-device.js'
import { DreameMowerMapSelectDevice } from './dreame-mower-map-select-device.js'
import { DreameMowerSubstateDevice } from './dreame-mower-substate-device.js'
import { DreameNumberDevice } from './dreame-number-device.js'
import { DreameNumericSensorDevice } from './dreame-numeric-sensor-device.js'
import { DreameSelectDevice } from './dreame-select-device.js'
import { DreameSwitchDevice } from './dreame-switch-device.js'
import { DreameVacuumDevice } from './dreame-vacuum-device.js'
import { DreameVacuumMapDevice } from './dreame-vacuum-map-device.js'

/**
 * Resolve the concrete Dreame accessory-child class from the persisted child
 * config's `model` string. Mirrors the Homematic `hmChildFactoryForSpec` seam:
 * the Container's `getAccessoryChildren()` hands the kernel this factory, which
 * picks `DreameVacuumDevice` vs `DreameMowerDevice` from the model prefix.
 *
 * Throws a descriptive error for an unsupported model — the discovery/adoption
 * layer already filters those out, so this only fires on a corrupt persisted row.
 */
export function dreameChildFactory(ctx: DeviceContext): IDevice {
  const model = readModel(ctx.persistedConfig)
  const kind = classifyDreameModel(model)
  switch (kind) {
    case 'vacuum':
      return new DreameVacuumDevice(ctx)
    case 'mower':
      return new DreameMowerDevice(ctx)
    case 'unsupported':
      throw new Error(`dreame child factory: unsupported model "${model}" (id=${ctx.id})`)
  }
}

function readModel(config: Record<string, unknown> | undefined): string {
  const model = config?.['model']
  return typeof model === 'string' ? model : ''
}

/**
 * Factory for the vacuum MAP child (a `DeviceType.Image` grouped under the
 * Container). Distinct from {@link dreameChildFactory} because the map child and
 * the vacuum child share the same `model` string — the Container's
 * `getAccessoryChildren()` selects this factory for the map child spec directly.
 */
export function dreameMapChildFactory(ctx: DeviceContext): IDevice {
  return new DreameVacuumMapDevice(ctx)
}

/**
 * Factory for the mower MAP child (a `DeviceType.Image` grouped under the
 * Container). Selected directly by the Container's `getAccessoryChildren()` for
 * the mower map spec — like {@link dreameMapChildFactory} but renders the mower's
 * cloud-stored batch map to SVG.
 */
export function dreameMowerMapChildFactory(ctx: DeviceContext): IDevice {
  return new DreameMowerMapDevice(ctx)
}

/**
 * Factory for the mower "Mow" action select (a `DeviceType.Control` select child)
 * — collapses HA's map/zone/edge/spot/mowing-action selects into one actionable
 * list whose options come from the live map. Selected directly by the Container.
 */
export function dreameMowerActionChildFactory(ctx: DeviceContext): IDevice {
  return new DreameMowerActionDevice(ctx)
}

/** Factory for the mower "Map" select (container-level `DeviceType.Control`). */
export function dreameMowerMapSelectChildFactory(ctx: DeviceContext): IDevice {
  return new DreameMowerMapSelectDevice(ctx)
}

/**
 * Factory for the CAMERA + NAVIGATION child (a `DeviceType.Camera` grouped under
 * the Container), spawned only for camera-capable vacuums. Owns the `navigation`
 * cap (drive / actions / sounds / fill light). Selected directly by the
 * Container's `getAccessoryChildren()` for the camera child spec.
 */
export function dreameCameraChildFactory(ctx: DeviceContext): IDevice {
  return new DreameCameraDevice(ctx)
}

/**
 * Factory for an AI-obstacle Switch child (a `DeviceType.Switch` grouped under
 * the Container). Like {@link dreameMapChildFactory}, selected directly by the
 * Container's `getAccessoryChildren()` — the child config carries the
 * `aiFeature` that distinguishes one AI switch from another.
 */
export function dreameAiSwitchChildFactory(ctx: DeviceContext): IDevice {
  return new DreameAiSwitchDevice(ctx)
}

/** Factory for a catalog-driven numeric-sensor child (`DeviceType.Sensor`). */
export function dreameNumericSensorChildFactory(ctx: DeviceContext): IDevice {
  return new DreameNumericSensorDevice(ctx)
}

/** Factory for a catalog-driven direct-property switch child (`DeviceType.Switch`). */
export function dreameSwitchChildFactory(ctx: DeviceContext): IDevice {
  return new DreameSwitchDevice(ctx)
}

/** Factory for a catalog-driven writable-enum select child (`DeviceType.Control`). */
export function dreameSelectChildFactory(ctx: DeviceContext): IDevice {
  return new DreameSelectDevice(ctx)
}

/** Factory for a catalog-driven fire-only action button child (`DeviceType.Button`). */
export function dreameButtonChildFactory(ctx: DeviceContext): IDevice {
  return new DreameButtonDevice(ctx)
}

/** Factory for a catalog-driven read-only enum-state sensor child (`DeviceType.Sensor`). */
export function dreameEnumSensorChildFactory(ctx: DeviceContext): IDevice {
  return new DreameEnumSensorDevice(ctx)
}

/** Factory for the mower "Task" sensor — derived task sub-state from the
 *  heartbeat (`DeviceType.Sensor`, `enum-sensor` cap). */
export function dreameMowerSubstateChildFactory(ctx: DeviceContext): IDevice {
  return new DreameMowerSubstateDevice(ctx)
}

/** Factory for a catalog-driven writable-number child (`DeviceType.Control`, numeric). */
export function dreameNumberChildFactory(ctx: DeviceContext): IDevice {
  return new DreameNumberDevice(ctx)
}

/** Factory for a packed auto-switch boolean child (`DeviceType.Switch`). */
export function dreameAutoSwitchChildFactory(ctx: DeviceContext): IDevice {
  return new DreameAutoSwitchDevice(ctx)
}

/** Factory for a packed auto-switch enum child (`DeviceType.Control`, select). */
export function dreameAutoSelectChildFactory(ctx: DeviceContext): IDevice {
  return new DreameAutoSelectDevice(ctx)
}
