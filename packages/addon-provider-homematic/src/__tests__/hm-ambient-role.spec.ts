/**
 * A Homematic motion detector that also reports the brightness is ONE multi-sensor:
 * an ambient monitor. A single-reading channel keeps its channel role. A device
 * adopted before that moves once, and only when its role is still the one the
 * channel type gave it.
 */
import {
  type DeviceContext,
  DeviceRole,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import type { Homematic } from 'nodehomematic'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveHmEntitySpecs } from '../devices/hm-entity-spec.js'
import { HmSensorDevice } from '../devices/hm-sensor-device.js'
import { homematicFacades } from '../homematic-facade-resolver.js'
import { hmDataPoint, hmDevice } from './hm-test-fixtures.js'

const ADDRESS = '0001D3C99AB777'
const INTEGRATION_ID = 'hm_001'
const CHANNEL = `${ADDRESS}:1`

function deviceWith(channelType: string, parameters: readonly string[]) {
  return hmDevice({
    address: ADDRESS,
    type: 'HmIP-SMI',
    channels: [
      {
        address: CHANNEL,
        index: 1,
        type: channelType,
        dataPoints: parameters.map((parameter) => hmDataPoint({ parameter, value: 1 })),
      },
    ],
  })
}

const sensorSpec = (channelType: string, parameters: readonly string[]) =>
  deriveHmEntitySpecs(deviceWith(channelType, parameters), []).find(
    (s) => s.key === `sensor-${CHANNEL}`,
  )

describe('the role a Homematic sensor spec carries', () => {
  it('motion + brightness on one channel is an ambient monitor', () => {
    const spec = sensorSpec('MOTIONDETECTOR_TRANSCEIVER', ['MOTION', 'ILLUMINATION'])
    expect(spec?.role).toBe(DeviceRole.AmbientMonitor)
    expect(spec?.config['role']).toBe(DeviceRole.AmbientMonitor)
    expect(spec?.config['channelRole']).toBe(DeviceRole.MotionSensor)
  })

  it('a single-reading channel keeps the role of its channel type', () => {
    expect(sensorSpec('ENERGIE_METER_TRANSMITTER', ['POWER'])?.role).toBe(DeviceRole.PowerSensor)
  })
})

function build(role: string | null, config: Record<string, unknown> = {}) {
  const setRole = vi.fn(async () => {})
  const info = vi.fn()
  const persisted = vi.fn(async () => {})
  let rs: IDeviceRuntimeState | null = null
  const logger = {
    debug: () => undefined,
    info,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  const ctx = {
    id: 5598,
    stableId: `hm:${INTEGRATION_ID}:${ADDRESS}-sensor-${CHANNEL}`,
    parentDeviceId: 5597,
    deviceMeta: {
      id: 5598,
      stableId: 'x',
      addonId: 'provider-homematic',
      type: DeviceType.Sensor,
      name: 'sensor',
      location: null,
      disabled: false,
      parentDeviceId: 5597,
      metadata: null,
      ...(role !== null ? { role } : {}),
    },
    persistedConfig: {
      address: ADDRESS,
      integrationId: INTEGRATION_ID,
      channel: CHANNEL,
      capabilities: ['motion', 'ambient-light-sensor', 'battery'],
      channelRole: DeviceRole.MotionSensor,
      ...config,
    },
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: persisted,
    bindRuntimeState: (r: IDeviceRuntimeState) => {
      rs = r
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && rs) {
        rs.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    logger,
    api: { deviceManager: { setRole: { mutate: setRole } } },
  } as unknown as DeviceContext
  return { device: new HmSensorDevice(ctx), setRole, info }
}

beforeEach(() => {
  homematicFacades.clear()
  homematicFacades.set(INTEGRATION_ID, {
    on: () => () => undefined,
    devices: () => [deviceWith('MOTIONDETECTOR_TRANSCEIVER', ['MOTION', 'ILLUMINATION'])],
    customEntities: () => [],
  } as unknown as Homematic)
})

describe('an adopted multi-sensor moves to ambient-monitor once', () => {
  it('replaces the role its channel type gave it', async () => {
    const h = build(DeviceRole.MotionSensor)
    await h.device.onActivate()
    expect(h.setRole).toHaveBeenCalledWith({ deviceId: 5598, role: 'ambient-monitor' })
  })

  it('keeps a role the operator chose, and says so with the device tag', async () => {
    const h = build(DeviceRole.GenericSensor)
    await h.device.onActivate()
    expect(h.setRole).not.toHaveBeenCalled()
    expect(h.info).toHaveBeenCalledWith(
      expect.stringContaining('role kept: operator-chosen or unknown'),
      expect.objectContaining({ tags: { deviceId: 5598 } }),
    )
  })

  it('does not flip a role back that was decided already', async () => {
    const h = build(DeviceRole.MotionSensor, { ambientRoleReviewed: true })
    await h.device.onActivate()
    expect(h.setRole).not.toHaveBeenCalled()
  })
})
