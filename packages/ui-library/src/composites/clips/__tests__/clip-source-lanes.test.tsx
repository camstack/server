// @vitest-environment jsdom
/**
 * One lane per clip PROVIDER from `videoclips.listSources`, each with its own
 * clips query; a lane that could not answer says so instead of an empty bar.
 */
import type { Clip, ClipSource } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const FROM = new Date(2026, 8, 20, 0, 0, 0, 0).getTime()
const TO = FROM + 12 * 3_600_000

interface ClipsInput {
  readonly provider: string
}

const CLIPS: Readonly<
  Record<string, { status: string; data?: Clip[]; error?: { message: string } }>
> = {
  'provider-a': {
    status: 'success',
    data: [
      {
        id: '1',
        source: 'a',
        kind: 'native',
        timeRange: { startMs: FROM + 60_000, endMs: FROM + 120_000 },
      },
      {
        id: '2',
        source: 'a',
        kind: 'native',
        timeRange: { startMs: FROM + 600_000, endMs: FROM + 660_000 },
      },
    ],
  },
  'provider-b': { status: 'error', error: { message: 'camera asleep' } },
  'provider-c': { status: 'success', data: [] },
}

vi.mock('../../../generated/system-hooks', () => ({
  useVideoclipsListClips: (input: ClipsInput) => CLIPS[input.provider] ?? { status: 'pending' },
}))

const { ClipSourceLanes } = await import('../ClipSourceLanes.js')
const { clipProviderOptions } = await import('../clip-source-options.js')

const OK = { state: 'ok' } as const
const THREE: readonly ClipSource[] = [
  { source: 'a', label: 'Source A', addonId: 'provider-a', availability: OK },
  { source: 'b', label: 'Source B', addonId: 'provider-b', availability: OK },
  { source: 'c', label: 'Source C', addonId: 'provider-c', availability: OK },
]

describe('ClipSourceLanes', () => {
  it('renders one lane per listed source, each from its own answer', () => {
    const onPickClip = vi.fn()
    render(
      <ClipSourceLanes
        deviceId={101}
        options={clipProviderOptions(THREE)}
        view={{ fromMs: FROM, toMs: TO }}
        selectedProvider="provider-a"
        onPickClip={onPickClip}
      />,
    )
    const laneA = screen.getByTestId('clip-source-lane-provider-a')
    expect(within(laneA).getByText('Source A')).toBeTruthy()
    expect(within(laneA).getByText('2 clips')).toBeTruthy()
    expect(within(laneA).getAllByRole('button')).toHaveLength(2)

    const laneB = screen.getByTestId('clip-source-lane-provider-b')
    expect(within(laneB).getByText(/camera asleep/)).toBeTruthy()
    expect(within(laneB).queryAllByRole('button')).toHaveLength(0)

    const laneC = screen.getByTestId('clip-source-lane-provider-c')
    expect(within(laneC).getByText('0 clips')).toBeTruthy()

    const second = within(laneA).getAllByRole('button')[1]
    if (second === undefined) throw new Error('lane A drew fewer than two clips')
    fireEvent.click(second)
    expect(onPickClip).toHaveBeenCalledWith('provider-a', expect.objectContaining({ id: '2' }))
  })

  it('draws nothing when the camera lists no source', () => {
    const { container } = render(
      <ClipSourceLanes
        deviceId={101}
        options={[]}
        view={{ fromMs: FROM, toMs: TO }}
        selectedProvider={null}
        onPickClip={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})
