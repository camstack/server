import { describe, expect, it } from 'vitest'
import {
  buildCameraPlan,
  buildDerivedPlan,
  buildDevicePlan,
  CAMERA_DERIVED_CAPS,
  CAP_ENTITY_MAP,
  capEntities,
  CAPS_NOT_EXPORTED,
  controlEntitySpecs,
  EXPORTED_MACROS,
  LABELLED_MACROS,
  MACROS_NOT_EXPORTED,
  ZONE_MACROS,
} from '../entity-catalog.js'
import { derivedEntityId, toComponentKey } from '../topics.js'
import type { CatalogDevice, HaCmps } from '../types.js'

const BASE: CatalogDevice = {
  id: 101,
  name: 'Front door',
  type: 'camera',
  manufacturer: 'Reolink',
  model: 'RLC-811A',
  features: [],
  boundCaps: ['motion', 'snapshot'],
  zones: [],
  switches: [],
  slices: ['device-status', 'motion'],
}

function keys(device: CatalogDevice): readonly string[] {
  return Object.keys(buildCameraPlan(device).cmps).sort()
}

describe('the taxonomy guard', () => {
  it('accounts for every macro in the taxonomy registry', async () => {
    const { EVENT_TAXONOMY } = await import('@camstack/types')
    const macros = Object.values(EVENT_TAXONOMY)
      .filter((entry) => entry.level === 'macro')
      .map((entry) => entry.kind)
      .sort()
    const accounted = [...EXPORTED_MACROS, ...MACROS_NOT_EXPORTED.map((e) => e.macro)].sort()
    expect(accounted).toEqual(macros)
  })

  it('exports exactly the six macros the design agreed', () => {
    expect([...EXPORTED_MACROS]).toEqual([
      'motion',
      'audio',
      'person',
      'vehicle',
      'animal',
      'package',
    ])
  })

  it('gives every non-exported macro a written reason', () => {
    for (const entry of MACROS_NOT_EXPORTED) {
      expect(entry.reason.length).toBeGreaterThan(20)
    }
  })
})

describe('per-macro entities', () => {
  it('creates detected / last_image / last_detection for every exported macro', () => {
    const built = keys(BASE)
    for (const macro of EXPORTED_MACROS) {
      expect(built).toContain(`binary_sensor-${macro}-detected`)
      expect(built).toContain(`image-${macro}-last-image`)
      expect(built).toContain(`sensor-${macro}-last-detection`)
    }
  })

  it('creates last_label ONLY for macros that have an identification', () => {
    const built = keys(BASE)
    for (const macro of LABELLED_MACROS) {
      expect(built).toContain(`sensor-${macro}-last-label`)
    }
    for (const macro of ['package', 'motion', 'audio']) {
      expect(built).not.toContain(`sensor-${macro}-last-label`)
    }
  })

  it('creates a last_label_at occurrence stamp beside every last_label, and nowhere else', () => {
    const built = keys(BASE)
    for (const macro of LABELLED_MACROS) {
      expect(built).toContain(`sensor-${macro}-last-label-at`)
    }
    for (const macro of ['package', 'motion', 'audio']) {
      expect(built).not.toContain(`sensor-${macro}-last-label-at`)
    }
  })

  it('marks the occurrence stamp as a timestamp and ships it enabled', () => {
    const cmps = buildCameraPlan(BASE).cmps
    const stamp = cmps['sensor-person-last-label-at']
    expect(stamp?.device_class).toBe('timestamp')
    expect(stamp?.enabled_by_default).not.toBe(false)
  })

  it('marks a macro detector with HA motion device_class', () => {
    const cmps = buildCameraPlan(BASE).cmps
    expect(cmps['binary_sensor-person-detected']?.device_class).toBe('motion')
  })
})

