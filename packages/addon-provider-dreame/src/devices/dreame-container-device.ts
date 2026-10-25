import {
  type DreameAiFeature,
  MowerDevice as DreameMower,
  VacuumDevice as DreameVacuum,
} from '@apocaliss92/nodedreame'
import {
  type AccessoryChildrenAnswer,
  type AccessoryChildSpec,
  accessoryChildrenComplete,
  accessoryChildrenUnknown,
  BaseDevice,
  type DeviceContext,
  DeviceFeature,
  DeviceRole,
  DeviceType,
  errMsg,
} from '@camstack/types'
import { z } from 'zod'
import {
  DREAME_AUTO_SELECTS,
  DREAME_AUTO_SWITCHES,
  DREAME_BUTTONS,
  DREAME_ENUM_SENSORS,
  DREAME_MOWER_ENUM_SENSORS,
  DREAME_NUMBERS,
  DREAME_NUMERIC_SENSORS,
  DREAME_SELECTS,
  DREAME_SWITCHES,
} from '../dreame-entity-catalog.js'
import { dreameFacades } from '../dreame-gateway.js'
import { classifyDreameModel, deviceTypeForKind } from '../dreame-mapping.js'
import { AI_FEATURE_LABEL } from './dreame-ai-switch-device.js'
import {
  deriveContainerFeatures,
  type DreameMowerCapabilitySnapshot,
  type DreameVacuumCapabilitySnapshot,
  mowerSupportsMap,
  mowerSupportsTargetedMowing,
  vacuumSupportsCamera,
  vacuumSupportsMap,
} from './dreame-container-features.js'
import {
  dreameAiSwitchChildFactory,
  dreameAutoSelectChildFactory,
  dreameAutoSwitchChildFactory,
  dreameButtonChildFactory,
  dreameCameraChildFactory,
  dreameChildFactory,
  dreameEnumSensorChildFactory,
  dreameMapChildFactory,
  dreameMowerActionChildFactory,
  dreameMowerMapChildFactory,
  dreameMowerMapSelectChildFactory,
  dreameMowerSubstateChildFactory,
  dreameNumberChildFactory,
  dreameNumericSensorChildFactory,
  dreameSelectChildFactory,
  dreameSwitchChildFactory,
} from './dreame-child-class-factory.js'

/** Accordion section the AI-obstacle Switch children are grouped into. */
const AI_SECTION = 'AI / Obstacle'
/** stableIdSuffix prefix for an AI-switch child (childLayout `childKey`). */
const aiSwitchSuffix = (feature: DreameAiFeature): string => `ai-${feature}`
/** stableIdSuffix prefix for a catalog numeric-sensor child. */
const numericSensorSuffix = (key: string): string => `sensor-${key}`
/** stableIdSuffix prefix for a catalog direct-property switch child. */
const switchSuffix = (key: string): string => `sw-${key}`
/** stableIdSuffix prefix for a catalog writable-enum select child. */
const selectSuffix = (key: string): string => `sel-${key}`
/** stableIdSuffix prefix for a catalog fire-only button child. */
const buttonSuffix = (key: string): string => `btn-${key}`
/** stableIdSuffix prefix for a catalog read-only enum-state sensor child. */
const enumSensorSuffix = (key: string): string => `enum-${key}`
/** stableIdSuffix prefix for a catalog writable-number child. */
const numberSuffix = (key: string): string => `num-${key}`
/** stableIdSuffix prefix for a packed auto-switch boolean child. */
const autoSwitchSuffix = (key: string): string => `aw-${key}`
/** stableIdSuffix prefix for a packed auto-switch enum (select) child. */
const autoSelectSuffix = (key: string): string => `asel-${key}`
/** stableId suffix for the mower's derived task sub-state ("Task") sensor. */
const MOWER_SUBSTATE_SUFFIX = 'mower-task-substate'

/**
 * Persisted config for a Dreame Container (the parent of one cloud device).
 * `dreameDeviceId` resolves the live handle from the facade; `brokerId` selects
 * the account; `model` classifies the single accessory child; `integrationId`
 * is stamped onto the child; `system`/`name` are provenance.
 */
