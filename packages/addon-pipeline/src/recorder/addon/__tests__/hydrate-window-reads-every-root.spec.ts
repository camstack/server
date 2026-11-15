/**
 * A closed hour whose footage is split across two recordings roots is read from
 * BOTH (#557).
 *
 * `hydrateWindowFromStorage` marks the span walked at the end of each root's
 * pass. The next root then asked "is this closed hour hydrated?", got yes from
 * the first root's marker, and skipped its own directory — so a minute of
 * footage that lives on the second root (a rotation or drain moved the writer
 * mid-hour) was never indexed, and `hourSegmentsFromIndex` answered the hour as
 * complete without it: a false "no recordings" gap on the timeline.
 */
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { RecordingIndex } from '../../recording-index.js'
import { segmentRelPath } from '../../segment-path.js'
import { hydrateWindowFromStorage, recordingsLocationOfMode } from '../roots.js'
import { hourSegmentsFromIndex } from '../calendar-index.js'

const HOUR_MS = 3_600_000
const HOUR0 = Math.floor(1_700_000_000_000 / HOUR_MS) * HOUR_MS
const DEVICE = 584

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as IScopedLogger

const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hydrate-roots-spec-'))
  tmpDirs.push(root)
  return root
}

async function writeSegment(root: string, startMs: number): Promise<void> {
  const rel = segmentRelPath(DEVICE, 'low', startMs, 10_000, 1_000)
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, new Uint8Array(4))
}

describe('hydrateWindowFromStorage with two roots', () => {
  it('indexes a closed hour from every root that holds part of it', async () => {
    const rootA = await makeRoot()
    const rootB = await makeRoot()
    await writeSegment(rootA, HOUR0)
    await writeSegment(rootA, HOUR0 + 10_000)
    // The footage on the second root, mid-hour.
    await writeSegment(rootB, HOUR0 + 20_000)
    const index = new RecordingIndex()

    await hydrateWindowFromStorage(
      index,
      DEVICE,
      HOUR0,
      HOUR0 + HOUR_MS,
      [
        recordingsLocationOfMode({ id: 'rec:a', type: 'recordings', root: rootA }, 'active'),
        recordingsLocationOfMode({ id: 'rec:b', type: 'recordings', root: rootB }, 'active'),
      ],
      noopLogger,
    )

    const hour = hourSegmentsFromIndex(index, DEVICE, 'low', HOUR0)
    expect(hour?.map((s) => s.startMs)).toEqual([HOUR0, HOUR0 + 10_000, HOUR0 + 20_000])
  })
})
