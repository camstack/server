import {
  DeviceType,
  type AccessoryChildSpec,
  type ChildLayout,
  type ChildLayoutEntry,
} from '@camstack/types'
import { z } from 'zod'
import { ENPAL_SYSTEM } from './config.js'
import { findSpec } from './enpal-catalog.js'
import type { EnpalSnapshot } from './enpal-snapshot.js'
import { enpalSensorFactory } from './devices/enpal-sensor-factory.js'

/**
 * One child of an equipment Container: the catalog entry, the accordion section it sits in
 * (none when the Container has no sections), and whether it is a diagnostic. A diagnostic keeps
 * its history but is hidden from the Container's list by default (`display.hidden`, the field
 * the child list already honours).
 */
export interface EquipmentChild {
  readonly specId: string
  readonly section?: string
  readonly diagnostic: boolean
}

/** One identity fact of the equipment: a device attribute fed by a text key of the box. */
export interface MetadataField {
  readonly attribute: string
  readonly key: string
}

/**
 * How a piece is adopted: the box itself is the integration's {@link DeviceType.Gateway}, and
 * each other piece is a {@link DeviceType.Container}. Both carry Sensor children.
 */
export type EnpalEquipmentKind = 'gateway' | 'container'

/** One physical piece of the installation, with the catalog entries it owns. */
export interface EnpalEquipment {
  readonly id: string
  readonly kind: EnpalEquipmentKind
  /** The default name of the adopted device (the box takes its integration's name first). */
  readonly name: string
  readonly children: readonly EquipmentChild[]
  /** Model, hardware type, serials and firmware: attributes of the Container, never sensors. */
  readonly metadata: readonly MetadataField[]
  /**
   * Which child stands for the Container, most preferred first. Stamped on the adopted device
   * as `primaryChildPreference`; the framework takes the first one that exists, whatever order
   * the children come back in. Empty for the gateway, which stands for itself.
   */
  readonly primaryChildPreference: readonly string[]
  /** Derived: the spec ids of {@link children}, in order. */
  readonly specIds: readonly string[]
}

const live = (section: string | undefined, ...specIds: string[]): EquipmentChild[] =>
  specIds.map((specId) => ({
    specId,
    ...(section !== undefined ? { section } : {}),
    diagnostic: false,
  }))

const diag = (section: string | undefined, ...specIds: string[]): EquipmentChild[] =>
  specIds.map((specId) => ({
    specId,
    ...(section !== undefined ? { section } : {}),
    diagnostic: true,
  }))

function equipment(input: Omit<EnpalEquipment, 'specIds'>): EnpalEquipment {
  return { ...input, specIds: input.children.map((c) => c.specId) }
}

/** The equipment id, and `childNativeId`, of the box itself: the integration's Gateway. */
export const ENPAL_BOX_ID = 'box'

/**
 * Three adoptable pieces: the box (the Gateway, with its connection, firmware and
 * diagnostics), the installation (System: Sungrow inverter, battery, grid, house meter), and
 * the heat pump as the box reads it. Order is the order the candidates are listed in. Every
 * catalog entry belongs to one. The ids of the older catalog entries are unchanged.
 */
