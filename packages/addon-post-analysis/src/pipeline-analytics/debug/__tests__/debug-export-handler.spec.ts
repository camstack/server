/**
 * The debug bundle, end to end: the handler streams a real archive, and the
 * system `unzip` is what says whether it has the shape the operator was
 * promised — one directory per track, `track.json` / `analysis.json` /
 * `events.json` inside it, and the media under `media/` with speaking names.
 *
 * The manifest gets its own attention because it is the one thing in the bundle
 * that can LIE: it is written after the blobs, precisely so that a file which
 * failed to read is recorded as missing instead of being claimed.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import {
  type DebugBundleManifest,
  type DebugBundlePlan,
  planTrackMediaNames,
} from '../debug-bundle.js'
import { createDebugExportHandler } from '../debug-export-handler.js'
import { buildDebugTrackReport } from '../debug-track-analysis.js'

const T0 = 1_700_000_000_000
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

interface Capture {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: Buffer
}

/** A `ServerResponse` reduced to what the handler actually touches. */
function fakeResponse(): { res: ServerResponse; captured: () => Capture } {
  const chunks: Buffer[] = []
  let status = 0
  let headers: Record<string, string> = {}
  const res = {
    writeHead(code: number, h?: Record<string, string>) {
      status = code
      headers = h ?? {}
      return res
    },
    write(chunk: Buffer, cb?: (err?: Error | null) => void) {
      chunks.push(chunk)
      cb?.(null)
      return true
    },
    once() {
      return res
    },
    end(cb?: () => void) {
      cb?.()
      return res
    },
  }
  return {
    res: res as unknown as ServerResponse,
    captured: () => ({ status, headers, body: Buffer.concat(chunks) }),
  }
}

function request(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage
}

// A media row's own id is a rowid (D482) — arbitrary and unrelated to owner,
// kind or track. A fresh block per call keeps two tracks' ids from colliding.
let nextMediaId = 1
function trackEntry(trackId: string, deviceId: number) {
  const firstFrameId = nextMediaId++
  const keyFrameId = nextMediaId++
  const snapshot1Id = nextMediaId++
  const snapshot2Id = nextMediaId++
  const media = [
    {
      mediaId: firstFrameId,
      kind: 'firstFrame' as const,
      sizeBytes: 6,
      timestamp: T0,
    },
    {
      mediaId: keyFrameId,
      kind: 'keyFrame' as const,
      sizeBytes: 6,
      timestamp: T0 + 12_000,
    },
    {
      mediaId: snapshot1Id,
      kind: 'snapshot' as const,
      sizeBytes: 6,
      timestamp: T0 + 10_000,
    },
    {
      mediaId: snapshot2Id,
      kind: 'snapshot' as const,
      sizeBytes: 6,
      timestamp: T0 + 20_000,
    },
  ]
  const report = buildDebugTrackReport({
    facts: {
      trackId,
      deviceId,
      className: 'person',
      label: 'person',
      labelScore: 0.9,
      firstSeen: T0,
      lastSeen: T0 + 30_000,
      active: false,
      positionCount: 12,
      snapshotCount: 2,
      bestEventId: 'evt-1',
    },
    media,
    eventCount: 2,
  })
  return {
    report,
    track: { trackId, deviceId, className: 'person', firstSeen: T0, lastSeen: T0 + 30_000 },
    events: [{ id: 'evt-1', trackId, confidence: 0.9 }],
    media: planTrackMediaNames(media),
    keyFrameId,
  }
}

function plan(...entries: ReturnType<typeof trackEntry>[]): DebugBundlePlan {
  return {
    generatedAt: T0,
    deviceIds: [...new Set(entries.map((e) => e.report.deviceId))],
    tracks: entries,
    capped: false,
  }
}

async function runExport(
  bundlePlan: DebugBundlePlan,
  readMedia: (mediaId: number) => Promise<Buffer | null> = async () => JPEG,
): Promise<Capture> {
  const { res, captured } = fakeResponse()
  const handler = createDebugExportHandler({
    buildPlan: async () => bundlePlan,
    readMedia,
    logger: makeSilentLogger(),
    now: () => T0,
  })
  await handler(request('GET', '/?deviceIds=101'), res)
  return captured()
}

