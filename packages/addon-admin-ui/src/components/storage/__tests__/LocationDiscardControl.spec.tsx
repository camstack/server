import type { StorageLocation } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const confirm = vi.fn()
const custom = vi.fn()

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
  }
})

import { LocationDiscardControl } from '../LocationDiscardControl'

const HDD: StorageLocation = {
  id: 'eventMedia:default',
  type: 'eventMedia',
  displayName: 'Events HDD',
  providerId: 'filesystem',
  config: { basePath: '/recordings' },
  nodeId: 'hub',
  isSystem: true,
  enabled: false,
  createdAt: 1,
  updatedAt: 2,
}

const SSD: StorageLocation = {
  ...HDD,
  id: 'eventMedia:ssd',
  displayName: 'Events SSD',
  config: { basePath: '/media-fast/eventMedia' },
  enabled: true,
}

const IDLE = {
  running: false,
  locationId: null,
  jobId: null,
  phase: 'idle',
  camerasTotal: 0,
  camerasDone: 0,
  foldersRemoved: 0,
  dbRowsDeleted: 0,
  ownersCascaded: 0,
  detail: '',
  startedAtMs: null,
  finishedAtMs: null,
  error: null,
}

describe('LocationDiscardControl', () => {
  beforeEach(() => {
    confirm.mockReset()
    custom.mockReset()
    custom.mockResolvedValue(IDLE)
    confirm.mockResolvedValue(true)
  })

  it('renders nothing when the location is still writable', () => {
    render(<LocationDiscardControl location={{ ...HDD, enabled: true }} siblings={[HDD, SSD]} />)
    expect(screen.queryByRole('button', { name: /discard leftovers/i })).toBeNull()
  })

  it('starts the job after confirm and shows FS progress', async () => {
    custom
      .mockResolvedValueOnce(IDLE)
      .mockResolvedValueOnce({ started: true, alreadyRunning: false, jobId: 'j1' })
      .mockResolvedValueOnce({
        ...IDLE,
        running: true,
        locationId: 'eventMedia:default',
        jobId: 'j1',
        phase: 'wiping-fs',
        camerasTotal: 10,
        camerasDone: 3,
        foldersRemoved: 3,
        detail: 'camera 104',
      })
    render(<LocationDiscardControl location={HDD} siblings={[HDD, SSD]} />)
    await waitFor(() => expect(custom).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: /discard leftovers/i }))
    await waitFor(() => expect(confirm).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText(/wiping-fs/i)).toBeTruthy())
    expect(screen.getByText(/3\/10 cam/i)).toBeTruthy()
    const startCall = custom.mock.calls.find(
      (c) => (c[0] as { action: string }).action === 'storage.discardLocation',
    )
    expect(startCall?.[0]).toEqual({
      addonId: 'pipeline-analytics',
      action: 'storage.discardLocation',
      input: { locationId: 'eventMedia:default' },
    })
  })
})