export const ENPAL_EQUIPMENT: readonly EnpalEquipment[] = [
  equipment({
    id: ENPAL_BOX_ID,
    kind: 'gateway',
    name: 'Enpal Box',
    children: [
      ...diag('Box', 'box-main-state', 'box-cpu-load', 'box-memory-usage', 'box-hardware-check'),
      ...diag('EEBUS', 'eebus-connection', 'eebus-discovery', 'eebus-cert-expiry'),
      ...diag(
        'Connectivity',
        'lte-state',
        'lte-connection-type',
        'lte-quality',
        'lte-rsrp',
        'lte-rsrq',
        'lte-rssi',
        'lte-snr',
        'lte-failover',
        'lte-signal-check',
        'wifi-state',
        'data-lan-down',
        'data-lan-up',
        'data-lte-down',
        'data-lte-up',
      ),
    ],
    metadata: [
      { attribute: 'deviceName', key: 'Device.Name' },
      { attribute: 'model', key: 'IoTEdgeDevice.Device.Type' },
      { attribute: 'serialNumber', key: 'IoTEdgeDevice.SerialNumber' },
      { attribute: 'hardware', key: 'Generation.HW' },
      { attribute: 'softwareGeneration', key: 'Generation.SW' },
      { attribute: 'eebusSki', key: 'Eebus.Ski' },
      { attribute: 'modemModel', key: 'LTE.Modem.Type' },
      { attribute: 'modemFirmware', key: 'LTE.Modem.Firmware.Version' },
    ],
    primaryChildPreference: [],
  }),
  equipment({
    id: 'impianto',
    kind: 'container',
    name: 'System',
    children: [
      ...live('Photovoltaic', 'pv', 'pv-string-1-power', 'pv-string-2-power', 'pv-energy-day'),
      ...diag(
        'Photovoltaic',
        'pv-string-1-voltage',
        'pv-string-2-voltage',
        'pv-string-1-current',
        'pv-string-2-current',
      ),
      ...live(
        'Battery',
        'battery',
        'battery-stored-energy',
        'battery-temperature',
        'battery-charge-day',
        'battery-discharge-day',
        'battery-charged',
        'battery-discharged',
      ),
      ...diag(
        'Battery',
        'battery-health',
        'battery-capacity',
        'battery-power-rating',
        'battery-level-max',
        'battery-level-min',
        'battery-power-set',
        'battery-charge-power-max',
        'battery-discharge-power-max',
        'battery-charge-current-max',
        'battery-discharge-current-max',
      ),
      ...live(
        'Grid',
        'grid-import',
        'grid-export',
        'grid-phase-a',
        'grid-phase-b',
        'grid-phase-c',
        'grid-import-day',
        'grid-export-day',
      ),
      ...diag(
        'Grid',
        'grid-voltage-a',
        'grid-voltage-b',
        'grid-voltage-c',
        'grid-frequency',
        'grid-feed-max',
      ),
      ...live('Home', 'house', 'house-energy-day'),
      ...live('Inverter', 'inverter-state', 'inverter-ems-mode', 'inverter-ac-power'),
      ...diag(
        'Inverter',
        'inverter-start-stop',
        'inverter-forcible-mode',
        'inverter-temperature',
        'inverter-power-rating',
        'inverter-phase-type',
        'inverter-modbus-rtu',
        'inverter-modbus-tcp',
      ),
    ],
    metadata: [
      { attribute: 'model', key: 'Code.Device.Type' },
      { attribute: 'firmware', key: 'SoftwareVersion.Service.1' },
      { attribute: 'communicationFirmware', key: 'SoftwareVersion.Service.2' },
      { attribute: 'dongleSerialNumber', key: 'Dongle.SerialNumber' },
      { attribute: 'batterySerialNumber', key: 'SerialNumber.Battery' },
      {
        attribute: 'batteryFirmware',
        key: 'SoftwareVersion.Service.Battery.Unit.1',
      },
    ],
    primaryChildPreference: ['pv', 'battery', 'house'],
  }),
  equipment({
    id: 'heatpump',
    kind: 'container',
    name: 'Heat pump (Enpal)',
    children: [
      ...live(
        undefined,
        'heatpump',
        'heatpump-hot-water',
        'heatpump-outside',
        'heatpump-hot-water-mode',
        'heatpump-heating-mode',
        'heatpump-generator-state',
        'heatpump-heater-state',
      ),
      ...diag(
        undefined,
        'heatpump-energy-management',
        'heatpump-power-desired',
        'heatpump-pv-optimization',
        'heatpump-power-min',
        'heatpump-power-max',
        'heatpump-connection',
      ),
    ],
    metadata: [
      { attribute: 'model', key: 'Heatpump.IndoorUnit.DeviceType' },
      { attribute: 'serialNumber', key: 'Heatpump.SerialNumber' },
      {
        attribute: 'indoorUnitSerialNumber',
        key: 'Heatpump.IndoorUnit.SerialNumber',
      },
      { attribute: 'firmware', key: 'Heatpump.SoftwareVersion' },
      {
        attribute: 'indoorUnitFirmware',
        key: 'Heatpump.IndoorUnit.SoftwareVersion',
      },
      { attribute: 'gatewayModel', key: 'Heatpump.Gateway.Device.Type' },
      {
        attribute: 'gatewaySerialNumber',
        key: 'Heatpump.Gateway.SerialNumber',
      },
      { attribute: 'gatewayFirmware', key: 'Heatpump.Gateway.SoftwareVersion' },
    ],
    primaryChildPreference: ['heatpump', 'heatpump-hot-water', 'heatpump-outside'],
  }),
]

