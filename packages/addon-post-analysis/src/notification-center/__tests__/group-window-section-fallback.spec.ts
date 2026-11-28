/**
 * A grouped window of kinds the state summary has no section for (alerts)
 * is still titled: the burst is named after its rule, never `": 2"`.
 */
import { NcRuleInputSchema, NcRuleSchema } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { groupWindowSubject } from '../group-window-summary.js'
import type { NcOutboxEntry } from '../outbox.js'
import { NC_SYSTEM_DEVICE_ID } from '../rule-engine.js'
import { NcTextCatalog } from '../text-catalog.js'

const RULE = NcRuleSchema.parse({
  ...NcRuleInputSchema.parse({
    name: 'Allarmi critici',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds: ['alert-critical'] } },
    targets: [{ targetId: 'zentik-1' }],
  }),
  id: 'r',
  createdBy: 'admin',
  createdAt: 1,
  updatedAt: 1,
})

function alert(addon: string): NcOutboxEntry {
  return {
    id: `r:${addon}`,
    ruleId: 'r',
    targetId: 't',
    deviceId: NC_SYSTEM_DEVICE_ID,
    recordKind: 'system-event',
    recordId: `ev-${addon}`,
    trackId: 'x',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    updatedAt: 1,
    payload: {
      ruleName: 'Allarmi critici',
      delivery: 'system-event',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: NC_SYSTEM_DEVICE_ID,
        className: 'system',
        zones: [],
        timestamp: 1_000,
        systemEvent: {
          kind: 'alert-critical',
          subject: `alert:install-held:${addon}`,
          title: `${addon} was not installed`,
          body: `The boot installer did not install ${addon}.`,
          data: {},
        },
      },
    },
  }
}

describe('a grouped window of section-less kinds', () => {
  it('is titled with the rule name and the count', () => {
    const subject = groupWindowSubject({
      rule: RULE,
      entries: [alert('@dominevo/addon-admin-ui'), alert('@dominevo/addon-post-analysis')],
      texts: new NcTextCatalog({ language: 'it' }),
      nowMs: 2_000,
      openedAt: 1_000,
      targetId: 't',
    })
    expect(subject?.systemEvent?.textParams?.['summarySection']).toBe('Allarmi critici')
    expect(subject?.systemEvent?.textParams?.['summaryCount']).toBe('2')
  })
})
