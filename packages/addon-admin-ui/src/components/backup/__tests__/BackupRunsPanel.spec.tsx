/**
 * BackupRunsPanel — the incident invariants, at the UI layer (D342).
 *
 * The operator watched a runaway backup fill the disk and found it
 * with `du`. This suite pins what the panel must make impossible:
 *
 *   1. D315 — an UNANSWERED runs query must not render as "no runs".
 *   2. A run in flight shows its live staged bytes — the number that
 *      would have shown the runaway in seconds.
 *   3. A stopped run reads "Stopped", never rounded off to success;
 *      a failed run shows its error and completed-vs-failed targets.
 *   4. Queued and running runs carry a cancel control wired to the
 *      run; finished runs do not.
 *   5. The cancel confirm states what survives — queued loses
 *      nothing, running loses the partial but KEEPS completed
 *      destinations.
 */
import type { BackupRun } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackupRunsPanelView,
  describeCancelConsequence,
  formatElapsed,
  positionLabel,
} from '../BackupRunsPanel'

afterEach(() => {
  cleanup()
})

const NOW = 1_757_000_000_000

function makeRun(overrides: Partial<BackupRun>): BackupRun {
  return {
    id: 'run-aaaa-bbbb',
    state: 'running',
    phase: 'building',
    destinationIds: ['backups:default'],
    requestedAt: NOW - 60_000,
    startedAt: NOW - 50_000,
    stagedBytes: 0,
    uploadedBytes: 0,
    completedDestinationIds: [],
    failedDestinationIds: [],
    ...overrides,
  }
}

function renderView(input: {
  queryState: 'pending' | 'error' | 'ready'
  runs?: readonly BackupRun[]
  cancelingId?: string | null
  onCancelRequest?: (run: BackupRun) => void
}) {
  const onCancelRequest = input.onCancelRequest ?? vi.fn()
  render(
    <BackupRunsPanelView
      queryState={input.queryState}
      runs={input.runs ?? []}
      cancelingId={input.cancelingId ?? null}
      onCancelRequest={onCancelRequest}
      now={NOW}
    />,
  )
  return onCancelRequest
}

describe('BackupRunsPanelView — pending vs empty (D315)', () => {
  it('an unanswered query renders as CHECKING, never as "no runs"', () => {
    renderView({ queryState: 'pending' })
    expect(screen.getByText(/checking for backup runs/i)).toBeTruthy()
    expect(screen.queryByText(/no backup runs yet/i)).toBeNull()
  })

  it('an ANSWERED empty list states there are no runs', () => {
    renderView({ queryState: 'ready', runs: [] })
    expect(screen.getByText(/no backup runs yet/i)).toBeTruthy()
    expect(screen.queryByText(/checking for backup runs/i)).toBeNull()
  })

  it('a failed query says the orchestrator did not answer — not "no runs"', () => {
    renderView({ queryState: 'error' })
    expect(screen.getByText(/could not read backup runs/i)).toBeTruthy()
    expect(screen.queryByText(/no backup runs yet/i)).toBeNull()
  })

  it('never blanks: the section frame renders in every query state', () => {
    for (const queryState of ['pending', 'error', 'ready'] as const) {
      cleanup()
      renderView({ queryState })
      expect(screen.getByRole('heading', { name: 'Runs' })).toBeTruthy()
    }
  })
})

describe('BackupRunsPanelView — a run in flight is legible', () => {
  it('a BUILDING run shows its live staged bytes — the runaway number', () => {
    renderView({
      queryState: 'ready',
      runs: [makeRun({ stagedBytes: 5.1 * 1024 * 1024 * 1024 })],
    })
    // formatBytes(5.1 GB) — the growing value itself, plus what it is.
    expect(screen.getByText(/5\.1 GB/)).toBeTruthy()
    expect(screen.getByText(/staged so far/i)).toBeTruthy()
    expect(screen.getByText(/building archive/i)).toBeTruthy()
  })

  it('an UPLOADING run shows uploaded / total and the phase', () => {
    renderView({
      queryState: 'ready',
      runs: [
        makeRun({
          phase: 'uploading',
          stagedBytes: 2048,
          archiveSizeBytes: 4 * 1024 * 1024 * 1024,
          uploadedBytes: 1024 * 1024 * 1024,
        }),
      ],
    })
    expect(screen.getByText(/uploading/i)).toBeTruthy()
    expect(screen.getByText(/1\.0 GB \/ 4\.0 GB/)).toBeTruthy()
  })

  it('shows elapsed running time and the destination targets', () => {
    renderView({
      queryState: 'ready',
      runs: [makeRun({ destinationIds: ['backups:default', 'backups:nas'] })],
    })
    expect(screen.getByText(/running for 50s/i)).toBeTruthy()
    expect(screen.getByText(/2 targets/i)).toBeTruthy()
  })
})

describe('BackupRunsPanelView — honest outcomes', () => {
  it('a cancelled run reads STOPPED, never Succeeded', () => {
    renderView({
      queryState: 'ready',
      runs: [
        makeRun({
          state: 'cancelled',
          phase: 'done',
          finishedAt: NOW - 1_000,
          completedDestinationIds: ['backups:default'],
        }),
      ],
    })
    expect(screen.getByText('Stopped')).toBeTruthy()
    expect(screen.queryByText('Succeeded')).toBeNull()
  })

  it('a failed run shows its error and completed vs failed destinations', () => {
    renderView({
      queryState: 'ready',
      runs: [
        makeRun({
          state: 'failed',
          phase: 'done',
          finishedAt: NOW - 1_000,
          error: 'disk on fire',
          destinationIds: ['backups:default', 'backups:nas'],
          completedDestinationIds: ['backups:default'],
          failedDestinationIds: ['backups:nas'],
        }),
      ],
    })
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('disk on fire')).toBeTruthy()
    expect(screen.getByText(/1 completed/)).toBeTruthy()
    expect(screen.getByText(/1 failed/)).toBeTruthy()
  })
})

