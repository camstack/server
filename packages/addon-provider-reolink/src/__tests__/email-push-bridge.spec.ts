import {
  SMTP_INBOUND_DEFAULT_ID,
  SMTP_RECIPIENT_CLAIMED,
  type SmtpInboundMessage,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type BridgeCamera,
  type BrokerPort,
  EmailPushBridge,
  REOLINK_SUBSCRIBER_ID,
} from '../email-push-bridge.js'

interface Event {
  readonly cam: number
  readonly type: string
  readonly channel: number
  readonly source: string
  readonly timestamp: number
}

function camera(id: number, stableId: string, events: Event[], eligible = true): BridgeCamera {
  return {
    id,
    stableId,
    isEmailPushEligible: eligible,
    emailPushChannel: 0,
    handleSimpleEvent: (e) => {
      events.push({
        cam: id,
        type: e.type,
        channel: e.channel,
        source: e.source,
        timestamp: e.timestamp,
      })
    },
  }
}

function msg(seq: number, subject: string, text = ''): SmtpInboundMessage {
  return {
    seq,
    messageId: `m${seq}`,
    receivedAt: 1000 + seq,
    from: 'cam@x',
    to: 'cam-A@camstack.local',
    subject,
    text,
    attachments: [],
  }
}

interface FakeBroker {
  readonly port: BrokerPort
  readonly adds: string[]
  readonly subscribes: { id: string; recipients: readonly string[] }[]
  readonly unsubscribes: string[]
  readonly stateKeys: string[]
  ring: { key: string; message: SmtpInboundMessage }[]
  lastSeq: number
  exists: boolean
  host: string | null
  claimedError: boolean
  addFailsWithInUse: boolean
}

function fakeBroker(): FakeBroker {
  const state: FakeBroker = {
    adds: [],
    subscribes: [],
    unsubscribes: [],
    stateKeys: [],
    ring: [],
    lastSeq: 0,
    exists: false,
    host: '192.0.2.10',
    claimedError: false,
    addFailsWithInUse: false,
    port: {
      list: async () => (state.exists ? [{ id: SMTP_INBOUND_DEFAULT_ID }] : []),
      add: async ({ id }) => {
        state.adds.push(id)
        if (state.addFailsWithInUse) {
          state.exists = true
          throw new Error(`broker id '${id}' is already in use`)
        }
        state.exists = true
        return { id }
      },
      getBrokerConfig: async () => ({
        host: state.host,
        hostReason: state.host === null ? 'set the Internal address under System → Network' : null,
        port: 2525,
        domain: 'camstack.local',
        requireAuth: true,
        username: 'u',
        password: 'p',
        starttls: false,
      }),
      subscribe: async (id, recipients) => {
        if (state.claimedError) throw new Error(`${SMTP_RECIPIENT_CLAIMED}: x`)
        state.subscribes.push({ id, recipients })
        return { subscriptionId: `sub-${REOLINK_SUBSCRIBER_ID}` }
      },
      unsubscribe: async (_id, subscriptionId) => {
        state.unsubscribes.push(subscriptionId)
      },
      getState: async (_id, key) => {
        state.stateKeys.push(key)
        const since = Number(key.slice('since:'.length))
        return {
          lastSeq: state.lastSeq,
          oldestSeq: state.ring[0]?.message.seq ?? 0,
          messages: state.ring.filter((e) => e.message.seq > since),
        }
      },
    },
  }
  return state
}

function build(cameras: BridgeCamera[], broker: FakeBroker) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  const bridge = new EmailPushBridge({ port: broker.port, listCameras: () => cameras, logger })
  return { bridge, logger }
}

const data = (brokerId: string, m: SmtpInboundMessage, key = 'cam-A') => ({
  brokerId,
  subscriptionId: `sub-${REOLINK_SUBSCRIBER_ID}`,
  key,
  payload: m,
})

