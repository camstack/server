import { describe, it, expect } from 'vitest'
import {
  DeviceType,
  baseUnitOf,
  enumerateSchemaFields,
  powerMeterCapability,
} from '@camstack/types'
import {
  MatterClusterId,
  mapMatterEndpointToCamStack,
  endpointLabel,
} from '../matter-cluster-mapping.js'
import { parsePairingCode, isValidPairingCode } from '../matter-commissioning.js'
import { buildMatterNodeCandidate, endpointNativeId } from '../matter-discovery.js'
import { settingsToMatterConnection } from '../config.js'
import { decodeMatterAttribute, MatterAttributeId } from '../matter-attr-decode.js'

describe('mapMatterEndpointToCamStack', () => {
  it('maps single clusters to their caps + device type', () => {
    expect(mapMatterEndpointToCamStack([MatterClusterId.OnOff])).toEqual({
      deviceType: DeviceType.Switch,
      capabilities: ['switch'],
    })
    expect(mapMatterEndpointToCamStack([MatterClusterId.DoorLock])).toEqual({
      deviceType: DeviceType.Lock,
      capabilities: ['lock-control'],
    })
    expect(mapMatterEndpointToCamStack([MatterClusterId.WindowCovering])).toEqual({
      deviceType: DeviceType.Cover,
      capabilities: ['cover'],
    })
    expect(mapMatterEndpointToCamStack([MatterClusterId.TemperatureMeasurement])).toEqual({
      deviceType: DeviceType.Sensor,
      capabilities: ['temperature-sensor'],
    })
  })

  it('unions multi-cluster endpoints into several caps (dimmable colour bulb)', () => {
    const mapping = mapMatterEndpointToCamStack([
      MatterClusterId.OnOff,
      MatterClusterId.LevelControl,
      MatterClusterId.ColorControl,
    ])
    expect(mapping.deviceType).toBe(DeviceType.Light)
    expect(mapping.capabilities).toEqual(['switch', 'brightness', 'color'])
  })

  it('returns an empty mapping for unrecognised clusters', () => {
    const mapping = mapMatterEndpointToCamStack([0x9999, 0xabcd])
    expect(mapping.capabilities).toEqual([])
    expect(mapping.deviceType).toBe(DeviceType.Generic)
  })

  it('maps Thermostat → climate-control (Thermostat device)', () => {
    expect(mapMatterEndpointToCamStack([MatterClusterId.Thermostat])).toEqual({
      deviceType: DeviceType.Thermostat,
      capabilities: ['climate-control'],
    })
  })

  it('maps electrical power + energy measurement → power-meter (deduped)', () => {
    const mapping = mapMatterEndpointToCamStack([
      MatterClusterId.ElectricalPowerMeasurement,
      MatterClusterId.ElectricalEnergyMeasurement,
    ])
    expect(mapping.capabilities).toEqual(['power-meter'])
  })

  it('is order-independent in cap output', () => {
    const a = mapMatterEndpointToCamStack([MatterClusterId.ColorControl, MatterClusterId.OnOff])
    const b = mapMatterEndpointToCamStack([MatterClusterId.OnOff, MatterClusterId.ColorControl])
    expect(a.capabilities).toEqual(b.capabilities)
  })
})

describe('endpointLabel', () => {
  it('labels endpoint 0 bare and others with an index', () => {
    expect(endpointLabel(0, DeviceType.Light)).toBe('Light')
    expect(endpointLabel(3, DeviceType.Switch)).toBe('Switch #3')
  })
})

describe('parsePairingCode', () => {
  it('classifies a QR payload', () => {
    expect(parsePairingCode('MT:Y.K9042C00KA0648G00')).toEqual({
      kind: 'qr',
      normalized: 'MT:Y.K9042C00KA0648G00',
    })
  })
  it('classifies + strips a manual 11-digit code', () => {
    expect(parsePairingCode('3497-011-2332')).toEqual({ kind: 'manual', normalized: '34970112332' })
  })
  it('rejects empty + wrong-length codes', () => {
    expect(() => parsePairingCode('')).toThrow()
    expect(() => parsePairingCode('12345')).toThrow()
    expect(isValidPairingCode('3497-011-2332')).toBe(true)
    expect(isValidPairingCode('abc')).toBe(false)
  })
})