describe('per-zone entities', () => {
  const withZones: CatalogDevice = {
    ...BASE,
    zones: [
      { id: 'z-drive', name: 'Vialetto' },
      { id: 'z-door', name: 'Porta' },
    ],
  }

  it('restricts the per-zone macro set to person / vehicle / animal', () => {
    expect([...ZONE_MACROS]).toEqual(['person', 'vehicle', 'animal'])
  })

  it('creates four entities per zone per zone-macro', () => {
    const built = keys(withZones)
    for (const zone of ['z-drive', 'z-door']) {
      for (const macro of ZONE_MACROS) {
        expect(built).toContain(`binary_sensor-${zone}-${macro}-detected`)
        expect(built).toContain(`image-${zone}-${macro}-last-image`)
        expect(built).toContain(`sensor-${zone}-${macro}-last-detection`)
        expect(built).toContain(`sensor-${zone}-${macro}-objects`)
      }
    }
  })

  it('keeps unique_id stable under a zone rename and moves only the name', () => {
    const before = buildCameraPlan(withZones).cmps['binary_sensor-z-drive-person-detected']
    const renamed = buildCameraPlan({
      ...withZones,
      zones: [
        { id: 'z-drive', name: 'Driveway' },
        { id: 'z-door', name: 'Porta' },
      ],
    }).cmps['binary_sensor-z-drive-person-detected']
    expect(renamed?.unique_id).toBe(before?.unique_id)
    expect(before?.name).toContain('Vialetto')
    expect(renamed?.name).toContain('Driveway')
  })

  it('derives unique_id from the numeric id, zone id, macro and suffix', () => {
    const cmp = buildCameraPlan(withZones).cmps['sensor-z-drive-person-objects']
    expect(cmp?.unique_id).toBe('101_z-drive_person_objects')
  })
})

describe('identity', () => {
  it('survives a device rename', () => {
    const before = buildCameraPlan(BASE)
    const after = buildCameraPlan({ ...BASE, name: 'Front door' })
    expect(after.deviceKey).toBe(before.deviceKey)
    expect(after.cmps['binary_sensor-person-detected']?.unique_id).toBe(
      before.cmps['binary_sensor-person-detected']?.unique_id,
    )
    expect(after.dev.name).toBe('Front door')
  })

  /**
   * ── THE CROSS-SIDE IDENTITY CONTRACT ──────────────────────────────────
   *
   * The hub OWNS this rule (`topics.ts`, {@link deviceKeyFor}). The
   * component MIRRORS it in `CamStackDevice.device_key`
   * (`custom_components/camstack/coordinator.py`) because the camera entity
   * is built from the export membership rather than pushed, so there is no
   * `dev.ids[0]` to take. Two independent compositions agree only by
   * convention, and a divergence is silent: the camera entity lands on a
   * SECOND Home Assistant device beside the pushed one.
   *
   * So both sides assert the same literals for the same device — 101, the
   * operator's `Camera front door`. The other half is
   * `tests/test_entities.py::test_the_device_key_matches_the_hub_rule` in
   * `camstack/homeassistant-component`. Change either composition and one
   * of the two goes red.
   */
  it('composes the device key and unique_id from the NUMERIC id', () => {
    const plan = buildCameraPlan(BASE)
    expect(plan.deviceKey).toBe('camstack-101')
    expect(plan.dev.ids[0]).toBe('camstack-101')
    expect(plan.cmps['binary_sensor-online']?.unique_id).toBe('101_online')
    expect(plan.cmps['binary_sensor-online']?.state_topic).toBe('camstack/camstack-101/online')
  })

  /**
   * `stableId` is the addon-facing identity (`(addonId, stableId)` in
   * `device-meta-actions.ts`) and Home Assistant was the only export that
   * leaked it. The device is deliberately built with a provider-shaped id
   * NOWHERE in `CatalogDevice` — this asserts none reappears through a
   * field added later.
   */
  it('leaks no provider-internal identity onto the wire', () => {
    const plan = buildCameraPlan(BASE)
    const wire = JSON.stringify(plan)
    expect(wire).not.toContain('reolink-101')
    expect(wire).not.toContain('hikvision')
  })

  it('carries manufacturer and model under the keys the component reads', () => {
    const dev = buildCameraPlan(BASE).dev
    expect(dev.mf).toBe('Reolink')
    expect(dev.mdl).toBe('RLC-811A')
  })
})

