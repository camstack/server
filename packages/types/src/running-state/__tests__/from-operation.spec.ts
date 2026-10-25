import { describe, expect, it } from 'vitest'
import {
  runningFromDishwasherOperation,
  runningFromLawnMower,
  runningFromMediaPlayer,
  runningFromVacuumState,
} from '../from-operation.js'
import { RUNNING_STATE_COLD } from '../defaults.js'

const FETCHED = 1_700_000_000_000
const TRANSITION = 1_700_000_100_000

describe('runningFromDishwasherOperation', () => {
  it('unknown operation is null running, not false', () => {
    const slice = runningFromDishwasherOperation(null, null, undefined, FETCHED)
    expect(slice.running).toBeNull()
    expect(slice.since).toBeNull()
    expect(slice.source).toBe('native')
    expect(slice.lastFetchedAt).toBe(FETCHED)
  })

  it('first sight of idle is not running with null since', () => {
    const slice = runningFromDishwasherOperation('Ready', null, RUNNING_STATE_COLD, FETCHED)
    expect(slice.running).toBe(false)
    expect(slice.phase).toBe('Ready')
    expect(slice.since).toBeNull()
    expect(slice.lastFetchedAt).toBe(FETCHED)
  })

  it('Run on first sight has null since without program timing', () => {
    const slice = runningFromDishwasherOperation('Run', 'Eco', RUNNING_STATE_COLD, FETCHED)
    expect(slice.running).toBe(true)
    expect(slice.phase).toBe('Eco')
    expect(slice.since).toBeNull()
  })

  it('Run on first sight derives since from remaining program seconds', () => {
    const remainingSeconds = 600
    const slice = runningFromDishwasherOperation(
      'Run',
      'Eco',
      RUNNING_STATE_COLD,
      FETCHED,
      remainingSeconds,
    )
    expect(slice.since).toBe(FETCHED - remainingSeconds * 1000)
  })

  it('transition to running stamps since at transition time', () => {
    const previous = runningFromDishwasherOperation('Ready', null, RUNNING_STATE_COLD, FETCHED)
    const slice = runningFromDishwasherOperation('Run', 'Eco', previous, FETCHED, null, TRANSITION)
    expect(slice.running).toBe(true)
    expect(slice.since).toBe(TRANSITION)
  })

  it('Pause is not running', () => {
    const slice = runningFromDishwasherOperation('Pause', null, undefined, FETCHED)
    expect(slice.running).toBe(false)
    expect(slice.phase).toBe('Pause')
  })

  it('never emits since or lastFetchedAt as 0', () => {
    const slice = runningFromDishwasherOperation('Ready', null, undefined, 0)
    expect(slice.since).not.toBe(0)
    expect(slice.lastFetchedAt).toBe(0)
  })
})

describe('runningFromVacuumState', () => {
  it('null state is unknown', () => {
    expect(runningFromVacuumState(null, undefined, FETCHED).running).toBeNull()
  })

  it('first sight cleaning has null since', () => {
    const slice = runningFromVacuumState('cleaning', RUNNING_STATE_COLD, FETCHED)
    expect(slice.running).toBe(true)
    expect(slice.since).toBeNull()
  })

  it('cleaning after idle transition uses transition time', () => {
    const previous = runningFromVacuumState('idle', RUNNING_STATE_COLD, FETCHED, TRANSITION)
    const slice = runningFromVacuumState('cleaning', previous, FETCHED, TRANSITION)
    expect(slice.since).toBe(TRANSITION)
  })

  it('cleaning is running', () => {
    const slice = runningFromVacuumState('cleaning', undefined, FETCHED)
    expect(slice.running).toBe(true)
    expect(slice.phase).toBe('cleaning')
  })
})

describe('runningFromLawnMower', () => {
  it('mowing is running', () => {
    expect(runningFromLawnMower('mowing', undefined, FETCHED).running).toBe(true)
  })
})

describe('runningFromMediaPlayer', () => {
  it('playing is running', () => {
    expect(runningFromMediaPlayer('playing', undefined, FETCHED).running).toBe(true)
  })
})

describe('RUNNING_STATE_COLD', () => {
  it('is entirely unknown', () => {
    expect(RUNNING_STATE_COLD).toEqual({
      running: null,
      since: null,
      source: 'native',
      phase: null,
      lastFetchedAt: null,
    })
  })
})
