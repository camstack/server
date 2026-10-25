import { describe, it, expect } from 'vitest'
import type { UiContribution } from '../capability-definition.js'

describe('UiContribution', () => {
  it('accepts a remote-kind descriptor', () => {
    const c: UiContribution = {
      tab: 'dashboard',
      label: 'Occupancy',
      kind: 'remote',
      remote: { remoteName: 'addon_x_widgets', exposedModule: './Occupancy' },
    }
    expect(c.remote?.remoteName).toBe('addon_x_widgets')
  })
  it('accepts optional subTab and order', () => {
    const c: UiContribution = {
      tab: 'device-tab',
      subTab: 'streaming',
      label: 'Streaming',
      kind: 'remote',
      order: 10,
    }
    expect(c.subTab).toBe('streaming')
    expect(c.order).toBe(10)
  })
})
