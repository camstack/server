/**
 * The streamer, asserted end-to-end: what it writes is extracted by the system
 * `tar` binary and compared byte for byte with what went in. A dataset export
 * that produces an archive only its author can read is not an export.
 */
import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import type { PlannedTrack, TrainingExportPlan } from '../dataset-plan.js'
import {
  MANIFEST_ENTRY_NAME,
  buildManifest,
  streamDataset,
  type ArchiveSink,
} from '../training-export-stream.js'

function plannedTrack(partial: Partial<PlannedTrack> & { trackId: string }): PlannedTrack {
  return {
    deviceId: 101,
    className: 'person',
    firstSeen: 1000,
    lastSeen: 2000,
    classes: ['person'],
    zonesVisited: [],
    files: [],
    ...partial,
  }
}

function makePlan(tracks: readonly PlannedTrack[]): TrainingExportPlan {
  const files = tracks.flatMap((t) => t.files)
  return {
    generatedAt: 5_000,
    tracks,
    totals: [],
    trackCount: tracks.length,
    fileCount: files.length,
    byteCount: files.reduce((sum, f) => sum + f.sizeBytes, 0),
    truncated: false,
    skippedPaths: [],
  }
}

function makeSink(): ArchiveSink & { readonly chunks: Buffer[]; readonly ended: () => boolean } {
  const chunks: Buffer[] = []
  let ended = false
  return {
    chunks,
    ended: () => ended,
    write: async (chunk) => {
      chunks.push(chunk)
    },
    end: async () => {
      ended = true
    },
  }
}

const noPacing = { pace: vi.fn(async () => {}), pacingMs: 0 }

