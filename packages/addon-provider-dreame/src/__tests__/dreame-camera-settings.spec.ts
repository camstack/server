/**
 * The camera child's settings form.
 *
 * The operator asked (2026-09-16) to see which video backend the robot is on
 * and to be able to move it, so the Tencent path can be tested once it exists.
 * The two backends are not interchangeable: measured that day on an X50, a
 * robot on `tx` is offered only Tencent's proprietary UDP P2P plane
 * (`getRtcInfo` answers 404), while the same robot on `ali` streams through a
 * plain RTMP relay this stack implements end to end.
 */
import type { ConfigSelectField } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { CAMERA_SETTINGS_SCHEMA, cameraSettingsValues } from '../devices/dreame-camera-device.js'

function backendField(): ConfigSelectField {
  const section = CAMERA_SETTINGS_SCHEMA.sections.find((s) => s.id === 'camera-backend')
  if (!section) throw new Error('no camera-backend section')
  const field = section.fields.find((f) => f.key === 'videoVendor')
  if (!field || field.type !== 'select') throw new Error('videoVendor is not a select')
  return field
}

describe('the backend selector', () => {
  /**
   * EXACTLY the two this stack can stream. The cloud record also lists
   * `agora`; offering it would be a switch into a dead end, because nothing
   * here speaks it — and a robot moved there could not be moved back from a
   * form that no longer loads its video.
   */
  it('offers the two backends this stack speaks, and no others', () => {
    expect(backendField().options.map((o) => o.value)).toEqual(['ali', 'tx'])
  })

  // The working one first: a list whose head is the path that cannot stream
  // invites the wrong pick.
  it('puts the implemented backend first', () => {
    expect(backendField().options[0]?.value).toBe('ali')
  })

  // The labels have to carry the consequence, because the value alone does
  // not: "tx" does not say "you will not see this camera".
  it('says in the label which one actually works', () => {
    const [ali, tx] = backendField().options
    expect(ali?.label).toMatch(/supported/i)
    expect(tx?.label).toMatch(/not implemented/i)
  })
})

describe('the values the form opens with', () => {
  /**
   * THE DEVICE WINS. The stored value is only what the operator last asked
   * for; showing it while the robot sits elsewhere would report a switch that
   * did not happen.
   */
  it('shows where the robot IS, not where it was asked to be', () => {
    const v = cameraSettingsValues({ vendorNow: 'tx', storedVendor: 'ali' })
    expect(v['videoVendor']).toBe('tx')
  })

  it('falls back to the stored preference before the first read answers', () => {
    expect(cameraSettingsValues({ vendorNow: null, storedVendor: 'ali' })['videoVendor']).toBe(
      'ali',
    )
  })

  /**
   * Neither known ⇒ EMPTY, never a default. A form that opened on "ali" for a
   * robot nobody had asked would state a fact it does not have (D393).
   */
  it('shows nothing at all when neither is known', () => {
    expect(cameraSettingsValues({})['videoVendor']).toBe('')
  })

  it('still carries the access code it always did', () => {
    expect(cameraSettingsValues({ accessCode: '1234' })['navigationAccessCode']).toBe('1234')
    expect(cameraSettingsValues({})['navigationAccessCode']).toBe('')
  })
})
