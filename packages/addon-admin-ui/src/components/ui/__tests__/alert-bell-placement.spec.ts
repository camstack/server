import { describe, expect, it } from 'vitest'
import { computeAlertPanelStyle } from '../alert-bell-placement'

describe('computeAlertPanelStyle', () => {
  it('drops down from a header bell and keeps the notch inset in the top clamp', () => {
    const s = computeAlertPanelStyle({
      rect: { left: 340, top: 50, bottom: 90 },
      viewportWidth: 390,
      viewportHeight: 844,
    })
    expect(s.top).toBe('max(94px, calc(env(safe-area-inset-top) + 8px))')
    expect(s.left).toBe(62)
    expect(s.width).toBe(320)
    expect(String(s.maxHeight)).toContain('env(safe-area-inset-bottom)')
    expect(s.bottom).toBeUndefined()
  })

  it('never lets the top clamp collapse below the status bar when the bell is at y=0', () => {
    const s = computeAlertPanelStyle({
      rect: { left: 10, top: 0, bottom: 20 },
      viewportWidth: 390,
      viewportHeight: 844,
    })
    expect(s.top).toContain('env(safe-area-inset-top)')
  })

  it('drops up from a bottom bell and caps its height under the top inset', () => {
    const s = computeAlertPanelStyle({
      rect: { left: 8, top: 800, bottom: 840 },
      viewportWidth: 1440,
      viewportHeight: 844,
    })
    expect(s.bottom).toBe('max(48px, calc(env(safe-area-inset-bottom) + 8px))')
    expect(String(s.maxHeight)).toContain('env(safe-area-inset-top)')
    expect(s.top).toBeUndefined()
  })

  it('fits a narrow screen', () => {
    const s = computeAlertPanelStyle({
      rect: { left: 300, top: 0, bottom: 40 },
      viewportWidth: 320,
      viewportHeight: 640,
    })
    expect(s.width).toBe(304)
    expect(s.left).toBe(8)
  })
})
