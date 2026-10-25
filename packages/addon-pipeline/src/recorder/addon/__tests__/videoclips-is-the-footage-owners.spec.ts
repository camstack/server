/**
 * The CamStack clip source is DECLARED and REGISTERED by the addon that owns
 * the footage (D560).
 *
 * A clip from this source is a time WINDOW over recorded segments — the
 * recorder's segments, resolved by the recorder's `getPlayback`. It was
 * registered by `pipeline-analytics` because the annotations live there, which
 * is the wrong half: *"deve registrarla CHI ha il footage e non altri addons
 * casuali"* [it must be registered BY WHOEVER has the footage and not by other random addons]. The computation did not move; the registration did.
 *
 * What that costs, and what this file pins: the analytics event log is now on
 * the other side of a process boundary, so every read the provider makes goes
 * through `ctx.api` — including the two that used to be local to the recorder.
 * That is deliberate. `recorder` is `placement: 'any-node'`, so the
 * registration the hub dispatches to is not necessarily the node holding this
 * camera's segments; `ctx.api.recording.*` routes to the node that does, and an
 * in-process short cut would answer a camera recorded on agent-a from the
 * hub's empty index.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LogExtras } from '@camstack/types'
import {
  createRecorderVideoclipsProvider,
  type VideoclipsWiringLogger,
} from '../videoclips-wiring.js'

/** The `provider` a videoclips call names (D554): the recorder's clip-source addon id. */
const RECORDER = 'recorder'

interface ManifestCapability {
  readonly name: string
}
interface ManifestAddonEntry {
  readonly id: string
  readonly capabilities?: readonly ManifestCapability[]
}

function recorderEntry(): ManifestAddonEntry | undefined {
  const raw: unknown = JSON.parse(
    readFileSync(path.join(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8'),
  )
  const addons = (raw as { camstack?: { addons?: readonly ManifestAddonEntry[] } }).camstack?.addons
  return addons?.find((a) => a.id === 'recorder')
}

describe('the recorder declares the clip source over its own footage', () => {
  it('declares `videoclips` beside `recording` — one addon, one archive', () => {
    const declared = (recorderEntry()?.capabilities ?? []).map((c) => c.name)
    expect(declared).toContain('recording')
    expect(declared).toContain('videoclips')
  })
})

/** The four reads, recorded. Nothing here touches a disk or a store. */
function fakeApi(): {
  readonly api: Parameters<typeof createRecorderVideoclipsProvider>[0]['api']
  readonly calls: string[]
} {
  const calls: string[] = []
  const api = {
    pipelineAnalytics: {
      getMotionEvents: {
        query: vi.fn(async () => {
          calls.push('pipelineAnalytics.getMotionEvents')
          return [{ id: 11, timestamp: 50_000, mediaUrl: '/t/11' }]
        }),
      },
      getObjectEvents: {
        query: vi.fn(async () => {
          calls.push('pipelineAnalytics.getObjectEvents')
          return []
        }),
      },
      getAudioEvents: {
        query: vi.fn(async () => {
          calls.push('pipelineAnalytics.getAudioEvents')
          return []
        }),
      },
      ownersWithMedia: {
        query: vi.fn(async () => {
          calls.push('pipelineAnalytics.ownersWithMedia')
          return ['11']
        }),
      },
    },
    recording: {
      getAvailability: {
        query: vi.fn(async () => {
          calls.push('recording.getAvailability')
          // `read` is part of the answer since D625 — a fake that omits it is
          // the "green because the fake supplied what production forgot"
          // failure CLAUDE.md names.
          return { read: 'read' as const, ranges: [{ startMs: 0, endMs: 100_000 }] }
        }),
      },
      getPlayback: {
        query: vi.fn(async () => {
          calls.push('recording.getPlayback')
          return {
            kind: 'hls' as const,
            manifest: {
              deviceId: 101,
              localMasterPath: null,
              playbackUrl: '/hls/master.m3u8',
              playbackEndpoints: ['/lan/master.m3u8'],
            },
          }
        }),
      },
    },
  }
  return { api, calls }
}

function silentLog(): VideoclipsWiringLogger {
  return { warn: () => {}, info: () => {} }
}

describe('createRecorderVideoclipsProvider', () => {
  it('reads EVERYTHING through ctx.api — the events AND the footage', async () => {
    const { api, calls } = fakeApi()
    const provider = createRecorderVideoclipsProvider({ api, logger: silentLog() })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 101,
      since: 0,
      until: 200_000,
    })

    expect(clips).toHaveLength(1)
    expect(clips[0]!.thumbnail).toBe('/t/11')
    // The footage reads are NOT taken from the in-process recording provider:
    // this addon runs on every recording node and the hub dispatches to one of
    // them, which need not be the one holding this camera.
    expect(calls).toContain('recording.getAvailability')
    expect(calls).toContain('pipelineAnalytics.getMotionEvents')
    expect(calls).toContain('pipelineAnalytics.ownersWithMedia')
  })

  it('resolves playback through the recorder cap, and stamps hls', async () => {
    const { api, calls } = fakeApi()
    const provider = createRecorderVideoclipsProvider({ api, logger: silentLog() })
    const playback = await provider.getClipPlayback({
      deviceId: 101,
      clipId: 'analytics:1000:2000:visit',
    })
    expect(playback).toEqual({
      playbackUrl: '/hls/master.m3u8',
      playbackEndpoints: ['/lan/master.m3u8'],
      format: 'hls',
    })
    expect(calls).toContain('recording.getPlayback')
  })

  it('names the RECORDER on its source row — the picker resolves a row to who serves it', async () => {
    const { api } = fakeApi()
    const provider = createRecorderVideoclipsProvider({ api, logger: silentLog() })
    const sources = await provider.listSources({ deviceId: 101 })
    expect(sources).toHaveLength(1)
    expect(sources[0]!.addonId).toBe('recorder')
    // The clip-id namespace does NOT move with the registration: ids already
    // minted say `analytics:` and a stored id must keep resolving.
    expect(sources[0]!.source).toBe('analytics')
  })

  it('every device log line it emits carries the numeric deviceId as a TAG', async () => {
    const { api } = fakeApi()
    const tagged: LogExtras[] = []
    api.recording.getAvailability.query = vi.fn(async () => {
      throw new Error('recorder offline')
    })
    const provider = createRecorderVideoclipsProvider({
      api,
      logger: {
        warn: (_m: string, extras?: LogExtras) => {
          if (extras !== undefined) tagged.push(extras)
        },
        info: () => {},
      },
    })
    await provider.listClips({ provider: RECORDER, deviceId: 101, since: 0, until: 200_000 })
    expect(tagged.length).toBeGreaterThan(0)
    for (const extras of tagged) expect(extras.tags).toEqual({ deviceId: 101 })
  })
})
