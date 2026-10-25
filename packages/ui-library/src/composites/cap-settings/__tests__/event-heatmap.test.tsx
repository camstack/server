// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EventHeatmap } from '../EventHeatmap'
import type { DensityBucket } from '../recording-timeline-model'

function bucket(index: number, total: number, dominant: DensityBucket['dominant']): DensityBucket {
  return {
    index,
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    counts: {
      motion: dominant === 'motion' ? total : 0,
      object: dominant === 'object' ? total : 0,
      audio: 0,
    },
    total,
    dominant,
  }
}

describe('EventHeatmap', () => {
  it('renders only non-empty buckets as bars', () => {
    render(
      <EventHeatmap
        windowFrom={0}
        windowTo={4000}
        buckets={[bucket(0, 0, null), bucket(1, 3, 'object'), bucket(2, 1, 'motion')]}
        selectedIndex={null}
        onSelectBucket={vi.fn()}
      />,
    )
    expect(screen.getAllByTestId('heatmap-bar')).toHaveLength(2)
  })

  it('calls onSelectBucket with the bucket index on click', () => {
    const onSelectBucket = vi.fn()
    render(
      <EventHeatmap
        windowFrom={0}
        windowTo={2000}
        buckets={[bucket(1, 5, 'object')]}
        selectedIndex={null}
        onSelectBucket={onSelectBucket}
      />,
    )
    fireEvent.click(screen.getByTestId('heatmap-bar'))
    expect(onSelectBucket).toHaveBeenCalledWith(1)
  })
})