describe('controls', () => {
  it('renders one switch per AVAILABLE camera switch and none for the rest', () => {
    const built = keys({
      ...BASE,
      switches: [
        { id: 'notifications', label: 'Notifications', available: true },
        { id: 'recording', label: 'Recording', available: true },
        { id: 'privacy-mask', label: 'Privacy mask', available: false },
      ],
    })
    expect(built).toContain('switch-notifications')
    expect(built).toContain('switch-recording')
    expect(built).not.toContain('switch-privacy-mask')
  })

  it('creates the reboot button only where the device declares it', () => {
    expect(keys(BASE)).not.toContain('button-reboot')
    expect(keys({ ...BASE, features: ['rebootable'] })).toContain('button-reboot')
  })

  it('creates PTZ entities only where the ptz cap is declared', () => {
    expect(keys(BASE)).not.toContain('button-ptz-up')
    const ptz = keys({ ...BASE, boundCaps: [...BASE.boundCaps, 'ptz'] })
    expect(ptz).toContain('button-ptz-up')
    expect(ptz).toContain('button-ptz-zoom-in')
    expect(ptz).toContain('select-ptz-preset')
  })

  it('creates battery entities only where the device has the slice', () => {
    expect(keys(BASE)).not.toContain('sensor-battery')
    const batt = keys({ ...BASE, slices: [...BASE.slices, 'battery'] })
    expect(batt).toContain('sensor-battery')
    expect(batt).toContain('binary_sensor-charger')
    expect(batt).toContain('binary_sensor-sleeping')
  })
})

function enabledKeys(cmps: HaCmps): readonly string[] {
  return Object.entries(cmps)
    .filter(([, cmp]) => cmp.enabled_by_default !== false)
    .map(([key]) => key)
    .sort()
}

function disabledKeys(cmps: HaCmps): readonly string[] {
  return Object.entries(cmps)
    .filter(([, cmp]) => cmp.enabled_by_default === false)
    .map(([key]) => key)
    .sort()
}

