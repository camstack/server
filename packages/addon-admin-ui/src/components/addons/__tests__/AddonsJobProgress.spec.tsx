/**
 * AddonsJobProgress (F4) — per-addon live progress over the lifecycle
 * job engine.
 *
 * Covers:
 *  - `deriveTaskProgressByPackage`: per-package keying, concurrent jobs
 *    kept independent, stale terminal entries dropped, later job wins.
 *  - `isTaskProgressActive`: phase/job-state terminality.
 *  - `useAddonJobProgress`: listJobs seed merged with live per-job event
 *    snapshots (events override the seed; one job completing never
 *    clears another job's progress).
 *  - `AddonsJobProgress` badge rendering per phase.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { LifecycleJob, LifecycleTask, TaskPhase } from '@camstack/types'

// ---------------------------------------------------------------------------
// Mock @camstack/ui-library BEFORE importing the module under test
// ---------------------------------------------------------------------------

let mockActiveJobs: LifecycleJob[] = []
let mockLiveJobMap: Map<string, { job: LifecycleJob }> = new Map()

vi.mock('@camstack/ui-library', () => ({
  useAddonsListJobs: () => ({ data: mockActiveJobs }),
  useEventStreamMap: () => ({
    map: mockLiveJobMap,
    values: Array.from(mockLiveJobMap.values()),
  }),
}))

import {
  AddonsJobProgress,
  deriveTaskProgressByPackage,
  isTaskProgressActive,
  useAddonJobProgress,
  TERMINAL_VISIBILITY_MS,
} from '../AddonsJobProgress'
import type { AddonTaskProgress } from '../AddonsJobProgress'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_000_000

function task(overrides: Partial<LifecycleTask> = {}): LifecycleTask {
  return {
    taskId: 't-1',
    nodeId: 'hub',
    packageName: '@camstack/addon-a',
    fromVersion: '1.0.0',
    toVersion: '1.0.1',
    target: 'addon',
    phase: 'applying',
    stagedPath: null,
    attempts: 1,
    steps: [],
    error: null,
    startedAtMs: NOW - 5_000,
    finishedAtMs: null,
    ...overrides,
  }
}

function job(overrides: Partial<LifecycleJob> = {}): LifecycleJob {
  return {
    jobId: 'job-1',
    kind: 'update',
    createdAtMs: NOW - 10_000,
    createdBy: 'tester',
    scope: 'single',
    tasks: [task()],
    state: 'running',
    schemaVersion: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// deriveTaskProgressByPackage
// ---------------------------------------------------------------------------

describe('deriveTaskProgressByPackage', () => {
  it('keys progress by packageName — two concurrent jobs stay independent', () => {
    const jobs = [
      job({ jobId: 'job-a', tasks: [task({ packageName: '@camstack/addon-a' })] }),
      job({
        jobId: 'job-b',
        createdAtMs: NOW - 9_000,
        tasks: [task({ taskId: 't-2', packageName: '@camstack/addon-b', phase: 'fetching' })],
      }),
    ]
    const map = deriveTaskProgressByPackage(jobs, NOW)
    expect(map.size).toBe(2)
    expect(map.get('@camstack/addon-a')?.phase).toBe('applying')
    expect(map.get('@camstack/addon-a')?.jobId).toBe('job-a')
    expect(map.get('@camstack/addon-b')?.phase).toBe('fetching')
    expect(map.get('@camstack/addon-b')?.jobId).toBe('job-b')
  })

  it('one job completing does not remove the other package entry', () => {
    const jobs = [
      job({
        jobId: 'job-a',
        state: 'completed',
        tasks: [
          task({ packageName: '@camstack/addon-a', phase: 'done', finishedAtMs: NOW - 1_000 }),
        ],
      }),
      job({
        jobId: 'job-b',
        tasks: [task({ taskId: 't-2', packageName: '@camstack/addon-b', phase: 'applying' })],
      }),
    ]
    const map = deriveTaskProgressByPackage(jobs, NOW)
    expect(map.get('@camstack/addon-a')?.phase).toBe('done')
    expect(map.get('@camstack/addon-b')?.phase).toBe('applying')
  })

  it('drops terminal-job entries older than the visibility window', () => {
    const jobs = [
      job({
        jobId: 'job-old',
        state: 'completed',
        tasks: [
          task({
            packageName: '@camstack/addon-a',
            phase: 'done',
            finishedAtMs: NOW - TERMINAL_VISIBILITY_MS - 1,
          }),
        ],
      }),
    ]
    expect(deriveTaskProgressByPackage(jobs, NOW).size).toBe(0)
  })

  it('keeps a RUNNING job visible regardless of age', () => {
    const jobs = [
      job({ createdAtMs: NOW - TERMINAL_VISIBILITY_MS * 10, tasks: [task({ phase: 'queued' })] }),
    ]
    expect(deriveTaskProgressByPackage(jobs, NOW).size).toBe(1)
  })

  it('a later job for the same package overrides the earlier one', () => {
    const jobs = [
      job({
        jobId: 'job-old',
        createdAtMs: NOW - 20_000,
        state: 'failed',
        tasks: [task({ phase: 'failed', error: 'boom', finishedAtMs: NOW - 15_000 })],
      }),
      job({ jobId: 'job-new', createdAtMs: NOW - 5_000, tasks: [task({ phase: 'fetching' })] }),
    ]
    const map = deriveTaskProgressByPackage(jobs, NOW)
    expect(map.get('@camstack/addon-a')?.jobId).toBe('job-new')
    expect(map.get('@camstack/addon-a')?.phase).toBe('fetching')
  })
})

// ---------------------------------------------------------------------------
// isTaskProgressActive
// ---------------------------------------------------------------------------

describe('isTaskProgressActive', () => {
  function progress(phase: TaskPhase, jobState: AddonTaskProgress['jobState']): AddonTaskProgress {
    return {
      jobId: 'j',
      packageName: 'p',
      phase,
      fromVersion: '1.0.0',
      toVersion: '1.0.1',
      error: null,
      jobState,
      finishedAtMs: null,
    }
  }

  it('running phases on a running job are active', () => {
    for (const phase of ['queued', 'fetching', 'staged', 'validating', 'applying'] as const) {
      expect(isTaskProgressActive(progress(phase, 'running'))).toBe(true)
    }
  })

  it('terminal task phases are inactive', () => {
    for (const phase of ['done', 'failed', 'skipped'] as const) {
      expect(isTaskProgressActive(progress(phase, 'running'))).toBe(false)
    }
  })

  it('terminal job states are inactive even with a non-terminal phase', () => {
    expect(isTaskProgressActive(progress('applying', 'cancelled'))).toBe(false)
    expect(isTaskProgressActive(progress('applying', 'failed'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// useAddonJobProgress — seed + live merge
// ---------------------------------------------------------------------------

function Probe() {
  const map = useAddonJobProgress()
  return (
    <ul>
      {Array.from(map.values()).map((p) => (
        <li key={p.packageName} data-testid="probe-entry">
          {p.packageName}:{p.phase}:{p.jobId}
        </li>
      ))}
    </ul>
  )
}

describe('useAddonJobProgress', () => {
  beforeEach(() => {
    mockActiveJobs = []
    mockLiveJobMap = new Map()
  })

  it('seeds from listJobs(activeOnly) so reload-mid-job still shows progress', () => {
    mockActiveJobs = [job({ jobId: 'job-seed', tasks: [task({ phase: 'applying' })] })]
    render(<Probe />)
    expect(screen.getByTestId('probe-entry').textContent).toBe(
      '@camstack/addon-a:applying:job-seed',
    )
  })

  it('live event snapshot for the same jobId overrides the seed', () => {
    mockActiveJobs = [job({ jobId: 'job-1', tasks: [task({ phase: 'fetching' })] })]
    mockLiveJobMap = new Map([
      ['job-1', { job: job({ jobId: 'job-1', tasks: [task({ phase: 'applying' })] }) }],
    ])
    render(<Probe />)
    expect(screen.getByTestId('probe-entry').textContent).toBe('@camstack/addon-a:applying:job-1')
  })

  it('two concurrent live jobs render independent per-package progress', () => {
    mockLiveJobMap = new Map([
      [
        'job-a',
        { job: job({ jobId: 'job-a', tasks: [task({ packageName: '@camstack/addon-a' })] }) },
      ],
      [
        'job-b',
        {
          job: job({
            jobId: 'job-b',
            tasks: [task({ taskId: 't-2', packageName: '@camstack/addon-b', phase: 'fetching' })],
          }),
        },
      ],
    ])
    render(<Probe />)
    const entries = screen.getAllByTestId('probe-entry').map((e) => e.textContent)
    expect(entries).toContain('@camstack/addon-a:applying:job-a')
    expect(entries).toContain('@camstack/addon-b:fetching:job-b')
  })
})

// ---------------------------------------------------------------------------
// AddonsJobProgress badge
// ---------------------------------------------------------------------------

describe('AddonsJobProgress badge', () => {
  function progress(overrides: Partial<AddonTaskProgress> = {}): AddonTaskProgress {
    return {
      jobId: 'j',
      packageName: '@camstack/addon-a',
      phase: 'applying',
      fromVersion: '1.0.0',
      toVersion: '1.0.1',
      error: null,
      jobState: 'running',
      finishedAtMs: null,
      ...overrides,
    }
  }

  it('renders the in-flight phase label + target version', () => {
    render(<AddonsJobProgress progress={progress()} />)
    const badge = screen.getByTestId('addon-job-progress')
    expect(badge.textContent).toContain('applying')
    expect(badge.textContent).toContain('1.0.1')
  })

  it('renders done as "updated"', () => {
    render(<AddonsJobProgress progress={progress({ phase: 'done', finishedAtMs: 1 })} />)
    expect(screen.getByTestId('addon-job-progress').textContent).toContain('updated')
  })

  it('renders failed with the error message in the title', () => {
    render(<AddonsJobProgress progress={progress({ phase: 'failed', error: 'npm 404' })} />)
    const badge = screen.getByTestId('addon-job-progress')
    expect(badge.textContent).toContain('failed')
    expect(badge.getAttribute('title')).toContain('npm 404')
  })
})