export const dreameContainerSchema = z.object({
  dreameDeviceId: z.string().min(1).describe('Dreame cloud device id (did)'),
  brokerId: z.string().min(1).describe('Registry broker id'),
  model: z.string().min(1).describe('Dreame cloud model string'),
  integrationId: z.string().optional(),
  system: z.literal('dreame').optional(),
  name: z.string().optional(),
})

export type DreameContainerConfig = z.infer<typeof dreameContainerSchema>

/**
 * Parent Container device for a single Dreame cloud device. Owns no control caps
 * itself — it declares `getAccessoryChildren()` so the kernel auto-spawns the
 * single typed accessory child (vacuum or mower) and reconciles it across
 * reboots. Mirrors `HmContainerDevice` / `HaContainerDevice`.
 *
 * The Container fans out to exactly ONE accessory child today (one cloud device =
 * one vacuum OR one mower). The container→children cascade is kept (rather than a
 * flat top-level device) for parity with the other provider addons and to leave
 * room for future sub-accessories (e.g. a separate battery child, or a map child).
 */
export class DreameContainerDevice extends BaseDevice<typeof dreameContainerSchema> {
  /**
   * Feature flags derived from the live device handle (getter override of the
   * abstract `readonly features` on BaseDevice — typechecks as a getter). Always
   * advertises `Resyncable`; adds the kind-specific map / AI / targeted-mowing
   * flags gated on the RESOLVED handle's capabilities (never optimistically),
   * using the SAME predicates that gate the corresponding accessory children so
   * the scalar feature signal and the spawned child STAY CONSISTENT. The kernel
   * refreshes the meta `features` block on every reconcile (`reprobe`), so this
   * tracks the handle as it binds rather than a stale constructor snapshot.
   */
  override get features(): readonly DeviceFeature[] {
    return deriveContainerFeatures({
      kind: classifyDreameModel(this.model),
      vacuumCaps: this.resolveVacuumCaps(),
      mowerCaps: this.resolveMowerCaps(),
    })
  }

  private readonly dreameDeviceId: string
  private readonly brokerId: string
  private readonly model: string
  private readonly integrationId: string | undefined