export function findEquipment(id: string): EnpalEquipment | undefined {
  return ENPAL_EQUIPMENT.find((e) => e.id === id)
}

/** The `childNativeId` of a child candidate: namespaced by its container. */
export function childNativeId(equipmentId: string, specId: string): string {
  return `${equipmentId}#${specId}`
}

/**
 * Persisted config of an equipment Container. `specIds` are the children it was adopted with:
 * they stay, whatever the box reports later, so a restart with the box off keeps them.
 */
export const enpalEquipmentSchema = z.object({
  equipment: z
    .string()
    .min(1)
    .describe(
      'Equipment id (impianto, heatpump; older adoptions: pv, battery, grid, house)',
    ),
  specIds: z.array(z.string().min(1)).describe('Catalog entries adopted as children'),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(ENPAL_SYSTEM).optional(),
})

export type EnpalEquipmentConfig = z.infer<typeof enpalEquipmentSchema>

/**
 * The declared primary children of an adopted piece: its preference, limited to the children
 * it was adopted with. Empty for the gateway and for an equipment id the catalog dropped.
 */
export function primaryChildPreferenceOf(
  found: EnpalEquipment | undefined,
  specIds: readonly string[],
): readonly string[] {
  if (found === undefined) return []
  return found.primaryChildPreference.filter((id) => specIds.includes(id))
}

/**
 * The accordion layout of an equipment Container, for the children it was adopted with.
 * Empty for a Container with no sections (the heat pump) or an unknown equipment.
 */
export function childLayoutOf(
  found: EnpalEquipment | undefined,
  specIds: readonly string[],
): ChildLayout {
  if (found === undefined) return []
  const entries: ChildLayoutEntry[] = []
  found.children.forEach((child, order) => {
    if (child.section === undefined || !specIds.includes(child.specId)) return
    entries.push({ childKey: child.specId, section: child.section, order })
  })
  return entries
}

/** The identity facts the box reported for an equipment, by device attribute. */
export function metadataOf(
  found: EnpalEquipment | undefined,
  snapshot: EnpalSnapshot,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const field of found?.metadata ?? []) {
    const value = snapshot.texts.get(field.key)
    if (value !== undefined) out[field.attribute] = value
  }
  return out
}

/** The Sensor children the kernel spawns under an adopted piece (a Container or the Gateway). */
export function accessoryChildSpecs(config: {
  readonly equipment: string
  readonly specIds: readonly string[]
  readonly integrationId: string
}): readonly AccessoryChildSpec[] {
  const found = findEquipment(config.equipment)
  const out: AccessoryChildSpec[] = []
  for (const specId of config.specIds) {
    const spec = findSpec(specId)
    if (spec === undefined) continue
    const diagnostic = found?.children.find((c) => c.specId === specId)?.diagnostic === true
    out.push({
      stableIdSuffix: spec.id,
      meta: {
        type: DeviceType.Sensor,
        name: spec.name,
        role: spec.role,
        integrationId: config.integrationId,
        ...(diagnostic ? { display: { hidden: true } } : {}),
      },
      config: {
        specId: spec.id,
        integrationId: config.integrationId,
        system: ENPAL_SYSTEM,
      },
      factory: enpalSensorFactory,
    })
  }
  return out
}