describe('buildMatterNodeCandidate', () => {
  it('builds one Container with one child per mappable endpoint, skipping cap-less ones', () => {
    const candidate = buildMatterNodeCandidate({
      node: {
        nodeId: 'node-1',
        label: 'Test Bulb',
        online: true,
        endpoints: [
          { endpointId: 0, clusterIds: [0x0028] }, // root / Basic Info → no cap
          { endpointId: 1, clusterIds: [MatterClusterId.OnOff, MatterClusterId.LevelControl] },
        ],
      },
      adoptedDeviceId: null,
    })
    expect(candidate.type).toBe(DeviceType.Container)
    expect(candidate.childNativeId).toBe('node-1')
    expect(candidate.alreadyAdopted).toBe(false)
    expect(candidate.children).toHaveLength(1)
    const child = candidate.children?.[0]
    expect(child?.childNativeId).toBe(endpointNativeId('node-1', 1))
    expect(child?.capabilities).toEqual(['switch', 'brightness'])
    expect(child?.type).toBe(DeviceType.Light)
  })

  it('reports adopted when an id is provided', () => {
    const candidate = buildMatterNodeCandidate({
      node: { nodeId: 'n2', label: '', online: false, endpoints: [] },
      adoptedDeviceId: 7,
    })
    expect(candidate.alreadyAdopted).toBe(true)
    expect(candidate.adoptedDeviceId).toBe(7)
    expect(candidate.name).toBe('Matter node n2')
  })
})

describe('settingsToMatterConnection', () => {
  it('applies defaults to an empty blob', () => {
    const cfg = settingsToMatterConnection({})
    expect(cfg.threadDataset).toBe('')
    expect(cfg.reconcileIntervalMs).toBe(300_000)
  })
  it('coerces a partial blob', () => {
    const cfg = settingsToMatterConnection({ wifiSsid: 'home', reconcileIntervalMs: 60_000 })
    expect(cfg.wifiSsid).toBe('home')
    expect(cfg.reconcileIntervalMs).toBe(60_000)
  })
})

