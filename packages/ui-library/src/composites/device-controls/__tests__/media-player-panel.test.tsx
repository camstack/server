// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MediaPlayerPanel } from '../media-player-panel'

const play = vi.fn()
const pause = vi.fn()
const stop = vi.fn()
const next = vi.fn()
const previous = vi.fn()
const setVolume = vi.fn()
const setMute = vi.fn()
const setShuffle = vi.fn()
const setRepeat = vi.fn()
const selectSource = vi.fn()

let mockResult: { cap: unknown; slice: unknown; available: boolean }

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => mockResult,
}))

const trpc = {} as never

const baseSlice = {
  state: 'playing' as const,
  volumeLevel: 40,
  isMuted: false,
  source: 'Spotify',
  availableSources: ['Spotify', 'TV'] as string[],
  currentMedia: null,
  positionMs: null,
  durationMs: null,
  shuffle: null,
  repeat: null,
  lastChangedAt: 0,
}

beforeEach(() => {
  play.mockReset()
  pause.mockReset()
  stop.mockReset()
  next.mockReset()
  previous.mockReset()
  setVolume.mockReset()
  setMute.mockReset()
  setShuffle.mockReset()
  setRepeat.mockReset()
  selectSource.mockReset()
  mockResult = {
    cap: {
      play,
      pause,
      stop,
      next,
      previous,
      setVolume,
      setMute,
      setShuffle,
      setRepeat,
      selectSource,
    },
    slice: { ...baseSlice },
    available: true,
  }
})