describe('the email-push bridge: the mailbox', () => {
  it('creates no mailbox while no camera needs one', async () => {
    const broker = fakeBroker()
    const { bridge } = build([camera(1, 'A', [], false)], broker)
    await bridge.sync()
    expect(broker.adds).toEqual([])
    expect(broker.subscribes).toEqual([])
  })

  it('creates the mailbox on first need, under the adopted id, and subscribes the cam-<stableId> set', async () => {
    const broker = fakeBroker()
    const { bridge } = build(
      [camera(1, 'A', []), camera(2, 'B', []), camera(3, 'H', [], false)],
      broker,
    )
    await bridge.sync()
    expect(broker.adds).toEqual([SMTP_INBOUND_DEFAULT_ID])
    expect(broker.subscribes).toEqual([
      { id: SMTP_INBOUND_DEFAULT_ID, recipients: ['cam-A', 'cam-B'] },
    ])
  })

  it('concurrent first needs make ONE mailbox; an id taken meanwhile is read back, not an error', async () => {
    const broker = fakeBroker()
    const { bridge } = build([camera(1, 'A', [])], broker)
    await Promise.all([bridge.ensureMailbox(), bridge.ensureMailbox(), bridge.sync()])
    expect(broker.adds).toHaveLength(1)

    const raced = fakeBroker()
    raced.addFailsWithInUse = true
    const second = build([camera(1, 'A', [])], raced)
    await expect(second.bridge.ensureMailbox()).resolves.toBe(SMTP_INBOUND_DEFAULT_ID)
  })

  it('an existing mailbox is reused, never added again', async () => {
    const broker = fakeBroker()
    broker.exists = true
    const { bridge } = build([camera(1, 'A', [])], broker)
    await bridge.sync()
    expect(broker.adds).toEqual([])
  })

  it('redeclares the set when a camera goes, and unsubscribes when none is left', async () => {
    const broker = fakeBroker()
    const cams = [camera(1, 'A', []), camera(2, 'B', [])]
    const { bridge } = build(cams, broker)
    await bridge.sync()
    cams.pop()
    await bridge.sync()
    expect(broker.subscribes.at(-1)?.recipients).toEqual(['cam-A'])
    cams.pop()
    await bridge.sync()
    expect(broker.unsubscribes).toEqual([`sub-${REOLINK_SUBSCRIBER_ID}`])
  })

  it('a recipient claimed by someone else is logged, not thrown out of sync', async () => {
    const broker = fakeBroker()
    broker.claimedError = true
    const { bridge, logger } = build([camera(1, 'A', [])], broker)
    await expect(bridge.sync()).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('the email-push bridge: messages', () => {
  async function live() {
    const broker = fakeBroker()
    const events: Event[] = []
    const { bridge, logger } = build([camera(7, 'A', events), camera(8, 'B', events)], broker)
    await bridge.sync()
    return { broker, events, bridge, logger }
  }

  it('classifies a message and feeds the matching camera as an email event', async () => {
    const { bridge, events } = await live()
    await bridge.onMessage(data(SMTP_INBOUND_DEFAULT_ID, msg(1, 'Person Detected from Garden')))
    expect(events).toEqual([
      { cam: 7, type: 'people', channel: 0, source: 'email', timestamp: 1001 },
    ])
  })

  it('a doorbell mail owes the camera a doorbell AND a motion event', async () => {
    const { bridge, events } = await live()
    await bridge.onMessage(
      data(SMTP_INBOUND_DEFAULT_ID, msg(1, 'Someone rang the button visitor at door'), 'cam-B'),
    )
    expect(events.map((e) => [e.cam, e.type])).toEqual([
      [8, 'doorbell'],
      [8, 'motion'],
    ])
  })

  it('a message for another broker, or already seen, is ignored', async () => {
    const { bridge, events } = await live()
    await bridge.onMessage(data('other-broker', msg(1, 'Motion')))
    await bridge.onMessage(data(SMTP_INBOUND_DEFAULT_ID, msg(1, 'Motion')))
    await bridge.onMessage(data(SMTP_INBOUND_DEFAULT_ID, msg(1, 'Motion')))
    expect(events).toHaveLength(1)
  })

  it('a gap in seq replays the missing messages from the ring, in order, once', async () => {
    const { bridge, events, broker } = await live()
    broker.ring = [1, 2, 3, 4].map((n) => ({ key: 'cam-A', message: msg(n, `Motion ${n}`) }))
    broker.lastSeq = 4
    await bridge.onMessage(data(SMTP_INBOUND_DEFAULT_ID, msg(1, 'Motion 1')))
    // seq 2 and 3 were lost; 4 arrives.
    await bridge.onMessage(data(SMTP_INBOUND_DEFAULT_ID, msg(4, 'Motion 4')))
    expect(events.map((e) => e.timestamp)).toEqual([1001, 1002, 1003, 1004])
    // The late events for 2 and 3 are duplicates now.
    await bridge.onMessage(data(SMTP_INBOUND_DEFAULT_ID, msg(2, 'Motion 2')))
    await bridge.onMessage(data(SMTP_INBOUND_DEFAULT_ID, msg(3, 'Motion 3')))
    expect(events).toHaveLength(4)
  })

  it('a broker that came back connected is resubscribed and reconciled, and a restarted seq is not lost', async () => {
    const { bridge, events, broker } = await live()
    broker.ring = [1, 2, 3].map((n) => ({ key: 'cam-A', message: msg(n, `Motion ${n}`) }))
    broker.lastSeq = 3
    await bridge.onMessage(data(SMTP_INBOUND_DEFAULT_ID, msg(1, 'Motion 1')))
    await bridge.onMessage(data(SMTP_INBOUND_DEFAULT_ID, msg(2, 'Motion 2')))
    await bridge.onMessage(data(SMTP_INBOUND_DEFAULT_ID, msg(3, 'Motion 3')))
    const subscribesBefore = broker.subscribes.length
    // smtp-nodemailer restarted: its ring is empty, then one new mail arrives with seq 1.
    broker.ring = [{ key: 'cam-A', message: { ...msg(1, 'Motion fresh'), receivedAt: 9000 } }]
    broker.lastSeq = 1
    await bridge.onStatusChanged({ brokerId: SMTP_INBOUND_DEFAULT_ID, status: 'connected' })
    expect(broker.subscribes.length).toBe(subscribesBefore + 1)
    expect(events.at(-1)?.timestamp).toBe(9000)
    expect(events).toHaveLength(4)
  })

  it('a message for a camera that is gone is logged and dropped', async () => {
    const { bridge, events, logger } = await live()
    await bridge.onMessage(data(SMTP_INBOUND_DEFAULT_ID, msg(1, 'Motion'), 'cam-ZZ'))
    expect(events).toEqual([])
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('the email-push bridge: what a camera is told', () => {
  it('answers the host, port, domain, recipient and credentials of the mailbox', async () => {
    const broker = fakeBroker()
    const cam = camera(1, 'A', [])
    const { bridge } = build([cam], broker)
    const params = await bridge.buildCameraSetupParams(cam)
    expect(params).toEqual({
      managerHost: '192.0.2.10',
      managerPort: 2525,
      domain: 'camstack.local',
      recipientLocalPart: 'cam-A',
      authUsername: 'u',
      authPassword: 'p',
    })
  })

  it('refuses with the reason when the hub has no internal address — never a fallback host', async () => {
    const broker = fakeBroker()
    broker.host = null
    const cam = camera(1, 'A', [])
    const { bridge } = build([cam], broker)
    await expect(bridge.buildCameraSetupParams(cam)).rejects.toThrow(/System → Network/)
  })

  it('is null for a camera that cannot do email push (hub child)', async () => {
    const broker = fakeBroker()
    const cam = camera(1, 'H', [], false)
    const { bridge } = build([cam], broker)
    expect(await bridge.buildCameraSetupParams(cam)).toBeNull()
    expect(broker.adds).toEqual([])
  })
})
