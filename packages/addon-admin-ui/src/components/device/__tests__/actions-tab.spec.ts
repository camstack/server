import { describe, expect, it } from 'vitest'
import { actionsTabVisible, type BindingsSnapshot } from '../actions-tab'

const bound = (...capNames: string[]): BindingsSnapshot => ({
  status: 'success',
  entries: capNames.map((capName) => ({ capName })),
})

describe('actionsTabVisible', () => {
  it('a device that binds device-transitions gets the tab', () => {
    expect(actionsTabVisible('present', bound('switch', 'device-transitions'))).toBe(true)
  })

  it('a container binds none: the cap exists on the node but not for this device', () => {
    expect(actionsTabVisible('present', bound('device-status'))).toBe(false)
  })

  it('an unanswered bindings read does not claim the device lacks it, and shows no tab yet (D315)', () => {
    expect(actionsTabVisible('present', { status: 'pending', entries: [] })).toBe(false)
    expect(actionsTabVisible('present', { status: 'error', entries: [] })).toBe(false)
  })

  it('no provider on the cluster, no tab, whatever the device binds', () => {
    expect(actionsTabVisible('absent', bound('device-transitions'))).toBe(false)
    expect(actionsTabVisible('pending', bound('device-transitions'))).toBe(false)
  })
})