describe('MediaPlayerPanel', () => {
  describe('compact layout', () => {
    it('renders nothing when the cap slice has not landed (unbound)', () => {
      mockResult = { cap: undefined, slice: undefined, available: false }
      const { container } = render(
        <MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      expect(container.firstChild).toBeNull()
    })

    it('puts data-state on the root element reflecting the active state', () => {
      const { container } = render(
        <MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      const root = container.firstChild as HTMLElement
      expect(root.dataset['state']).toBe('playing')
    })

    it('applies a green class when state is playing', () => {
      const { container } = render(
        <MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      const root = container.firstChild as HTMLElement
      expect(root.className).toContain('green')
    })

    it('applies an amber class when state is paused', () => {
      mockResult = {
        cap: {
          play,
          pause,
          stop,
          next,
          previous,
          setVolume,
          setMute,
          setShuffle,
          setRepeat,
          selectSource,
        },
        slice: { ...baseSlice, state: 'paused' as const },
        available: true,
      }
      const { container } = render(
        <MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />,
      )
      const root = container.firstChild as HTMLElement
      expect(root.className).toContain('amber')
    })

    it('renders a state indicator dot', () => {
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      expect(screen.getByRole('status')).toBeTruthy()
    })

    it('renders a toggle button', () => {
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
    })

    it('clicking toggle when state is playing calls cap.pause()', () => {
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
      expect(pause).toHaveBeenCalledTimes(1)
      expect(play).not.toHaveBeenCalled()
    })

    it('clicking toggle when state is paused calls cap.play()', () => {
      mockResult = {
        cap: {
          play,
          pause,
          stop,
          next,
          previous,
          setVolume,
          setMute,
          setShuffle,
          setRepeat,
          selectSource,
        },
        slice: { ...baseSlice, state: 'paused' as const },
        available: true,
      }
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Play' }))
      expect(play).toHaveBeenCalledTimes(1)
      expect(pause).not.toHaveBeenCalled()
    })

    it('clicking toggle when state is idle calls cap.play()', () => {
      mockResult = {
        cap: {
          play,
          pause,
          stop,
          next,
          previous,
          setVolume,
          setMute,
          setShuffle,
          setRepeat,
          selectSource,
        },
        slice: { ...baseSlice, state: 'idle' as const },
        available: true,
      }
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      fireEvent.click(screen.getByRole('button', { name: 'Play' }))
      expect(play).toHaveBeenCalledTimes(1)
    })

    it('disables toggle when not available', () => {
      mockResult = {
        cap: {
          play,
          pause,
          stop,
          next,
          previous,
          setVolume,
          setMute,
          setShuffle,
          setRepeat,
          selectSource,
        },
        slice: { ...baseSlice },
        available: false,
      }
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="compact" />)
      const btn = screen.getByRole('button', { name: 'Pause' }) as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    })
  })

  describe('full layout', () => {
    it('renders nothing when the cap slice has not landed', () => {
      mockResult = { cap: undefined, slice: undefined, available: false }
      const { container } = render(
        <MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />,
      )
      expect(container.firstChild).toBeNull()
    })

    it('clicking next calls cap.next()', () => {
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(next).toHaveBeenCalledTimes(1)
    })

    it('clicking previous calls cap.previous()', () => {
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
      expect(previous).toHaveBeenCalledTimes(1)
    })

    it('renders a volume slider when volumeLevel is non-null', () => {
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      expect(screen.getByLabelText('Volume')).toBeTruthy()
    })

    it('changing volume slider calls setVolume with volumeLevel', () => {
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '75' } })
      expect(setVolume).toHaveBeenCalledWith({ volumeLevel: 75 })
    })

    it('does not render volume slider when volumeLevel is null', () => {
      mockResult = {
        cap: {
          play,
          pause,
          stop,
          next,
          previous,
          setVolume,
          setMute,
          setShuffle,
          setRepeat,
          selectSource,
        },
        slice: { ...baseSlice, volumeLevel: null },
        available: true,
      }
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      expect(screen.queryByLabelText('Volume')).toBeNull()
    })

    it('renders a mute button when isMuted is non-null', () => {
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      expect(screen.getByRole('button', { name: 'Mute' })).toBeTruthy()
    })

    it('clicking mute button calls setMute with muted:true when currently unmuted', () => {
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.click(screen.getByRole('button', { name: 'Mute' }))
      expect(setMute).toHaveBeenCalledWith({ muted: true })
    })

    it('clicking mute button calls setMute with muted:false when currently muted', () => {
      mockResult = {
        cap: {
          play,
          pause,
          stop,
          next,
          previous,
          setVolume,
          setMute,
          setShuffle,
          setRepeat,
          selectSource,
        },
        slice: { ...baseSlice, isMuted: true },
        available: true,
      }
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.click(screen.getByRole('button', { name: 'Unmute' }))
      expect(setMute).toHaveBeenCalledWith({ muted: false })
    })

    it('does not render mute button when isMuted is null', () => {
      mockResult = {
        cap: {
          play,
          pause,
          stop,
          next,
          previous,
          setVolume,
          setMute,
          setShuffle,
          setRepeat,
          selectSource,
        },
        slice: { ...baseSlice, isMuted: null },
        available: true,
      }
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      expect(screen.queryByRole('button', { name: 'Mute' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Unmute' })).toBeNull()
    })

    it('renders a source selector when availableSources are present', () => {
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      expect(screen.getByLabelText('Source')).toBeTruthy()
    })

    it('changing source selector calls selectSource', () => {
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'TV' } })
      expect(selectSource).toHaveBeenCalledWith({ source: 'TV' })
    })

    it('renders shuffle button when shuffle is non-null', () => {
      mockResult = {
        cap: {
          play,
          pause,
          stop,
          next,
          previous,
          setVolume,
          setMute,
          setShuffle,
          setRepeat,
          selectSource,
        },
        slice: { ...baseSlice, shuffle: false },
        available: true,
      }
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      expect(screen.getByRole('button', { name: 'Shuffle' })).toBeTruthy()
    })

    it('clicking shuffle button calls setShuffle', () => {
      mockResult = {
        cap: {
          play,
          pause,
          stop,
          next,
          previous,
          setVolume,
          setMute,
          setShuffle,
          setRepeat,
          selectSource,
        },
        slice: { ...baseSlice, shuffle: false },
        available: true,
      }
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }))
      expect(setShuffle).toHaveBeenCalledWith({ shuffle: true })
    })

    it('renders repeat selector when repeat is non-null', () => {
      mockResult = {
        cap: {
          play,
          pause,
          stop,
          next,
          previous,
          setVolume,
          setMute,
          setShuffle,
          setRepeat,
          selectSource,
        },
        slice: { ...baseSlice, repeat: 'off' as const },
        available: true,
      }
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      expect(screen.getByLabelText('Repeat')).toBeTruthy()
    })

    it('changing repeat calls setRepeat', () => {
      mockResult = {
        cap: {
          play,
          pause,
          stop,
          next,
          previous,
          setVolume,
          setMute,
          setShuffle,
          setRepeat,
          selectSource,
        },
        slice: { ...baseSlice, repeat: 'off' as const },
        available: true,
      }
      render(<MediaPlayerPanel trpc={trpc} deviceId={1} features={[]} layout="full" />)
      fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'all' } })
      expect(setRepeat).toHaveBeenCalledWith({ repeat: 'all' })
    })
  })
})
