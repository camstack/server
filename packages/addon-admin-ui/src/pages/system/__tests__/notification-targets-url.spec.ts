import { describe, expect, it } from 'vitest'
import {
  clearTargetsEditorParams,
  TARGET_KIND_PARAM,
  TARGET_NEW,
  TARGET_PARAM,
  withTargetsTabForNewKind,
  withTargetsTabForTarget,
} from '../notification-targets-url'

describe('notification-targets-url', () => {
  it('opens edit for a target id and clears kind', () => {
    const params = new URLSearchParams('tab=rules&kind=whatsapp')
    const next = withTargetsTabForTarget(params, 't-1')
    expect(next.get('tab')).toBe('targets')
    expect(next.get(TARGET_PARAM)).toBe('t-1')
    expect(next.get(TARGET_KIND_PARAM)).toBeNull()
  })

  it('opens create with optional kind', () => {
    const withKind = withTargetsTabForNewKind(new URLSearchParams(), 'whatsapp')
    expect(withKind.get(TARGET_PARAM)).toBe(TARGET_NEW)
    expect(withKind.get(TARGET_KIND_PARAM)).toBe('whatsapp')

    const picker = withTargetsTabForNewKind(new URLSearchParams(), null)
    expect(picker.get(TARGET_PARAM)).toBe(TARGET_NEW)
    expect(picker.get(TARGET_KIND_PARAM)).toBeNull()
  })

  it('clears editor params without dropping unrelated ones', () => {
    const params = new URLSearchParams('tab=targets&target=t-1&kind=whatsapp&foo=1')
    const next = clearTargetsEditorParams(params)
    expect(next.get('tab')).toBe('targets')
    expect(next.get(TARGET_PARAM)).toBeNull()
    expect(next.get(TARGET_KIND_PARAM)).toBeNull()
    expect(next.get('foo')).toBe('1')
  })
})