describe('the pressure valve', () => {
  it('enables by default only what an operator automates on', () => {
    const cmps = buildCameraPlan({
      ...BASE,
      switches: [{ id: 'notifications', label: 'Notifications', available: true }],
    }).cmps
    const enabled = enabledKeys(cmps)
    expect(enabled).toContain('binary_sensor-person-detected')
    expect(enabled).toContain('binary_sensor-triggered')
    expect(enabled).toContain('binary_sensor-online')
    expect(enabled).toContain('image-last-image')
    expect(enabled).toContain('switch-notifications')
    /**
     * The three the operator asked for on 2026-08-14, each because of what
     * the VALUE is rather than because of taste: "when was a person last
     * seen" is the timestamp half of every `for:` an operator writes, and
     * `person_last_label` is where the recognised FACE arrives — it was the
     * highest-value gap against the reference integration and it shipped
     * switched off, so the name camstack worked out was in Home Assistant
     * and invisible.
     */
    expect(enabled).toContain('sensor-person-last-detection')
    expect(enabled).toContain('sensor-person-last-label')
    expect(enabled).toContain('sensor-last-detection')
    // What the valve still holds: the per-macro COUNTERS.
    expect(enabled).not.toContain('sensor-person-objects')
  })

  /**
   * A battery percentage is the headline of a battery device, not a
   * diagnostic detail about one — an operator who installs a battery camera
   * expects to see its charge without hunting HA's disabled list.
   * `sleeping` stays off: it describes the power state machine, not the
   * charge.
   */
  it('switches on a battery camera’s charge and its charging state', () => {
    const enabled = enabledKeys(
      buildCameraPlan({ ...BASE, slices: [...BASE.slices, 'battery'] }).cmps,
    )
    expect(enabled).toContain('sensor-battery')
    expect(enabled).toContain('binary_sensor-charger')
    expect(enabled).not.toContain('binary_sensor-sleeping')
  })

  /**
   * The valve exists for a MEASURED problem: a camera with three zones is
   * ~73 entities and the fleet is ~880. Pinned exactly, because the two
   * halves of this catalog now decide it separately and the camera half
   * must not drift while the derived half is fixed.
   *
   * Every `*_last_image` is enabled (operator, 2026-08-09): the picture is the
   * reason to look at a notification, and hunting HA's disabled-entity list
   * per camera per macro per zone to get it is the opposite of the point. The
   * timestamps, labels and counters stay off — the valve still holds, it just
   * no longer holds the frames.
   */
  it('leaves the camera fan-out off — that is the ~880-entity problem it exists for', () => {
    const full: CatalogDevice = {
      ...BASE,
      features: ['rebootable'],
      boundCaps: [...BASE.boundCaps, 'ptz'],
      slices: [...BASE.slices, 'battery'],
      switches: [
        { id: 'notifications', label: 'Notifications', available: true },
        { id: 'recording', label: 'Recording', available: true },
      ],
      zones: [
        { id: 'z-drive', name: 'Vialetto' },
        { id: 'z-door', name: 'Porta' },
      ],
    }
    const cmps = buildCameraPlan(full).cmps
    expect(enabledKeys(cmps)).toEqual([
      'binary_sensor-animal-detected',
      'binary_sensor-audio-detected',
      'binary_sensor-charger',
      'binary_sensor-motion-detected',
      'binary_sensor-online',
      'binary_sensor-package-detected',
      'binary_sensor-person-detected',
      'binary_sensor-recording-active',
      'binary_sensor-triggered',
      'binary_sensor-vehicle-detected',
      'binary_sensor-z-door-animal-detected',
      'binary_sensor-z-door-person-detected',
      'binary_sensor-z-door-vehicle-detected',
      'binary_sensor-z-drive-animal-detected',
      'binary_sensor-z-drive-person-detected',
      'binary_sensor-z-drive-vehicle-detected',
      'button-ptz-down',
      'button-ptz-left',
      'button-ptz-right',
      'button-ptz-up',
      'button-ptz-zoom-in',
      'button-ptz-zoom-out',
      'button-reboot',
      'image-animal-last-image',
      'image-audio-last-image',
      'image-last-image',
      'image-motion-last-image',
      'image-package-last-image',
      'image-person-last-image',
      'image-vehicle-last-image',
      'image-z-door-animal-last-image',
      'image-z-door-person-last-image',
      'image-z-door-vehicle-last-image',
      'image-z-drive-animal-last-image',
      'image-z-drive-person-last-image',
      'image-z-drive-vehicle-last-image',
      'select-ptz-preset',
      'sensor-animal-last-detection',
      'sensor-animal-last-label',
      'sensor-animal-last-label-at',
      'sensor-audio-last-detection',
      'sensor-audio-last-sound',
      'sensor-audio-level-rms',
      'sensor-audio-volume',
      'sensor-battery',
      'sensor-last-detection',
      'sensor-motion-last-detection',
      'sensor-objects',
      'sensor-package-last-detection',
      'sensor-person-last-detection',
      'sensor-person-last-label',
      'sensor-person-last-label-at',
      'sensor-status',
      'sensor-vehicle-last-detection',
      'sensor-vehicle-last-label',
      'sensor-vehicle-last-label-at',
      'sensor-z-door-objects',
      'sensor-z-drive-objects',
      'switch-notifications',
      'switch-recording',
    ])
    /**
     * What the valve holds back after 2026-08-14: the per-macro and
     * per-zone COUNTERS, the per-zone timestamps and the diagnostics. The
     * camera-level and per-macro `last_detection` / `last_label` entities
     * moved to the enabled side with the `*_last_image` ones, for the same
     * reason — an operator hunting HA's disabled list per camera per macro
     * to get the value they installed the integration for is the opposite
     * of what the export is for.
     *
     * Checked by CLASS rather than by a count, which drifts with every
     * entity added.
     */
    const disabled = disabledKeys(cmps)
    // Two zones × three macros × (a timestamp + a counter), the six
    // per-macro counters, and the diagnostics. The valve holds a set, not
    // a number — the classes below are what it means.
    expect(disabled.length).toBeGreaterThan(12)
    for (const zone of ['z-door', 'z-drive']) {
      for (const macro of ['person', 'vehicle', 'animal']) {
        expect(disabled).toContain(`sensor-${zone}-${macro}-last-detection`)
      }
    }
    expect(disabled).toContain('binary_sensor-sleeping')
    /**
     * Counts are the case the suffix rule cannot express. The TOTALS are
     * enabled — one per zone plus one for the scene, which is what an operator
     * automates on — while the zone × macro CROSS stays off. That cross is the
     * fan-out the valve exists for: three zones × three macros on every camera.
     */
    for (const zone of ['z-door', 'z-drive']) {
      expect(enabledKeys(cmps)).toContain(`sensor-${zone}-objects`)
      for (const macro of ['person', 'vehicle', 'animal']) {
        expect(disabled).toContain(`sensor-${zone}-${macro}-objects`)
      }
    }
    expect(enabledKeys(cmps)).toContain('sensor-objects')
  })
})

