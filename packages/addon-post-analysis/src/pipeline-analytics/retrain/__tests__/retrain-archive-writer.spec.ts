/**
 * The archive body, written to any sink — the browser download and the
 * training upload (`writeRetrainArchive`) are the same bytes.
 *
 * Pinned: the manifest is the FIRST entry (a consumer can stop after it); a
 * `crops` archive carries one crop per manifest `cropPath`; an unreadable copy
 * is dropped, counted and never stamped exported; the sha256 is of the exact
 * bytes the sink received.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import type { RetrainAnnotation } from '../retrain-annotation-store.js'
import { writeRetrainArchiveTo } from '../retrain-archive-writer.js'
import { buildRetrainManifest } from '../retrain-export.js'
import { RETRAIN_MANIFEST_ENTRY } from '../retrain-export-handler.js'
import type { RetrainFrame } from '../retrain-frame-store.js'

interface Entry {
  readonly name: string
  readonly body: Buffer
}

/** Minimal ustar reader: name (+prefix), size, body. */
function readTar(archive: Buffer): readonly Entry[] {
  const out: Entry[] = []
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .split('\u0000')[0] ?? ''
    const name = field(0, 100)
    const prefix = field(345, 155)
    const size = Number.parseInt(field(124, 12).trim() || '0', 8)
    const body = archive.subarray(offset + 512, offset + 512 + size)
    out.push({ name: prefix ? `${prefix}/${name}` : name, body: Buffer.from(body) })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

function frame(id: string): RetrainFrame {
  return {
    frameId: `retrain:t:${id}`,
    deviceId: 101,
    origin: 'track',
    trackId: 't',
    sourceMediaId: 1,
    sourceKind: 'keyFrame',
    sizeBytes: 3,
    width: 100,
    height: 100,
    copiedAt: 1,
    locationId: 'retrainMedia',
    complete: true,
  }
}

function annotation(id: string, frameId: string): RetrainAnnotation {
  return {
    id,
    trackId: 't',
    deviceId: 101,
    mediaKey: frameId,
    bbox: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 },
    macroClass: 'person',
    kind: 'subject',
    source: 'operator',
    createdAt: 1,
  }
}

async function run(layout: 'frames' | 'crops', unreadable: ReadonlySet<string> = new Set()) {
  const frames = [frame('1'), frame('2')]
  const manifest = buildRetrainManifest({
    frames,
    annotationsByFrame: new Map(
      frames.map((f) => [f.frameId, [annotation(`a${f.frameId.slice(-1)}`, f.frameId)]]),
    ),
    zoneForDevice: () => null,
    generatedAt: 1,
    batchId: 'batch-1',
    layout,
  })
  const chunks: Buffer[] = []
  const marked: string[][] = []
  const result = await writeRetrainArchiveTo({
    plan: { manifest, frames },
    readFrame: async (f) => (unreadable.has(f.frameId) ? null : Buffer.from(`px-${f.frameId}`)),
    cutCrop: async (_bytes, f, a) => Buffer.from(`crop-${f.frameId}-${a.id}`),
    sink: { write: async (chunk) => void chunks.push(Buffer.from(chunk)) },
    markExported: async (ids) => void marked.push([...ids]),
    logger: makeSilentLogger(),
    now: () => 1_700_000_000_000,
    pacingMs: 0,
  })
  const archive = Buffer.concat(chunks)
  return { result, archive, entries: readTar(archive), marked }
}

describe('writeRetrainArchiveTo', () => {
  it('writes the manifest first, then every frame, and hashes exactly what it wrote', async () => {
    const { result, archive, entries, marked } = await run('frames')

    expect(entries[0]?.name).toBe(RETRAIN_MANIFEST_ENTRY)
    expect(JSON.parse(entries[0]?.body.toString('utf8') ?? '{}').batchId).toBe('batch-1')
    expect(entries.map((e) => e.name).slice(1)).toEqual([
      'frames/101/t/1.jpg',
      'frames/101/t/2.jpg',
    ])
    expect(result.frames).toBe(2)
    expect(result.crops).toBe(0)
    expect(result.missing).toBe(0)
    expect(result.bytes).toBe(archive.length)
    expect(result.sha256).toBe(createHash('sha256').update(archive).digest('hex'))
    expect(marked).toEqual([['retrain:t:1', 'retrain:t:2']])
  })

  it('a crops archive carries one crop per manifest cropPath', async () => {
    const { result, entries } = await run('crops')

    const manifest = JSON.parse(entries[0]?.body.toString('utf8') ?? '{}')
    const cropPaths: string[] = manifest.frames.flatMap(
      (f: { annotations: { cropPath?: string }[] }) => f.annotations.map((a) => a.cropPath),
    )
    expect(cropPaths).toEqual(['crops/person/a1.jpg', 'crops/person/a2.jpg'])
    for (const p of cropPaths) expect(entries.some((e) => e.name === p)).toBe(true)
    expect(result.crops).toBe(2)
  })

  it('an unreadable copy is dropped, counted, and never stamped exported', async () => {
    const { result, entries, marked } = await run('crops', new Set(['retrain:t:1']))

    expect(entries.some((e) => e.name === 'frames/101/t/1.jpg')).toBe(false)
    expect(entries.some((e) => e.name === 'crops/person/a1.jpg')).toBe(false)
    expect(result.missing).toBe(1)
    expect(result.frames).toBe(1)
    expect(marked).toEqual([['retrain:t:2']])
  })
})
