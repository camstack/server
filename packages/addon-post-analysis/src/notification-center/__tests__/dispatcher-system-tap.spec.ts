/**
 * The system event's tap URL, end to end through the dispatcher.
 *
 * `system-event-tap-url.spec.ts` pins the mapping; this file pins that the
 * mapping is actually REACHED — that the frozen `subject.systemEvent` fields
 * (kind, deviceId, deviceType, nodeId) are the ones handed to it, and that an
 * authored `clickUrl` still wins. Both had to be true before any of these
 * links existed on a phone, and neither is visible from the pure test.
 */
import type { MediaFile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'

const BASE = 'https://camstack.example.top'

type SystemEventSubject = NonNullable<NcOutboxPayload['subject']['systemEvent']>

interface Harness {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
}

function makeHarness(baseUrl: string | null): Harness {
  const targets: readonly NcTargetRef[] = [
    { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
  ]
  const sends: NcSendInput[] = []
  const dispatcher = new NcDispatcher({
    logger: makeSilentLogger(),
    listTargets: async () => targets,
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async (): Promise<readonly MediaFile[]> => [],
    getDeviceName: async () => null,
    publicUrlBase: async () => baseUrl,
  })
  return { dispatcher, sends }
}

function systemEntry(
  systemEvent: SystemEventSubject,
  params?: Readonly<Record<string, unknown>>,
): NcOutboxEntry {
  return {
    id: 'rule-1:sys-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 0,
    recordKind: 'system-event',
    recordId: 'sys-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 100,
    updatedAt: 100,
    payload: {
      ruleName: 'Infrastructure',
      delivery: 'system-event',
      priority: 3,
      media: 'none',
      ...(params !== undefined ? { params } : {}),
      subject: {
        deviceId: 0,
        className: 'event',
        zones: [],
        timestamp: 1_753_000_000_000,
        systemEvent,
      },
    },
  }
}

describe('a system notification carries the admin page it is about', () => {
  it('an addon update names its node in the Addons link', async () => {
    const h = makeHarness(BASE)
    await h.dispatcher.deliver(
      systemEntry({
        kind: 'addon-update-available',
        subject: 'packages:addon:sig',
        nodeId: 'agent-a',
        data: {},
      }),
    )
    const url = h.sends[0]!.notification.clickUrl
    expect(url).toBe(`${BASE}/system/addons?node=agent-a`)
    expect(url).toContain('node=agent-a')
  })

  it("a node's own update names its node in the CLUSTER link", async () => {
    const h = makeHarness(BASE)
    await h.dispatcher.deliver(
      systemEntry({
        kind: 'server-update-available',
        subject: 'packages:server:sig',
        nodeId: 'hub',
        data: {},
      }),
    )
    expect(h.sends[0]!.notification.clickUrl).toBe(`${BASE}/system/nodes?node=hub`)
  })

  it('a camera that stopped streaming names the device and the Stream Broker tab', async () => {
    const h = makeHarness(BASE)
    await h.dispatcher.deliver(
      systemEntry({
        kind: 'stream-offline',
        subject: 'stream:102',
        deviceId: 102,
        deviceType: 'camera',
        data: {},
      }),
    )
    const url = h.sends[0]!.notification.clickUrl
    expect(url).toBe(`${BASE}/devices/102?tab=stream-broker`)
    expect(url).toContain('/devices/102')
  })

  it('the deviceType FROZEN on the row is what decides the tab', async () => {
    // The row is the only source: the device may be gone by the time this
    // drains, and a cap mount may not join backend state at render time. Both
    // directions are asserted — a dispatcher that dropped `deviceType` would
    // still produce the right answer for the plug and the wrong one for the
    // camera, so only the camera row proves the field is handed over.
    const camera = makeHarness(BASE)
    await camera.dispatcher.deliver(
      systemEntry({
        kind: 'device-offline',
        subject: 'device:101',
        deviceId: 101,
        deviceType: 'camera',
        data: {},
      }),
    )
    expect(camera.sends[0]!.notification.clickUrl).toBe(`${BASE}/devices/101?tab=stream-broker`)

    const plug = makeHarness(BASE)
    await plug.dispatcher.deliver(
      systemEntry({
        kind: 'device-offline',
        subject: 'device:2018',
        deviceId: 2018,
        deviceType: 'switch',
        data: {},
      }),
    )
    expect(plug.sends[0]!.notification.clickUrl).toBe(`${BASE}/devices/2018`)
  })

  it('a camera that came BACK carries the same tap as the one that went away', async () => {
    // The 2026-08-30 row that reached the phone with `tapAction.value: null`.
    // Asserted through the real dispatcher, because the pure mapping cannot
    // show that the frozen row's fields are the ones handed to it.
    const h = makeHarness(BASE)
    await h.dispatcher.deliver(
      systemEntry({
        kind: 'device-online',
        subject: 'device:107',
        deviceId: 107,
        deviceType: 'camera',
        data: {},
      }),
    )
    expect(h.sends[0]!.notification.clickUrl).toBe(`${BASE}/devices/107?tab=stream-broker`)
  })

  it('an authored clickUrl still wins over the default', async () => {
    const h = makeHarness(BASE)
    await h.dispatcher.deliver(
      systemEntry(
        { kind: 'addon-update-available', subject: 's', nodeId: 'hub', data: {} },
        { clickUrl: 'https://authored.example/x' },
      ),
    )
    expect(h.sends[0]!.notification.clickUrl).toBe('https://authored.example/x')
  })

  it('no reachable base costs the tap, never the notification', async () => {
    const h = makeHarness(null)
    const result = await h.dispatcher.deliver(
      systemEntry({ kind: 'addon-update-available', subject: 's', nodeId: 'hub', data: {} }),
    )
    expect(result).toEqual({ ok: true })
    expect(h.sends[0]!.notification.clickUrl).toBeUndefined()
  })
})
