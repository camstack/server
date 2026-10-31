/**
 * MaintenanceAuditSection — Recordings → Management batch audit.
 *
 * One safe "Run audit" walks orphans → debug media → frozen ledger, stacking
 * a report as each step finishes. Apply buttons appear under a report only
 * when that pass found something. Reconcile and migration are not this panel.
 */

import type { StorageLocation } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMaintenanceAudit } from '../maintenance-audit-session'

const confirm = vi.fn()
const custom = vi.fn()
const startMedia = vi.fn()
const refetchMedia = vi.fn()
const walk = vi.fn()

const LIVE: StorageLocation = {
  id: 'recordings:default',
  type: 'recordings',
  displayName: 'Recordings',
  providerId: 'fs',
  config: {},
  isSystem: true,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
}

const FROZEN: StorageLocation = {
  id: 'recordingsLow:default',
  type: 'recordingsLow',
  displayName: 'Low-res (old disk)',
  providerId: 'fs',
  config: {},
  isSystem: true,
  enabled: false,
  createdAt: 0,
  updatedAt: 0,
}

let locations: StorageLocation[] | undefined = [LIVE, FROZEN]

let mediaStatus: {
  running: boolean
  mode: 'report' | 'reclaim' | null
  totalExamined: number
  totalEligible: number
  totalReclaimed: number
  totalBytesReclaimed: number
  totalRefused: number
  devicesDone: number
  complete: boolean | null
  startedAtMs: number | null
  finishedAtMs: number | null
  error: string | null
}

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    Button: actual.Button,
    Input: actual.Input,
    Select: actual.Select,
    FileInput: actual.FileInput,
    Textarea: actual.Textarea,
    Checkbox: actual.Checkbox,
    Slider: actual.Slider,
    Radio: actual.Radio,
    useConfirm: () => confirm,
    useAddonsCustom: () => ({ mutateAsync: custom, isPending: false }),
    usePipelineAnalyticsReclaimDebugMedia: () => ({ mutateAsync: startMedia, isPending: false }),
    usePipelineAnalyticsGetMediaReclaimStatus: () => ({ data: mediaStatus, refetch: refetchMedia }),
    useStorageListLocations: () => ({ data: locations }),
    useRecordingArchiveReconcileLedgerAgainstDisk: () => ({ mutateAsync: walk, isPending: false }),
  }
})

import { MaintenanceAuditSection } from '../MaintenanceAuditSection'

const MEDIA_IDLE = {
  running: false,
  mode: null as 'report' | 'reclaim' | null,
  totalExamined: 0,
  totalEligible: 0,
  totalReclaimed: 0,
  totalBytesReclaimed: 0,
  totalRefused: 0,
  devicesDone: 0,
  complete: null as boolean | null,
  startedAtMs: null as number | null,
  finishedAtMs: null as number | null,
  error: null as string | null,
}

const MEDIA_REPORT = {
  ...MEDIA_IDLE,
  mode: 'report' as const,
  totalExamined: 4000,
  totalEligible: 120,
  totalReclaimed: 0,
  totalBytesReclaimed: 11_000_000,
  complete: true,
  startedAtMs: 1,
  finishedAtMs: 2,
}

const LEDGER_REPORT = {
  locationId: 'recordingsLow:default',
  applied: false,
  refused: null,
  archiveSegments: 1,
  archiveBytes: 1,
  hoursClaimed: 1,
  hoursWalked: 1,
  hoursMissing: 0,
  listings: 1,
  segmentsClaimed: 1,
  ghostSegments: 38,
  ghostBytes: 5_650_495_197,
  ghostHoursWhole: 1,
  forgottenSegments: 0,
  forgottenBytes: 0,
  orphanFiles: 2,
  orphanSample: [],
  hoursSkipped: 0,
  skippedByReason: {
    'live-tail': 0,
    'listing-error': 0,
    'path-mismatch': 0,
    'durable-refused': 0,
  },
  bounded: false,
  byDevice: [],
}

