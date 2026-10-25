/**
 * Who owns the teed files, and for how long.
 *
 * Driven against a REAL temporary directory rather than an fs seam, on
 * purpose: every claim here — "the JPEG is on disk", "all three files went
 * together", "the open clip was not pruned" — is a claim about the filesystem,
 * and a fake filesystem would only prove the store agrees with the fake. The
 * vouching test in particular exists BECAUSE a minter that reports success and
 * wrote nothing is exactly the shape of failure this repo has shipped twice.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClipRemuxer } from '../clip-remux.js'
import type { ClipThumbnailMinter, HksvClipBounds } from '../clip-store.js'
import { DEFAULT_CLIP_BOUNDS, HksvClipStore } from '../clip-store.js'
import type { ClipWriteOutcome } from '../clip-writer.js'

const DEVICE_ID = 101
const OTHER_DEVICE_ID = 102

interface LogLine {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

interface LogPayload {
  readonly meta?: Record<string, unknown>
  readonly tags?: Record<string, unknown>
}

function logger(sink: LogLine[]): IScopedLogger {
  const record =
    (level: LogLine['level']) =>
    (message: string, payload?: LogPayload): void => {
      sink.push({ level, message, meta: payload?.meta ?? {}, tags: payload?.tags ?? {} })
    }
  const log = {
    debug: () => {},
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => log,
    withTags: () => log,
  }
  // Documented type boundary: the store only ever calls these six.
  return log as unknown as IScopedLogger
}

let root = ''
let logs: LogLine[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hksv-clips-'))
  logs = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function outcome(over: Partial<ClipWriteOutcome> = {}): ClipWriteOutcome {
  return {
    bytes: 100,
    fragments: 3,
    sawInit: true,
    truncated: null,
    startedAtMs: 1_000,
    endedAtMs: 21_000,
    ...over,
  }
}

/** Writes a JPEG that is actually there — the honest minter. */
function realMinter(bytes = 512): ClipThumbnailMinter {
  return async ({ jpegPath }) => {
    await writeFile(jpegPath, Buffer.alloc(bytes, 0xff))
    return { ok: true }
  }
}

/** Reports success and writes NOTHING. The reason vouching exists. */
const lyingMinter: ClipThumbnailMinter = async () => ({ ok: true })

function store(options: {
  readonly minter?: ClipThumbnailMinter
  readonly remuxer?: ClipRemuxer
  readonly bounds?: Partial<HksvClipBounds>
  readonly now?: () => number
  /** Per-camera retention — the operator's knob, cascaded by the addon. */
  readonly maxAgeMsFor?: (deviceId: number) => number
  /** `null` = no writable location right now. */
  readonly resolveRoot?: () => Promise<string | null>
}): HksvClipStore {
  return new HksvClipStore({
    logger: logger(logs),
    resolveRoot: options.resolveRoot ?? (async () => root),
    mintThumbnail: options.minter,
    remuxClip: options.remuxer,
    bounds: options.bounds,
    maxAgeMsFor: options.maxAgeMsFor,
    now: options.now ?? (() => 21_000),
  })
}

async function writeClip(
  s: HksvClipStore,
  input: {
    readonly deviceId?: number
    readonly streamId: number
    readonly startedAtMs: number
    readonly bytes?: number
  },
): Promise<string> {
  const open = await s.open({
    deviceId: input.deviceId ?? DEVICE_ID,
    streamId: input.streamId,
    startedAtMs: input.startedAtMs,
    prebufferSpanMs: 8_000,
    width: 1280,
    height: 720,
    fragmentMs: 4_000,
  })
  if (open === null) throw new Error('the store refused to open a clip')
  const size = input.bytes ?? 100
  await open.sink.write(new Uint8Array(size).fill(1))
  await open.sink.close()
  await open.complete(
    outcome({
      bytes: size,
      startedAtMs: input.startedAtMs,
      endedAtMs: input.startedAtMs + 20_000,
    }),
  )
  return open.clipId
}

