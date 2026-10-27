import { DishwasherStatusSchema, type DishwasherStatus } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { CAP_ENTITY_MAP } from '../entity-catalog.js'
import { projectCapSlice } from '../state-projector.js'

const UNKNOWN: DishwasherStatus = DishwasherStatusSchema.parse({
  availability: 'offline',
  state: 'unavailable',
  operationState: null,
  program: null,
  selectedProgram: null,
  availablePrograms: [],
  remaining: null,
  delayedStart: null,
  progress: null,
  doorOpen: null,
  doorLocked: null,
  remoteStartAllowed: null,
  remoteControlActive: null,
  localControlActive: null,
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
  lastFetchedAt: 0,
})

describe('dishwasher export', () => {
  it('is mapped, with the writable switches and the verbs it can route', () => {
    const mapping = CAP_ENTITY_MAP['dishwasher']
    expect(mapping?.field).toBe('operationState')
    expect(Object.keys(mapping?.commands ?? {}).sort()).toEqual([
      'pause',
      'resume',
      'start',
      'stop',
    ])
    for (const suffix of ['power', 'child-lock', 'half-load', 'hygiene-plus', 'extra-dry']) {
      expect(mapping?.extras?.[suffix]).toMatchObject({ platform: 'switch', writable: true })
    }
    expect(mapping?.extras?.['remaining-time']).toMatchObject({
      deviceClass: 'duration',
      unit: 's',
    })
  })

  it('publishes NOTHING for an appliance nobody has heard from — Home Assistant shows unknown, not off', () => {
    const projection = projectCapSlice('camstack-dw', 'dishwasher', { ...UNKNOWN })
    expect(projection.kind).toBe('values')
    if (projection.kind !== 'values') return
    expect(projection.values).toEqual([])
  })

  it('publishes what is known and only that', () => {
    const projection = projectCapSlice('camstack-dw', 'dishwasher', {
      ...UNKNOWN,
      availability: 'available',
      operationState: 'Run',
      remaining: 2520,
      doorOpen: false,
      childLock: false,
    })
    if (projection.kind !== 'values') throw new Error(`unexpected ${projection.kind}`)
    const rendered = projection.values.map((v) => v.value).sort()
    expect(rendered).toEqual(['2520', 'false', 'false', 'Run'].sort())
  })
})