describe('MaintenanceAuditSection', () => {
  beforeEach(() => {
    clearMaintenanceAudit()
    confirm.mockReset()
    custom.mockReset()
    startMedia.mockReset()
    refetchMedia.mockReset()
    walk.mockReset()
    confirm.mockResolvedValue(true)
    custom.mockResolvedValue({
      ran: true,
      mode: 'report',
      totalOrphans: 12,
      totalReclaimed: 0,
      totalBytesReclaimed: 0,
    })
    startMedia.mockResolvedValue({ started: true, alreadyRunning: false })
    mediaStatus = { ...MEDIA_REPORT }
    refetchMedia.mockResolvedValue({ data: MEDIA_REPORT })
    walk.mockResolvedValue(LEDGER_REPORT)
    locations = [LIVE, FROZEN]
  })

  it('offers Run audit and no essay headings', () => {
    render(<MaintenanceAuditSection />)
    expect(screen.getByRole('heading', { name: 'Count leftovers' })).toBeInTheDocument()
    expect(screen.getByText(/orphan analytics|debug stills|ghost hours/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run audit' })).toBeInTheDocument()
    expect(screen.queryByText(/make the database match/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/alignment and one-shot reclaim/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Housekeeping' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Migration' })).not.toBeInTheDocument()
  })

  it('holds Run audit until storage locations have loaded', () => {
    locations = undefined
    render(<MaintenanceAuditSection />)
    expect(screen.getByRole('button', { name: 'Run audit' })).toBeDisabled()
  })

  it('Run audit reports orphans, then debug media, then frozen ledger — in that order', async () => {
    const order: string[] = []
    custom.mockImplementation(async () => {
      order.push('orphans')
      return {
        ran: true,
        mode: 'report',
        totalOrphans: 12,
        totalReclaimed: 0,
        totalBytesReclaimed: 0,
      }
    })
    startMedia.mockImplementation(async () => {
      order.push('debug-media')
      return { started: true, alreadyRunning: false }
    })
    walk.mockImplementation(async () => {
      order.push('ledger')
      return LEDGER_REPORT
    })

    render(<MaintenanceAuditSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }))

    await waitFor(() => {
      expect(screen.getByText(/12 orphans/)).toBeInTheDocument()
    })
    expect(screen.getByText(/120/)).toBeInTheDocument()
    expect(screen.getByText(/recordingsLow:default/)).toBeInTheDocument()
    expect(screen.getByText(/38 ghosts/)).toBeInTheDocument()
    expect(order).toEqual(['orphans', 'debug-media', 'ledger'])
    expect(custom).toHaveBeenCalledWith({
      addonId: 'pipeline-analytics',
      action: 'retention.orphanAudit',
      input: { mode: 'report' },
    })
    expect(startMedia).toHaveBeenCalledWith({ mode: 'report' })
    expect(walk).toHaveBeenCalledWith({ locationId: 'recordingsLow:default' })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('keeps the last count after the panel unmounts', async () => {
    const { unmount } = render(<MaintenanceAuditSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }))
    await waitFor(() => {
      expect(screen.getByText(/12 orphans/)).toBeInTheDocument()
    })
    unmount()
    render(<MaintenanceAuditSection />)
    expect(screen.getByText(/12 orphans/)).toBeInTheDocument()
    expect(screen.getByText(/38 ghosts/)).toBeInTheDocument()
  })

  it('skips the ledger when no footage location is frozen', async () => {
    locations = [LIVE]
    render(<MaintenanceAuditSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }))
    await waitFor(() => {
      expect(screen.getByText(/12 orphans/)).toBeInTheDocument()
    })
    expect(walk).not.toHaveBeenCalled()
    expect(screen.getByText(/no frozen location/i)).toBeInTheDocument()
  })

  it('shows apply actions only where the report found work', async () => {
    render(<MaintenanceAuditSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reclaim orphans' })).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Reclaim debug media' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Forget ghosts' })).toBeInTheDocument()
  })

  it('hides apply when a pass found nothing', async () => {
    custom.mockResolvedValue({
      ran: true,
      mode: 'report',
      totalOrphans: 0,
      totalReclaimed: 0,
      totalBytesReclaimed: 0,
    })
    refetchMedia.mockResolvedValue({
      data: { ...MEDIA_REPORT, totalEligible: 0, totalBytesReclaimed: 0 },
    })
    walk.mockResolvedValue({ ...LEDGER_REPORT, ghostSegments: 0, orphanFiles: 0 })

    render(<MaintenanceAuditSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }))
    await waitFor(() => {
      expect(screen.getByText(/0 orphans/)).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Reclaim orphans' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reclaim debug media' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Forget ghosts' })).not.toBeInTheDocument()
  })

  it('Reclaim orphans confirms, then names mode reclaim', async () => {
    custom
      .mockResolvedValueOnce({
        ran: true,
        mode: 'report',
        totalOrphans: 12,
        totalReclaimed: 0,
        totalBytesReclaimed: 0,
      })
      .mockResolvedValueOnce({
        ran: true,
        mode: 'reclaim',
        totalOrphans: 12,
        totalReclaimed: 8,
        totalBytesReclaimed: 1024,
      })

    render(<MaintenanceAuditSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reclaim orphans' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reclaim orphans' }))
    await waitFor(() => {
      expect(custom).toHaveBeenCalledWith({
        addonId: 'pipeline-analytics',
        action: 'retention.orphanAudit',
        input: { mode: 'reclaim' },
      })
    })
    expect(confirm).toHaveBeenCalled()
  })

  it('does not reclaim when the operator cancels', async () => {
    confirm.mockResolvedValue(false)
    render(<MaintenanceAuditSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reclaim orphans' })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reclaim orphans' }))
    await waitFor(() => {
      expect(confirm).toHaveBeenCalled()
    })
    expect(custom).toHaveBeenCalledTimes(1)
  })
})
