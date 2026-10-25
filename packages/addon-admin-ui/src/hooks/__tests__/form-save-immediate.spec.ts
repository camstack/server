/**
 * Which fields auto-save, and which wait for Save.
 *
 * `immediate: true` means "write on every change, no review". That is right for
 * a single switch and wrong for a MULTISELECT, because a multiselect passes
 * through states the operator never chose on the way to the one they did:
 * going from `['pipeline']` to `['onboard']` is two clicks, and the middle one
 * is a real, saved, applied configuration. Deselecting first is worse — the
 * middle state is `[]`, a camera with NO root detector, written and applied
 * from a click that was half of one intent.
 *
 * The shipped `detection-sources` picker carried `immediate: true`, copied from
 * the single boolean toggle it replaced. This pins the rule for anything that
 * reconfigures a camera: it goes through edit → review → Save.
 */
import { describe, expect, it } from 'vitest'
import { isImmediateField } from '../useFormSaveController'

const section = (fields: readonly unknown[], immediate?: boolean) =>
  ({ fields, ...(immediate === undefined ? {} : { immediate }) }) as never

describe('isImmediateField', () => {
  it('a multiselect is DEFERRED unless it says otherwise', () => {
    expect(
      isImmediateField(
        [section([{ type: 'multiselect', key: 'detectionSources' }])],
        'detectionSources',
      ),
    ).toBe(false)
  })

  it('an explicit per-field flag still wins', () => {
    expect(isImmediateField([section([{ type: 'boolean', key: 'k', immediate: true }])], 'k')).toBe(
      true,
    )
  })

  it('a control field with no value is always immediate', () => {
    expect(isImmediateField([section([{ type: 'button', key: 'go' }])], 'go')).toBe(true)
  })
})
