/**
 * A committed tracking case (D681, spec §5.3): a promoted window of track
 * history plus the operator's labels, kept in the repo as a replay test the
 * tracker must pass.
 *
 *   packages/addon-post-analysis/tracking-bench/cases/<slug>/
 *     tape.jsonl.gz   the promoted tape (face pseudonyms `p<n>` only)
 *     gt.json         the marks, rebased onto the tape
 *     manifest.json   `CaseManifest`
 *
 * Outside `src/` and outside the package's `files`: nothing is published.
 * `status` is MEASURED when the case is made (plan decision 17): `held` when
 * `CASE_TRACKER` already honours the labels, `open` when it does not yet.
 *
 * `deriveTruth` and `readTapeFile` both take an `IScopedLogger` (added after
 * this module's contract was written — the operator-wins/slow-read logging).
 * This module carries no `ctx.logger` of its own (`caseFromBundle` is a pure
 * function per the contract, `loadCaseFixture` takes only a `dir`), so both
 * calls use the package's existing no-op logger rather than widen either
 * signature.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { BundleParts } from '../bundle.js'
import { deriveTruth, type GroundTruthFile, GroundTruthFileSchema } from '../ground-truth.js'
import { createNoopLogger } from '../no-op-logger.js'
import { encodeTapeGzip, readTapeFile, type Tape } from '../tape-codec.js'
import {
  COMMITTED_FACE_ID,
  TapeLightingSchema,
  type TapePlane,
  TapePlaneSchema,
} from '../tape-schema.js'
import { assessCaseLabels } from './case-labels.js'

/** `packages/addon-post-analysis/tracking-bench/cases`. */
export const CASES_DIR = path.resolve(import.meta.dirname, '../../../../tracking-bench/cases')
/** Same rule as promotion's `SCENARIO_SLUG` (a spec asserts it). */
export const CASE_SLUG = /^[a-z0-9][a-z0-9-]{2,63}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const CaseStatusSchema = z.enum(['open', 'held'])
export type CaseStatus = z.infer<typeof CaseStatusSchema>

export const CaseManifestSchema = z.strictObject({
  version: z.literal(1),
  slug: z.string().regex(CASE_SLUG),
  deviceId: z.number().int().positive(),
  plane: TapePlaneSchema,
  lighting: TapeLightingSchema,
  status: CaseStatusSchema,
  note: z.string().min(1).optional(),
  recordedDate: z.string().regex(DATE),
  importedDate: z.string().regex(DATE),
  frames: z.number().int().nonnegative(),
})
export type CaseManifest = z.infer<typeof CaseManifestSchema>

export interface CaseContent {
  readonly manifest: CaseManifest
  readonly tape: Tape
  readonly gt: GroundTruthFile
}

export interface CaseFixture extends CaseContent {
  readonly dir: string
}

export type CaseRefusalCode =
  | 'invalid-slug'
  | 'incomplete'
  | 'unreviewed'
  | 'pseudonym'
  | 'contradiction'
  | 'no-labels'

export interface CaseFromBundleOptions {
  readonly slug: string
  readonly plane: TapePlane
  readonly note?: string
  readonly importedDate: string
}

export interface CaseAccepted {
  readonly ok: true
  readonly content: CaseContent
}

export interface CaseRefused {
  readonly ok: false
  readonly code: CaseRefusalCode
  readonly detail: string
}

export type CaseFromBundleResult = CaseAccepted | CaseRefused

function refuse(code: CaseRefusalCode, detail: string): CaseRefused {
  return { ok: false, code, detail }
}

/**
 * A committed tape carries `p<n>` pseudonyms only (spec §3.6), so a hub-side
 * `h:` hash can never sit in the repo — on a detection's `fid` AND on an
 * `identity` record's `fid` (fix round 1, M3: the recognizer's verdict is a
 * face id too, and was missed by the original scan). Exported so
 * `cases.spec.ts` can re-run it on every committed fixture at LOAD time, not
 * only at creation — a hand-edited or hand-committed case bypassed it
 * entirely before.
 */
export function committedFaceViolation(tape: Tape): string | null {
  for (const r of tape.body) {
    if (r.kind === 'identity') {
      if (r.fid !== null && !COMMITTED_FACE_ID.test(r.fid))
        return `t=${String(r.t)} identity ${r.trk} carries a non-committed face id`
      continue
    }
    if (r.kind !== 'frame' && r.kind !== 'skip') continue
    for (const d of r.dets) {
      if (d.fid !== undefined && !COMMITTED_FACE_ID.test(d.fid))
        return `t=${String(r.t)} detection ${d.id} carries a non-committed face id`
    }
  }
  return null
}

