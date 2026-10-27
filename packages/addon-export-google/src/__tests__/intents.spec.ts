import { describe, expect, it } from 'vitest'

import { handleExecute } from '../intents/execute.js'
import { handleQuery } from '../intents/query.js'
import { handleSync } from '../intents/sync.js'
import { createFakeGateway, facts, RecordingLogger, statusKey } from './fakes.js'

const LAMP = facts({
  deviceId: 101,
  name: 'Kitchen lamp',
  deviceType: 'light',
  capNames: ['switch', 'brightness'],
})
const LOCK = facts({
  deviceId: 616,
  name: 'Front door',
  deviceType: 'lock',
  capNames: ['lock-control'],
})
const CAMERA = facts({
  deviceId: 102,
  name: 'Driveway',
  deviceType: 'camera',
  capNames: ['camera-streams', 'snapshot'],
})

describe('handleSync', () => {
  it('returns one device per exposed, mappable device', async () => {
    const logger = new RecordingLogger()
    const payload = await handleSync('user-1', {
      gateway: createFakeGateway({ devices: { 101: LAMP, 616: LOCK } }),
      logger,
      listExposed: () => [101, 616],
    })
    expect(payload.agentUserId).toBe('user-1')
    expect(payload.devices.map((d) => d.id)).toEqual(['101', '616'])
  })

  it('drops an exposed device that left the registry, and says so per device', async () => {
    const logger = new RecordingLogger()
    const payload = await handleSync('user-1', {
      gateway: createFakeGateway({ devices: { 101: LAMP } }),
      logger,
      listExposed: () => [101, 999],
    })
    expect(payload.devices.map((d) => d.id)).toEqual(['101'])
    // The drop branch must be attributable to the device it dropped.
    expect(logger.taggedWith(999)).toHaveLength(1)
    expect(logger.taggedWith(999)[0]?.message).toContain('not in the live registry')
  })

  it('drops an exposed device with no exported capability, and says so', async () => {
    const logger = new RecordingLogger()
    const payload = await handleSync('user-1', {
      gateway: createFakeGateway({ devices: { 102: CAMERA } }),
      logger,
      listExposed: () => [102],
    })
    expect(payload.devices).toEqual([])
    expect(logger.taggedWith(102)[0]?.message).toContain('no exported capability')
  })

  it('drops a device whose registry read failed without failing the whole sync', async () => {
    const logger = new RecordingLogger()
    const payload = await handleSync('user-1', {
      gateway: createFakeGateway({ devices: { 101: LAMP }, failingFacts: [616] }),
      logger,
      listExposed: () => [616, 101],
    })
    expect(payload.devices.map((d) => d.id)).toEqual(['101'])
    expect(logger.taggedWith(616)[0]?.message).toContain('registry read failed')
  })

  it('preserves exposed order', async () => {
    const payload = await handleSync('user-1', {
      gateway: createFakeGateway({ devices: { 101: LAMP, 616: LOCK } }),
      logger: new RecordingLogger(),
      listExposed: () => [616, 101],
    })
    expect(payload.devices.map((d) => d.id)).toEqual(['616', '101'])
  })
})

describe('handleQuery', () => {
  const gateway = createFakeGateway({
    devices: { 101: LAMP, 616: LOCK },
    statuses: {
      [statusKey('switch', 101)]: { on: true, lastChangedAt: 1 },
      [statusKey('brightness', 101)]: { level: 80, lastChangedAt: 1 },
      [statusKey('lockControl', 616)]: { state: 'locked', lastChangedAt: 1 },
    },
  })

  it('merges every trait’s state into one device entry', async () => {
    const payload = await handleQuery(
      { intent: 'action.devices.QUERY', payload: { devices: [{ id: '101' }] } },
      { gateway, logger: new RecordingLogger(), isExposed: () => true },
    )
    expect(payload.devices['101']).toEqual({
      online: true,
      status: 'SUCCESS',
      on: true,
      brightness: 80,
    })
  })

  it('refuses a device the operator never exposed', async () => {
    // The security gate: a linked Google account must not be able to read a
    // device by guessing its id.
    const logger = new RecordingLogger()
    const payload = await handleQuery(
      { intent: 'action.devices.QUERY', payload: { devices: [{ id: '616' }] } },
      { gateway, logger, isExposed: (id) => id === 101 },
    )
    expect(payload.devices['616']).toEqual({
      online: false,
      status: 'ERROR',
      errorCode: 'deviceNotFound',
    })
    expect(logger.taggedWith(616)[0]?.message).toContain('not exposed')
  })

  it('reports OFFLINE when the provider has no state to give', async () => {
    const offline = createFakeGateway({ devices: { 101: LAMP } })
    const logger = new RecordingLogger()
    const payload = await handleQuery(
      { intent: 'action.devices.QUERY', payload: { devices: [{ id: '101' }] } },
      { gateway: offline, logger, isExposed: () => true },
    )
    expect(payload.devices['101']).toEqual({ online: false, status: 'OFFLINE' })
    expect(logger.taggedWith(101).length).toBeGreaterThan(0)
  })

  it('answers a non-numeric id rather than dropping the key', async () => {
    const payload = await handleQuery(
      { intent: 'action.devices.QUERY', payload: { devices: [{ id: 'not-a-device' }] } },
      { gateway, logger: new RecordingLogger(), isExposed: () => true },
    )
    expect(payload.devices['not-a-device']?.errorCode).toBe('deviceNotFound')
  })
})

