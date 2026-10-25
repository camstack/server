/**
 * Device details renders the hub's switch group — the same one the viewer
 * renders, from the same payload (D544).
 *
 * What this pins, and why each one is here:
 *
 *  - **Every function the hub reports appears.** The cluster used to be four
 *    hand-listed ids re-derived locally, so `privacy-mask`, `device-audio`,
 *    `broker-audio`, `stream-broker` and `notifications` were absent from this
 *    surface while the viewer showed all nine. That is how the operator found
 *    it: the mask control is on the viewer and not here.
 *  - **Nothing is hardcoded.** A row whose id this build has never heard of
 *    still renders, from the label the hub sent.
 *  - **Unknown is not a control.** A row the hub could not read draws as
 *    unknown and cannot be clicked; a toggle over a guessed state writes the
 *    opposite of what the operator sees half the time.
 *  - **A write goes to the composed authority**, which dispatches on
 *    `CameraSwitch.authority` — the group is a composition, never a store.
 */
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const setCameraSwitch = vi.fn()

interface Row {
  readonly id: string
  readonly label: string
  readonly costWhenOff: string
  readonly available: boolean
  readonly enabled: boolean
  readonly unavailableReason?: string
}

let payload: { switches: readonly Row[] } | undefined

vi.mock('../../../hooks/useEventInvalidation', () => ({
  useEventInvalidation: () => undefined,
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    usePipelineOrchestratorGetCameraSwitches: () => ({
      data: payload,
      isLoading: false,
      error: null,
    }),
    usePipelineOrchestratorSetCameraSwitch: () => ({
      mutate: setCameraSwitch,
      isPending: false,
    }),
  }
})

import { CameraFunctionSwitches } from '../CameraFunctionSwitches'

const row = (over: Partial<Row> & Pick<Row, 'id' | 'label'>): Row => ({
  costWhenOff: 'Something stops happening.',
  available: true,
  enabled: true,
  ...over,
})

function renderCluster(deviceId = 1438): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CameraFunctionSwitches deviceId={deviceId} />
    </QueryClientProvider>,
  ) as unknown as ReactElement
}

/** Open the group so the rows are on screen. */
function openGroup(): void {
  fireEvent.click(screen.getByLabelText('Camera functions'))
}

beforeEach(() => {
  setCameraSwitch.mockReset()
  payload = {
    switches: [
      row({ id: 'object-detection', label: 'Object detection' }),
      row({ id: 'privacy-mask', label: 'Privacy mask', enabled: false }),
      row({ id: 'recording', label: 'Recording' }),
    ],
  }
})
afterEach(cleanup)

describe('CameraFunctionSwitches', () => {
  it('renders every function the hub reports — the mask included', () => {
    renderCluster()
    openGroup()
    expect(screen.getByLabelText('Privacy mask')).toBeTruthy()
    expect(screen.getByLabelText('Object detection')).toBeTruthy()
    expect(screen.getByLabelText('Recording')).toBeTruthy()
  })

  it('renders a switch this build has never heard of, from the label the hub sent', () => {
    payload = { switches: [row({ id: 'something-new', label: 'Something new' })] }
    renderCluster()
    openGroup()
    expect(screen.getByLabelText('Something new')).toBeTruthy()
  })

  it('writes the composed authority with the id and the flipped state', () => {
    renderCluster()
    openGroup()
    fireEvent.click(screen.getByLabelText('Privacy mask'))
    expect(setCameraSwitch).toHaveBeenCalledWith({
      deviceId: 1438,
      switchId: 'privacy-mask',
      enabled: true,
    })
  })

  it('reports an off function from the CLOSED trigger', () => {
    // A camera producing nothing because somebody switched it off must never
    // read as a broken one just because the controls folded away.
    renderCluster()
    expect(screen.getByLabelText('Camera functions').textContent).toContain('1 off')
  })

  it('an unavailable function is drawn with its reason and cannot be clicked', () => {
    payload = {
      switches: [
        row({
          id: 'broker-audio',
          label: 'Stream audio',
          available: false,
          unavailableReason: 'not-configured',
        }),
      ],
    }
    renderCluster()
    openGroup()
    const control = screen.getByLabelText('Stream audio') as HTMLButtonElement
    expect(control.disabled).toBe(true)
    fireEvent.click(control)
    expect(setCameraSwitch).not.toHaveBeenCalled()
  })

  it('an unavailable function is never counted as switched OFF', () => {
    payload = {
      switches: [row({ id: 'broker-audio', label: 'Stream audio', available: false })],
    }
    renderCluster()
    expect(screen.getByLabelText('Camera functions').textContent).not.toContain('off')
  })

  it('a query that has not answered draws no control at all', () => {
    // Not a row of switches that all read "off": that is a claim about the
    // camera made from an absence of data (D315).
    payload = undefined
    renderCluster()
    expect(screen.queryByLabelText('Camera functions')).toBeNull()
  })

  it('writes NOTHING on mount', () => {
    // A surface that "normalises" state on render silently undoes an
    // operator's decision.
    renderCluster()
    expect(setCameraSwitch).not.toHaveBeenCalled()
  })
})