describe('streamDataset — the archive a training pipeline receives', () => {
  it('extracts to the planned paths with byte-identical contents', async () => {
    const bytes = Buffer.alloc(700, 0x5a)
    const plan = makePlan([
      plannedTrack({
        trackId: 't1',
        files: [
          {
            archivePath: 'tracks/101/t1/keyFrame.jpg',
            mediaId: 101,
            kind: 'keyFrame',
            sizeBytes: 700,
            timestamp: 10,
          },
        ],
      }),
    ])
    const sink = makeSink()

    const result = await streamDataset({
      plan,
      sink,
      readBlob: async () => bytes,
      logger: makeSilentLogger(),
      now: () => 1_700_000_000_000,
      ...noPacing,
    })

    expect(result.filesWritten).toBe(1)
    const dir = mkdtempSync(join(tmpdir(), 'camstack-export-'))
    try {
      const archive = join(dir, 'out.tar')
      writeFileSync(archive, Buffer.concat(sink.chunks))
      execFileSync('tar', ['-xf', archive, '-C', dir])
      const out = readFileSync(join(dir, 'tracks/101/t1/keyFrame.jpg'))
      expect(out.equals(bytes)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('puts the manifest FIRST so the archive self-describes', async () => {
    const plan = makePlan([
      plannedTrack({
        trackId: 't1',
        files: [
          {
            archivePath: 'tracks/101/t1/keyFrame.jpg',
            mediaId: 201,
            kind: 'keyFrame',
            sizeBytes: 4,
            timestamp: 10,
          },
        ],
      }),
    ])
    const sink = makeSink()

    await streamDataset({
      plan,
      sink,
      readBlob: async () => Buffer.from('abcd'),
      logger: makeSilentLogger(),
      now: () => 1_700_000_000_000,
      ...noPacing,
    })

    const dir = mkdtempSync(join(tmpdir(), 'camstack-export-'))
    try {
      const archive = join(dir, 'out.tar')
      writeFileSync(archive, Buffer.concat(sink.chunks))
      const listing = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' })
      expect(listing.split('\n')[0]).toBe(MANIFEST_ENTRY_NAME)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('closes the sink so the client sees a complete archive', async () => {
    const sink = makeSink()

    await streamDataset({
      plan: makePlan([]),
      sink,
      readBlob: async () => null,
      logger: makeSilentLogger(),
      now: () => 0,
      ...noPacing,
    })

    expect(sink.ended()).toBe(true)
  })
})

describe('streamDataset — dropped work is never silent', () => {
  it('counts and LOGS a file whose media cannot be read, and keeps going', async () => {
    const logger = makeSilentLogger()
    const warn = vi.spyOn(logger, 'warn')
    const plan = makePlan([
      plannedTrack({
        trackId: 't1',
        files: [
          {
            archivePath: 'tracks/101/t1/keyFrame.jpg',
            mediaId: 301,
            kind: 'keyFrame',
            sizeBytes: 10,
            timestamp: 1,
          },
          {
            archivePath: 'tracks/101/t1/thumbnail.jpg',
            mediaId: 302,
            kind: 'thumbnail',
            sizeBytes: 4,
            timestamp: 2,
          },
        ],
      }),
    ])

    const result = await streamDataset({
      plan,
      sink: makeSink(),
      readBlob: async (mediaId) => (mediaId === 302 ? Buffer.from('abcd') : null),
      logger,
      now: () => 0,
      ...noPacing,
    })

    expect(result).toMatchObject({ filesWritten: 1, filesMissing: 1 })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('media unreadable'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })

  it('drops an unrepresentable path with a log rather than a truncated entry', async () => {
    const logger = makeSilentLogger()
    const warn = vi.spyOn(logger, 'warn')
    const plan = makePlan([
      plannedTrack({
        trackId: 't1',
        files: [
          {
            archivePath: `tracks/101/${'x'.repeat(300)}.jpg`,
            mediaId: 201,
            kind: 'keyFrame',
            sizeBytes: 4,
            timestamp: 1,
          },
        ],
      }),
    ])
    const readBlob = vi.fn(async () => Buffer.from('abcd'))

    const result = await streamDataset({
      plan,
      sink: makeSink(),
      readBlob,
      logger,
      now: () => 0,
      ...noPacing,
    })

    expect(result.filesMissing).toBe(1)
    // The cheap check comes first: an unrepresentable name must not cost a read.
    expect(readBlob).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('path too long'),
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
  })
})

describe('streamDataset — pacing and abort', () => {
  it('yields between files', async () => {
    const pace = vi.fn(async () => {})
    const files = [1, 2, 3].map((n) => ({
      archivePath: `tracks/101/t1/snapshot-${n}.jpg`,
      mediaId: 1000 + n,
      kind: 'snapshot',
      sizeBytes: 4,
      timestamp: n,
    }))

    await streamDataset({
      plan: makePlan([plannedTrack({ trackId: 't1', files })]),
      sink: makeSink(),
      readBlob: async () => Buffer.from('abcd'),
      logger: makeSilentLogger(),
      now: () => 0,
      pace,
      pacingMs: 25,
    })

    expect(pace).toHaveBeenCalledTimes(3)
    expect(pace).toHaveBeenCalledWith(25)
  })

  it('stops reading disk once the client is gone', async () => {
    const readBlob = vi.fn(async () => Buffer.from('abcd'))
    const files = [1, 2, 3].map((n) => ({
      archivePath: `tracks/101/t1/snapshot-${n}.jpg`,
      mediaId: 1000 + n,
      kind: 'snapshot',
      sizeBytes: 4,
      timestamp: n,
    }))

    const result = await streamDataset({
      plan: makePlan([plannedTrack({ trackId: 't1', files })]),
      sink: makeSink(),
      readBlob,
      logger: makeSilentLogger(),
      now: () => 0,
      aborted: () => readBlob.mock.calls.length >= 1,
      ...noPacing,
    })

    expect(result.aborted).toBe(true)
    expect(readBlob).toHaveBeenCalledTimes(1)
  })
})

describe('buildManifest', () => {
  it('describes each track and its files without leaking store keys', () => {
    const plan = makePlan([
      plannedTrack({
        trackId: 't1',
        label: 'postino',
        importance: 0.8,
        files: [
          {
            archivePath: 'tracks/101/t1/keyFrame.jpg',
            mediaId: 101,
            kind: 'keyFrame',
            sizeBytes: 4,
            timestamp: 10,
          },
        ],
      }),
    ])

    const manifest = JSON.parse(buildManifest(plan).toString('utf8'))

    expect(manifest.format).toBe('camstack-training-export')
    expect(manifest.tracks[0].label).toBe('postino')
    expect(manifest.tracks[0].files[0].path).toBe('tracks/101/t1/keyFrame.jpg')
    expect(buildManifest(plan).toString('utf8')).not.toContain('mediaKey')
  })
})
