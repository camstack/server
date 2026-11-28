import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Job } from '@dominevo/types'
import {
  activityBadgeCount,
  canCancelJob,
  canDismissJob,
  cancelRefusalKey,
  formatJobProgress,
  jobKindLabelKey,
  jobStateTone,
  readJobProgress,
  sortJobs,
} from '../job-model'

type P = Pick<Job, 'state' | 'progress'>
const running = (progress: Job['progress']): P => ({
  state: 'running',
  progress,
})

describe('readJobProgress', () => {
  it('is determinate with a known total and clamps the percent', () => {
    const r = readJobProgress(running({ done: 3, total: 10, unit: 'devices' }))
    expect(r).toEqual({
      kind: 'determinate',
      done: 3,
      total: 10,
      unit: 'devices',
      percent: 30,
    })
    const over = readJobProgress(running({ done: 12, total: 10, unit: 'devices' }))
    expect(over.kind === 'determinate' && over.percent).toBe(100)
  })

  it('null progress on a live job is indeterminate, never 0%', () => {
    expect(readJobProgress(running(null))).toEqual({
      kind: 'indeterminate',
      done: null,
      unit: null,
    })
  })

  it('null progress on a queued or finished job shows nothing', () => {
    expect(readJobProgress({ state: 'queued', progress: null })).toEqual({
      kind: 'none',
    })
    expect(readJobProgress({ state: 'done', progress: null })).toEqual({
      kind: 'none',
    })
  })

  it('an unknown or zero total is indeterminate but keeps the count', () => {
    expect(readJobProgress(running({ done: 4, total: null, unit: 'files' }))).toEqual({
      kind: 'indeterminate',
      done: 4,
      unit: 'files',
    })
    expect(readJobProgress(running({ done: 0, total: 0, unit: 'files' })).kind).toBe(
      'indeterminate',
    )
  })
})

describe('formatJobProgress', () => {
  it('formats real units', () => {
    expect(
      formatJobProgress(readJobProgress(running({ done: 3, total: 10, unit: 'devices' }))),
    ).toBe('3 / 10 devices')
    expect(
      formatJobProgress(readJobProgress(running({ done: 4, total: null, unit: 'files' }))),
    ).toBe('4 files')
  })
  it('has no text when nothing is known', () => {
    expect(formatJobProgress(readJobProgress(running(null)))).toBeNull()
    expect(formatJobProgress({ kind: 'none' })).toBeNull()
  })
})

describe('state mapping and actions', () => {
  it('maps every state to a tone', () => {
    expect(jobStateTone('running')).toBe('info')
    expect(jobStateTone('failed')).toBe('danger')
    expect(jobStateTone('done')).toBe('success')
    expect(jobStateTone('cancelled')).toBe('warning')
    expect(jobStateTone('queued')).toBe('neutral')
  })
  it('cancels only a cancellable live job, dismisses only a finished one', () => {
    expect(canCancelJob({ state: 'running', cancellable: true })).toBe(true)
    expect(canCancelJob({ state: 'running', cancellable: false })).toBe(false)
    expect(canCancelJob({ state: 'done', cancellable: true })).toBe(false)
    expect(canDismissJob({ state: 'running' })).toBe(false)
    expect(canDismissJob({ state: 'failed' })).toBe(true)
  })
  it('names every refusal, and an unknown one', () => {
    expect(cancelRefusalKey('producer-unreachable')).toBe(
      'activity.cancelRefused.producerUnreachable',
    )
    expect(cancelRefusalKey(null)).toBe('activity.cancelRefused.unknown')
  })
  it('builds a kind key without dots', () => {
    expect(jobKindLabelKey({ kind: 'adoption' })).toBe('activity.kind.adoption')
  })
})

describe('badge and order', () => {
  it('counts running plus unseen finished; an unmeasured count is not a number', () => {
    expect(activityBadgeCount({ running: 2, unseenFinished: 1 })).toBe(3)
    expect(activityBadgeCount({ running: 2, unseenFinished: null })).toBe(2)
    expect(activityBadgeCount(undefined)).toBe(0)
    expect(activityBadgeCount(null)).toBe(0)
  })
  it('puts live jobs first, then newest', () => {
    const jobs = [
      { state: 'done' as const, createdAt: 30 },
      { state: 'running' as const, createdAt: 10 },
      { state: 'failed' as const, createdAt: 40 },
      { state: 'queued' as const, createdAt: 20 },
    ]
    expect(sortJobs(jobs).map((j) => j.createdAt)).toEqual([20, 10, 40, 30])
  })
})

describe('the real adoption producer against the en catalogue', () => {
  const engine = readFileSync(
    resolve(__dirname, '../../../../../system/src/builtins/device-manager/adoption-job-engine.ts'),
    'utf8',
  )
  const kind = /ADOPTION_JOB_KIND = '([^']+)'/.exec(engine)?.[1]
  const titleKey = /titleKey: '([^']+)'/.exec(engine)?.[1]
  const unit = /unit: '([^']+)'/.exec(engine)?.[1]
  const en: unknown = JSON.parse(readFileSync(resolve(__dirname, '../../../i18n/en.json'), 'utf8'))
  const lookup = (key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>(
        (o, k) => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined),
        en,
      )

  it('reads kind, titleKey and unit from the producer', () => {
    expect([kind, titleKey, unit]).toEqual(['adoption', 'jobs.adoption.title', 'candidates'])
  })
  it('has a kind label, a title and a unit label for what the producer registers', () => {
    expect(typeof lookup(jobKindLabelKey({ kind: kind ?? '' }))).toBe('string')
    expect(typeof lookup(titleKey ?? '')).toBe('string')
    expect(typeof lookup(`activity.unit.${unit ?? ''}_other`)).toBe('string')
  })
})
