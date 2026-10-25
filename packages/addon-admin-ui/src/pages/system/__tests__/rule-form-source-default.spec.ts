/**
 * R5 (D690): a new detection rule watches the PIPELINE source by default — and
 * that default never follows the rule onto a trigger whose subject is not a
 * pipeline detection (a sensor event is stamped `sensor`, so a `pipeline`
 * source would silence it for good).
 */
import { ruleSeedForSection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { changeRuleDelivery, emptyRuleForm } from '../notification-rules.helpers'

function newDetectionForm() {
  const seed = ruleSeedForSection('detection')
  return emptyRuleForm(seed.delivery, seed.conditions)
}

describe('the detection source default', () => {
  it('a new detection rule opens on the pipeline source', () => {
    expect(newDetectionForm().conditions.source).toBe('pipeline')
  })

  it('keeps it on the other detection triggers', () => {
    expect(changeRuleDelivery(newDetectionForm(), 'track-end').conditions.source).toBe('pipeline')
    expect(changeRuleDelivery(newDetectionForm(), 'package-event').conditions.source).toBe(
      'pipeline',
    )
  })

  it('drops it when the rule moves to a sensor or system trigger', () => {
    expect(changeRuleDelivery(newDetectionForm(), 'device-event').conditions.source).toBeUndefined()
    expect(changeRuleDelivery(newDetectionForm(), 'system-event').conditions.source).toBeUndefined()
  })

  it('never touches a source the operator chose for a sensor rule', () => {
    const sensor = emptyRuleForm('device-event', { source: 'sensor' })
    expect(changeRuleDelivery(sensor, 'device-event').conditions.source).toBe('sensor')
  })
})
