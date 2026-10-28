/**
 * A rule target's `params` reach the notifier as `notification.delivery`, but
 * only for keys the target's KIND declared (D938). A kind that declared nothing
 * is handed nothing, whatever the rule carries.
 */
import type { DeliveryParam } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import type { NcOutboxEntry } from '../outbox.js'

const DECLARED: readonly DeliveryParam[] = [
  {
    key: 'mode',
    label: 'Mode',
    type: 'enum',
    options: [
      { value: 'speak', label: 'Speak' },
      { value: 'announce', label: 'Announce' },
    ],
  },
  { key: 'volume', label: 'Volume', type: 'number', min: 0, max: 100 },
]

function entry(params: Record<string, unknown>): NcOutboxEntry {
  return {
    id: 'rule-1:trk-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 101,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 100,
    updatedAt: 100,
    payload: {
      ruleName: 'Person at gate',
      delivery: 'immediate',
      priority: 3,
      media: 'best',
      params,
      subject: {
        deviceId: 101,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'person',
        zones: [],
        timestamp: 1_753_000_000_000,
      },
    },
  }
}

async function sendWith(
  target: Partial<NcTargetRef>,
  params: Record<string, unknown>,
): Promise<NcSendInput> {
  const sends: NcSendInput[] = []
  const dispatcher = new NcDispatcher({
    logger: makeSilentLogger(),
    listTargets: async () => [
      { id: 'tgt-1', addonId: 'x', name: 'echo', kind: 'k', enabled: true, ...target },
    ],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => 'Cancello',
    now: () => 1_800_000_000_000,
  })
  await dispatcher.deliver(entry(params))
  const [sent] = sends
  if (sent === undefined) throw new Error('nothing was sent')
  return sent
}

describe('NcDispatcher — delivery params', () => {
  it('forwards the declared, valid keys as notification.delivery', async () => {
    const sent = await sendWith(
      { deliveryParams: DECLARED },
      { mode: 'announce', volume: 70, sound: 'ignored-here' },
    )
    expect(sent.notification.delivery).toEqual({ mode: 'announce', volume: 70 })
  })

  it('forwards nothing to a kind that declared nothing', async () => {
    const sent = await sendWith({}, { mode: 'announce', volume: 70 })
    expect(sent.notification.delivery).toBeUndefined()
  })

  it('drops a value the declaration refuses', async () => {
    const sent = await sendWith({ deliveryParams: DECLARED }, { mode: 'shout', volume: 40 })
    expect(sent.notification.delivery).toEqual({ volume: 40 })
  })
})
