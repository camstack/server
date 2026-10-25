/**
 * The notification gif/clip render runs the node's PINNED ffmpeg (D540): it
 * used to take an optional path nobody passed and fall back to a bare
 * `'ffmpeg'` — the host's binary. Without the pinned build it refuses, named
 * per camera, before a playlist is staged or a child spawned.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { RecordingIndex } from '../../recording-index.js'
import type { SegmentStore } from '../../segment-store.js'
import type { RecordingConfigsState } from '../config-store.js'
import { renderClip, renderGif } from '../footage-render.js'
import type { RecordingProviderDeps } from '../recording-provider.js'

function makeDeps(error: IScopedLogger['error']): RecordingProviderDeps {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error,
    child: () => logger,
    withTags: () => logger,
  }
  return {
    index: new RecordingIndex(),
    // Never reached: the refusal comes before any footage is looked up.
    segmentStore: {} as unknown as SegmentStore,
    nodeId: 'hub',
    logger,
    configStore: {} as unknown as RecordingConfigsState,
    locations: () => [],
    refreshLocations: async () => [],
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir: '/nowhere',
    playbackBaseUrl: () => '/addon/recorder/playback',
  }
}

const WINDOW = {
  deviceId: 101,
  aroundMs: 1_790_000_000_000,
  preRollSec: 2,
  postRollSec: 2,
  maxWidth: 480,
}

describe('footage render — the pinned ffmpeg (D540)', () => {
  it.each([
    ['gif', (deps: Parameters<typeof renderGif>[0]) => renderGif(deps, { ...WINDOW, fps: 8 })],
    ['mp4', (deps: Parameters<typeof renderClip>[0]) => renderClip(deps, WINDOW)],
  ])('a %s render REFUSES, per camera, and spawns nothing without the pinned build', async (ext, render) => {
    const error = vi.fn()
    const spawn = vi.fn()
    await expect(
      render({
        deps: makeDeps(error),
        exportsDir: '/nowhere/exports',
        spawn,
        resolveFfmpeg: async () => {
          throw new Error('download failed')
        },
      }),
    ).rejects.toThrow(`${ext} render refused for device 101: no pinned ffmpeg`)
    expect(spawn).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('no pinned ffmpeg'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })
})