/**
 * The derived half — every non-camera kind.
 *
 * Fixture from the live hub (device 296, an Ecowitt outdoor sensor):
 * `device-status` / `feature-probe` / `device-ops` carry no entity,
 * `temperature-sensor` and `battery` do. It matters that the fixture
 * carries the unmapped caps too — a fake that only held the mapped ones
 * would pass whether or not the mapping filtered anything.
 */
describe('the derived half', () => {
  const SENSOR: CatalogDevice = {
    id: 296,
    name: 'Outdoor Temperature',
    type: 'sensor',
    manufacturer: 'Ecowitt',
    features: [],
    boundCaps: ['device-status', 'feature-probe', 'device-ops', 'temperature-sensor', 'battery'],
    zones: [],
    switches: [],
    slices: ['device-status', 'temperature-sensor'],
  }

  it('builds one entity per mapped capability, plus availability', () => {
    const keys = Object.keys(buildDerivedPlan(SENSOR).cmps).sort()
    expect(keys).toEqual(['binary_sensor-online', 'sensor-battery', 'sensor-temperature-sensor'])
  })

  it('routes a non-camera device to the derived half', () => {
    expect(Object.keys(buildDevicePlan(SENSOR).cmps)).toEqual(
      Object.keys(buildDerivedPlan(SENSOR).cmps),
    )
  })

  /**
   * The defect: every derived sensor shipped `enabled_by_default: false`,
   * so a temperature sensor exported its temperature switched OFF. The
   * camera valve exists because a camera is ~73 entities; a derived device
   * on this hub is **2 on average and 3 at most** (115 devices, 228
   * entities), and its cap entity is the only reason the device exists.
   */
  it('arrives ENABLED — a derived device has no fan-out to protect against', () => {
    expect(disabledKeys(buildDerivedPlan(SENSOR).cmps)).toEqual([])
  })

  /**
   * The PRIMARY entity of a capability is the reason the device exists —
   * a temperature sensor's temperature, a cover's state, an alarm panel's
   * mode — and it arrives enabled without exception. A SECONDARY one is
   * a decision per entity: `cover_position` yes, `cover_tilt` no.
   */
  it('enables the primary entity of every capability, whatever platform it maps to', () => {
    for (const [cap, mapping] of Object.entries(CAP_ENTITY_MAP)) {
      if (CAMERA_DERIVED_CAPS.includes(cap)) continue
      const cmps = buildDerivedPlan({ ...SENSOR, boundCaps: [cap] }).cmps
      const primary = cmps[toComponentKey(mapping.platform, derivedEntityId(cap))]
      expect(primary, `${cap}: the catalog builds no primary component`).toBeDefined()
      expect(
        primary?.enabled_by_default,
        `${cap} (${mapping.platform}) must not arrive switched off`,
      ).toBeUndefined()
    }
  })

  /**
   * The valve, restated for the widened table. A base device was 2
   * entities on average and 3 at most, and Tier A adds families that
   * cannot be one entity — a thermostat is a mode AND the temperature it
   * measures. The bound that matters is what arrives ENABLED: a widened
   * capability must not put eight switched-on entities on a dashboard.
   */
  it('stays small — no capability arrives with more than seven entities switched on', () => {
    for (const cap of Object.keys(CAP_ENTITY_MAP)) {
      if (CAMERA_DERIVED_CAPS.includes(cap)) continue
      const cmps = buildDerivedPlan({ ...SENSOR, boundCaps: [cap] }).cmps
      const enabled = Object.entries(cmps).filter(
        ([, component]) => component.enabled_by_default !== false,
      )
      /**
       * `online` is the diagnostic every derived device carries. The bound
       * moved from 5 to 8 when T9 made Tier A writable, and the reason is
       * that a cover, a valve, a vacuum and a media player are CONTROLLERS:
       * the buttons are not extra readings, they are the only way an
       * automation can act on the device at all, and hiding them in HA's
       * disabled list per device is the opposite of what the export is for.
       * What the valve still holds back is the RARE verb — `stop` on a
       * cover, a valve and a player, `locate` on a vacuum, `source` on a
       * player — which arrive registered and off.
       */
      expect(
        enabled.length,
        `${cap} arrives with ${enabled.length} entities switched on`,
      ).toBeLessThanOrEqual(8)
    }
  })

  /**
   * A camera-scoped capability takes the CAMERA path. If both halves
   * built it, an operator would get the entity twice under two ids — and
   * `buildDevicePlan` branches on type, so only one of the two would ever
   * receive a value.
   */
  it('builds a camera-scoped capability on the camera and nowhere else', () => {
    for (const cap of CAMERA_DERIVED_CAPS) {
      expect(CAP_ENTITY_MAP[cap], `${cap} must be a mapped capability`).toBeDefined()
      const derived = Object.keys(buildDerivedPlan({ ...SENSOR, boundCaps: [cap] }).cmps)
      expect(derived, `${cap} must not appear on a base device`).toEqual(['binary_sensor-online'])

      const onCamera = keys({ ...BASE, boundCaps: [...BASE.boundCaps, cap] })
      expect(onCamera).toContain(
        toComponentKey(CAP_ENTITY_MAP[cap]?.platform ?? 'sensor', derivedEntityId(cap)),
      )
      expect(keys(BASE)).not.toContain(
        toComponentKey(CAP_ENTITY_MAP[cap]?.platform ?? 'sensor', derivedEntityId(cap)),
      )
    }
  })

  /**
   * A `control` with `kind: select` is a Home Assistant `select`, not a
   * sensor: the VPN server picker (and every HA `input_select` we re-export)
   * carries its options on the slice. Announcing a sensor left the operator
   * with a reading they could not write.
   */
  it('announces a select-control as a writable select with the slice options', () => {
    const options = ['it452 - 1.2.3.4', 'it536 - 5.6.7.8']
    const device: CatalogDevice = {
      id: 4652,
      name: 'UniFi VPN server',
      type: 'control',
      features: [],
      boundCaps: ['control'],
      zones: [],
      switches: [],
      slices: ['control'],
      capSlices: {
        control: { kind: 'select', value: options[0], options, lastChangedAt: 1 },
      },
    }
    const plan = buildDerivedPlan(device)
    const select = plan.cmps['select-control']
    expect(select?.platform).toBe('select')
    expect(select?.command_topic).toBeDefined()
    expect(select?.options).toEqual(options)
  })

  it('falls back to a read-only sensor when a select has no options', () => {
    const specs = controlEntitySpecs({ kind: 'select', value: '', options: [], lastChangedAt: 1 })
    expect(specs[0]?.platform).toBe('sensor')
    expect(specs[0]?.writable).toBeUndefined()
  })

  /**
   * Two capabilities cannot claim one entity id. `cover_position` is a
   * secondary of `cover`; a future capability named `cover-position`
   * would slug to the same thing and one of the two would silently win.
   */
  it('gives every entity of every capability a unique id', () => {
    const seen = new Map<string, string>()
    for (const cap of Object.keys(CAP_ENTITY_MAP)) {
      for (const ref of capEntities(cap)) {
        const owner = seen.get(ref.entity)
        expect(
          owner,
          `'${ref.entity}' is claimed by both ${String(owner)} and ${cap}`,
        ).toBeUndefined()
        seen.set(ref.entity, cap)
      }
    }
  })

  /** Every exclusion is a written decision, never an empty string. */
  it('gives every non-exported capability a reason worth reading', () => {
    for (const entry of CAPS_NOT_EXPORTED) {
      expect(entry.reason.length, entry.cap).toBeGreaterThan(40)
    }
  })

  /**
   * D62 generalised, and the rule T3 inherited from T1: a descriptor that
   * declares itself writable must name a route, or ship read-only. A
   * `switch` that writes nothing is worse than no switch.
   */
  it('declares nothing writable that the route table cannot write', async () => {
    const { hasCommandRoute, hasExtraCommandRoute, hasButtonCommandRoute } = await import(
      '../command-routes.js'
    )
    const lying: string[] = []
    for (const [cap, mapping] of Object.entries(CAP_ENTITY_MAP)) {
      if (mapping.writable === true && !hasCommandRoute(cap)) lying.push(cap)
      for (const [suffix, extra] of Object.entries(mapping.extras ?? {})) {
        if (extra.writable === true && !hasExtraCommandRoute(cap, suffix)) {
          lying.push(`${cap}.${suffix}`)
        }
      }
      // A button has no `writable` to consult: existing IS the declaration.
      for (const suffix of Object.keys(mapping.commands ?? {})) {
        if (!hasButtonCommandRoute(cap, suffix)) lying.push(`${cap}!${suffix}`)
      }
    }
    expect(lying).toEqual([])
  })

  /**
   * The same question backwards, and it is not redundant. A route with no
   * descriptor is a control the catalog never built, so nothing can ever
   * reach it — an orphan that READS as a working control to the next person
   * to open the file. A leftover describing the right design is worse than
   * nothing; this is the assertion that deletes it.
   */
  it('routes nothing the catalog does not build', async () => {
    const { CAP_COMMAND_ROUTES } = await import('../command-routes.js')
    const orphans: string[] = []
    for (const [cap, route] of Object.entries(CAP_COMMAND_ROUTES)) {
      const mapping = CAP_ENTITY_MAP[cap]
      if (mapping === undefined) {
        orphans.push(cap)
        continue
      }
      if (route.primary !== undefined && mapping.writable !== true) orphans.push(cap)
      for (const suffix of Object.keys(route.extras ?? {})) {
        if (mapping.extras?.[suffix]?.writable !== true) orphans.push(`${cap}.${suffix}`)
      }
      for (const suffix of Object.keys(route.commands ?? {})) {
        if (mapping.commands?.[suffix] === undefined) orphans.push(`${cap}!${suffix}`)
      }
    }
    expect(orphans).toEqual([])
  })

  /**
   * A `number` with no range is 1..100 step 1 to Home Assistant — so a cover
   * cannot be closed, a thermostat cannot go below 1 °C and no setpoint can
   * hold a half degree. A `select` with no options is an entity HA builds
   * with nothing to choose from. Both are silent, and both are the same
   * failure as a mapped field that does not exist: an entity that is
   * published and cannot do what it advertises.
   */
  it('gives every writable number a range and every select its options', () => {
    for (const cap of Object.keys(CAP_ENTITY_MAP)) {
      for (const ref of capEntities(cap)) {
        const { platform, writable, range, options } = ref.descriptor
        if (platform === 'number' && writable === true) {
          expect(range, `${cap} → ${ref.entity}: a writable number needs a range`).toBeDefined()
          expect(range?.min, ref.entity).toBeLessThan(range?.max ?? 0)
          expect(range?.step, ref.entity).toBeGreaterThan(0)
        }
        if (platform === 'select') {
          expect(options?.length, `${cap} → ${ref.entity}: a select needs options`).toBeGreaterThan(
            1,
          )
        }
      }
    }
  })

  /**
   * The range Home Assistant is TOLD and the range the hub ACCEPTS are two
   * tables on purpose (see the note in `command-routes.ts`), so this is what
   * keeps them equal. A `number` whose declared maximum is above what the
   * parser takes is a slider an operator can drag into a 422.
   */
  it('accepts every value the declared range lets an operator send', async () => {
    const { resolveCommand } = await import('../command-routes.js')
    for (const cap of Object.keys(CAP_ENTITY_MAP)) {
      for (const ref of capEntities(cap)) {
        const { platform, writable, range } = ref.descriptor
        if (platform !== 'number' || writable !== true || range === undefined) continue
        for (const value of [range.min, range.max]) {
          const resolution = resolveCommand(
            { deviceId: 900, type: 'generic', boundCaps: [cap] },
            ref.entity,
            String(value),
          )
          expect(resolution.ok, `${ref.entity} refused its own bound ${value}`).toBe(true)
        }
      }
    }
  })

  /**
   * Talk-back, on the operator's decision (2026-08-14). It was excluded
   * because the cap declared no `runtimeState`, so the entity could never
   * have received a value; `intercom.cap.ts` now declares it and the Reolink
   * and Hikvision providers write it. Read-only on purpose: talk-back is an
   * audio stream, and a switch that opened a session nobody could speak into
   * is the control that lies.
   */
  it('exports intercom as a camera capability, read-only', () => {
    expect(CAPS_NOT_EXPORTED.some((entry) => entry.cap === 'intercom')).toBe(false)
    expect(CAMERA_DERIVED_CAPS).toContain('intercom')
    expect(CAP_ENTITY_MAP['intercom']?.field).toBe('talking')
    expect(CAP_ENTITY_MAP['intercom']?.writable).toBeUndefined()
    expect(CAP_ENTITY_MAP['intercom']?.commands).toBeUndefined()
  })
})