describe('BackupRunsPanelView — cancel control', () => {
  it('a RUNNING run offers Stop and hands back the run', () => {
    const run = makeRun({})
    const onCancel = renderView({ queryState: 'ready', runs: [run] })
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(onCancel).toHaveBeenCalledWith(run)
  })

  it('a QUEUED run offers Cancel', () => {
    const run = makeRun({ state: 'queued', phase: 'queued' })
    const onCancel = renderView({ queryState: 'ready', runs: [run] })
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledWith(run)
  })

  it('finished runs offer no cancel control', () => {
    renderView({
      queryState: 'ready',
      runs: [
        makeRun({ state: 'succeeded', phase: 'done', finishedAt: NOW }),
        makeRun({ id: 'run-2', state: 'failed', phase: 'done', finishedAt: NOW }),
        makeRun({ id: 'run-3', state: 'cancelled', phase: 'done', finishedAt: NOW }),
      ],
    })
    expect(screen.queryByRole('button', { name: /stop|cancel/i })).toBeNull()
  })
})

describe('BackupRunsPanelView — the queue, in execution order', () => {
  /**
   * Server order: running, then queued as the orchestrator WILL run
   * them. The queued runs' timestamps are arranged so a newest-first
   * sort would FLIP them — the exact regression this test pins.
   */
  function queueScenario(): readonly BackupRun[] {
    return [
      makeRun({ id: 'run-live', label: 'live', requestedAt: NOW - 300_000 }),
      makeRun({
        id: 'run-first',
        label: 'first-in-line',
        state: 'queued',
        phase: 'queued',
        queuePosition: 1,
        requestedAt: NOW - 120_000,
      }),
      makeRun({
        id: 'run-second',
        label: 'second-in-line',
        state: 'queued',
        phase: 'queued',
        queuePosition: 2,
        requestedAt: NOW - 10_000,
      }),
    ]
  }

  it('renders queued runs in EXECUTION order — a newest-first sort would flip them', () => {
    renderView({ queryState: 'ready', runs: queueScenario() })
    const rows = screen.getAllByRole('row').map((row) => row.textContent ?? '')
    const liveIndex = rows.findIndex((text) => text.includes('live'))
    const firstIndex = rows.findIndex((text) => text.includes('first-in-line'))
    const secondIndex = rows.findIndex((text) => text.includes('second-in-line'))
    expect(liveIndex).toBeGreaterThan(-1)
    expect(firstIndex).toBeGreaterThan(liveIndex)
    expect(secondIndex).toBeGreaterThan(firstIndex)
  })

  it('says WHERE each queued run stands: next, then 2nd', () => {
    renderView({ queryState: 'ready', runs: queueScenario() })
    expect(screen.getByText('next')).toBeTruthy()
    expect(screen.getByText('2nd')).toBeTruthy()
  })

  it('states the design: one run executes at a time', () => {
    renderView({ queryState: 'ready', runs: [] })
    expect(screen.getByText(/one run executes at a time/i)).toBeTruthy()
  })

  it('a queued run the server gave no position falls back to waiting, not a wrong number', () => {
    renderView({
      queryState: 'ready',
      runs: [makeRun({ state: 'queued', phase: 'queued' })],
    })
    expect(screen.getByText(/waiting its turn/i)).toBeTruthy()
    expect(screen.queryByText('next')).toBeNull()
  })
})

describe('positionLabel', () => {
  it('labels the head of the line "next" and the rest ordinally', () => {
    expect(positionLabel(1)).toBe('next')
    expect(positionLabel(2)).toBe('2nd')
    expect(positionLabel(3)).toBe('3rd')
    expect(positionLabel(4)).toBe('4th')
    expect(positionLabel(11)).toBe('11th')
    expect(positionLabel(21)).toBe('21st')
  })
})

describe('describeCancelConsequence — the operator must not guess', () => {
  it('queued: never starts, nothing deleted', () => {
    const prompt = describeCancelConsequence({ state: 'queued', completedDestinationIds: [] })
    expect(prompt.message).toMatch(/has not started/i)
    expect(prompt.message).toMatch(/nothing is deleted/i)
    expect(prompt.variant).toBe('warning')
  })

  it('running with completed destinations: partial discarded, completed KEEP their archive', () => {
    const prompt = describeCancelConsequence({
      state: 'running',
      completedDestinationIds: ['backups:default', 'backups:nas'],
    })
    expect(prompt.message).toMatch(/half-written staging archive is deleted/i)
    expect(prompt.message).toMatch(/discards its partial copy/i)
    expect(prompt.message).toMatch(/2 destinations that already completed KEEP/)
    expect(prompt.variant).toBe('danger')
  })

  it('running with nothing completed: says nothing will be kept', () => {
    const prompt = describeCancelConsequence({ state: 'running', completedDestinationIds: [] })
    expect(prompt.message).toMatch(/nothing will be kept/i)
  })
})

describe('formatElapsed', () => {
  it('renders seconds, minutes and hours compactly', () => {
    expect(formatElapsed(42_000)).toBe('42s')
    expect(formatElapsed(192_000)).toBe('3m 12s')
    expect(formatElapsed(3_840_000)).toBe('1h 04m')
    expect(formatElapsed(-5)).toBe('0s')
  })
})
