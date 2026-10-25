/**
 * Our detections on a NATIVE clip (D923): the camera's own clip carries the
 * classes CamStack saw inside its window, by the same overlap rule the
 * recorder's visits use, and keeps what the firmware said.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Clip, IVideoclipsProvider } from '../../capabilities/videoclips.cap.js'
import {
  annotateClipsWithEventLabels,
  clipEventLabelDepsFromApi,
  type ClipEventLabelDeps,
  type ClipObjectEvent,
  clipLabelsForWindow,
  eventOverlapsClipWindow,
  mergeClipLabels,
  withClipEventLabels,
} from '../clip-event-labels.js'

const PAD = { preMs: 5_000, postMs: 10_000 }

const nativeClip = (startMs: number, endMs: number, over: Partial<Clip> = {}): Clip => ({
  id: `native:hik:${String(startMs)}`,
  source: 'native:hikvision',
  kind: 'native',
  timeRange: { startMs, endMs },
  nativeTypes: ['VMD'],
  ...over,
})

const deps = (
  events: readonly ClipObjectEvent[] | Error,
  logger = { info: vi.fn(), warn: vi.fn() },
): ClipEventLabelDeps & { logger: typeof logger } => ({
  pad: PAD,
  fetchObjectEvents: vi.fn(async () => {
    if (events instanceof Error) throw events
    return events
  }),
  logger,
})

describe('the overlap rule', () => {
  it('attaches an event inside the window, or one whose padded window crosses it', () => {
    const window = { startMs: 100_000, endMs: 130_000 }
    expect(eventOverlapsClipWindow(110_000, window, PAD)).toBe(true)
    // 8 s before the clip: its +10 s post-pad reaches into it.
    expect(eventOverlapsClipWindow(92_000, window, PAD)).toBe(true)
    // 12 s before: the post-pad ends before the clip starts.
    expect(eventOverlapsClipWindow(88_000, window, PAD)).toBe(false)
    // 4 s after: the −5 s pre-pad reaches back into it.
    expect(eventOverlapsClipWindow(134_000, window, PAD)).toBe(true)
    expect(eventOverlapsClipWindow(136_000, window, PAD)).toBe(false)
  })

  it('ranks labels by how often they overlap, capped at three', () => {
    const window = { startMs: 0, endMs: 60_000 }
    const events: ClipObjectEvent[] = [
      { timestamp: 1_000, className: 'vehicle' },
      { timestamp: 2_000, className: 'person' },
      { timestamp: 3_000, className: 'person' },
      { timestamp: 4_000, className: 'animal' },
      { timestamp: 5_000, className: 'package' },
      { timestamp: 500_000, className: 'person' },
    ]
    expect(clipLabelsForWindow(window, events, PAD)).toEqual(['person', 'vehicle', 'animal'])
  })

  it('keeps the source labels first and adds ours it did not say', () => {
    expect(mergeClipLabels(['person'], ['vehicle', 'person'])).toEqual(['person', 'vehicle'])
    expect(mergeClipLabels(undefined, ['vehicle'])).toEqual(['vehicle'])
  })
})

describe('annotateClipsWithEventLabels', () => {
  it('a native clip with a person inside it shows person, and keeps its native types', async () => {
    const [clip] = await annotateClipsWithEventLabels(
      1439,
      [nativeClip(100_000, 130_000)],
      deps([{ timestamp: 110_000, className: 'person' }]),
    )
    expect(clip?.labels).toEqual(['person'])
    expect(clip?.nativeTypes).toEqual(['VMD'])
  })

  it('a clip nothing overlapped is returned untouched — no empty labels array', async () => {
    const original = nativeClip(100_000, 130_000)
    const [clip] = await annotateClipsWithEventLabels(
      1439,
      [original],
      deps([{ timestamp: 900_000, className: 'person' }]),
    )
    expect(clip).toBe(original)
  })

  it('reads events across the padded span of every listed clip', async () => {
    const d = deps([])
    await annotateClipsWithEventLabels(
      1439,
      [nativeClip(100_000, 130_000), nativeClip(200_000, 210_000)],
      d,
    )
    expect(d.fetchObjectEvents).toHaveBeenCalledWith({
      deviceId: 1439,
      since: 90_000,
      until: 215_000,
      limit: 5_000,
    })
  })

  it('a read that fails changes nothing and says so, per camera', async () => {
    const d = deps(new Error('analytics down'))
    const original = nativeClip(100_000, 130_000, { labels: ['vehicle'] })
    const clips = await annotateClipsWithEventLabels(1439, [original], d)
    expect(clips).toEqual([original])
    expect(d.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be read'),
      expect.objectContaining({ tags: { deviceId: 1439 } }),
    )
  })

  it('does not read anything for an empty listing', async () => {
    const d = deps([])
    expect(await annotateClipsWithEventLabels(1439, [], d)).toEqual([])
    expect(d.fetchObjectEvents).not.toHaveBeenCalled()
  })
})

describe('withClipEventLabels', () => {
  it('labels what listClips answers and leaves every other method the provider’s own', async () => {
    const listSources = vi.fn(async () => [])
    const getClipPlayback = vi.fn()
    const provider: IVideoclipsProvider = {
      listSources,
      getClipPlayback,
      listClips: vi.fn(async () => [nativeClip(100_000, 130_000)]),
    }
    const wrapped = withClipEventLabels(
      provider,
      deps([{ timestamp: 120_000, className: 'vehicle' }]),
    )
    const clips = await wrapped.listClips({
      deviceId: 1439,
      since: 0,
      until: 1_000_000,
      provider: 'provider-hikvision',
    })
    expect(clips[0]?.labels).toEqual(['vehicle'])
    expect(wrapped.listSources).toBe(listSources)
    expect(wrapped.getClipPlayback).toBe(getClipPlayback)
  })
})

describe('clipEventLabelDepsFromApi', () => {
  it('asks pipelineAnalytics for slim object events with the canonical event pad', async () => {
    const query = vi.fn(async () => [{ timestamp: 1, className: 'person' }])
    const d = clipEventLabelDepsFromApi(
      { pipelineAnalytics: { getObjectEvents: { query } } },
      { info: vi.fn(), warn: vi.fn() },
    )
    expect(d.pad).toEqual({ preMs: 5_000, postMs: 10_000 })
    await d.fetchObjectEvents({ deviceId: 7, since: 1, until: 2, limit: 3 })
    expect(query).toHaveBeenCalledWith({
      deviceId: 7,
      since: 1,
      until: 2,
      limit: 3,
      projection: 'slim',
    })
  })
})