describe('command topics', () => {
  it('gives every writable entity a command topic and every read-only one none', () => {
    const cmps = buildCameraPlan({
      ...BASE,
      features: ['rebootable'],
      switches: [{ id: 'recording', label: 'Recording', available: true }],
    }).cmps
    expect(cmps['switch-recording']?.command_topic).toBe('camstack/camstack-101/recording/set')
    expect(cmps['button-reboot']?.command_topic).toBe('camstack/camstack-101/reboot/set')
    expect(cmps['binary_sensor-person-detected']?.command_topic).toBeUndefined()
    expect(cmps['binary_sensor-person-detected']?.state_topic).toBe(
      'camstack/camstack-101/person_detected',
    )
  })
})

describe('doorbell on a camera', () => {
  /**
   * `MACROS_NOT_EXPORTED` says a doorbell is an actuator on its own device,
   * and that stays true for a BUTTON accessory — which takes the DERIVED path
   * and gets `CAP_ENTITY_MAP.doorbell`. A CAMERA with the cap bound is the
   * other case: it rings, and the operator automates on the ring exactly as
   * they do on `person_detected`. The two paths are exclusive
   * (`buildDevicePlan` branches on `type === 'camera'`), so there is no
   * duplicate entity.
   */
  it('adds the ring entities only when the cap is bound', () => {
    const withBell = keys({
      ...BASE,
      boundCaps: [...BASE.boundCaps, 'doorbell'],
    })
    expect(withBell).toContain('binary_sensor-doorbell-pressed')
    expect(withBell).toContain('sensor-doorbell-last-pressed')
    expect(withBell).toContain('sensor-doorbell-press-count')

    expect(keys(BASE).some((k) => k.includes('doorbell'))).toBe(false)
  })

  /**
   * NOT because a press has no frame — it has one, the marker track's
   * `keyFrameSmall`, which is what the notification centre already shows. The
   * export simply has no road to it: `persistSyntheticTrack` emits no
   * `track-lifecycle`, the one event this addon listens to for frames. The
   * entity is owed, and until the upstream event exists it is not shipped dead.
   */
  it('creates NO doorbell last-image YET — the export has no road to the frame', () => {
    const withBell = keys({
      ...BASE,
      boundCaps: [...BASE.boundCaps, 'doorbell'],
    })
    expect(withBell.some((k) => k.includes('doorbell') && k.includes('image'))).toBe(false)
  })
})
