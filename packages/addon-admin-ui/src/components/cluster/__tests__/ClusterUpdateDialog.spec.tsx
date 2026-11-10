import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ClusterUpdateJob, ClusterUpdatePlan, ClusterUpdateStep } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClusterUpdateSession } from '../ClusterUpdateDialog'
import type { ClusterUpdateClient, ClusterUpdateClock } from '../cluster-update-client'

function installDialog(): void {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false
    }
  }
}

function step(
  kind: ClusterUpdateStep['kind'],
  status: ClusterUpdateStep['status'],
  detail: string,
): ClusterUpdateStep {
  return { kind, status, detail }
}

function runningJob(): ClusterUpdateJob {
  return {
    id: 'job-1',
    state: 'running',
    targetVersion: '1.2.900',
    requestedBy: 'admin',
    startedAt: 1,
    steps: [
      step('backup', 'ok', 'Stored on the hub disk.'),
      step('hub-server', 'running', 'Hub is restarting onto 1.2.900.'),
    ],
    skippedOffline: [],
  }
}

function plan(): ClusterUpdatePlan {
  return {
    targetVersion: '1.2.900',
    steps: [
      step('backup', 'pending', 'Back up first.'),
      step('hub-server', 'pending', 'Then the hub.'),
    ],
    skippedOffline: [],
    blocker: null,
    blockerDetail: null,
  }
}

describe('ClusterUpdateSession', () => {
  let nextTick: (() => void) | null
  let job: ClusterUpdateJob | null
  let dropRead: boolean
  let started: unknown
  const clock: ClusterUpdateClock = {
    later: (_ms, tick) => {
      nextTick = tick
      return () => {
        if (nextTick === tick) nextTick = null
      }
    },
  }

  beforeEach(() => {
    installDialog()
    nextTick = null
    job = null
    dropRead = false
    started = undefined
  })

  function client(): ClusterUpdateClient {
    return {
      preview: async () => plan(),
      start: async (options) => {
        started = options
        return { accepted: true, jobId: 'job-9', blocker: null, message: 'started' }
      },
      readJob: async () => {
        if (dropRead) throw new Error('socket hang up')
        return job
      },
    }
  }

  it('resumes a running job on load, and a later failed read is restarting', async () => {
    job = runningJob()
    render(
      <ClusterUpdateSession open={false} onOpenChange={vi.fn()} client={client()} clock={clock} />,
    )
    await screen.findByRole('list', { name: /cluster update steps/i })
    expect(
      screen.getAllByRole('listitem').some((el) => el.getAttribute('data-status') === 'running'),
    ).toBe(true)

    dropRead = true
    await act(async () => {
      nextTick?.()
    })
    expect((await screen.findByRole('status')).textContent).toMatch(/restarting/i)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      screen.getAllByRole('listitem').some((el) => el.getAttribute('data-status') === 'running'),
    ).toBe(true)
  })

  it('starts with backup and addons on unless the operator skips them', async () => {
    job = null
    render(<ClusterUpdateSession open onOpenChange={vi.fn()} client={client()} clock={clock} />)
    const backup = await screen.findByRole('checkbox', { name: /skip the backup/i })
    const addons = screen.getByRole('checkbox', { name: /skip addon updates/i })
    expect(backup).toHaveProperty('checked', false)
    expect(addons).toHaveProperty('checked', false)
    fireEvent.click(screen.getByRole('button', { name: /start update/i }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(started).toEqual({ backup: true, addons: true })
  })
})
