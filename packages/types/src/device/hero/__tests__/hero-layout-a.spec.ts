import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device-type.js'
import { HERO_ROW_IDS, HERO_ROW_LABELS } from '../hero-model.js'
import { actionsOf, build, NOW, rowOf } from './hero-test-kit.js'

const RUNNING = {
  'running-state': {
    running: true,
    since: NOW - 120_000,
    source: 'native',
    phase: 'Rinse',
    lastFetchedAt: NOW,
  },
  'power-meter': { power: 412, energy: 18.4, lastFetchedAt: NOW },
}

const DISH = {
  availability: 'available',
  state: 'running',
  operationState: 'Run',
  program: 'Eco 50',
  selectedProgram: null,
  availablePrograms: [],
  remaining: 4320,
  delayedStart: null,
  progress: 30,
  doorOpen: false,
  doorLocked: true,
  remoteStartAllowed: true,
  remoteControlActive: true,
  localControlActive: false,
  powerOn: null,
  powerState: null,
  filterCleaningDue: null,
  machineCareDue: null,
  machineCareRemainingRuns: null,
  halfLoad: null,
  hygienePlus: null,
  extraDry: null,
  intensiveZone: null,
  varioSpeedPlus: null,
  childLock: null,
  activeEvents: [],
  errorCode: null,
  errorLabel: null,
  lastFetchedAt: NOW,
}

describe('layout A anatomy in the model', () => {
  it('names every row, so no client invents a label', () => {
    for (const id of HERO_ROW_IDS) expect(HERO_ROW_LABELS[id].en).not.toBe('')
  })

  it('a washer shows its phase and start beside the scene; power is a fact, not a tile', () => {
    const m = build(DeviceType.Washer, ['running-state', 'power-meter'], RUNNING)
    expect(m.sideTiles.left.map((t) => t.label.en)).toEqual(['Phase'])
    expect(m.sideTiles.right.map((t) => t.label.en)).toEqual(['Started'])
    expect(m.facts.some((f) => f.id === 'power' && f.text.en === '412 W')).toBe(true)
  })

  it('a plug with only a meter keeps the meter tiles', () => {
    const m = build(DeviceType.Switch, ['power-meter'], { 'power-meter': RUNNING['power-meter'] })
    expect(m.sideTiles.right.map((t) => t.label.en)).toEqual(['Power'])
    expect(m.sideTiles.left.map((t) => t.label.en)).toEqual(['Energy'])
  })

  it('a dishwasher carries phase, program and time left, a progress bar and pause / stop', () => {
    const m = build(DeviceType.Dishwasher, ['dishwasher'], { dishwasher: DISH })
    expect(m.sideTiles.left.map((t) => [t.label.en, t.value.en])).toEqual([
      ['Phase', 'Running'],
      ['Program', 'Eco 50'],
    ])
    expect(m.sideTiles.right.map((t) => t.label.en)).toEqual(['Left'])
    expect(rowOf(m, 'progress').progress).toBeCloseTo(0.3)
    expect(actionsOf(rowOf(m, 'cycle').controls).map((a) => a.call.method)).toEqual([
      'pause',
      'stop',
    ])
    expect(m.rows.map((r) => r.id)).toEqual(['progress', 'cycle'])
  })

  it('a paused dishwasher offers resume as the primary action', () => {
    const m = build(DeviceType.Dishwasher, ['dishwasher'], {
      dishwasher: { ...DISH, state: 'paused', operationState: 'Pause' },
    })
    const resume = actionsOf(rowOf(m, 'cycle').controls).find((a) => a.call.method === 'resume')
    expect(resume?.emphasis).toBe('primary')
  })

  it('an idle dishwasher has no cycle row and no progress bar', () => {
    const m = build(DeviceType.Dishwasher, ['dishwasher'], {
      dishwasher: {
        ...DISH,
        state: 'idle',
        operationState: 'Ready',
        progress: null,
        remaining: null,
      },
    })
    expect(m.rows.map((r) => r.id)).toEqual([])
  })

  it('names the foot history button for what the device keeps', () => {
    expect(build(DeviceType.Washer, []).historyLabel.en).toBe('Cycles')
    expect(build(DeviceType.PetFeeder, []).historyLabel.en).toBe('Meals')
    expect(build(DeviceType.Lock, []).historyLabel.en).toBe('Access')
    expect(build(DeviceType.Switch, []).historyLabel.en).toBe('History')
  })
})