export function caseFromBundle(
  parts: BundleParts,
  options: CaseFromBundleOptions,
): CaseFromBundleResult {
  const { tape, gt } = parts
  if (!CASE_SLUG.test(options.slug))
    return refuse(
      'invalid-slug',
      'a case slug is lower-case letters, digits and dashes, 3–64 characters',
    )
  if (parts.manifest.gaps > 0 || tape.end === null || tape.body.some((r) => r.kind === 'gap')) {
    return refuse(
      'incomplete',
      'the promoted window has a gap or no end record — promote the next occurrence',
    )
  }
  if (!parts.manifest.reviewed || !gt.reviewed)
    return refuse('unreviewed', 'mark the tape reviewed (debug.tape.review) and download it again')
  const face = committedFaceViolation(tape)
  if (face !== null) return refuse('pseudonym', face)
  const truth = deriveTruth(tape, gt, options.plane, createNoopLogger())
  if (!truth.ok)
    return refuse(
      'contradiction',
      `different-subjects inside a same-subject chain: ${truth.chain.join(' → ')}`,
    )
  const assessment = assessCaseLabels(tape, gt, options.plane)
  if (assessment.judgeableRelations === 0)
    return refuse(
      'no-labels',
      'the case carries no relation that can be judged — every relation touches a ' +
        'not-a-subject track, or a mixed track with no switch or side — so it asserts nothing',
    )
  if (assessment.unjudgeablePieces.length > 0)
    return refuse(
      'incomplete',
      `no detection was ever bound to ${assessment.unjudgeablePieces.join(', ')} on plane ` +
        `${options.plane} — that label can never be judged by any tracker`,
    )
  const frames = tape.body.filter((r) => r.kind === 'frame' && r.plane === options.plane).length
  const manifest = CaseManifestSchema.parse({
    version: 1,
    slug: options.slug,
    deviceId: parts.manifest.deviceId,
    plane: options.plane,
    lighting: parts.manifest.lighting,
    status: 'open',
    ...(options.note !== undefined && options.note.length > 0 ? { note: options.note } : {}),
    recordedDate: parts.manifest.recordedDate,
    importedDate: options.importedDate,
    frames,
  })
  // Fix round 1, M4: `deriveTruth` already computed every auto fid
  // cannot-link the operator's own same-subject mark outranked — it must not
  // be dropped silently just because THIS call passed a no-op logger. Kept
  // in the fixture so the Task 23 CLI can print it before committing.
  const committedGt: GroundTruthFile =
    truth.truth.suppressedAuto.length > 0
      ? { ...gt, suppressedAuto: [...truth.truth.suppressedAuto] }
      : gt
  return { ok: true, content: { manifest, tape, gt: committedGt } }
}

export function withStatus(content: CaseContent, status: CaseStatus): CaseContent {
  return { ...content, manifest: { ...content.manifest, status } }
}

export class CaseExistsError extends Error {
  constructor(readonly dir: string) {
    super(`a case is already committed at ${dir}`)
    this.name = 'CaseExistsError'
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Validates `content.manifest` (fix round 1, L5: an unparsed slug such as
 * `../x` would otherwise write outside `root`) and writes through a STAGING
 * directory, renamed into place only once every file is down — a write that
 * throws partway (disk full, a bad `Tape`) leaves no half-written `dir`
 * behind, so a caller can retry immediately rather than needing to clean up
 * a directory that would otherwise block every later attempt with
 * `CaseExistsError`.
 */
export async function writeCaseFixture(root: string, content: CaseContent): Promise<string> {
  const manifest = CaseManifestSchema.parse(content.manifest)
  const dir = path.join(root, manifest.slug)
  if (existsSync(dir)) throw new CaseExistsError(dir)
  const staging = path.join(root, `.staging-${manifest.slug}-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    await writeFile(path.join(staging, 'tape.jsonl.gz'), encodeTapeGzip(content.tape))
    await writeFile(path.join(staging, 'gt.json'), json(content.gt))
    await writeFile(path.join(staging, 'manifest.json'), json(manifest))
    if (existsSync(dir)) throw new CaseExistsError(dir)
    await rename(staging, dir)
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    throw err
  }
  return dir
}

export async function loadCaseFixture(dir: string): Promise<CaseFixture> {
  const manifest = CaseManifestSchema.parse(
    JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
  )
  if (manifest.slug !== path.basename(dir))
    throw new Error(`${dir}: manifest names slug ${manifest.slug}`)
  const gt = GroundTruthFileSchema.parse(
    JSON.parse(await readFile(path.join(dir, 'gt.json'), 'utf8')),
  )
  const tape = await readTapeFile(path.join(dir, 'tape.jsonl.gz'), {
    logger: createNoopLogger(),
    deviceId: manifest.deviceId,
  })
  return { dir, manifest, gt, tape }
}

/**
 * Synchronous so a spec can enumerate cases while vitest collects tests. A
 * leading `.` never names a case (`writeCaseFixture`'s staging directory, if
 * one is ever left behind by a process kill mid-write) and is skipped rather
 * than handed to `loadCaseFixture` as if it were one.
 */
export function listCaseDirs(root: string = CASES_DIR): readonly string[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => !name.startsWith('.'))
    .sort()
    .map((name) => path.join(root, name))
    .filter((full) => statSync(full).isDirectory())
}
