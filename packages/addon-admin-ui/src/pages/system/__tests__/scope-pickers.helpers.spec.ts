import { describe, expect, it } from 'vitest'
import { offListSelections } from '../device-selection'
import { nodeScopeState, packageScopeState } from '../scope-pickers.helpers'

describe('node picker state (D315 / D49)', () => {
  it('pending and failed are never "none" and never "removed"', () => {
    expect(nodeScopeState({ data: undefined, isError: false }).listState).toBe('pending')
    const failed = nodeScopeState({ data: undefined, isError: true })
    expect(failed.listState).toBe('failed')
    expect(
      offListSelections(['agent-x'], failed.items, failed.fleet.devices, failed.fleet.state),
    ).toEqual([{ id: 'agent-x', removed: false }])
  })

  it('a stored node absent from a COMPLETE directory is judged missing — and still a row (removable)', () => {
    const s = nodeScopeState({
      data: { complete: true, nodes: [{ id: 'hub', name: 'Hub', isHub: true, isOnline: true }] },
      isError: false,
    })
    expect(offListSelections(['agent-x'], s.items, s.fleet.devices, s.fleet.state)).toEqual([
      { id: 'agent-x', removed: true },
    ])
  })

  it('an INCOMPLETE directory (history unreadable) never calls it missing', () => {
    const s = nodeScopeState({ data: { complete: false, nodes: [] }, isError: false })
    expect(s.listState).toBe('answered')
    expect(offListSelections(['agent-x'], s.items, s.fleet.devices, s.fleet.state)).toEqual([
      { id: 'agent-x', removed: false },
    ])
  })

  it('offline nodes are listed and marked', () => {
    const s = nodeScopeState({
      data: { complete: true, nodes: [{ id: 'a', name: 'A', isHub: false, isOnline: false }] },
      isError: false,
    })
    expect(s.items[0]).toMatchObject({ id: 'a', location: 'offline' })
  })
})

describe('package picker state', () => {
  it('pending is not "no packages"', () => {
    const s = packageScopeState({ data: undefined, isError: false })
    expect(s.listState).toBe('pending')
    expect(s.fleet.devices).toBeUndefined()
    expect(offListSelections(['@camstack/x'], s.items, s.fleet.devices, s.fleet.state)).toEqual([
      { id: '@camstack/x', removed: false },
    ])
  })

  it('every update-event package is always offered', () => {
    expect(packageScopeState({ data: [], isError: false }).items.map((i) => i.id)).toEqual([
      '@camstack/server',
      '@camstack/system',
      'camstack-wrapper',
    ])
  })

  it('a stored package the answered list lacks is judged missing', () => {
    const s = packageScopeState({ data: [], isError: false })
    expect(offListSelections(['@camstack/gone'], s.items, s.fleet.devices, s.fleet.state)).toEqual([
      { id: '@camstack/gone', removed: true },
    ])
  })
})
