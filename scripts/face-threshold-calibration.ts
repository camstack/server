#!/usr/bin/env tsx
/**
 * Face recognition threshold from a MEASUREMENT of the enrolled gallery (D651).
 *
 * A threshold is a property of one model's cosine space. When the face model
 * changes (ArcFace → AuraFace), the old number means nothing, and a number
 * picked by feel is how this repo shipped 0.62 (almost nothing matched) and
 * then 0.55 under AuraFace (1 probe in 496). So the number comes from here:
 *
 *   - genuine pairs: two samples of the SAME identity;
 *   - impostor pairs: two samples of DIFFERENT identities;
 *   - both in ONE model's space (a sample of any other model is excluded and
 *     counted — mixing spaces would measure nothing);
 *   - the threshold is the lowest 0.001 step that lets at most
 *     `falseAcceptTarget` of the impostor pairs through.
 *
 * With n impostor pairs, no false-accept rate finer than 1/n can be told apart
 * from zero. The report says so (`targetResolvable: false`) and then answers
 * conservatively: above every impostor pair it saw. A measurement that cannot
 * be taken at all (one identity, no identity with two samples, no sample of
 * the model) is `null` with a reason — never 0 (AGENTS.md: a failed
 * measurement is null).
 *
 * Pairs are sample-to-sample. The matcher scores a probe against each
 * identity's BEST sample, so a live probe's impostor score is the max over an
 * identity's samples — the pairwise impostor tail is the right thing to bound.
 *
 * Usage (read-only):
 *   tsx scripts/face-threshold-calibration.ts --live [--model auraface-r100] [--far 0.001]
 *   tsx scripts/face-threshold-calibration.ts --from gallery.json [--model …] [--far …]
 *
 * `--live` reads the hub through GET queries only: `faceGallery.listIdentities`,
 * `faceGallery.listIdentitySamples`, `vectorStore.fetchByIds` on the
 * `identity-arcface` index. The model of each sample is the stamp its VECTOR
 * carries, the same stamp the gallery load checks (D651).
 *
 * No hub address lives in this file. The hub is `CAMSTACK_HUB_URL`, or the
 * gitignored `scratchpad/.hub`; with neither, `--live` refuses by name. The
 * token is the operator's `camstack login` session through the shared resolver
 * (`scripts/hub/credentials.mjs`); `CAMSTACK_HUB_TOKEN_FILE` is an explicit
 * override only. The hub serves a self-signed certificate, so the
 * connection skips verification exactly as hub.mjs does, but scoped to this
 * script's own dispatcher rather than the whole process.
 *
 * `--from` takes a JSON array of `{ identityId, sampleId, modelId, embedding }`.
 */
import { resolveHubAuth } from './hub/credentials.mjs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent, fetch as undiciFetch } from 'undici'

/** One enrolled sample, as the measurement needs it. */
export interface CalibrationSample {
  readonly identityId: string
  readonly sampleId: string
  readonly modelId: string
  readonly embedding: readonly number[]
}

export interface CalibrationOptions {
  /** The model whose cosine space is measured. */
  readonly modelId: string
  /** Largest fraction of impostor pairs allowed at or above the threshold, in [0, 1). */
  readonly falseAcceptTarget: number
}

/** A distribution summary; every field `null` when the distribution is empty. */
export interface Distribution {
  readonly count: number
  readonly min: number | null
  readonly p01: number | null
  readonly p10: number | null
  readonly p50: number | null
  readonly p90: number | null
  readonly p99: number | null
  readonly max: number | null
}

export interface CalibrationReport {
  readonly modelId: string
  readonly falseAcceptTarget: number
  /** `null` = could not be measured; see `reason`. */
  readonly threshold: number | null
  /** Impostor pairs at or above `threshold`, as a fraction. */
  readonly falseAcceptRate: number | null
  /** Genuine pairs below `threshold`, as a fraction. */
  readonly falseRejectRate: number | null
  /** The smallest non-zero false-accept rate these impostor pairs can express (1/n). */
  readonly resolution: number | null
  /** False when the target is finer than `resolution` (and not 0). */
  readonly targetResolvable: boolean
  readonly identities: number
  readonly samples: number
  readonly genuine: Distribution
  readonly impostor: Distribution
  /** Samples of other models, left out of the measurement, per model. */
  readonly excludedOtherModels: Readonly<Record<string, number>>
  /** Samples of this model whose dimension disagrees with the majority. */
  readonly excludedDimension: number
  /**
   * Samples of this model that cannot be measured: a zero-norm or non-finite
   * vector has no direction, so it has no cosine. Never scored as 0.
   */
  readonly skipped: number
  readonly reason?: string
}

