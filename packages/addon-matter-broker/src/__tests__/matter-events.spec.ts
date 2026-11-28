/**
 * Matter EVENTS: decode, extraction from a subscription update, replay guard,
 * emission on the bus, and node presence. Each case fails without the event
 * path (there was none) or without the presence wiring.
 */
import { DeviceType, EventCategory } from '@dominevo/types'
import { afterEach, describe, expect, it } from 'vitest'
import type { MatterEventReport } from '../matter-controller.js'
import { matterNodes } from '../matter-gateway.js'
import { MatterClusterId } from '../matter-cluster-mapping.js'
import { decodeMatterEvent, DoorLockEventId, SwitchEventId } from '../matter-event-decode.js'
import { collectEventReports } from '../matter-subscription.js'
import { activeEndpoint, FIXTURE_DEVICE_ID } from './matter-device-fixture.js'

const lockEvent = (
  eventId: number,
  value: unknown,
  extra: Partial<MatterEventReport> = {},
): MatterEventReport => ({
  nodeId: '1',
  endpointId: 1,
  clusterId: MatterClusterId.DoorLock,
  eventId,
  eventNumber: null,
  timestampMs: null,
  value,
  ...extra,
})

/** Only the event-emitter fires; registration and cap-state traffic share the bus. */
const fires = (fx: { emitted: readonly { category: string; data: unknown }[] }) =>
  fx.emitted.filter((e) => e.category === EventCategory.EventEmitted)

afterEach(() => {
  matterNodes.clear()
})

describe('decodeMatterEvent', () => {
  it('lock operation carries the source and user index', () => {
    expect(
      decodeMatterEvent({
        clusterId: MatterClusterId.DoorLock,
        eventId: DoorLockEventId.LockOperation,
        value: { lockOperationType: 1, operationSource: 3, userIndex: 2 },
      }),
    ).toEqual({ kind: 'event', eventType: 'unlocked', data: { source: 'keypad', userIndex: 2 } })
  })

  it('alarm, operation error and button multi-press', () => {
    expect(
      decodeMatterEvent({
        clusterId: MatterClusterId.DoorLock,
        eventId: 0,
        value: { alarmCode: 5 },
      }),
    ).toMatchObject({ eventType: 'alarm-tamper' })
    expect(
      decodeMatterEvent({
        clusterId: MatterClusterId.DoorLock,
        eventId: DoorLockEventId.LockOperationError,
        value: { operationError: 1, operationSource: 3 },
      }),
    ).toMatchObject({ eventType: 'operation-error', data: { error: 'invalid-credential' } })
    expect(
      decodeMatterEvent({
        clusterId: MatterClusterId.Switch,
        eventId: SwitchEventId.MultiPressComplete,
        value: { totalNumberOfPressesCounted: 3 },
      }),
    ).toMatchObject({ eventType: 'multi-press-3', data: { count: 3 } })
  })

  it('names the reason for every event it drops', () => {
    const dropped = (clusterId: number, eventId: number, value: unknown) =>
      decodeMatterEvent({ clusterId, eventId, value })
    expect(dropped(MatterClusterId.DoorLock, 0x04, {})).toMatchObject({ kind: 'dropped' })
    expect(dropped(MatterClusterId.DoorLock, 0x99, {})).toMatchObject({ kind: 'dropped' })
    expect(dropped(MatterClusterId.Switch, SwitchEventId.MultiPressOngoing, {})).toMatchObject({
      kind: 'dropped',
    })
    expect(dropped(MatterClusterId.OnOff, 1, {})).toMatchObject({
      kind: 'dropped',
      reason: expect.stringContaining('no event mapping'),
    })
  })
})

describe('collectEventReports', () => {
  it('lifts event-value records and ignores attribute and status records', async () => {
    const update = [
      [
        { kind: 'attr-value', path: { endpointId: 1, clusterId: 257, attributeId: 0 }, value: 1 },
        {
          kind: 'event-value',
          path: { endpointId: 1, clusterId: 257, eventId: 2 },
          number: 7,
          epochTimestamp: 1_700_000_000_000,
          value: { lockOperationType: 0 },
        },
        { kind: 'event-status', path: { endpointId: 1, clusterId: 257, eventId: 2 } },
      ],
    ]
    expect(await collectEventReports('9', update)).toEqual([
      {
        nodeId: '9',
        endpointId: 1,
        clusterId: 257,
        eventId: 2,
        eventNumber: 7,
        timestampMs: 1_700_000_000_000,
        value: { lockOperationType: 0 },
      },
    ])
  })
})

