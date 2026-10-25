/**
 * Where a notification tap opens, end to end through the dispatcher (D709,
 * D734): the **Notification taps** role decides whether a camera tap opens
 * `https://camstack.zentik.app/camera/…&hub=` or a hub address's own
 * `/viewer/camstack/camera/…`; an admin destination always uses the **Public
 * endpoint**, never the taps address and never the app form.
 */
import type { MediaFile, ViewerLinkBase } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'

const PUBLIC = 'https://cam.example.top'
const TAPS = 'http://192.168.10.9:4480'
const AT = 1_753_000_000_000

function makeHarness(tapBase?: () => Promise<ViewerLinkBase>): {
  readonly dispatcher: NcDispatcher
  readonly sends: NcSendInput[]
} {
  const targets: readonly NcTargetRef[] = [
    { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'zentik', enabled: true },
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
    getDeviceName: async () => 'Front door',
    publicUrlBase: async () => PUBLIC,
    ...(tapBase !== undefined ? { tapBase } : {}),
  })
  return { dispatcher, sends }
}

function entry(subject: Partial<NcOutboxPayload['subject']> = {}): NcOutboxEntry {
  return {
    id: 'rule-1:ev-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 101,
    recordKind: 'device-event',
    recordId: 'ev-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 100,
    updatedAt: 100,
    payload: {
      ruleName: 'Doorbell',
      delivery: 'device-event',
      priority: 3,
      media: 'none',
      subject: { deviceId: 101, className: 'event', zones: [], timestamp: AT, ...subject },
    },
  }
}

const SYSTEM_EVENT = {
  kind: 'addon-update-available',
  subject: 'packages:addon:sig',
  nodeId: 'hub',
  data: {},
} as const

function systemEntry(): NcOutboxEntry {
  return {
    ...entry({ deviceId: 0, systemEvent: SYSTEM_EVENT }),
    deviceId: 0,
    recordKind: 'system-event',
    payload: {
      ...entry().payload,
      delivery: 'system-event',
      subject: {
        deviceId: 0,
        className: 'event',
        zones: [],
        timestamp: AT,
        systemEvent: SYSTEM_EVENT,
      },
    },
  }
}

describe('the notification tap follows the notification-taps role (D709, D734)', () => {
  it('app link: the camera tap opens the central domain carrying the hub', async () => {
    const h = makeHarness(async () => ({ form: 'app', hubBaseUrl: PUBLIC }))
    await h.dispatcher.deliver(entry())
    expect(h.sends[0]!.notification.clickUrl).toBe(
      `https://camstack.zentik.app/camera/101?at=${String(AT)}&hub=https%3A%2F%2Fcam.example.top`,
    )
  })

  it('app link with no public hub: still a link, without hub=', async () => {
    const h = makeHarness(async () => ({ form: 'app', hubBaseUrl: null }))
    await h.dispatcher.deliver(entry())
    expect(h.sends[0]!.notification.clickUrl).toBe(
      `https://camstack.zentik.app/camera/101?at=${String(AT)}`,
    )
  })

  it('a hub address flagged for taps: the tap opens THAT address, not the public endpoint', async () => {
    const h = makeHarness(async () => ({ form: 'hub', hubBaseUrl: TAPS }))
    await h.dispatcher.deliver(entry())
    expect(h.sends[0]!.notification.clickUrl).toBe(
      `${TAPS}/viewer/camstack/camera/101?at=${String(AT)}`,
    )
  })

  it('an unreadable taps role falls back to the hub viewer on the public endpoint', async () => {
    const h = makeHarness(async () => {
      throw new Error('local-network unreachable')
    })
    await h.dispatcher.deliver(entry())
    expect(h.sends[0]!.notification.clickUrl).toBe(
      `${PUBLIC}/viewer/camstack/camera/101?at=${String(AT)}`,
    )
  })

  it('an admin destination uses the public endpoint even with the app link for taps', async () => {
    const h = makeHarness(async () => ({ form: 'app', hubBaseUrl: PUBLIC }))
    await h.dispatcher.deliver(systemEntry())
    expect(h.sends[0]!.notification.clickUrl).toBe(`${PUBLIC}/system/addons?node=hub`)
  })

  it('an admin destination uses the public endpoint, not a hub address flagged for taps', async () => {
    const h = makeHarness(async () => ({ form: 'hub', hubBaseUrl: TAPS }))
    await h.dispatcher.deliver(systemEntry())
    expect(h.sends[0]!.notification.clickUrl).toBe(`${PUBLIC}/system/addons?node=hub`)
  })

  it('an authored clickUrl still wins over the app link', async () => {
    const h = makeHarness(async () => ({ form: 'app', hubBaseUrl: PUBLIC }))
    const e = entry()
    await h.dispatcher.deliver({
      ...e,
      payload: { ...e.payload, params: { clickUrl: 'https://example.org/x' } },
    })
    expect(h.sends[0]!.notification.clickUrl).toBe('https://example.org/x')
  })
})