/** Threshold granularity: the settings UI and the store carry 0.001 steps. */
const THRESHOLD_STEP = 1000

/**
 * A unit copy of `v`, or `null` when `v` has no direction (zero norm, or a
 * non-finite component). `null`, not a zero vector: a zero vector scores
 * cosine 0 against everything and would be counted as a real pair.
 */
function unitOrNull(v: readonly number[]): readonly number[] | null {
  let norm2 = 0
  for (const x of v) {
    if (!Number.isFinite(x)) return null
    norm2 += x * x
  }
  if (!(norm2 > 0)) return null
  const norm = Math.sqrt(norm2)
  return v.map((x) => x / norm)
}

/** Cosine of two UNIT vectors of equal length. */
function dotUnit(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0)
  return dot
}

/** Nearest-rank quantile over an ASCENDING array. */
function quantile(sortedAsc: readonly number[], q: number): number | null {
  if (sortedAsc.length === 0) return null
  const rank = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1))
  return sortedAsc[rank] ?? null
}

function round4(x: number | null): number | null {
  return x === null ? null : Number(x.toFixed(4))
}

function summarise(values: readonly number[]): Distribution {
  const s = [...values].sort((a, b) => a - b)
  return {
    count: s.length,
    min: round4(s[0] ?? null),
    p01: round4(quantile(s, 0.01)),
    p10: round4(quantile(s, 0.1)),
    p50: round4(quantile(s, 0.5)),
    p90: round4(quantile(s, 0.9)),
    p99: round4(quantile(s, 0.99)),
    max: round4(s[s.length - 1] ?? null),
  }
}

/** The most common dimension among the samples (ties: the first seen). */
function majorityDim(samples: readonly CalibrationSample[]): number | null {
  const counts = new Map<number, number>()
  for (const s of samples) counts.set(s.embedding.length, (counts.get(s.embedding.length) ?? 0) + 1)
  let best: number | null = null
  let bestCount = 0
  for (const [dim, count] of counts) {
    if (count > bestCount) {
      best = dim
      bestCount = count
    }
  }
  return best
}

/** The lowest 0.001 step strictly above `score`. */
function stepAbove(score: number): number {
  return Number(((Math.floor(score * THRESHOLD_STEP) + 1) / THRESHOLD_STEP).toFixed(3))
}

/**
 * Genuine and impostor distributions in `modelId`'s space, and the threshold
 * that meets `falseAcceptTarget` on the impostor pairs.
 */
export function calibrateFaceThreshold(
  samples: readonly CalibrationSample[],
  options: CalibrationOptions,
): CalibrationReport {
  const target = options.falseAcceptTarget
  if (!(target >= 0 && target < 1)) {
    throw new Error(`falseAcceptTarget must be in [0, 1), got ${target}`)
  }

  const excludedOtherModels: Record<string, number> = {}
  const ofModel: CalibrationSample[] = []
  for (const s of samples) {
    if (s.modelId === options.modelId) ofModel.push(s)
    else excludedOtherModels[s.modelId] = (excludedOtherModels[s.modelId] ?? 0) + 1
  }
  const dim = majorityDim(ofModel)
  const ofDim = ofModel.filter((s) => s.embedding.length === dim && dim !== 0)
  const excludedDimension = ofModel.length - ofDim.length
  const measured: Array<{ readonly identityId: string; readonly unit: readonly number[] }> = []
  for (const s of ofDim) {
    const unit = unitOrNull(s.embedding)
    if (unit !== null) measured.push({ identityId: s.identityId, unit })
  }
  const skipped = ofDim.length - measured.length

  const genuine: number[] = []
  const impostor: number[] = []
  for (let i = 0; i < measured.length; i += 1) {
    for (let j = i + 1; j < measured.length; j += 1) {
      const a = measured[i]
      const b = measured[j]
      if (a === undefined || b === undefined) continue
      const c = dotUnit(a.unit, b.unit)
      if (a.identityId === b.identityId) genuine.push(c)
      else impostor.push(c)
    }
  }

  const base = {
    modelId: options.modelId,
    falseAcceptTarget: target,
    identities: new Set(measured.map((s) => s.identityId)).size,
    samples: measured.length,
    genuine: summarise(genuine),
    impostor: summarise(impostor),
    excludedOtherModels,
    excludedDimension,
    skipped,
  }
  const unmeasured = (reason: string): CalibrationReport => ({
    ...base,
    threshold: null,
    falseAcceptRate: null,
    falseRejectRate: null,
    resolution: impostor.length > 0 ? 1 / impostor.length : null,
    targetResolvable: false,
    reason,
  })

  if (measured.length === 0) return unmeasured(`no sample of model "${options.modelId}"`)
  if (impostor.length === 0) return unmeasured('no impostor pair: fewer than two identities')
  if (genuine.length === 0) return unmeasured('no genuine pair: no identity has two samples')

  const resolution = 1 / impostor.length
  const allowed = Math.floor(target * impostor.length + 1e-12)
  const desc = [...impostor].sort((a, b) => b - a)
  // The (allowed+1)-th highest impostor must fall BELOW the bar.
  const pivot = desc[allowed] ?? desc[desc.length - 1] ?? 0
  const threshold = stepAbove(pivot)
  const falseAccepts = impostor.filter((c) => c >= threshold).length
  const falseRejects = genuine.filter((c) => c < threshold).length

  return {
    ...base,
    threshold,
    falseAcceptRate: falseAccepts / impostor.length,
    falseRejectRate: falseRejects / genuine.length,
    resolution,
    targetResolvable: target === 0 || target >= resolution,
  }
}