describe('resolver replay guard', () => {
  it('a resubscribe that re-reads buffered events delivers nothing twice', () => {
    const seen: number[] = []
    matterNodes.onEvent((_b, e) => {
      seen.push(e.eventNumber ?? -1)
    })
    expect(matterNodes.recordEvent('b1', lockEvent(2, {}, { eventNumber: 5 }))).toBe(true)
    expect(matterNodes.recordEvent('b1', lockEvent(2, {}, { eventNumber: 5 }))).toBe(false)
    expect(matterNodes.recordEvent('b1', lockEvent(2, {}, { eventNumber: 4 }))).toBe(false)
    expect(matterNodes.recordEvent('b1', lockEvent(2, {}, { eventNumber: 6 }))).toBe(true)
    expect(seen).toEqual([5, 6])
  })
})

describe('event to eventBus emission', () => {
  const lockOnly = {
    type: DeviceType.Lock,
    capabilities: ['lock-control', 'event-emitter'],
  } as const

  it('a keypad unlock becomes an EventEmitted fire on the device', async () => {
    const fx = await activeEndpoint(lockOnly)
    matterNodes.recordEvent(
      'b1',
      lockEvent(DoorLockEventId.LockOperation, {
        lockOperationType: 1,
        operationSource: 3,
        userIndex: 4,
      }),
    )
    expect(fires(fx)).toHaveLength(1)
    const [ev] = fires(fx)
    expect(ev?.category).toBe(EventCategory.EventEmitted)
    expect(JSON.stringify(ev?.data)).toContain('"eventType":"unlocked"')
    expect(JSON.stringify(ev?.data)).toContain('"deviceId":' + FIXTURE_DEVICE_ID)
  })

  it('an alarm is emitted too', async () => {
    const fx = await activeEndpoint(lockOnly)
    matterNodes.recordEvent('b1', lockEvent(DoorLockEventId.DoorLockAlarm, { alarmCode: 0 }))
    expect(JSON.stringify(fires(fx)[0]?.data)).toContain('alarm-jammed')
  })

  it('a button triple press is one multi-press fire', async () => {
    const fx = await activeEndpoint({
      type: DeviceType.Button,
      capabilities: ['button', 'event-emitter'],
    })
    matterNodes.recordEvent('b1', {
      ...lockEvent(SwitchEventId.MultiPressComplete, { totalNumberOfPressesCounted: 3 }),
      clusterId: MatterClusterId.Switch,
    })
    expect(fires(fx)).toHaveLength(1)
    expect(JSON.stringify(fires(fx)[0]?.data)).toContain('multi-press-3')
  })

  it('a dropped event is logged with the deviceId tag and emits nothing (D391)', async () => {
    const fx = await activeEndpoint(lockOnly)
    matterNodes.recordEvent('b1', lockEvent(DoorLockEventId.LockUserChange, {}))
    matterNodes.recordEvent(
      'b1',
      lockEvent(
        DoorLockEventId.LockOperation,
        { lockOperationType: 0 },
        { timestampMs: Date.now() - 60 * 60_000 },
      ),
    )
    expect(fires(fx)).toHaveLength(0)
    const drops = fx.logs.filter((l) => l.message.startsWith('Matter event dropped'))
    expect(drops).toHaveLength(2)
    for (const d of drops) expect(d.tags).toEqual({ deviceId: FIXTURE_DEVICE_ID })
  })

  it('an event for another node or endpoint is not ours', async () => {
    const fx = await activeEndpoint(lockOnly)
    matterNodes.recordEvent('b1', lockEvent(2, { lockOperationType: 0 }, { nodeId: '2' }))
    matterNodes.recordEvent('b1', lockEvent(2, { lockOperationType: 0 }, { endpointId: 5 }))
    expect(fires(fx)).toHaveLength(0)
  })
})

describe('offline lock', () => {
  it('goes offline when the node drops, and back when it returns', async () => {
    const fx = await activeEndpoint({ type: DeviceType.Lock, capabilities: ['lock-control'] })
    matterNodes.setNodes('b1', [{ nodeId: '1', label: 'lock', online: true, endpoints: [] }])
    expect(fx.device.online).toBe(true)
    matterNodes.setNodes('b1', [{ nodeId: '1', label: 'lock', online: false, endpoints: [] }])
    expect(fx.device.online).toBe(false)
    matterNodes.setNodes('b1', [{ nodeId: '1', label: 'lock', online: true, endpoints: [] }])
    expect(fx.device.online).toBe(true)
  })
})
