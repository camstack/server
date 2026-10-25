/**
 * A selected device the hub no longer has must stay VISIBLE and removable.
 *
 * Operator report 2026-09-25: a rule kept a deleted camera, no picker showed
 * it, and when it was the only one the editor showed zero selected ("all
 * devices") while the rule matched nothing. The picker renders only live
 * cameras, so every selected id outside that list has to be surfaced here —
 * and only from a list that ANSWERED (D315): an unanswered or failed list says
 * nothing about absence.
 */
import { describe, expect, it } from 'vitest'
import {
  deviceListStateOf,
  emptyDevicesWidens,
  offListSelections,
  resolveSelectedDevices,
  showsNoCamerasHint,
} from '../device-selection'

const CAMERAS = [
  { id: 1, name: 'Front door' },
  { id: 5, name: 'Garden' },
]

describe('resolveSelectedDevices', () => {
  it('names a live camera and flags a missing one as removed when the list answered', () => {
    expect(resolveSelectedDevices([5, 42], CAMERAS, 'answered')).toEqual([
      { id: 5, name: 'Garden', removed: false },
      { id: 42, removed: true },
    ])
  })

  it('an EMPTY answered list makes every selected id removed', () => {
    expect(resolveSelectedDevices([42], [], 'answered')).toEqual([{ id: 42, removed: true }])
  })

  it('a pending list never claims removal', () => {
    expect(resolveSelectedDevices([42], undefined, 'pending')).toEqual([{ id: 42, removed: false }])
  })

  it('a failed list never claims removal, but still yields a row per id so it can be removed', () => {
    expect(resolveSelectedDevices([1, 42], undefined, 'failed')).toEqual([
      { id: 1, removed: false },
      { id: 42, removed: false },
    ])
  })

  it('keeps every id — nothing is dropped from the selection (D49)', () => {
    expect(resolveSelectedDevices([42, 43], CAMERAS, 'answered').map((row) => row.id)).toEqual([
      42, 43,
    ])
  })
})

describe('offListSelections', () => {
  const FLEET = [...CAMERAS, { id: 70, name: 'Door sensor' }]

  it('judges an id the camera list lacks against the FLEET: a sensor is named, not removed', () => {
    expect(offListSelections([1, 70, 42], CAMERAS, FLEET, 'answered')).toEqual([
      { id: 70, name: 'Door sensor', removed: false },
      { id: 42, removed: true },
    ])
  })

  it('an unanswered fleet names nothing and removes nothing', () => {
    expect(offListSelections([70, 42], CAMERAS, undefined, 'pending')).toEqual([
      { id: 70, removed: false },
      { id: 42, removed: false },
    ])
  })

  it('an unanswered drawn list leaves every selected id to the fleet', () => {
    expect(offListSelections([1, 42], undefined, FLEET, 'answered')).toEqual([
      { id: 1, name: 'Front door', removed: false },
      { id: 42, removed: true },
    ])
  })
})

describe('deviceListStateOf', () => {
  it('data present is answered, even alongside a later refetch error', () => {
    expect(deviceListStateOf({ data: [], isError: true })).toBe('answered')
  })
  it('no data and an error is failed', () => {
    expect(deviceListStateOf({ data: undefined, isError: true })).toBe('failed')
  })
  it('no data and no error is pending', () => {
    expect(deviceListStateOf({ data: undefined, isError: false })).toBe('pending')
  })
})

describe('showsNoCamerasHint', () => {
  it('only an answered-empty list with nothing selected', () => {
    expect(showsNoCamerasHint('answered', 0, 0)).toBe(true)
    expect(showsNoCamerasHint('answered', 0, 1)).toBe(false)
    expect(showsNoCamerasHint('answered', 2, 0)).toBe(false)
  })
  it('never while pending or failed', () => {
    expect(showsNoCamerasHint('pending', 0, 0)).toBe(false)
    expect(showsNoCamerasHint('failed', 0, 0)).toBe(false)
  })
})

describe('emptyDevicesWidens', () => {
  it('warns when an all-meaning selection became empty after having devices', () => {
    expect(emptyDevicesWidens(true, 0, true)).toBe(true)
  })
  it('stays quiet while something is selected, when it never had devices, or when empty is not "all"', () => {
    expect(emptyDevicesWidens(true, 1, true)).toBe(false)
    expect(emptyDevicesWidens(true, 0, false)).toBe(false)
    expect(emptyDevicesWidens(false, 0, true)).toBe(false)
  })
})

describe('string ids (D637)', () => {
  it('a node id absent from an ANSWERED list is removed; from a failed one it is only unnamed', () => {
    expect(
      resolveSelectedDevices(['agent-gone'], [{ id: 'hub', name: 'Hub' }], 'answered'),
    ).toEqual([{ id: 'agent-gone', removed: true }])
    expect(resolveSelectedDevices(['agent-gone'], undefined, 'failed')).toEqual([
      { id: 'agent-gone', removed: false },
    ])
  })
  it('a list held while the state is NOT answered never claims absence (D315)', () => {
    const held = [{ id: 'hub', name: 'Hub' }]
    expect(resolveSelectedDevices(['agent-gone'], held, 'pending')).toEqual([
      { id: 'agent-gone', removed: false },
    ])
    expect(resolveSelectedDevices(['agent-gone'], held, 'failed')).toEqual([
      { id: 'agent-gone', removed: false },
    ])
  })
})