/** Little-endian float32 base64, as `vectorStore.fetchByIds` serves it. `null` = unreadable. */
export function decodeVectorBase64(b64: string): readonly number[] | null {
  const buf = Buffer.from(b64, 'base64')
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null
  const copy = new Uint8Array(buf)
  return Array.from(new Float32Array(copy.buffer, 0, copy.byteLength / 4))
}

// ─── live read (GET only) ────────────────────────────────────────────────────

const IDENTITY_INDEX = 'identity-arcface'

/** Where the hub is, and the explicit token override when the operator named one. */
export interface HubConnection {
  readonly hubUrl: string
  readonly tokenFile?: string
}

export interface HubConnectionSources {
  readonly env: Readonly<Record<string, string | undefined>>
  /** The repository root; `scratchpad/` under it is gitignored. */
  readonly repoRoot: string
  /** A file's text, or `null` when it does not exist. */
  readonly readFile: (filePath: string) => string | null
}

/**
 * The hub URL and token file, from the operator's environment or the
 * gitignored scratchpad — never from this file, which is public (D651).
 */
export function resolveHubConnection(sources: HubConnectionSources): HubConnection {
  const scratchpad = path.join(sources.repoRoot, 'scratchpad')
  const fromEnv = sources.env['CAMSTACK_HUB_URL']?.trim()
  const fromFile = sources.readFile(path.join(scratchpad, '.hub'))?.trim()
  const hubUrl = fromEnv !== undefined && fromEnv !== '' ? fromEnv : fromFile
  if (hubUrl === undefined || hubUrl === '') {
    throw new Error(
      'no hub URL: set CAMSTACK_HUB_URL (e.g. https://<hub-host>:4443) or write it to scratchpad/.hub (gitignored)',
    )
  }
  const tokenFromEnv = sources.env['CAMSTACK_HUB_TOKEN_FILE']?.trim()
  return {
    hubUrl: hubUrl.replace(/\/+$/, ''),
    ...(tokenFromEnv !== undefined && tokenFromEnv !== '' ? { tokenFile: tokenFromEnv } : {}),
  }
}

/** The shared resolver's contract (`scripts/hub/credentials.mjs`); injectable for the spec. */
export type ResolveHubAuth = (opts: {
  readonly server?: string
  readonly tokenFile?: string
}) => Promise<{ readonly server: string; readonly token: string }>

/** Hub address + bearer for `--live`: the token is never read from a file here. */
export async function authenticateHub(
  hub: HubConnection,
  resolveAuth: ResolveHubAuth,
): Promise<{ readonly hubUrl: string; readonly token: string }> {
  const auth = await resolveAuth({
    server: hub.hubUrl,
    ...(hub.tokenFile !== undefined ? { tokenFile: hub.tokenFile } : {}),
  })
  return { hubUrl: auth.server, token: auth.token }
}

interface IdentityRow {
  readonly id: string
  readonly name: string
}
interface SampleRow {
  readonly id: string
}
interface VectorRow {
  readonly id: string
  readonly vector: string
  readonly metadata: Readonly<Record<string, unknown>>
}

type HubGet = (procedure: string, input: unknown) => Promise<unknown>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
function isIdentityRow(v: unknown): v is IdentityRow {
  return isRecord(v) && typeof v['id'] === 'string' && typeof v['name'] === 'string'
}
function isSampleRow(v: unknown): v is SampleRow {
  return isRecord(v) && typeof v['id'] === 'string'
}
function isVectorRow(v: unknown): v is VectorRow {
  return (
    isRecord(v) &&
    typeof v['id'] === 'string' &&
    typeof v['vector'] === 'string' &&
    isRecord(v['metadata'])
  )
}

