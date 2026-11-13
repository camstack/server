/**
 * History keeps the title and body that were sent. A detection row used to
 * store neither, so the history page could not show the sentence the phone got.
 */
import { NcHistoryEntrySchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput, type NcTargetRef } from '../dispatcher.js'
import { NcOutbox, type NcOutboxEntry } from '../outbox.js'
import { outboxEntryToHistory } from '../rules-provider.js'
import { NcTextCatalog } from '../text-catalog.js'
import { makeNcRecords } from './support/nc-test-deps.js'

const AT = 1_753_000_000_000

const TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'My phone', kind: 'pushover', enabled: true },
]

function detectionEntry(): NcOutboxEntry {
  return {
    id: 'rule-1:ev-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 104,
    recordKind: 'object-event',
    recordId: 'ev-1',
    status: 'pending',
    attempts: 0,
    createdAt: AT,
    updatedAt: AT,
    nextAttemptAt: AT,
    payload: {
      ruleName: 'Person at gate',
      delivery: 'immediate',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: 104,
        className: 'person',
        zones: [],
        timestamp: AT,
      },
    },
  }
}

function textField(value: unknown, key: 'title' | 'body'): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined
  const got = Reflect.get(value, key)
  return typeof got === 'string' ? got : undefined
}

describe('history freezes the sent title and body', () => {
  it('a detection send returns the sentence, and history keeps it', async () => {
    const sends: NcSendInput[] = []
    const dispatcher = new NcDispatcher({
      logger: makeSilentLogger(),
      texts: new NcTextCatalog(),
      listTargets: async () => TARGETS,
      send: async (input) => {
        sends.push(input)
        return { success: true }
      },
      getMediaForOwner: async () => [],
      getDeviceName: async () => 'Front door',
      getZoneNames: async () => [],
    })
    const world = makeNcRecords()
    const outbox = new NcOutbox({
      records: world.records,
      logger: makeSilentLogger(),
      deliver: (entry) => dispatcher.deliver(entry),
      now: () => AT,
    })
    const pending = detectionEntry()
    await outbox.enqueue([
      {
        ruleId: pending.ruleId,
        targetId: pending.targetId,
        deviceId: pending.deviceId,
        recordKind: pending.recordKind,
        recordId: pending.recordId,
        payload: pending.payload,
      },
    ])
    await outbox.drainOnce()
    const rows = await outbox.queryHistory({ limit: 10 })
    const sent = rows[0]
    expect({
      status: sent?.status,
      error: sent?.lastError,
      title: sent?.payload.renderedTitle,
    }).toEqual({
      status: 'sent',
      error: undefined,
      title: 'Person — Front door',
    })
    expect(sent?.payload.renderedBody).toBe('Person on front door')
    const history = outboxEntryToHistory(new NcTextCatalog(), sent ?? detectionEntry())
    const parsed = NcHistoryEntrySchema.parse(history)
    expect(textField(history, 'title')).toBe('Person — Front door')
    expect(textField(history, 'body')).toBe('Person on front door')
    expect(textField(parsed, 'title')).toBe('Person — Front door')
    expect(textField(parsed, 'body')).toBe('Person on front door')
    expect(sends[0]?.notification.title).toBe('Person — Front door')
  })
})