async function deviceFiles(deviceId = DEVICE_ID): Promise<string[]> {
  return (await readdir(join(root, String(deviceId)))).sort()
}

describe('HksvClipStore — the owner of the teed files', () => {
  it('lands the clip and a sidecar naming what iOS actually pulled', async () => {
    const s = store({ minter: realMinter() })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })

    const records = await s.listRecords(DEVICE_ID)
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record?.deviceId).toBe(DEVICE_ID)
    expect(record?.source).toBe('hksv')
    // The duration is what iOS pulled, not a window we chose.
    expect(record?.durationMs).toBe(20_000)
    expect(record?.prebufferSpanMs).toBe(8_000)
    expect(record?.acknowledgedByHomeKit).toBe(false)
    const files = await deviceFiles()
    expect(files.filter((f) => f.endsWith('.mp4'))).toHaveLength(1)
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1)
  })

  it('VOUCHES the thumbnail: a minter that reports success and wrote nothing yields no thumbnail', async () => {
    const lying = store({ minter: lyingMinter })
    await writeClip(lying, { streamId: 1, startedAtMs: 1_000 })
    const [lied] = await lying.listRecords(DEVICE_ID)
    expect(lied?.thumbnailFile).toBeUndefined()
    expect(lied?.thumbnailUnavailable?.reason).toBe('decode-failed')

    await rm(join(root, String(DEVICE_ID)), { recursive: true, force: true })

    const honest = store({ minter: realMinter() })
    await writeClip(honest, { streamId: 2, startedAtMs: 2_000 })
    const [vouched] = await honest.listRecords(DEVICE_ID)
    expect(vouched?.thumbnailFile).toBeDefined()
    expect(vouched?.thumbnailUnavailable).toBeUndefined()
    const jpeg = await stat(join(root, String(DEVICE_ID), vouched?.thumbnailFile ?? ''))
    expect(jpeg.size).toBeGreaterThan(0)
  })

  it('treats a ZERO-BYTE jpeg as no jpeg, and removes it', async () => {
    const s = store({ minter: realMinter(0) })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    const [record] = await s.listRecords(DEVICE_ID)
    expect(record?.thumbnailFile).toBeUndefined()
    expect(record?.thumbnailUnavailable?.reason).toBe('decode-failed')
    expect((await deviceFiles()).some((f) => f.endsWith('.jpg'))).toBe(false)
  })

  it('says NOT-ATTEMPTED when no minter is wired, so absence never reads as a decode failure', async () => {
    const s = store({})
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    const [record] = await s.listRecords(DEVICE_ID)
    expect(record?.thumbnailUnavailable?.reason).toBe('not-attempted')
  })

  it('DROPS a clip with no init segment, and says so', async () => {
    const s = store({ minter: realMinter() })
    const open = await s.open({
      deviceId: DEVICE_ID,
      streamId: 9,
      startedAtMs: 1_000,
      prebufferSpanMs: 0,
      width: 1280,
      height: 720,
      fragmentMs: 4_000,
    })
    if (open === null) throw new Error('refused')
    await open.sink.write(new Uint8Array(50))
    await open.sink.close()
    const record = await open.complete(outcome({ sawInit: false }))

    expect(record).toBeNull()
    expect(await s.listRecords(DEVICE_ID)).toHaveLength(0)
    expect(await deviceFiles()).toEqual([])
    // A branch that drops work logs it.
    const dropped = logs.find((l) => l.level === 'warn' && /init/i.test(l.message))
    expect(dropped?.tags).toMatchObject({ deviceId: DEVICE_ID })
  })

  it('prunes oldest-first on the per-device CLIP COUNT, deleting all three files together', async () => {
    const s = store({ minter: realMinter(), bounds: { maxClipsPerDevice: 2 } })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    await writeClip(s, { streamId: 2, startedAtMs: 2_000 })
    await writeClip(s, { streamId: 3, startedAtMs: 3_000 })

    const records = await s.listRecords(DEVICE_ID)
    expect(records.map((r) => r.startedAtMs)).toEqual([3_000, 2_000])
    // Three files per clip, two clips — nothing orphaned behind.
    expect(await deviceFiles()).toHaveLength(6)
  })

  it('prunes on the per-device BYTE ceiling, and never touches another camera', async () => {
    const s = store({ bounds: { maxBytesPerDevice: 250 } })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000, bytes: 100 })
    await writeClip(s, { streamId: 2, startedAtMs: 2_000, bytes: 100 })
    await writeClip(s, { deviceId: OTHER_DEVICE_ID, streamId: 3, startedAtMs: 1_500, bytes: 100 })
    await writeClip(s, { streamId: 4, startedAtMs: 3_000, bytes: 100 })

    expect((await s.listRecords(DEVICE_ID)).map((r) => r.startedAtMs)).toEqual([3_000, 2_000])
    expect((await s.listRecords(OTHER_DEVICE_ID)).map((r) => r.startedAtMs)).toEqual([1_500])
  })

  it('prunes on AGE', async () => {
    const s = store({ maxAgeMsFor: () => 10_000, now: () => 100_000 })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    await writeClip(s, { streamId: 2, startedAtMs: 95_000 })
    expect((await s.listRecords(DEVICE_ID)).map((r) => r.startedAtMs)).toEqual([95_000])
  })

  it('prunes on the WHOLE-STORE ceiling, across cameras, oldest first', async () => {
    const s = store({ bounds: { maxStoreBytes: 250 } })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000, bytes: 100 })
    await writeClip(s, { deviceId: OTHER_DEVICE_ID, streamId: 2, startedAtMs: 2_000, bytes: 100 })
    await writeClip(s, { streamId: 3, startedAtMs: 3_000, bytes: 100 })

    const all = [...(await s.listRecords(DEVICE_ID)), ...(await s.listRecords(OTHER_DEVICE_ID))]
    expect(all.map((r) => r.startedAtMs).sort((a, b) => a - b)).toEqual([2_000, 3_000])
  })

  it('never prunes a clip that is still being WRITTEN', async () => {
    const s = store({ bounds: { maxClipsPerDevice: 1 } })
    const open = await s.open({
      deviceId: DEVICE_ID,
      streamId: 42,
      startedAtMs: 500,
      prebufferSpanMs: 0,
      width: 1280,
      height: 720,
      fragmentMs: 4_000,
    })
    if (open === null) throw new Error('refused')
    await open.sink.write(new Uint8Array(100))

    // A different camera's clip completing runs the whole-store prune while the
    // one above is mid-write. Deleting it would truncate a live HomeKit clip.
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    await stat(join(root, String(DEVICE_ID), `${open.clipId.replace(/[^A-Za-z0-9_-]/g, '_')}.mp4`))

    await open.sink.close()
    await open.complete(outcome({ startedAtMs: 500 }))
    expect((await s.listRecords(DEVICE_ID)).map((r) => r.startedAtMs)).toEqual([1_000])
  })

  it('never lists a sidecar it cannot parse, and says so instead of throwing', async () => {
    // Found by a flaky test: `JSON.parse` sat outside the try, so a sidecar
    // read while it was being written threw straight through `listRecords`.
    // The write is atomic now; this pins the READ side, which a later
    // `videoclips` provider will do on every listing.
    const s = store({})
    const clipId = await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    await writeFile(
      join(root, String(DEVICE_ID), `${clipId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`),
      '{"schemaVersion": 1, "clipId"',
      'utf8',
    )
    expect(await s.listRecords(DEVICE_ID)).toEqual([])
    expect(logs.some((l) => l.level === 'warn' && /readable JSON/i.test(l.message))).toBe(true)
  })

  it('records the clip as SEEKABLE, at the size the remux actually left on disk', async () => {
    // The tee writes a fragmented file: it plays, and nothing can map a time
    // to a byte in it. The pass that fixes that belongs to the producer, and
    // its result belongs on the record rather than being rediscovered by
    // every reader.
    const s = store({
      minter: realMinter(),
      remuxer: async ({ clipPath }) => {
        await writeFile(clipPath, Buffer.alloc(407, 7))
        return { ok: true, bytes: 407 }
      },
    })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000, bytes: 400 })

    const record = (await s.listRecords(DEVICE_ID))[0]
    expect(record?.seekable).toBe(true)
    expect(record?.remuxUnavailable).toBeUndefined()
    // Re-stat'd, never carried over from the tee's own count — otherwise the
    // one field a Range reader uses is wrong by the +0.7 % the pass costs.
    expect(record?.bytes).toBe(407)
  })

  it("takes the duration the FILE holds over the tee's own wall clock", async () => {
    // The tee's clock starts when the tee does, and the first fragments it
    // writes are the PREBUFFER — footage older than the tee itself. Measured
    // on 101: 12.0 s claimed against 19.99 s held.
    const s = store({
      minter: realMinter(),
      remuxer: async () => ({ ok: true, bytes: 407, durationMs: 19_991 }),
    })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000, bytes: 400 })

    expect((await s.listRecords(DEVICE_ID))[0]?.durationMs).toBe(19_991)
  })

  it('keeps the wall clock when the file could not be measured — never a zero', async () => {
    const s = store({
      minter: realMinter(),
      remuxer: async () => ({ ok: true, bytes: 407 }),
    })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000, bytes: 400 })

    expect((await s.listRecords(DEVICE_ID))[0]?.durationMs).toBe(20_000)
  })

  it('KEEPS a clip the remux could not fix, and names the reason instead of the silence', async () => {
    const s = store({
      minter: realMinter(),
      remuxer: async () => ({ ok: false, reason: 'not-seekable' }),
    })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000, bytes: 400 })

    const record = (await s.listRecords(DEVICE_ID))[0]
    expect(record?.seekable).toBeUndefined()
    expect(record?.remuxUnavailable).toEqual({ reason: 'not-seekable' })
    // A clip that does not seek is a clip. The bytes are the tee's own.
    expect(record?.bytes).toBe(400)
    expect((await deviceFiles()).filter((f) => f.endsWith('.mp4'))).toHaveLength(1)
  })

  it('says NOT-ATTEMPTED when no remuxer is wired, so absence never reads as a failed pass', async () => {
    const s = store({ minter: realMinter() })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })

    const record = (await s.listRecords(DEVICE_ID))[0]
    expect(record?.remuxUnavailable).toEqual({ reason: 'not-attempted' })
    expect(record?.seekable).toBeUndefined()
  })

  it('never lets a THROWING remuxer cost the clip', async () => {
    const s = store({
      minter: realMinter(),
      remuxer: async () => {
        throw new Error('the remuxer exploded')
      },
    })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000, bytes: 400 })

    const record = (await s.listRecords(DEVICE_ID))[0]
    expect(record?.remuxUnavailable).toEqual({ reason: 'remux-failed' })
    expect(record?.bytes).toBe(400)
    expect(logs.some((l) => l.level === 'warn' && l.tags['deviceId'] === DEVICE_ID)).toBe(true)
  })

  it('does not run the remux on a clip it is about to DROP', async () => {
    // The cheap question first: undecodable bytes are not a clip, and an
    // ffmpeg per dropped stream is an ffmpeg per HomeKit session that failed.
    let calls = 0
    const s = store({
      minter: realMinter(),
      remuxer: async () => {
        calls += 1
        return { ok: true, bytes: 1 }
      },
    })
    const open = await s.open({
      deviceId: DEVICE_ID,
      streamId: 9,
      startedAtMs: 1_000,
      prebufferSpanMs: 0,
      width: 1280,
      height: 720,
      fragmentMs: 4_000,
    })
    await open?.sink.close()
    await open?.complete(outcome({ sawInit: false, bytes: 0 }))

    expect(calls).toBe(0)
  })

  it('mints the still from the file the remux left, not from the one it replaced', async () => {
    // Ordering, asserted rather than assumed: an input seek on a fragmented
    // file is the unreliable case the thumbnail docblock calls out, and it is
    // the whole reason the remux runs first.
    const seen: string[] = []
    const s = store({
      minter: async ({ clipPath, jpegPath }) => {
        seen.push((await readFile(clipPath)).toString('utf8').slice(0, 8))
        await writeFile(jpegPath, Buffer.alloc(64, 0xff))
        return { ok: true }
      },
      remuxer: async ({ clipPath }) => {
        await writeFile(clipPath, 'REMUXED!')
        return { ok: true, bytes: 8 }
      },
    })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000, bytes: 400 })

    expect(seen).toEqual(['REMUXED!'])
  })

  it('leaves no staging file behind after a completed clip', async () => {
    const s = store({})
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    expect((await deviceFiles()).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('records iOS acknowledging the clip, on disk', async () => {
    const s = store({})
    const clipId = await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    await s.acknowledge(DEVICE_ID, clipId)
    const [record] = await s.listRecords(DEVICE_ID)
    expect(record?.acknowledgedByHomeKit).toBe(true)
    const raw = await readFile(
      join(root, String(DEVICE_ID), `${clipId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`),
      'utf8',
    )
    expect(JSON.parse(raw)).toMatchObject({ acknowledgedByHomeKit: true })
  })
})

describe("HksvClipStore — the operator's two knobs", () => {
  it('applies a DIFFERENT retention per camera', async () => {
    // The operator's ask: per-camera retention, 14 days by default. A cascade
    // that resolved one number for the whole fleet would be a knob drawn per
    // camera and read globally — the shape D62 keeps charging for.
    const s = store({
      now: () => 100_000,
      maxAgeMsFor: (deviceId) => (deviceId === DEVICE_ID ? 10_000 : 90_000),
    })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    await writeClip(s, { deviceId: OTHER_DEVICE_ID, streamId: 2, startedAtMs: 20_000 })
    await writeClip(s, { streamId: 3, startedAtMs: 95_000 })

    // 101 keeps 10 s of clips; 102's 80 s-old one survives its 90 s window.
    expect((await s.listRecords(DEVICE_ID)).map((r) => r.startedAtMs)).toEqual([95_000])
    expect((await s.listRecords(OTHER_DEVICE_ID)).map((r) => r.startedAtMs)).toEqual([20_000])
  })

  it('defaults to FOURTEEN DAYS when nothing resolves a retention', async () => {
    expect(DEFAULT_CLIP_BOUNDS.maxAgeMs).toBe(14 * 24 * 60 * 60 * 1000)
    const fourteenDays = DEFAULT_CLIP_BOUNDS.maxAgeMs
    const s = store({ now: () => fourteenDays + 100_000 })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    await writeClip(s, { streamId: 2, startedAtMs: fourteenDays + 50_000 })
    expect((await s.listRecords(DEVICE_ID)).map((r) => r.startedAtMs)).toEqual([
      fourteenDays + 50_000,
    ])
  })

  it('refuses to open a clip when there is no writable location — and says so', async () => {
    const s = store({ resolveRoot: async () => null })
    const open = await s.open({
      deviceId: DEVICE_ID,
      streamId: 1,
      startedAtMs: 1_000,
      prebufferSpanMs: 0,
      width: 1280,
      height: 720,
      fragmentMs: 4_000,
    })
    expect(open).toBeNull()
    expect(await s.listRecords(DEVICE_ID)).toEqual([])
    expect(logs.some((l) => l.level === 'warn')).toBe(true)
  })

  it('keeps the per-clip and whole-store RAILS whatever the retention says', async () => {
    // Stated rather than assumed: the age is the operator's preference; these
    // two are safety rails, and a long retention must not let one camera turn
    // the disk into a landfill.
    const s = store({ bounds: { maxStoreBytes: 250 }, maxAgeMsFor: () => 10 ** 12 })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000, bytes: 100 })
    await writeClip(s, { streamId: 2, startedAtMs: 2_000, bytes: 100 })
    await writeClip(s, { streamId: 3, startedAtMs: 3_000, bytes: 100 })
    expect((await s.listRecords(DEVICE_ID)).map((r) => r.startedAtMs)).toEqual([3_000, 2_000])
  })
})

