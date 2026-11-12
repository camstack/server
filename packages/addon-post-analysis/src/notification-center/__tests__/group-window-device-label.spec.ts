/**
 * A grouped window words `{{deviceLabel}}` in the language it is RENDERED in.
 * The intake freezes only the bare name and the device type; a label frozen
 * there would keep the intake's language for every line of the burst.
 */
import { DeviceType, NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { groupWindowSubject } from '../group-window-summary.js'
import type { NcOutboxEntry } from '../outbox.js'
import { NC_SYSTEM_DEVICE_ID } from '../rule-engine.js'
import { NcTextCatalog } from '../text-catalog.js'

const RULE = NcRuleSchema.parse({
  ...NcRuleInputSchema.parse({
    name: 'Problems',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds: ['device-offline'] } },
    targets: [{ targetId: 'zentik-1' }],
  }),
  id: 'r',
  createdBy: 'admin',
  createdAt: 1,
  updatedAt: 1,
})

function row(kind: 'device-offline' | 'device-attention-resolved', bodyKey: string): NcOutboxEntry {
  return {
    id: `r:${kind}`,
    ruleId: 'r',
    targetId: 't',
    deviceId: NC_SYSTEM_DEVICE_ID,
    recordKind: 'system-event',
    recordId: `ev-${kind}`,
    trackId: 'x',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    updatedAt: 1,
    payload: {
      ruleName: 'Problems',
      delivery: 'system-event',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: NC_SYSTEM_DEVICE_ID,
        className: 'system',
        zones: [],
        timestamp: 1_000,
        systemEvent: {
          kind,
          subject: `${kind}:12`,
          bodyKey,
          deviceId: 12,
          deviceType: DeviceType.Lock,
          // No `deviceLabel`: the intake never freezes one.
          textParams: { deviceId: '12', deviceName: 'Serratura cucina' },
          data: {},
        },
      },
    },
  }
}

describe('a grouped window - the device label follows the rendering language', () => {
  const entries = [
    row('device-offline', 'system.device-offline.body'),
    row('device-attention-resolved', 'system.device-attention-resolved.body'),
  ]

  it('Italian: a state line and a plain bullet both carry the Italian type word', () => {
    const subject = groupWindowSubject({
      rule: RULE,
      entries,
      texts: new NcTextCatalog({ language: 'it' }),
      nowMs: 2_000,
      openedAt: 1_000,
      targetId: 't',
    })
    const text = subject?.systemEvent?.textParams?.['summaryText'] ?? ''
    expect(text.match(/Serratura cucina \(Serratura\)/g)).toHaveLength(2)
  })

  it('English: the same rows say Lock', () => {
    const subject = groupWindowSubject({
      rule: RULE,
      entries,
      texts: new NcTextCatalog({ language: 'en' }),
      nowMs: 2_000,
      openedAt: 1_000,
      targetId: 't',
    })
    const text = subject?.systemEvent?.textParams?.['summaryText'] ?? ''
    expect(text.match(/Serratura cucina \(Lock\)/g)).toHaveLength(2)
  })
})
