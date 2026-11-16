/**
 * Quick edit writes only the name and the tags. Each fixture below carries a
 * MARKED value in every other field, so a builder that drops one of them (the
 * bug ee28c8611 fixed for actions and schedulers) fails here.
 */
import type { ActionEntry, CoreBlock, Scheduler } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  actionQuickEditInput,
  blockQuickEditInput,
  quickEditValuesOf,
  schedulerQuickEditInput,
} from '../quick-edit-inputs'

const NEXT = { name: 'Renamed', tags: ['Night', 'Garden'] } as const

const BLOCK: CoreBlock = {
  id: 'blk-1',
  name: 'Garage watch',
  code: 'export default MARKED_CODE',
  files: { 'main.ts': 'MARKED_FILE_A', 'util.ts': 'MARKED_FILE_B' },
  entry: 'main.ts',
  enabled: false,
  placement: 'node-marked',
  integrationId: 'integration-marked',
  tags: ['Old'],
  createdAt: 1,
  updatedAt: 2,
  createdBy: 'tester',
  status: 'stopped',
  lastChangedAt: 3,
}

describe('blockQuickEditInput', () => {
  it('sets the name and tags and keeps every other field of the script', () => {
    const input = blockQuickEditInput(BLOCK, NEXT)
    expect(input.name).toBe('Renamed')
    expect(input.tags).toEqual(['Night', 'Garden'])
    expect(input.code).toBe('export default MARKED_CODE')
    expect(input.files).toEqual({ 'main.ts': 'MARKED_FILE_A', 'util.ts': 'MARKED_FILE_B' })
    expect(input.entry).toBe('main.ts')
    expect(input.enabled).toBe(false)
    expect(input.placement).toBe('node-marked')
    expect(input.integrationId).toBe('integration-marked')
  })
})

const ACTION: ActionEntry = {
  id: 'internal:abc',
  name: 'Feed the dog',
  addonId: 'core-blocks',
  source: 'internal',
  readOnly: false,
  tags: ['Old'],
  variables: [{ name: 'marked_var', type: 'number', default: 7 }],
  steps: [{ kind: 'wait', seconds: 42 }],
  minDelaySec: 9999,
  status: { isRunning: false, lastRunAt: null, lastError: null },
}

describe('actionQuickEditInput', () => {
  it('sets the name and tags and keeps the steps, variables and cooldown', () => {
    const check = actionQuickEditInput(ACTION, NEXT)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.input.name).toBe('Renamed')
    expect(check.input.tags).toEqual(['Night', 'Garden'])
    expect(check.input.steps).toEqual([{ kind: 'wait', seconds: 42 }])
    expect(check.input.variables).toEqual([{ name: 'marked_var', type: 'number', default: 7 }])
    expect(check.input.minDelaySec).toBe(9999)
  })

  it('is refused (not sent) when the name is blank', () => {
    expect(actionQuickEditInput(ACTION, { name: '  ', tags: [] }).ok).toBe(false)
  })
})

const SCHEDULER: Scheduler = {
  id: 'sch-1',
  name: 'Garden lights',
  enabled: false,
  priority: 42,
  maxLateMs: 123_000,
  profiles: [{ id: 'p1', name: 'MARKED_PROFILE', enabled: true, days: ['mon'], points: [] }],
  tags: ['Old'],
  createdAt: 1,
  updatedAt: 2,
}

describe('schedulerQuickEditInput', () => {
  it('sets the name and tags and keeps settings and profiles, without the stamps', () => {
    const input = schedulerQuickEditInput(SCHEDULER, NEXT)
    expect(input.name).toBe('Renamed')
    expect(input.tags).toEqual(['Night', 'Garden'])
    expect(input.enabled).toBe(false)
    expect(input.priority).toBe(42)
    expect(input.maxLateMs).toBe(123_000)
    expect(input.profiles.map((p) => p.name)).toEqual(['MARKED_PROFILE'])
    expect('id' in input).toBe(false)
    expect('createdAt' in input).toBe(false)
  })
})

describe('quickEditValuesOf', () => {
  it('opens with the stored name and an empty list when there are no tags', () => {
    expect(quickEditValuesOf({ name: 'X' })).toEqual({ name: 'X', tags: [] })
    expect(quickEditValuesOf({ name: 'X', tags: ['a'] })).toEqual({ name: 'X', tags: ['a'] })
  })
})