  constructor(ctx: DeviceContext) {
    const cfg = dreameContainerSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, dreameContainerSchema, { type: DeviceType.Container })
    this.dreameDeviceId = cfg.dreameDeviceId
    this.brokerId = cfg.brokerId
    this.model = cfg.model
    this.integrationId = cfg.integrationId
    // online derives from whether the live handle is currently present.
    this.online = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId) !== null
    void this.updateSourceInfo({ id: this.dreameDeviceId, system: 'dreame' })
  }

  /**
   * The child list is known only while the cloud device is REACHABLE: every
   * presence-filtered child is derived from the live handle. Without it (no
   * credentials, cloud down, before the first connect) the answer is UNKNOWN —
   * the kernel then deletes nothing (D49; it deleted 97 accessories when this
   * answered only the core child) — and only the core child is named to spawn.
   */
  override getAccessoryChildren(): AccessoryChildrenAnswer {
    const specs = this.buildChildSpecs()
    if (dreameFacades.getDevice(this.brokerId, this.dreameDeviceId) === null) {
      this.ctx.logger.info(
        'DreameContainerDevice: cloud device not reachable; child list unknown',
        {
          tags: { deviceId: this.id },
          meta: { dreameDeviceId: this.dreameDeviceId, integrationId: this.brokerId },
        },
      )
      return accessoryChildrenUnknown('dreame cloud device not reachable', specs.slice(0, 1))
    }
    return accessoryChildrenComplete(specs)
  }

  private buildChildSpecs(): readonly AccessoryChildSpec[] {
    const kind = classifyDreameModel(this.model)
    if (kind === 'unsupported') {
      this.ctx.logger.warn('DreameContainerDevice: unsupported model; no children', {
        tags: { deviceId: this.id },
        meta: { model: this.model, dreameDeviceId: this.dreameDeviceId },
      })
      return []
    }
    const childType = deviceTypeForKind(kind)
    const meta: AccessoryChildSpec['meta'] = {
      type: childType,
      name: this.name,
      linkDeviceId: this.id,
      ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
    }
    const config: Record<string, unknown> = {
      dreameDeviceId: this.dreameDeviceId,
      brokerId: this.brokerId,
      model: this.model,
      system: 'dreame',
      ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
    }
    const children: AccessoryChildSpec[] = [
      {
        // Suffix the child stableId by kind so it is deterministic + collision-free.
        stableIdSuffix: kind,
        meta,
        config,
        factory: dreameChildFactory,
      },
    ]

    // The cleaning MAP is its own Image child grouped under the container (per
    // the Dreame container directive — non-robot entities are separate
    // children, not folded onto the Vacuum). Vacuum only (the mower map is
    // lib-blocked). Gated on the model's `canMap` when the live handle resolves;
    // optimistic when it has not (the reconcile re-derives once the facade is up).
    if (kind === 'vacuum' && this.modelSupportsMap()) {
      const mapMeta: AccessoryChildSpec['meta'] = {
        type: DeviceType.Image,
        name: this.name.length > 0 ? `${this.name} map` : 'Map',
        linkDeviceId: this.id,
        ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
      }
      children.push({
        stableIdSuffix: 'map',
        meta: mapMeta,
        config,
        factory: dreameMapChildFactory,
      })
    }

    // Camera-capable vacuums (LinkVisual video) get a SEPARATE camera +
    // navigation device — the `navigation` cap (drive joystick + discrete robot
    // actions + sounds + fill light) lives here, NOT on the Vacuum device. Gated
    // on the model's confirmed `hasCamera`; withheld until the live handle
    // resolves (the reconcile re-derives once the facade is up).
    if (kind === 'vacuum' && this.modelSupportsCamera()) {
      const cameraMeta: AccessoryChildSpec['meta'] = {
        type: DeviceType.Camera,
        name: this.name.length > 0 ? `${this.name} Camera` : 'Camera',
        linkDeviceId: this.id,
        ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
      }
      children.push({
        stableIdSuffix: 'camera',
        meta: cameraMeta,
        config,
        factory: dreameCameraChildFactory,
      })
    }

    // Each AI-obstacle toggle the model exposes becomes its own Switch child
    // grouped under the container (per the directive — every non-core entity is
    // a separate child). All read/write the ONE packed AI_DETECTION property;
    // the library decodes/encodes each feature out of it. Empty until the live
    // handle resolves its supported set (the reconcile re-derives on connect).
    if (kind === 'vacuum') {
      for (const feature of this.supportedAiFeatures()) {
        const switchMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Switch,
          name:
            this.name.length > 0
              ? `${this.name} ${AI_FEATURE_LABEL[feature]}`
              : AI_FEATURE_LABEL[feature],
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: aiSwitchSuffix(feature),
          meta: switchMeta,
          config: { ...config, aiFeature: feature },
          factory: dreameAiSwitchChildFactory,
        })
      }

      // Catalog-driven numeric sensors (statistics + maintenance durations),
      // presence-filtered: spawn ONLY those the device reports (the integration
      // manager seeds the catalog props before children spawn — see
      // DreameIntegrationManager.start). One Sensor child each.
      for (const sensor of this.presentNumericSensors()) {
        const sensorMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Sensor,
          // Generic numeric-sensor role so the UI renders value + unit from the
          // slice (SensorValueAtom requires a role; without it the row shows the
          // name only — the statistics/maintenance values stay invisible).
          role: DeviceRole.NumericSensor,
          name: this.name.length > 0 ? `${this.name} ${sensor.label}` : sensor.label,
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: numericSensorSuffix(sensor.key),
          meta: sensorMeta,
          config: {
            ...config,
            siid: sensor.siid,
            piid: sensor.piid,
            ...(sensor.unit !== undefined ? { unit: sensor.unit } : {}),
            label: sensor.label,
          },
          factory: dreameNumericSensorChildFactory,
        })
      }

      // Catalog-driven direct-property switches (writable boolean settings),
      // presence-filtered. One Switch child each.
      for (const sw of this.presentSwitches()) {
        const swMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Switch,
          name: this.name.length > 0 ? `${this.name} ${sw.label}` : sw.label,
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: switchSuffix(sw.key),
          meta: swMeta,
          config: { ...config, siid: sw.siid, piid: sw.piid, label: sw.label },
          factory: dreameSwitchChildFactory,
        })
      }

      // Catalog-driven writable-enum selects (DeviceType.Control, select-control
      // role), presence-filtered. One Control child each.
      for (const sel of this.presentSelects()) {
        const selMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Control,
          role: DeviceRole.SelectControl,
          name: this.name.length > 0 ? `${this.name} ${sel.label}` : sel.label,
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: selectSuffix(sel.key),
          meta: selMeta,
          config: {
            ...config,
            siid: sel.siid,
            piid: sel.piid,
            label: sel.label,
            options: sel.options,
          },
          factory: dreameSelectChildFactory,
        })
      }

      // Catalog-driven fire-only buttons (DeviceType.Button), presence-filtered
      // (universal actions always spawn; station actions gate on a presence prop).
      // One Button child each.
      for (const btn of this.presentButtons()) {
        const btnMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Button,
          name: this.name.length > 0 ? `${this.name} ${btn.label}` : btn.label,
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: buttonSuffix(btn.key),
          meta: btnMeta,
          config: { ...config, siid: btn.siid, aiid: btn.aiid, label: btn.label },
          factory: dreameButtonChildFactory,
        })
      }

      // Catalog-driven read-only enum-state sensors (DeviceType.Sensor, enum-sensor
      // cap), presence-filtered. One Sensor child each.
      for (const es of this.presentEnumSensors()) {
        const esMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Sensor,
          // Enum-sensor role so the UI renders the mapped string value (Status,
          // Task Status, Charging, the diagnostic enums) — without a role the
          // SensorValueAtom shows nothing.
          role: DeviceRole.EnumSensor,
          name: this.name.length > 0 ? `${this.name} ${es.label}` : es.label,
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: enumSensorSuffix(es.key),
          meta: esMeta,
          config: {
            ...config,
            siid: es.siid,
            piid: es.piid,
            label: es.label,
            options: es.options,
          },
          factory: dreameEnumSensorChildFactory,
        })
      }

      // Catalog-driven writable numbers (DeviceType.Control, numeric-control role),
      // presence-filtered. One Control child each.
      for (const num of this.presentNumbers()) {
        const numMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Control,
          role: DeviceRole.NumericControl,
          name: this.name.length > 0 ? `${this.name} ${num.label}` : num.label,
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: numberSuffix(num.key),
          meta: numMeta,
          config: {
            ...config,
            siid: num.siid,
            piid: num.piid,
            label: num.label,
            min: num.min,
            max: num.max,
            step: num.step,
            ...(num.unit !== undefined ? { unit: num.unit } : {}),
          },
          factory: dreameNumberChildFactory,
        })
      }

      // Packed auto-switch BOOLEAN settings (DeviceType.Switch), presence-filtered
      // — read/written through nodedreame's auto-switch codec, not a direct prop.
      for (const aw of this.presentAutoSwitches()) {
        const awMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Switch,
          name: this.name.length > 0 ? `${this.name} ${aw.label}` : aw.label,
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: autoSwitchSuffix(aw.key),
          meta: awMeta,
          config: { ...config, autoSwitchKey: aw.autoSwitchKey, label: aw.label },
          factory: dreameAutoSwitchChildFactory,
        })
      }

      // Packed auto-switch ENUM settings (DeviceType.Control, select-control role),
      // presence-filtered.
      for (const asel of this.presentAutoSelects()) {
        const aselMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Control,
          role: DeviceRole.SelectControl,
          name: this.name.length > 0 ? `${this.name} ${asel.label}` : asel.label,
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: autoSelectSuffix(asel.key),
          meta: aselMeta,
          config: {
            ...config,
            autoSwitchKey: asel.autoSwitchKey,
            label: asel.label,
            options: asel.options,
          },
          factory: dreameAutoSelectChildFactory,
        })
      }
    }

    // Mower catalog children. The mower has its own MIoT property space, so it
    // gets its own presence-filtered diagnostics (status/charging/task-status/
    // fault) rendered by the same generic enum-sensor child. Kept separate from
    // the vacuum block because some siids overlap with different meanings.
    if (kind === 'mower') {
      // The mower MAP is its own Image child (cloud-stored batch map → SVG),
      // grouped under the container like the vacuum map. Gated on the model's
      // `canMap`; optimistic before the live handle resolves.
      if (this.modelSupportsMowerMap()) {
        const mapMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Image,
          name: this.name.length > 0 ? `${this.name} map` : 'Map',
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: 'map',
          meta: mapMeta,
          config,
          factory: dreameMowerMapChildFactory,
        })
      }

      // The "Mow" action select: one actionable list (All area + per zone/edge/
      // spot) built from the live map. Collapses HA's 5 interdependent selects.
      // Gated on the model supporting targeted mowing; optimistic before connect.
      if (this.modelSupportsTargetedMowing()) {
        const actionMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Control,
          role: DeviceRole.SelectControl,
          name: this.name.length > 0 ? `${this.name} Mow` : 'Mow',
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: 'mow-action',
          meta: actionMeta,
          config,
          factory: dreameMowerActionChildFactory,
        })

        // "Map" select (HA select.a1_map) at CONTAINER level — switches the
        // active map via setCurrentMap. Lives here, NOT in the image settings.
        const mapSelMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Control,
          role: DeviceRole.SelectControl,
          name: this.name.length > 0 ? `${this.name} Map` : 'Map',
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: 'map-select',
          meta: mapSelMeta,
          config,
          factory: dreameMowerMapSelectChildFactory,
        })
      }

      for (const es of this.presentMowerEnumSensors()) {
        const esMeta: AccessoryChildSpec['meta'] = {
          type: DeviceType.Sensor,
          role: DeviceRole.EnumSensor,
          name: this.name.length > 0 ? `${this.name} ${es.label}` : es.label,
          linkDeviceId: this.id,
          ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
        }
        children.push({
          stableIdSuffix: enumSensorSuffix(es.key),
          meta: esMeta,
          config: {
            ...config,
            siid: es.siid,
            piid: es.piid,
            label: es.label,
            options: es.options,
          },
          factory: dreameEnumSensorChildFactory,
        })
      }

      // Derived "Task" sensor: the live mowing sub-state decoded from the
      // heartbeat (1:1) push. Always spawned for a mower (it reads "Idle" when no
      // session is active) — it is push-driven, not a raw catalog prop.
      const taskMeta: AccessoryChildSpec['meta'] = {
        type: DeviceType.Sensor,
        role: DeviceRole.EnumSensor,
        name: this.name.length > 0 ? `${this.name} Task` : 'Task',
        linkDeviceId: this.id,
        ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
      }
      children.push({
        stableIdSuffix: MOWER_SUBSTATE_SUFFIX,
        meta: taskMeta,
        config,
        factory: dreameMowerSubstateChildFactory,
      })
    }

    return children
  }

  /** Catalog switches the live handle REPORTS (presence: prop is a 0/1 value). */
  private presentSwitches(): readonly (typeof DREAME_SWITCHES)[number][] {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    if (handle === null) return []
    return DREAME_SWITCHES.filter((s) => {
      const v = handle.getProperty(s.siid, s.piid)?.value
      return typeof v === 'number' || typeof v === 'boolean'
    })
  }

  /** Catalog numeric sensors the live handle REPORTS (presence: prop non-null). */
  private presentNumericSensors(): readonly (typeof DREAME_NUMERIC_SENSORS)[number][] {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    if (handle === null) return []
    return DREAME_NUMERIC_SENSORS.filter((s) => {
      const v = handle.getProperty(s.siid, s.piid)?.value
      return typeof v === 'number' && Number.isFinite(v)
    })
  }

  /** Catalog selects the live handle REPORTS (presence: the enum prop is a number). */
  private presentSelects(): readonly (typeof DREAME_SELECTS)[number][] {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    if (handle === null) return []
    return DREAME_SELECTS.filter(
      (s) => typeof handle.getProperty(s.siid, s.piid)?.value === 'number',
    )
  }

  /**
   * Catalog buttons applicable to this model. Actions have no readable state, so
   * a button with NO presence prop is universal (always shown); a button WITH a
   * presence prop (station actions) shows only when the model reports that prop.
   */
  private presentButtons(): readonly (typeof DREAME_BUTTONS)[number][] {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    if (handle === null) return []
    return DREAME_BUTTONS.filter((b) => {
      if (b.presenceSiid === undefined || b.presencePiid === undefined) return true
      const v = handle.getProperty(b.presenceSiid, b.presencePiid)?.value
      return typeof v === 'number' || typeof v === 'boolean'
    })
  }

  /** Catalog enum sensors the live handle REPORTS (presence: the int prop is a number). */
  private presentEnumSensors(): readonly (typeof DREAME_ENUM_SENSORS)[number][] {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    if (handle === null) return []
    return DREAME_ENUM_SENSORS.filter(
      (s) => typeof handle.getProperty(s.siid, s.piid)?.value === 'number',
    )
  }

  /** Mower diagnostic enum sensors the live handle REPORTS (presence: prop is a
   *  number). Only consulted for mower containers — the mower's enum props share
   *  siids with the vacuum's (2/1, 3/2) but carry different meanings, so the kind
   *  gate in getAccessoryChildren keeps the two catalogs from cross-spawning. */
  private presentMowerEnumSensors(): readonly (typeof DREAME_MOWER_ENUM_SENSORS)[number][] {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    if (handle === null) return []
    return DREAME_MOWER_ENUM_SENSORS.filter(
      (s) => typeof handle.getProperty(s.siid, s.piid)?.value === 'number',
    )
  }

  /** Catalog numbers the live handle REPORTS (presence: the value prop is a number). */
  private presentNumbers(): readonly (typeof DREAME_NUMBERS)[number][] {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    if (handle === null) return []
    return DREAME_NUMBERS.filter(
      (s) => typeof handle.getProperty(s.siid, s.piid)?.value === 'number',
    )
  }

  /**
   * Packed auto-switch settings the live vacuum REPORTS. Presence = the key is in
   * the decoded bundle (`supportedAutoSwitchKeys`) AND its value is non-negative
   * (a `-1`/`-n` value is the "not applicable on this firmware" sentinel — Tasshack
   * hides those). Empty until the bundle (siid 4 piid 50) is seeded.
   */
  private presentAutoSwitches(): readonly (typeof DREAME_AUTO_SWITCHES)[number][] {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    if (!(handle instanceof DreameVacuum)) return []
    const supported = new Set(handle.supportedAutoSwitchKeys)
    return DREAME_AUTO_SWITCHES.filter((s) => {
      if (!supported.has(s.autoSwitchKey)) return false
      const v = handle.autoSwitchProperty(s.autoSwitchKey)
      return typeof v === 'number' && v >= 0
    })
  }

  /** Packed auto-switch ENUM settings the live vacuum reports (same presence rule). */
  private presentAutoSelects(): readonly (typeof DREAME_AUTO_SELECTS)[number][] {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    if (!(handle instanceof DreameVacuum)) return []
    const supported = new Set(handle.supportedAutoSwitchKeys)
    return DREAME_AUTO_SELECTS.filter((s) => {
      if (!supported.has(s.autoSwitchKey)) return false
      const v = handle.autoSwitchProperty(s.autoSwitchKey)
      return typeof v === 'number' && v >= 0
    })
  }

  /**
   * Group the auto-spawned AI-switch children into the `AI / Obstacle` accordion
   * section (best-effort; a layout failure never blocks activation). The Vacuum
   * (primary by type priority) and the map stay in the plain Overview. Re-run on
   * every reconcile so a changed supported-feature set re-sections automatically.
   */
  override async onActivate(): Promise<void> {
    await super.onActivate()
    const kind = classifyDreameModel(this.model)
    // The vacuum and mower catalogs share some siids with different meanings, so
    // the layout sections are kind-gated exactly like the spawn block — a mower
    // must not pick up vacuum childKeys (and vice-versa).
    const vacuumLayout =
      kind === 'vacuum'
        ? [
            ...this.presentNumericSensors().map((s) => ({
              childKey: numericSensorSuffix(s.key),
              section: s.section,
            })),
            ...this.presentSwitches().map((s) => ({
              childKey: switchSuffix(s.key),
              section: s.section,
            })),
            ...this.presentSelects().map((s) => ({
              childKey: selectSuffix(s.key),
              section: s.section,
            })),
            ...this.presentButtons().map((b) => ({
              childKey: buttonSuffix(b.key),
              section: b.section,
            })),
            ...this.presentEnumSensors().map((s) => ({
              childKey: enumSensorSuffix(s.key),
              section: s.section,
            })),
            ...this.presentNumbers().map((s) => ({
              childKey: numberSuffix(s.key),
              section: s.section,
            })),
            ...this.presentAutoSwitches().map((s) => ({
              childKey: autoSwitchSuffix(s.key),
              section: s.section,
            })),
            ...this.presentAutoSelects().map((s) => ({
              childKey: autoSelectSuffix(s.key),
              section: s.section,
            })),
          ]
        : []
    const mowerLayout =
      kind === 'mower'
        ? [
            ...this.presentMowerEnumSensors().map((s) => ({
              childKey: enumSensorSuffix(s.key),
              section: s.section,
            })),
            { childKey: MOWER_SUBSTATE_SUFFIX, section: 'Diagnostics' },
          ]
        : []
    const childLayout = [
      ...this.supportedAiFeatures().map((feature) => ({
        childKey: aiSwitchSuffix(feature),
        section: AI_SECTION,
      })),
      ...vacuumLayout,
      ...mowerLayout,
    ]
    if (childLayout.length === 0) return
    try {
      await this.ctx.api.deviceManager.setChildLayout.mutate({ deviceId: this.id, childLayout })
    } catch (err) {
      this.ctx.logger.warn('dreame container: failed to persist childLayout', {
        tags: { deviceId: this.id },
        meta: { dreameDeviceId: this.dreameDeviceId, error: errMsg(err) },
      })
    }
  }

  /** The AI-obstacle features the live model exposes — empty when the handle is
   *  not yet up or the model has no AI obstacle detection. */
  private supportedAiFeatures(): readonly DreameAiFeature[] {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    return handle instanceof DreameVacuum && handle.vacuumCapabilities.hasAiObstacleDetection
      ? handle.supportedAiFeatures
      : []
  }

  /** The live vacuum's capability snapshot, or null when no vacuum handle is up
   *  (account not connected). Shared by the `features` getter + the map predicate. */
  private resolveVacuumCaps(): DreameVacuumCapabilitySnapshot | null {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    if (!(handle instanceof DreameVacuum)) return null
    const caps = handle.vacuumCapabilities
    // aiFeatureCount mirrors the AI-switch spawn set (`supportedAiFeatures()`):
    // the toggles are empty unless `hasAiObstacleDetection`, so the count gates
    // `VacuumHasAi` to exactly match the spawned children.
    return {
      canMap: caps.canMap,
      hasCamera: caps.hasCamera,
      hasAiObstacleDetection: caps.hasAiObstacleDetection,
      aiFeatureCount: caps.hasAiObstacleDetection ? caps.supportedAiFeatures.length : 0,
    }
  }

  /** The live mower's capability snapshot, or null when no mower handle is up.
   *  Shared by the `features` getter + the mower map / targeted-mow predicates. */
  private resolveMowerCaps(): DreameMowerCapabilitySnapshot | null {
    const handle = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
    if (!(handle instanceof DreameMower)) return null
    const caps = handle.mowerCapabilities
    return {
      canMap: caps.canMap,
      canMowAllArea: caps.canMowAllArea,
      canMowZones: caps.canMowZones,
      canMowEdges: caps.canMowEdges,
      canMowSpots: caps.canMowSpots,
    }
  }

  /** Whether this vacuum model supports a cleaning map — gated on the RESOLVED
   *  handle's confirmed capability (false when the handle is not up, never
   *  optimistic). The provider awaits broker login + discovery before the kernel
   *  spawns these children, so the handle is present on the normal boot path; a
   *  null handle here means the account genuinely failed to connect, in which
   *  case the map child is correctly withheld instead of orphaned. */
  private modelSupportsMap(): boolean {
    return vacuumSupportsMap(this.resolveVacuumCaps())
  }

  /** Whether this vacuum model carries an on-board camera — gates the separate
   *  camera + navigation child. Gated on the RESOLVED handle's confirmed
   *  capability (false when the handle is not up, never optimistic). */
  private modelSupportsCamera(): boolean {
    return vacuumSupportsCamera(this.resolveVacuumCaps())
  }

  /** Whether this mower model supports a map — gated on the RESOLVED handle's
   *  confirmed capability (false when the handle is not up, never optimistic). */
  private modelSupportsMowerMap(): boolean {
    return mowerSupportsMap(this.resolveMowerCaps())
  }

  /** Whether this mower model supports targeted (all-area / zone / edge / spot)
   *  mowing — gates the "Mow" action select. Gated on the RESOLVED handle's
   *  confirmed capability (false when the handle is not up, never optimistic). */
  private modelSupportsTargetedMowing(): boolean {
    return mowerSupportsTargetedMowing(this.resolveMowerCaps())
  }
}
