// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EventBucketStrip, type BucketClip } from '../EventBucketStrip'
import type { ClipKind } from '../event-thumb'

function makeClip(kind: ClipKind, id = kind): BucketClip {
  return { id, timestamp: Date.now(), kind, label: kind, mediaUrl: undefined }
}

const ALL_KINDS: ReadonlySet<ClipKind> = new Set(['motion', 'object', 'audio'])

describe('EventBucketStrip — type filter', () => {
  it('renders a checkbox for each kind', () => {
    render(
      <EventBucketStrip
        clips={[makeClip('motion'), makeClip('object'), makeClip('audio')]}
        loading={false}
        busyKey={null}
        onPlay={vi.fn()}
        enabledKinds={ALL_KINDS}
        onToggleKind={vi.fn()}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    )
    expect(screen.getByRole('checkbox', { name: /motion/i })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /object/i })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: /audio/i })).toBeTruthy()
  })

  it('calls onToggleKind with the correct kind when a checkbox is clicked', () => {
    const onToggleKind = vi.fn<(k: ClipKind) => void>()
    render(
      <EventBucketStrip
        clips={[makeClip('motion'), makeClip('object')]}
        loading={false}
        busyKey={null}
        onPlay={vi.fn()}
        enabledKinds={ALL_KINDS}
        onToggleKind={onToggleKind}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /motion/i }))
    expect(onToggleKind).toHaveBeenCalledWith('motion')

    fireEvent.click(screen.getByRole('checkbox', { name: /object/i }))
    expect(onToggleKind).toHaveBeenCalledWith('object')
  })

  it('reflects checked state from enabledKinds', () => {
    const onlyMotion: ReadonlySet<ClipKind> = new Set(['motion'])
    render(
      <EventBucketStrip
        clips={[makeClip('motion')]}
        loading={false}
        busyKey={null}
        onPlay={vi.fn()}
        enabledKinds={onlyMotion}
        onToggleKind={vi.fn()}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    )
    const motionBox = screen.getByRole('checkbox', { name: /motion/i }) as HTMLInputElement
    const objectBox = screen.getByRole('checkbox', { name: /object/i }) as HTMLInputElement
    expect(motionBox.checked).toBe(true)
    expect(objectBox.checked).toBe(false)
  })
})

describe('EventBucketStrip — load more', () => {
  it('renders a "Load more" button when hasMore is true', () => {
    render(
      <EventBucketStrip
        clips={[makeClip('motion')]}
        loading={false}
        busyKey={null}
        onPlay={vi.fn()}
        enabledKinds={ALL_KINDS}
        onToggleKind={vi.fn()}
        hasMore={true}
        onLoadMore={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /load more/i })).toBeTruthy()
  })

  it('calls onLoadMore when the "Load more" button is clicked', () => {
    const onLoadMore = vi.fn()
    render(
      <EventBucketStrip
        clips={[makeClip('audio')]}
        loading={false}
        busyKey={null}
        onPlay={vi.fn()}
        enabledKinds={ALL_KINDS}
        onToggleKind={vi.fn()}
        hasMore={true}
        onLoadMore={onLoadMore}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /load more/i }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('does NOT render a "Load more" button when hasMore is false', () => {
    render(
      <EventBucketStrip
        clips={[makeClip('motion')]}
        loading={false}
        busyKey={null}
        onPlay={vi.fn()}
        enabledKinds={ALL_KINDS}
        onToggleKind={vi.fn()}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })
})
