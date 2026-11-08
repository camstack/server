/**
 * The system-event DELIVERY settings (activation / deactivation / scheduled
 * summary) belong to the Notification section, next to the priority and the
 * wording — not to Conditions, where they were authored until now.
 */
import { describe, expect, it } from 'vitest'
import { NC_RULE_TABS } from '../rule-form-tabs'

const tabOf = (field: 'systemEventDelivery') =>
  NC_RULE_TABS.find((tab) => tab.fields.includes(field))?.key

describe('system-event delivery section', () => {
  it('is claimed by the Notification tab', () => {
    expect(tabOf('systemEventDelivery')).toBe('notification')
  })

  it('is no longer claimed by the Conditions tab', () => {
    const conditions = NC_RULE_TABS.find((tab) => tab.key === 'conditions')
    expect(conditions?.fields).not.toContain('systemEventDelivery')
  })
})
