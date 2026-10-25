// @vitest-environment jsdom
/**
 * "Send frame to training" from a recording playhead: nothing for a session
 * that cannot curate, disabled without a playhead, and the instant is the one
 * the dialog opened on — playback keeps moving underneath it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const COLLECTIONS = [{ id: 'col-1', name: 'missed at night', createdAt: 1, frameCount: 2 }]

let listError = false
type SendInput = { collectionId: string; deviceId: number; epochMs: number }
type SendResult =
  | { kind: 'added'; collectionId: string; reused: boolean }
  | { kind: 'refused'; reason: 'still-unavailable'; detail?: string }
const send = vi.fn(
  async (_input: SendInput): Promise<SendResult> => ({
    kind: 'added',
    collectionId: 'col-1',
    reused: false,
  }),
)

vi.mock('../../../generated/system-hooks', () => ({
  usePipelineAnalyticsListRetrainCollections: () => ({
    data: listError ? undefined : COLLECTIONS,
    isError: listError,
    isLoading: false,
    refetch: vi.fn(),
  }),
  usePipelineAnalyticsCreateRetrainCollection: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePipelineAnalyticsAddRetrainFrameFromRecording: () => ({
    mutateAsync: (input: SendInput) => send(input),
    isPending: false,
  }),
}))

const { SendFrameToTrainingButton } = await import('../send-frame-to-training')

beforeEach(() => {
  listError = false
  send.mockClear()
  // jsdom has no <dialog> modal API.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false
  }
})

describe('SendFrameToTrainingButton', () => {
  it('draws nothing for a session that cannot read the collections', () => {
    listError = true
    const { container } = render(<SendFrameToTrainingButton deviceId={101} epochMs={1000} />)
    expect(container.innerHTML).toBe('')
  })

  it('is disabled while nothing is being played back', () => {
    render(<SendFrameToTrainingButton deviceId={101} epochMs={null} />)
    expect(screen.getByTestId('send-frame-to-training').hasAttribute('disabled')).toBe(true)
  })

  it('sends the instant the dialog opened on, to the chosen collection', async () => {
    const { rerender } = render(
      <SendFrameToTrainingButton deviceId={101} epochMs={1_700_000_000_000} />,
    )
    fireEvent.click(screen.getByTestId('send-frame-to-training'))
    // Playback moves on while the dialog is open.
    rerender(<SendFrameToTrainingButton deviceId={101} epochMs={1_700_000_005_000} />)
    fireEvent.change(screen.getByLabelText('Collection'), { target: { value: 'col-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith({
        collectionId: 'col-1',
        deviceId: 101,
        epochMs: 1_700_000_000_000,
      })
    })
    expect(await screen.findByText('Added to missed at night.')).toBeTruthy()
  })

  it('says why a frame was refused, in words', async () => {
    send.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'still-unavailable',
      detail: 'no recorded footage covers that instant',
    })
    render(<SendFrameToTrainingButton deviceId={101} epochMs={1_700_000_000_000} />)
    fireEvent.click(screen.getByTestId('send-frame-to-training'))
    fireEvent.change(screen.getByLabelText('Collection'), { target: { value: 'col-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(
      await screen.findByText(/No frame could be taken from the recording at that moment/),
    ).toBeTruthy()
  })
})
