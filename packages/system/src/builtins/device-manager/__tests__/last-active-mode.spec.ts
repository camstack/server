import { describe, expect, it } from 'vitest'
import { harness } from './mirror-harness.js'

const CLIMATE = { availableModes: ['off', 'heat', 'cool'], target: 22 }

describe('lastActiveMode - kept where every provider writes a climate slice', () => {
  it('records the mode while the device runs one, and keeps it through off', () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(7, 'climate-control', { ...CLIMATE, mode: 'heat' })
    expect(h.mirror.currentSlice(7, 'climate-control')?.lastActiveMode).toBe('heat')
    h.mirror.applySingleCapUpdate(7, 'climate-control', { ...CLIMATE, mode: 'off' })
    expect(h.mirror.currentSlice(7, 'climate-control')).toMatchObject({
      mode: 'off',
      lastActiveMode: 'heat',
    })
  })

  it('a later mode replaces it', () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(7, 'climate-control', { ...CLIMATE, mode: 'heat' })
    h.mirror.applySingleCapUpdate(7, 'climate-control', { ...CLIMATE, mode: 'cool' })
    h.mirror.applySingleCapUpdate(7, 'climate-control', { ...CLIMATE, mode: 'off' })
    expect(h.mirror.currentSlice(7, 'climate-control')?.lastActiveMode).toBe('cool')
  })

  it('a device that never reported a mode has none', () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(7, 'climate-control', { ...CLIMATE, mode: 'off' })
    expect(h.mirror.currentSlice(7, 'climate-control')).not.toHaveProperty('lastActiveMode')
  })

  it('survives a slice rewrite that omits it', () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(7, 'climate-control', { ...CLIMATE, mode: 'cool' })
    h.mirror.applySingleCapUpdate(7, 'climate-control', { ...CLIMATE, mode: 'off', target: 20 })
    h.mirror.applySingleCapUpdate(7, 'climate-control', { ...CLIMATE, mode: 'off', target: 21 })
    expect(h.mirror.currentSlice(7, 'climate-control')?.lastActiveMode).toBe('cool')
  })

  it('a water heater keeps its last operation mode through off', () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(7, 'water-heater', { operationMode: 'eco', targetTemp: 55 })
    h.mirror.applySingleCapUpdate(7, 'water-heater', { operationMode: 'off', targetTemp: 55 })
    expect(h.mirror.currentSlice(7, 'water-heater')?.lastActiveMode).toBe('eco')
  })

  it('leaves every other cap alone', () => {
    const h = harness()
    h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    expect(h.mirror.currentSlice(7, 'switch')).toEqual({ on: true })
  })
})
