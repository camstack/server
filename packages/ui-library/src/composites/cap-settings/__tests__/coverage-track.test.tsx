// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CoverageTrack } from '../CoverageTrack'

const WINDOW = { fromMs: 0, toMs: 100 }

describe('CoverageTrack', () => {
  it('renders one band element per recorded span', () => {
    render(
      <CoverageTrack
        windowFrom={WINDOW.fromMs}
        windowTo={WINDOW.toMs}
        spans={[
          { startMs: 0, endMs: 20 },
          { startMs: 50, endMs: 70 },
        ]}
        playheadMs={null}
        onSeek={vi.fn()}
      />,
    )
    expect(screen.getAllByTestId('coverage-band')).toHaveLength(2)
  })

  it('invokes onSeek with the click position when the track is clicked', () => {
    const onSeek = vi.fn<(clickMs: number) => void>()
    render(
      <CoverageTrack
        windowFrom={0}
        windowTo={100}
        spans={[{ startMs: 0, endMs: 100 }]}
        playheadMs={null}
        onSeek={onSeek}
      />,
    )
    const track = screen.getByTestId('coverage-track')
    // jsdom gives 0-size rects; force a known geometry so the click maps to ~50%.
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 200,
      height: 20,
      top: 0,
      left: 0,
      right: 200,
      bottom: 20,
      toJSON: () => ({}),
    })
    fireEvent.click(track, { clientX: 100 })
    expect(onSeek).toHaveBeenCalledTimes(1)
    const arg = onSeek.mock.calls.at(0)?.[0]
    expect(arg).toBeGreaterThanOrEqual(45)
    expect(arg).toBeLessThanOrEqual(55)
  })
})