function listEntries(archive: Buffer): readonly string[] {
  const dir = mkdtempSync(join(tmpdir(), 'camstack-debugzip-'))
  try {
    const file = join(dir, 'bundle.zip')
    writeFileSync(file, archive)
    execFileSync('unzip', ['-t', file], { encoding: 'utf8' })
    return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function readManifest(archive: Buffer): DebugBundleManifest {
  const dir = mkdtempSync(join(tmpdir(), 'camstack-debugzip-'))
  try {
    const file = join(dir, 'bundle.zip')
    writeFileSync(file, archive)
    execFileSync('unzip', ['-q', file, '-d', join(dir, 'out')])
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'out/manifest.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('manifest is not an object')
    return parsed as DebugBundleManifest
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('debug export — the archive shape', () => {
  it('gives every track its own directory, with the four documents and its media', async () => {
    const out = await runExport(plan(trackEntry('trk-a', 101)))

    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toBe('application/zip')
    expect(out.headers['content-disposition']).toContain('.zip"')

    expect(listEntries(out.body).toSorted()).toEqual([
      'manifest.json',
      'tracks/101/trk-a/analysis.json',
      'tracks/101/trk-a/events.json',
      'tracks/101/trk-a/media/firstFrame.jpg',
      'tracks/101/trk-a/media/keyFrame.jpg',
      // Repeated kinds carry their timestamp; single ones do not.
      'tracks/101/trk-a/media/snapshot-1700000010000.jpg',
      'tracks/101/trk-a/media/snapshot-1700000020000.jpg',
      'tracks/101/trk-a/track.json',
    ])
  })

  it('keeps two cameras’ tracks in separate directories', async () => {
    const out = await runExport(plan(trackEntry('trk-a', 101), trackEntry('trk-b', 102)))
    const dirs = new Set(
      listEntries(out.body)
        .filter((e) => e.startsWith('tracks/'))
        .map((e) => e.split('/').slice(0, 3).join('/')),
    )
    expect([...dirs].toSorted()).toEqual(['tracks/101/trk-a', 'tracks/102/trk-b'])
  })

  it('carries the media bytes verbatim', async () => {
    const out = await runExport(plan(trackEntry('trk-a', 101)))
    const dir = mkdtempSync(join(tmpdir(), 'camstack-debugzip-'))
    try {
      const file = join(dir, 'bundle.zip')
      writeFileSync(file, out.body)
      execFileSync('unzip', ['-q', file, '-d', join(dir, 'out')])
      const jpeg = readFileSync(join(dir, 'out/tracks/101/trk-a/media/keyFrame.jpg'))
      expect(jpeg.equals(JPEG)).toBe(true)
      const events: unknown = JSON.parse(
        readFileSync(join(dir, 'out/tracks/101/trk-a/events.json'), 'utf8'),
      )
      expect(events).toEqual([{ id: 'evt-1', trackId: 'trk-a', confidence: 0.9 }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers HEAD with the counts and NO body', async () => {
    const { res, captured } = fakeResponse()
    const handler = createDebugExportHandler({
      buildPlan: async () => plan(trackEntry('trk-a', 101), trackEntry('trk-b', 102)),
      readMedia: async () => JPEG,
      logger: makeSilentLogger(),
      now: () => T0,
    })
    await handler(request('HEAD', '/'), res)
    const out = captured()
    expect(out.headers['x-camstack-debug-tracks']).toBe('2')
    expect(out.headers['x-camstack-debug-media']).toBe('8')
    expect(out.body.length).toBe(0)
  })

  it('refuses a method that is not GET or HEAD', async () => {
    const { res, captured } = fakeResponse()
    const handler = createDebugExportHandler({
      buildPlan: async () => plan(),
      readMedia: async () => JPEG,
      logger: makeSilentLogger(),
      now: () => T0,
    })
    await handler(request('POST', '/'), res)
    expect(captured().status).toBe(405)
  })
})

describe('debug export — the manifest tells the truth', () => {
  it('records the findings, the directory and the media that landed', async () => {
    const manifest = readManifest((await runExport(plan(trackEntry('trk-a', 101)))).body)

    expect(manifest.trackCount).toBe(1)
    expect(manifest.deviceIds).toEqual([101])
    expect(manifest.mediaIncluded).toBe(4)
    expect(manifest.mediaMissing).toBe(0)
    expect(manifest.truncated).toBe(false)
    expect(manifest.stoppedBecause).toBeNull()
    expect(manifest.retentionNote).toContain('does not pin retention')

    const track = manifest.tracks[0]
    expect(track?.dir).toBe('tracks/101/trk-a')
    expect(track?.trackId).toBe('trk-a')
    expect(track?.durationMs).toBe(30_000)
    // The fixture is a realistically INCOMPLETE track — it captured a first
    // frame, a key frame and two snapshots, and nothing else. The manifest
    // carries the same finding codes the tab showed, so a bundle and the screen
    // it came from can be compared without re-running the analysis.
    // D400: MISSING_BEST_CROP is gone from this list on purpose — the fixture
    // ran no subject detail, so no crop was ever owed and the code that used to
    // fire here fired on healthy tracks too.
    expect(track?.findings).toEqual(['MISSING_LASTFRAME', 'MISSING_THUMBNAIL'])
    expect(track?.mediaIncluded).toContain('media/keyFrame.jpg')
  })

  it('names a blob it could not read as MISSING rather than claiming it', async () => {
    const entry = trackEntry('trk-a', 101)
    const out = await runExport(plan(entry), async (mediaId) =>
      mediaId === entry.keyFrameId ? null : JPEG,
    )

    // The entry is absent from the archive…
    expect(listEntries(out.body)).not.toContain('tracks/101/trk-a/media/keyFrame.jpg')
    // …and the manifest, written afterwards, says exactly which id failed.
    const manifest = readManifest(out.body)
    expect(manifest.mediaIncluded).toBe(3)
    expect(manifest.mediaMissing).toBe(1)
    expect(manifest.tracks[0]?.mediaMissing).toEqual([entry.keyFrameId])
    expect(manifest.tracks[0]?.mediaIncluded).not.toContain('media/keyFrame.jpg')
  })

  it('carries the findings of a track that produced nothing', async () => {
    const entry = trackEntry('trk-empty', 101)
    const report = buildDebugTrackReport({
      facts: {
        trackId: 'trk-empty',
        deviceId: 101,
        className: 'person',
        firstSeen: T0,
        lastSeen: T0 + 500,
        active: false,
        positionCount: 0,
        snapshotCount: 0,
      },
      media: [],
      eventCount: 0,
    })
    const manifest = readManifest((await runExport(plan({ ...entry, report, media: [] }))).body)
    expect(manifest.tracks[0]?.findings).toEqual([
      'MEDIA_EVICTED_OR_NEVER',
      'SHORT_TRACK',
      'ZERO_EVENTS',
      'ZERO_POSITIONS',
      'NO_BEST_EVENT',
    ])
    expect(manifest.mediaIncluded).toBe(0)
  })

  it('produces a readable, empty-of-tracks archive when nothing is marked', async () => {
    const out = await runExport(plan())
    expect(listEntries(out.body)).toEqual(['manifest.json'])
    expect(readManifest(out.body).trackCount).toBe(0)
  })
})

describe('planTrackMediaNames', () => {
  it('leaves a kind that occurs once bare, and timestamps one that repeats', () => {
    const names = planTrackMediaNames([
      { mediaId: 1, kind: 'keyFrame', sizeBytes: 1, timestamp: 10 },
      { mediaId: 2, kind: 'snapshot', sizeBytes: 1, timestamp: 20 },
      { mediaId: 3, kind: 'snapshot', sizeBytes: 1, timestamp: 30 },
    ]).map((m) => m.name)
    expect(names).toEqual(['media/keyFrame.jpg', 'media/snapshot-20.jpg', 'media/snapshot-30.jpg'])
  })

  it('disambiguates a genuine duplicate of kind AND timestamp', () => {
    const names = planTrackMediaNames([
      { mediaId: 1, kind: 'crop', sizeBytes: 1, timestamp: 10 },
      { mediaId: 2, kind: 'crop', sizeBytes: 1, timestamp: 10 },
    ]).map((m) => m.name)
    expect(names).toEqual(['media/crop-10.jpg', 'media/crop-10-2.jpg'])
  })
})