describe('decodeMatterAttribute', () => {
  it('decodes OnOff.OnOff → switch.on', () => {
    const decoded = decodeMatterAttribute({
      clusterId: MatterClusterId.OnOff,
      attributeId: MatterAttributeId.OnOff,
      value: true,
    })
    expect(decoded?.cap).toBe('switch')
    expect(decoded?.patch['on']).toBe(true)
  })

  it('scales LevelControl.CurrentLevel (0..254) → brightness percentage (0..100)', () => {
    const full = decodeMatterAttribute({
      clusterId: MatterClusterId.LevelControl,
      attributeId: MatterAttributeId.CurrentLevel,
      value: 254,
    })
    expect(full?.cap).toBe('brightness')
    expect(full?.patch['percentage']).toBe(100)

    const half = decodeMatterAttribute({
      clusterId: MatterClusterId.LevelControl,
      attributeId: MatterAttributeId.CurrentLevel,
      value: 127,
    })
    expect(half?.patch['percentage']).toBe(50)
  })

  it('decodes BooleanState.StateValue (closed=true) → contact.entryOpen (inverse)', () => {
    const closed = decodeMatterAttribute({
      clusterId: MatterClusterId.BooleanState,
      attributeId: MatterAttributeId.StateValue,
      value: true,
    })
    expect(closed?.cap).toBe('contact')
    expect(closed?.patch['entryOpen']).toBe(false)
  })

  it('decodes Occupancy bitmap → motion.detected', () => {
    const detected = decodeMatterAttribute({
      clusterId: MatterClusterId.OccupancySensing,
      attributeId: MatterAttributeId.Occupancy,
      value: 0x01,
    })
    expect(detected?.cap).toBe('motion')
    expect(detected?.patch['detected']).toBe(true)

    const clear = decodeMatterAttribute({
      clusterId: MatterClusterId.OccupancySensing,
      attributeId: MatterAttributeId.Occupancy,
      value: 0x00,
    })
    expect(clear?.patch['detected']).toBe(false)
    // A clear must not touch the last rise: the patch merges, so a key here
    // would erase it (`motion.cap.ts`: null = never detected).
    expect(Object.hasOwn(clear?.patch ?? {}, 'lastDetectedAt')).toBe(false)
  })

  it('scales TemperatureMeasurement.MeasuredValue (0.01 °C) → celsius', () => {
    const decoded = decodeMatterAttribute({
      clusterId: MatterClusterId.TemperatureMeasurement,
      attributeId: MatterAttributeId.MeasuredValue,
      value: 2350,
    })
    expect(decoded?.cap).toBe('temperature-sensor')
    expect(decoded?.patch['celsius']).toBeCloseTo(23.5)
  })

  it('scales RelativeHumidityMeasurement (0.01 %) → percent', () => {
    const decoded = decodeMatterAttribute({
      clusterId: MatterClusterId.RelativeHumidityMeasurement,
      attributeId: MatterAttributeId.MeasuredValue,
      value: 5500,
    })
    expect(decoded?.cap).toBe('humidity-sensor')
    expect(decoded?.patch['percent']).toBeCloseTo(55)
  })

  it('decodes PowerSource.BatPercentRemaining (half-percent) → battery percentage', () => {
    const decoded = decodeMatterAttribute({
      clusterId: MatterClusterId.PowerSource,
      attributeId: MatterAttributeId.BatPercentRemaining,
      value: 150,
    })
    expect(decoded?.cap).toBe('battery')
    expect(decoded?.patch['percentage']).toBe(75)
  })

  it('decodes Thermostat.LocalTemperature → climate-control.currentTemp', () => {
    const decoded = decodeMatterAttribute({
      clusterId: MatterClusterId.Thermostat,
      attributeId: MatterAttributeId.LocalTemperature,
      value: 2105,
    })
    expect(decoded?.cap).toBe('climate-control')
    expect(decoded?.patch['currentTemp']).toBeCloseTo(21.05)
  })

  it('decodes Thermostat.SystemMode → climate-control.mode', () => {
    const heat = decodeMatterAttribute({
      clusterId: MatterClusterId.Thermostat,
      attributeId: MatterAttributeId.SystemMode,
      value: 4,
    })
    expect(heat?.patch['mode']).toBe('heat')
    const off = decodeMatterAttribute({
      clusterId: MatterClusterId.Thermostat,
      attributeId: MatterAttributeId.SystemMode,
      value: 0,
    })
    expect(off?.patch['mode']).toBe('off')
  })

  it('scales ElectricalPowerMeasurement.ActivePower (mW) → power-meter.watts', () => {
    const decoded = decodeMatterAttribute({
      clusterId: MatterClusterId.ElectricalPowerMeasurement,
      attributeId: MatterAttributeId.ActivePower,
      value: 1_500_000,
    })
    expect(decoded?.cap).toBe('power-meter')
    expect(decoded?.patch['watts']).toBeCloseTo(1500)
    // D944 §4: base unit W is the watts declaration. mW → W stays the conversion above.
    expect(decoded?.patch['unit']).toBeUndefined()
    const watts = enumerateSchemaFields(powerMeterCapability.runtimeState).find(
      (field) => field.path === 'watts',
    )
    expect(watts?.quantity).toBe('power')
    expect(baseUnitOf('power')).toBe('W')
  })

  it('decodes ElectricalEnergyMeasurement (mWh, possibly wrapped) → kwhTotal', () => {
    const plain = decodeMatterAttribute({
      clusterId: MatterClusterId.ElectricalEnergyMeasurement,
      attributeId: MatterAttributeId.CumulativeEnergyImported,
      value: 2_000_000,
    })
    expect(plain?.patch['kwhTotal']).toBeCloseTo(2)

    const wrapped = decodeMatterAttribute({
      clusterId: MatterClusterId.ElectricalEnergyMeasurement,
      attributeId: MatterAttributeId.CumulativeEnergyImported,
      value: { energy: 500_000 },
    })
    expect(wrapped?.patch['kwhTotal']).toBeCloseTo(0.5)
  })

  it('returns null for unrecognised clusters / attributes / bad values', () => {
    expect(decodeMatterAttribute({ clusterId: 0x9999, attributeId: 0, value: 1 })).toBeNull()
    expect(
      decodeMatterAttribute({
        clusterId: MatterClusterId.OnOff,
        attributeId: 0x99,
        value: true,
      }),
    ).toBeNull()
    expect(
      decodeMatterAttribute({
        clusterId: MatterClusterId.OnOff,
        attributeId: MatterAttributeId.OnOff,
        value: undefined,
      }),
    ).toBeNull()
  })
})
