// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConfirmDialogProvider } from '@camstack/ui-library'

/**
 * `TrackFlagToggles` — the two per-track operator flags (`markForTrain`,
 * `debug`) as rendered in the admin Events detail panel.
 *
 * What these tests pin, and why each has already been a bug class in this repo:
 *
 *  - **A patch carries ONE key.** Three surfaces write these flags and none of
 *    them knows the others' state. Sending both keys on every toggle means the
 *    stale one clobbers a concurrent change from the viewer.
 *  - **Absent renders as OFF, and `false` renders as OFF, but neither is sent
 *    unasked.** The row omits a flag it has never had; a toggle that read
 *    `undefined` as "indeterminate" would render an empty box the operator
 *    cannot resolve.
 *  - **The optimistic state is the SERVER's answer**, not the click. A toggle
 *    that flips on click and never reconciles is how the operator ends up
 *    believing a track is marked when the write was refused.
 */

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }))

vi.mock('../use-track-flags.js', async () => {
  const actual =
    await vi.importActual<typeof import('../use-track-flags.js')>('../use-track-flags.js')
  return {
    ...actual,
    TRACK_FLAGS_AVAILABLE: true,
    useSetTrackFlagsMutation: () => ({ mutateAsync, isPending: false }),
  }
})

const { TrackFlagToggles } = await import('../TrackFlagToggles.js')

// A failed write is reported through the shared dialog provider (`useAlert`),
// not `window.alert`, so the component needs its provider — the same one the
// admin shell mounts app-wide.
function render(ui: Parameters<typeof rtlRender>[0]) {
  return rtlRender(<ConfirmDialogProvider>{ui}</ConfirmDialogProvider>)
}

describe('TrackFlagToggles', () => {
  beforeEach(() => {
    mutateAsync.mockReset()
    mutateAsync.mockResolvedValue({
      trackId: 't-1',
      markForTrain: true,
      debug: false,
      favourited: false,
    })
  })

  it('renders all flags OFF when the row carries none', () => {
    render(<TrackFlagToggles deviceId={101} trackId="t-1" />)

    expect(screen.getByRole('switch', { name: /training/i })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.getByRole('switch', { name: /debug/i })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: /favourit/i })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('renders the state the row carries', () => {
    render(<TrackFlagToggles deviceId={101} trackId="t-1" markForTrain debug={false} favourited />)

    expect(screen.getByRole('switch', { name: /training/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('switch', { name: /debug/i })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: /favourit/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('sends ONLY the toggled key, never both', async () => {
    render(<TrackFlagToggles deviceId={101} trackId="t-1" debug />)

    fireEvent.click(screen.getByRole('switch', { name: /training/i }))

    expect(mutateAsync).toHaveBeenCalledTimes(1)
    expect(mutateAsync).toHaveBeenCalledWith({
      deviceId: 101,
      trackId: 't-1',
      flags: { markForTrain: true },
    })
  })

  it('adopts the SERVER-reported state, not the click', async () => {
    mutateAsync.mockResolvedValue({
      trackId: 't-1',
      markForTrain: false,
      debug: true,
      favourited: true,
    })
    render(<TrackFlagToggles deviceId={101} trackId="t-1" />)

    fireEvent.click(screen.getByRole('switch', { name: /training/i }))

    // Clicked markForTrain, but the server says it is off and the others on.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: /debug/i })).toHaveAttribute('aria-checked', 'true')
    })
    expect(screen.getByRole('switch', { name: /training/i })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.getByRole('switch', { name: /favourit/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('notifies the parent so the feed row can be reconciled', async () => {
    const onChange = vi.fn()
    mutateAsync.mockResolvedValue({
      trackId: 't-1',
      markForTrain: true,
      debug: false,
      favourited: false,
    })
    render(<TrackFlagToggles deviceId={101} trackId="t-1" onChange={onChange} />)

    fireEvent.click(screen.getByRole('switch', { name: /training/i }))

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        trackId: 't-1',
        markForTrain: true,
        debug: false,
        favourited: false,
      })
    })
  })

  it('sends ONLY favourited when that toggle is pressed', async () => {
    render(<TrackFlagToggles deviceId={101} trackId="t-1" />)

    fireEvent.click(screen.getByRole('switch', { name: /favourit/i }))

    expect(mutateAsync).toHaveBeenCalledTimes(1)
    expect(mutateAsync).toHaveBeenCalledWith({
      deviceId: 101,
      trackId: 't-1',
      flags: { favourited: true },
    })
  })
})