describe('handleExecute', () => {
  function executeInput(id: string, command: string, params: Record<string, unknown>) {
    return {
      intent: 'action.devices.EXECUTE' as const,
      payload: { commands: [{ devices: [{ id }], execution: [{ command, params }] }] },
    }
  }

  it('dispatches the resolved capability call and echoes the new state', async () => {
    const gateway = createFakeGateway({ devices: { 101: LAMP } })
    const payload = await handleExecute(
      executeInput('101', 'action.devices.commands.OnOff', { on: true }),
      { gateway, logger: new RecordingLogger(), isExposed: () => true },
    )
    expect(gateway.dispatched).toEqual([{ kind: 'switch.setState', deviceId: 101, on: true }])
    expect(payload.commands).toEqual([
      { ids: ['101'], status: 'SUCCESS', states: { online: true, on: true } },
    ])
  })

  it('refuses to actuate a device that is not exposed', async () => {
    const gateway = createFakeGateway({ devices: { 616: LOCK } })
    const logger = new RecordingLogger()
    const payload = await handleExecute(
      executeInput('616', 'action.devices.commands.LockUnlock', { lock: false }),
      { gateway, logger, isExposed: () => false },
    )
    expect(gateway.dispatched).toEqual([])
    expect(payload.commands[0]).toEqual({
      ids: ['616'],
      status: 'ERROR',
      errorCode: 'deviceNotFound',
    })
    expect(logger.taggedWith(616)[0]?.message).toContain('not exposed')
  })

  it('refuses a command no bound capability answers', async () => {
    const gateway = createFakeGateway({ devices: { 101: LAMP } })
    const logger = new RecordingLogger()
    const payload = await handleExecute(
      executeInput('101', 'action.devices.commands.LockUnlock', { lock: true }),
      { gateway, logger, isExposed: () => true },
    )
    expect(gateway.dispatched).toEqual([])
    expect(payload.commands[0]?.errorCode).toBe('functionNotSupported')
    expect(logger.taggedWith(101)[0]?.message).toContain('no bound capability')
  })

  it('surfaces a provider failure as deviceOffline and logs it', async () => {
    const gateway = createFakeGateway({
      devices: { 101: LAMP },
      failingCalls: ['switch.setState'],
    })
    const logger = new RecordingLogger()
    const payload = await handleExecute(
      executeInput('101', 'action.devices.commands.OnOff', { on: true }),
      { gateway, logger, isExposed: () => true },
    )
    expect(payload.commands[0]?.errorCode).toBe('deviceOffline')
    expect(logger.taggedWith(101)[0]?.message).toContain('capability call failed')
  })

  it('keeps two executions on one device in request order', async () => {
    const gateway = createFakeGateway({ devices: { 101: LAMP } })
    const payload = await handleExecute(
      {
        intent: 'action.devices.EXECUTE',
        payload: {
          commands: [
            {
              devices: [{ id: '101' }],
              execution: [
                { command: 'action.devices.commands.OnOff', params: { on: true } },
                {
                  command: 'action.devices.commands.BrightnessAbsolute',
                  params: { brightness: 20 },
                },
              ],
            },
          ],
        },
      },
      { gateway, logger: new RecordingLogger(), isExposed: () => true },
    )
    expect(gateway.dispatched.map((c) => c.kind)).toEqual([
      'switch.setState',
      'brightness.setBrightness',
    ])
    expect(payload.commands).toHaveLength(2)
  })
})
