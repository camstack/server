import { describe, expect, it } from 'vitest'
import type { ClusterUpdateJob, ClusterUpdateStep } from '@camstack/types'
import {
  classifyJobRead,
  dialogMode,
  nextFollowing,
  optionsFromChoices,
  resumeJob,
  stepMark,
} from '../cluster-update-view'

function step(
  status: ClusterUpdateStep['status'],
  reason?: ClusterUpdateStep['reason'],
): ClusterUpdateStep {
  return {
    kind: 'agent-server',
    nodeId: 'agent-a',
    status,
    detail: 'agent-a',
    ...(reason !== undefined ? { reason } : {}),
  }
}

function job(
  state: ClusterUpdateJob['state'],
  steps: readonly ClusterUpdateStep[],
): ClusterUpdateJob {
  return {
    id: 'job-1',
    state,
    targetVersion: '1.2.900',
    requestedBy: 'admin',
    startedAt: 1,
    steps,
    skippedOffline: [],
  }
}

const running = job('running', [step('running')])

describe('optionsFromChoices', () => {
  it('runs backup and addons unless the operator opts out', () => {
    expect(optionsFromChoices({ skipBackup: false, skipAddons: false })).toEqual({
      backup: true,
      addons: true,
    })
    expect(optionsFromChoices({ skipBackup: true, skipAddons: true })).toEqual({
      backup: false,
      addons: false,
    })
  })
})

describe('classifyJobRead — a restart is not an error', () => {
  it('a failed read while a job is in flight is restarting and keeps the last steps', () => {
    const view = classifyJobRead({ ok: false, message: 'socket hang up' }, true, running)
    expect(view).toEqual({ kind: 'restarting', last: running })
  })

  it('a failed read before any job is an error', () => {
    const view = classifyJobRead({ ok: false, message: 'no procedure found' }, false, null)
    expect(view).toEqual({ kind: 'error', message: 'no procedure found' })
  })

  it('a job that is still running stays a job', () => {
    expect(classifyJobRead({ ok: true, job: running }, true, null)).toEqual({
      kind: 'job',
      job: running,
    })
  })

  it('no job yet is idle, and a missing job while following is a restart', () => {
    expect(classifyJobRead({ ok: true, job: null }, false, null)).toEqual({ kind: 'idle' })
    expect(classifyJobRead({ ok: true, job: null }, true, running)).toEqual({
      kind: 'restarting',
      last: running,
    })
  })
})

describe('nextFollowing', () => {
  it('keeps polling through a restart and stops when the job ends', () => {
    expect(nextFollowing(true, { kind: 'restarting', last: running })).toBe(true)
    expect(nextFollowing(true, { kind: 'job', job: running })).toBe(true)
    expect(
      nextFollowing(true, { kind: 'job', job: job('failed', [step('failed', 'node-capless')]) }),
    ).toBe(false)
    expect(nextFollowing(false, { kind: 'error', message: 'down' })).toBe(false)
  })
})

describe('dialogMode and resumeJob', () => {
  it('shows progress for a running job, a restart, or a job this dialog started', () => {
    expect(dialogMode({ kind: 'idle' }, null)).toBe('preview')
    expect(dialogMode({ kind: 'job', job: running }, null)).toBe('progress')
    expect(dialogMode({ kind: 'restarting', last: running }, null)).toBe('progress')
    expect(dialogMode({ kind: 'idle' }, 'job-1')).toBe('progress')
  })

  it('the page resumes a running job and a restart, and hides a finished one', () => {
    expect(resumeJob({ kind: 'job', job: running })).toBe(running)
    expect(resumeJob({ kind: 'restarting', last: running })).toBe(running)
    expect(
      resumeJob({ kind: 'job', job: job('failed', [step('failed', 'node-capless')]) }),
    ).toBeNull()
    expect(resumeJob({ kind: 'idle' })).toBeNull()
  })
})

describe('stepMark', () => {
  it('maps each step status onto one badge', () => {
    expect(stepMark('pending')).toBe('idle')
    expect(stepMark('running')).toBe('running')
    expect(stepMark('ok')).toBe('online')
    expect(stepMark('failed')).toBe('error')
    expect(stepMark('skipped')).toBe('disabled')
  })
})