/** Every enrolled sample with its vector and the model its vector is stamped with. */
export async function readLiveGallery(get: HubGet): Promise<readonly CalibrationSample[]> {
  const identities = await get('faceGallery.listIdentities', {})
  if (!Array.isArray(identities)) throw new Error('faceGallery.listIdentities: not an array')
  const owner = new Map<string, string>()
  for (const identity of identities.filter(isIdentityRow)) {
    const samples = await get('faceGallery.listIdentitySamples', { identityId: identity.id })
    if (!Array.isArray(samples))
      throw new Error(`listIdentitySamples(${identity.name}): not an array`)
    for (const s of samples.filter(isSampleRow)) owner.set(s.id, identity.id)
  }
  const fetched = await get('vectorStore.fetchByIds', {
    index: IDENTITY_INDEX,
    ids: [...owner.keys()],
  })
  const items = isRecord(fetched) && Array.isArray(fetched['items']) ? fetched['items'] : []
  const out: CalibrationSample[] = []
  for (const item of items.filter(isVectorRow)) {
    const identityId = owner.get(item.id)
    const embedding = decodeVectorBase64(item.vector)
    const modelId = item.metadata['modelId']
    if (identityId === undefined || embedding === null || typeof modelId !== 'string') continue
    out.push({ identityId, sampleId: item.id, modelId, embedding })
  }
  const missing = owner.size - out.length
  if (missing > 0) {
    process.stderr.write(
      `warning: ${missing} of ${owner.size} samples had no readable stamped vector\n`,
    )
  }
  return out
}

/**
 * The hub serves a self-signed certificate, as hub.mjs assumes. Verification
 * is skipped on THIS dispatcher only; the timeouts are hub.mjs's (a busy hub
 * answers slowly, it is not down).
 */
const HUB_CONNECT_TIMEOUT_MS = 60_000
const HUB_RESPONSE_TIMEOUT_MS = 180_000

function makeHubGet(hubUrl: string, token: string): HubGet {
  const dispatcher = new Agent({
    connect: { rejectUnauthorized: false, timeout: HUB_CONNECT_TIMEOUT_MS },
    headersTimeout: HUB_RESPONSE_TIMEOUT_MS,
    bodyTimeout: HUB_RESPONSE_TIMEOUT_MS,
  })
  return async (procedure, input) => {
    const url = `${hubUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
    const res = await undiciFetch(url, {
      headers: { authorization: `Bearer ${token}` },
      dispatcher,
    })
    const body: unknown = await res.json()
    if (!isRecord(body)) throw new Error(`${procedure}: unreadable response`)
    if (body['error'] !== undefined) {
      throw new Error(`${procedure}: ${JSON.stringify(body['error']).slice(0, 400)}`)
    }
    const result = body['result']
    const data = isRecord(result) ? result['data'] : undefined
    return isRecord(data) ? data['json'] : undefined
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  readonly live: boolean
  readonly from: string | null
  readonly modelId: string
  readonly far: number
}

function parseArgs(argv: readonly string[]): CliArgs {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i >= 0 ? (argv[i + 1] ?? null) : null
  }
  return {
    live: argv.includes('--live'),
    from: value('--from'),
    modelId: value('--model') ?? 'auraface-r100',
    far: Number(value('--far') ?? '0.001'),
  }
}

function isCalibrationSample(v: unknown): v is CalibrationSample {
  return (
    isRecord(v) &&
    typeof v['identityId'] === 'string' &&
    typeof v['sampleId'] === 'string' &&
    typeof v['modelId'] === 'string' &&
    Array.isArray(v['embedding']) &&
    v['embedding'].every((x) => typeof x === 'number')
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  let samples: readonly CalibrationSample[]
  if (args.from !== null) {
    const parsed: unknown = JSON.parse(readFileSync(args.from, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error('--from: expected a JSON array of samples')
    samples = parsed.filter(isCalibrationSample)
  } else if (args.live) {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const hub = resolveHubConnection({
      env: process.env,
      repoRoot,
      readFile: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
    })
    const auth = await authenticateHub(hub, resolveHubAuth)
    samples = await readLiveGallery(makeHubGet(auth.hubUrl, auth.token))
  } else {
    throw new Error('pass --live or --from <gallery.json>')
  }
  const report = calibrateFaceThreshold(samples, {
    modelId: args.modelId,
    falseAcceptTarget: args.far,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
