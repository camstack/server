/**
 * The downloadable bundle of a promoted tape (D681, spec §3.3): gzip JSON
 * `{ format, version, manifest, gt, tape: [records…] }`. The OUTPUT is a
 * stream of string chunks, so the bundle is never assembled into one string
 * on its way out. The INPUT is not: `readTapeFile` (tape-codec.ts)
 * decompresses and Zod-decodes the whole promoted tape before this module
 * ever sees it — an accepted cost for an admin-only, occasional download on
 * this process (fix round 1, L2 — this comment used to claim otherwise).
 */
import type { Writable } from 'node:stream'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, gunzipSync } from 'node:zlib'
import { errMsg, type IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import { GroundTruthFileSchema, type GroundTruthFile } from './ground-truth.js'
import { decodeTapeText, type Tape } from './tape-codec.js'
import { TapeLightingSchema, type TapeRecord } from './tape-schema.js'

const BUNDLE_FORMAT = 'camstack-tape-bundle'
const BUNDLE_VERSION = 1

const TapeBundleManifestSchema = z.strictObject({
  tapeId: z.string(),
  deviceId: z.number().int(),
  scenario: z.string(),
  lighting: TapeLightingSchema,
  durationMs: z.number(),
  frames: z.number().int(),
  skips: z.number().int(),
  gaps: z.number().int(),
  reviewed: z.boolean(),
  recordedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
export type TapeBundleManifest = z.infer<typeof TapeBundleManifestSchema>

const TapeBundleSchema = z.strictObject({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  manifest: TapeBundleManifestSchema,
  gt: GroundTruthFileSchema,
  tape: z.array(z.unknown()),
})

export interface BundleParts {
  readonly manifest: TapeBundleManifest
  readonly gt: GroundTruthFile
  readonly tape: Tape
}

export function* bundleChunks(parts: BundleParts): Generator<string> {
  yield `{"format":${JSON.stringify(BUNDLE_FORMAT)},"version":${String(BUNDLE_VERSION)},`
  yield `"manifest":${JSON.stringify(parts.manifest)},"gt":${JSON.stringify(parts.gt)},"tape":[`
  const records: TapeRecord[] = [
    parts.tape.header,
    ...parts.tape.body,
    ...(parts.tape.end === null ? [] : [parts.tape.end]),
  ]
  let first = true
  for (const r of records) {
    yield `${first ? '' : ','}${JSON.stringify(r)}`
    first = false
  }
  yield ']}'
}

export function parseBundle(gz: Buffer): BundleParts {
  const raw: unknown = JSON.parse(gunzipSync(gz).toString('utf8'))
  const bundle = TapeBundleSchema.parse(raw)
  const text = bundle.tape.map((r) => `${JSON.stringify(r)}\n`).join('')
  return { manifest: bundle.manifest, gt: bundle.gt, tape: decodeTapeText(text) }
}

/**
 * `complete` — the peer read everything. `peer-stalled` — this module cut a
 * peer whose buffer stayed full past `drainTimeoutMs`. `peer-closed` — the
 * peer went away on its own (a recognised disconnect code: the client closed
 * the tab, reset the connection, or `pipeline` saw the destination close
 * early). `failed` — a name for everything else: OUR OWN generator or gzip
 * threw, or the destination errored with something unrecognised. Fix round 1
 * (M4): the two used to be conflated under `peer-closed`, which blamed the
 * wrong end of the pipe for a bug in this process.
 */
export type BundleStreamExit = 'complete' | 'peer-stalled' | 'peer-closed' | 'failed'

export interface StreamBundleDeps {
  readonly logger: IScopedLogger
  readonly drainTimeoutMs: number
  readonly checkEveryMs: number
  readonly now: () => number
}

/** Error codes a peer disconnect legitimately raises on the destination
 *  stream — never on OUR generator or gzip transform. Anything else that
 *  reaches `streamBundle`'s catch is `failed`, not `peer-closed`: unknown is
 *  never assumed to be the peer's fault (D393's spirit). */
const PEER_DISCONNECT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'])

function isPeerDisconnect(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    PEER_DISCONNECT_CODES.has(err.code)
  )
}

/** `info` for the two exits that name no fault of this process; `warn` for
 *  the two that are worth an operator's attention. */
function logLevelFor(exit: BundleStreamExit): 'info' | 'warn' {
  return exit === 'complete' || exit === 'peer-closed' ? 'info' : 'warn'
}

/**
 * `pipeline` honours `write()`'s return and `drain`; the watchdog cuts a peer
 * whose buffer stays full for `drainTimeoutMs` (D447). Every exit is logged
 * with the camera, and — since fix round 1 (M4) — with the error that caused
 * it, when there was one.
 */
export async function streamBundle(
  res: Writable,
  parts: BundleParts,
  deps: StreamBundleDeps,
): Promise<BundleStreamExit> {
  let stalled = false
  let fullSince: number | null = null
  const watchdog = setInterval(() => {
    if (!res.writableNeedDrain) {
      fullSince = null
      return
    }
    fullSince ??= deps.now()
    if (deps.now() - fullSince > deps.drainTimeoutMs) {
      stalled = true
      res.destroy(new Error('peer never drained'))
    }
  }, deps.checkEveryMs)
  let exit: BundleStreamExit = 'complete'
  let failure: unknown = null
  try {
    await pipeline(Readable.from(bundleChunks(parts)), createGzip(), res)
  } catch (err) {
    failure = err
    exit = stalled ? 'peer-stalled' : isPeerDisconnect(err) ? 'peer-closed' : 'failed'
  } finally {
    clearInterval(watchdog)
  }
  deps.logger[logLevelFor(exit)]('tape export finished', {
    tags: { deviceId: parts.manifest.deviceId },
    meta: {
      exit,
      tapeId: parts.manifest.tapeId,
      scenario: parts.manifest.scenario,
      ...(failure === null ? {} : { error: errMsg(failure) }),
    },
  })
  return exit
}