/**
 * `listCatalog` — the ONE read a provider lists from.
 *
 * `listRecords` answers what was WRITTEN; a row is only playable if the fMP4 is
 * still there, and "the sidecar survived its clip" has to be distinguishable
 * from "the location is gone" and from "the read failed". Three different
 * answers, one directory read, and the store is the only thing that can tell
 * them apart — a provider that re-stats per clip would pay N syscalls to learn
 * what one `readdir` already said.
 */
describe('HksvClipStore.listCatalog', () => {
  it('answers with the sidecars AND the file names, so a caller can join them', async () => {
    const s = store({ minter: realMinter() })
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    const catalog = await s.listCatalog(DEVICE_ID)
    expect(catalog.kind).toBe('catalog')
    if (catalog.kind !== 'catalog') return
    expect(catalog.records).toHaveLength(1)
    const record = catalog.records[0]
    expect(record).toBeDefined()
    if (record === undefined) return
    expect(catalog.files.has(record.file)).toBe(true)
    expect(record.thumbnailFile).toBeDefined()
    expect(catalog.files.has(record.thumbnailFile ?? '')).toBe(true)
  })

  it('reports a sidecar whose clip file is GONE — it does not drop the row', async () => {
    const s = store({})
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    const before = await s.listCatalog(DEVICE_ID)
    if (before.kind !== 'catalog') throw new Error('expected a catalog')
    const record = before.records[0]
    if (record === undefined) throw new Error('expected a record')
    await rm(join(root, String(DEVICE_ID), record.file))

    const after = await s.listCatalog(DEVICE_ID)
    if (after.kind !== 'catalog') throw new Error('expected a catalog')
    expect(after.records.map((r) => r.clipId)).toEqual([record.clipId])
    expect(after.files.has(record.file)).toBe(false)
  })

  it('says NO-ROOT when there is no writable location — never an empty catalog', async () => {
    const s = store({ resolveRoot: async () => null })
    expect((await s.listCatalog(DEVICE_ID)).kind).toBe('no-root')
  })

  it('says FAILED when the location resolver throws — a failed read is not "no clips"', async () => {
    const s = store({
      resolveRoot: async () => {
        throw new Error('storage cap unreachable')
      },
    })
    const catalog = await s.listCatalog(DEVICE_ID)
    expect(catalog.kind).toBe('failed')
    if (catalog.kind !== 'failed') return
    expect(catalog.error).toContain('storage cap unreachable')
  })

  it('is an EMPTY catalog for a camera that never recorded — the location is fine', async () => {
    const s = store({})
    const catalog = await s.listCatalog(OTHER_DEVICE_ID)
    expect(catalog.kind).toBe('catalog')
    if (catalog.kind !== 'catalog') return
    expect(catalog.records).toEqual([])
  })

  it('serves listRecords from the same read, so the two can never disagree', async () => {
    const s = store({})
    await writeClip(s, { streamId: 1, startedAtMs: 1_000 })
    await writeClip(s, { streamId: 2, startedAtMs: 2_000 })
    const catalog = await s.listCatalog(DEVICE_ID)
    if (catalog.kind !== 'catalog') throw new Error('expected a catalog')
    expect((await s.listRecords(DEVICE_ID)).map((r) => r.clipId)).toEqual(
      catalog.records.map((r) => r.clipId),
    )
  })
})
