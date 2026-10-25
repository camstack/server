/**
 * `HksvClipStore` — who owns the teed clips, and for how long.
 *
 * ## The owner
 *
 * The **export-hap addon**, on its own DECLARED storage location
 * (`homekitClips`, see `clip-location.ts`) — the operator picks the disk. Not
 * the `eventMedia` class and not `recordings`:
 *
 *  - A teed clip is a DERIVED artifact of a HomeKit session, with no track, no
 *    detection and no event behind it. Filing it under `eventMedia` would put
 *    it inside the post-analysis retention sweep, where its lifetime would be
 *    decided by a policy written for a different question.
 *  - `recordings` rows belong to the recorder's placement planner, its evictor
 *    and its drain ratchet, and these files are not segments its index knows.
 *  - The precedent for a class of its own is D549 decision 13: Reolink's clip
 *    thumbnails sit outside `eventMedia` and outside the sweep for the same
 *    reason.
 *
 * Layout: `<location root>/homekit-clips/<deviceId>/<stem>.{mp4,jpg,json}`. One
 * stem per clip, three extensions, so a pruner deleting a clip never has to
 * guess which JPEG was its; the `homekit-clips/` subtree is mandatory because
 * the location's seeded default SHARES the recordings root (D327).
 *
 * The first cut wrote to `<dataDir>/hksv-clips/`. It was defensible and gave
 * the operator no say, which was the first thing he asked for after seeing it.
 *
 * ## The retention: one preference, three rails
 *
 * HomeKit's own retention is unreadable — HAP has no read-back, so CamStack can
 * never ask "does iOS still have this one?" and reconcile. The store therefore
 * cannot mirror HomeKit's lifetime and does not pretend to: it keeps a bounded
 * recent window and says, per clip, exactly when it started.
 *
 * **The AGE is the operator's, per camera**
 * ({@link HksvClipStoreInput.maxAgeMsFor}, cascaded global-default plus
 * per-device override by the addon), defaulting to 14 days. The other three are
 * RAILS, not preferences, and stay fixed:
 *
 *  - **{@link DEFAULT_CLIP_BOUNDS.maxClipBytes} per clip (256 MB).** A clip's
 *    duration is whatever iOS pulled — there is no window we choose — so this
 *    is the only ceiling on a session that never closes. At the ~64 KB/s a
 *    1080p copy branch produces it is over an hour of video.
 *  - **{@link DEFAULT_CLIP_BOUNDS.maxClipsPerDevice} (200)** and
 *    **{@link DEFAULT_CLIP_BOUNDS.maxBytesPerDevice} (512 MB)**, oldest first.
 *    Measured fragment sizes (D84): ~255 KB per 8 s at 720p, ~500 KB at 1080p,
 *    so a typical 20-40 s HKSV clip is 1.5-3 MB and 200 of them is ~400 MB.
 *    Both bounds exist for the same reason the prebuffer ring has both: at 4K
 *    a fragment is 6.35 MB, a 25x spread, and a count-only bound is a
 *    per-camera disk figure nobody can predict.
 *  - **{@link DEFAULT_CLIP_BOUNDS.maxStoreBytes} (4 GB)** across every camera,
 *    applied after the per-device pass. Per-device bounds alone multiply by a
 *    camera count the operator changes without thinking about this store.
 *
 * An operator able to set the first to zero could turn the tee into a silent
 * no-op, and one able to raise the last without limit could fill the disk; the
 * age changes neither. The consequence is stated rather than left to be
 * discovered: a retention LONGER than the rails allow does not reach — a busy
 * camera hits 200 clips or 512 MB first. Every prune logs which bound fired
 * (`reason: age | count | bytes`), so "my 30 days did nothing" has an answer in
 * the log instead of a theory.
 *
 * A file nobody prunes is a disk that fills, and the pruner is the only thing
 * standing between a permanent prebuffer and that.
 *
 * ## The thumbnail is VOUCHED, never promised
 *
 * The minter is injected and its verdict is not believed: after it returns the
 * store stats the JPEG, and `thumbnailFile` is written only if a non-empty file
 * is really there. A minter that reports success and produced nothing gets
 * `thumbnailUnavailable.reason: 'decode-failed'` and its zero-byte leftover
 * deleted — this repo has twice shipped a green test because the fake supplied
 * what production forgot, and a promise is not a file.
 */

import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CamProfile, IScopedLogger } from '@camstack/types'

import type {
  HksvClipFileNames,
  HksvClipRecord,
  HksvRemuxUnavailableReason,
  HksvThumbnailUnavailableReason,
} from './clip-record.js'
import {
  clipFileNames,
  clipFileNamesForStem,
  clipIdFor,
  HKSV_CLIP_SOURCE,
  HksvClipRecordSchema,
} from './clip-record.js'
import type { ClipRemuxer } from './clip-remux.js'
import type { ClipSink, ClipWriteOutcome } from './clip-writer.js'

/**
 * What ONE directory read says about a camera's clips.
 *
 * Three answers, kept apart on purpose. `catalog` is a read that ANSWERED —
 * including with nothing, which is the truth about a camera that never
 * recorded. `no-root` is "there is no writable clips location right now"
 * (`clip-location.ts` has already named which of its three refusals it was).
 * `failed` is a read that could not be made, and it is never folded into an
 * empty list: a measurement that failed is `null`, never `0` (D393).
 */
export type HksvClipCatalog =
  | {
      readonly kind: 'catalog'
      /** Every sidecar, newest first. */
      readonly records: readonly HksvClipRecord[]
      /** Every file name really in the device's directory — the playable join. */
      readonly files: ReadonlySet<string>
    }
  | { readonly kind: 'no-root' }
  | { readonly kind: 'failed'; readonly error: string }

/** An `errno` code off an unknown throw, without a cast. */
function errnoCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null
  const { code } = err
  return typeof code === 'string' ? code : null
}

export interface HksvClipBounds {
  readonly maxClipBytes: number
  readonly maxClipsPerDevice: number
  readonly maxBytesPerDevice: number
  /**
   * The DEFAULT retention (14 days), used when no
   * {@link HksvClipStoreInput.maxAgeMsFor} is supplied. The live value is
   * always the per-camera one — a camera's retention has one authority and it
   * is that resolver.
   */
  readonly maxAgeMs: number
  readonly maxStoreBytes: number
}

/** See the class docblock for what each number is, and where it comes from. */
export const DEFAULT_CLIP_BOUNDS: HksvClipBounds = {
  maxClipBytes: 256 * 1024 * 1024,
  maxClipsPerDevice: 200,
  maxBytesPerDevice: 512 * 1024 * 1024,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxStoreBytes: 4 * 1024 * 1024 * 1024,
}

export interface ClipThumbnailMintInput {
  readonly deviceId: number
  readonly clipPath: string
  readonly jpegPath: string
  /**
   * Where inside the clip the HomeKit trigger sat, in seconds — the prebuffer
   * span. Frame zero of a teed clip is a picture of the moment before anything
   * happened, and that is the one instant nobody asked for.
   */
  readonly triggerOffsetSec: number
}

export type ClipThumbnailMintResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: HksvThumbnailUnavailableReason }

/**
 * Produce a still from a saved fMP4. Injected, because the store's job is to
 * VOUCH for the result and vouching for your own claim is not vouching.
 */
export type ClipThumbnailMinter = (
  input: ClipThumbnailMintInput,
) => Promise<ClipThumbnailMintResult>

export interface HksvClipStoreInput {
  readonly logger: IScopedLogger
  /**
   * The directory clips live under — `<location root>/homekit-clips` — or
   * `null` when there is no writable location right now (`clip-location.ts`).
   * Asked EVERY time rather than captured: the operator can repoint or drain
   * the location while the hub runs, and a captured path would keep writing to
   * a disk he is emptying.
   */
  readonly resolveRoot: () => Promise<string | null>
  readonly mintThumbnail?: ClipThumbnailMinter
  /**
   * The faststart pass, run once per clip at mint time. Optional: absent is
   * RECORDED as `not-attempted` rather than looked like a failure.
   */
  readonly remuxClip?: ClipRemuxer
  readonly bounds?: Partial<HksvClipBounds>
  /**
   * How long THIS camera's clips are kept. The operator's knob, cascaded
   * global-default plus per-device override by the addon; absent resolves to
   * {@link DEFAULT_CLIP_BOUNDS.maxAgeMs}.
   */
  readonly maxAgeMsFor?: (deviceId: number) => number
  readonly now?: () => number
}

/**
 * What the store CONCLUDED about the faststart pass — the remuxer's own verdict
 * widened by the one case only the store can report: nothing was wired. The
 * reasons are the record's, not the remuxer's, because this is what gets
 * written down.
 */
export type ClipRemuxOutcome =
  | { readonly ok: true; readonly bytes: number; readonly durationMs?: number }
  | { readonly ok: false; readonly reason: HksvRemuxUnavailableReason }

export interface OpenClipInput {
  readonly deviceId: number
  readonly streamId: number
  readonly startedAtMs: number
  /** How much of the clip's head came from the prebuffer ring. */
  readonly prebufferSpanMs: number
  readonly width: number
  readonly height: number
  readonly fragmentMs: number
  /** The broker slot `pickRecordingSource` chose — the only `served` there is. */
  readonly profile?: CamProfile
}

export interface OpenClip {
  readonly clipId: string
  readonly sink: ClipSink
  /**
   * The tee finished. Mints and vouches the still, writes the sidecar, prunes.
   * Returns `null` when the clip was DROPPED, with the reason in the log.
   */
  complete(outcome: ClipWriteOutcome): Promise<HksvClipRecord | null>
}

/** One clip currently being written — never a pruning candidate. */
interface InFlight {
  readonly deviceId: number
  readonly stem: string
}

export class HksvClipStore {
  private readonly log: IScopedLogger
  private readonly bounds: HksvClipBounds
  private readonly now: () => number
  private readonly inFlight = new Map<string, InFlight>()

  constructor(private readonly input: HksvClipStoreInput) {
    this.log = input.logger
    this.bounds = { ...DEFAULT_CLIP_BOUNDS, ...input.bounds }
    this.now = input.now ?? Date.now
  }

  /** This camera's retention. One authority, asked at every prune. */
  private maxAgeMsFor(deviceId: number): number {
    const resolved = this.input.maxAgeMsFor?.(deviceId)
    return resolved === undefined || !Number.isFinite(resolved) || resolved <= 0
      ? this.bounds.maxAgeMs
      : resolved
  }

  /** The per-clip ceiling the tee enforces while writing. */
  get maxClipBytes(): number {
    return this.bounds.maxClipBytes
  }

  /**
   * Open a file for one HDS stream. `null` when the directory cannot be made —
   * the caller must then skip the tee entirely and leave HKSV untouched, which
   * is why this returns rather than throws.
   */
  async open(input: OpenClipInput): Promise<OpenClip | null> {
    const clipId = clipIdFor(input.deviceId, input.startedAtMs, input.streamId)
    const names = clipFileNames(clipId)
    const tags = { deviceId: input.deviceId }
    // The cheap question first: a location that cannot be written costs no
    // mkdir and no ffmpeg, and the resolver has already named the reason.
    const root = await this.resolveRootOrWarn(tags)
    if (root === null) return null
    const dir = this.deviceDir(root, input.deviceId)
    try {
      await mkdir(dir, { recursive: true })
      const sink = await createFileSink(join(dir, names.clip))
      this.inFlight.set(clipId, { deviceId: input.deviceId, stem: stemOf(names.clip) })
      return {
        clipId,
        sink,
        complete: (outcome) => this.complete(clipId, input, names, outcome, root),
      }
    } catch (err) {
      this.inFlight.delete(clipId)
      this.log.warn(
        'hksv clip store: could NOT open a clip file — nothing is teed for this stream',
        {
          tags,
          meta: {
            streamId: input.streamId,
            error: err instanceof Error ? err.message : String(err),
          },
        },
      )
      return null
    }
  }

  /** Every sidecar for a camera, newest first. What a later provider lists. */
  async listRecords(deviceId: number): Promise<readonly HksvClipRecord[]> {
    const catalog = await this.listCatalog(deviceId)
    return catalog.kind === 'catalog' ? catalog.records : []
  }

  /**
   * ONE directory read, answering the three questions a provider has to tell
   * apart: what was written, what is still THERE, and — when neither — whether
   * the location is gone or the read failed.
   *
   * `listRecords` is this method's `records` and nothing else, so the published
   * D550 contract and the provider can never disagree about what the store
   * holds. The file name set is here rather than a `stat` per clip because the
   * `readdir` has already answered it: a sidecar whose fMP4 was removed is a
   * row that must still LIST, saying it cannot be played (D549's `playable`),
   * and N syscalls to re-learn what one call said is the shape D447 charges
   * for.
   *
   * A device directory that does not exist is an EMPTY catalog, not a refusal:
   * the location is fine and this camera has recorded nothing. A `readdir` that
   * failed for any other reason is `failed` — a measurement that failed is
   * never folded into "no clips" (D393).
   */
  async listCatalog(deviceId: number): Promise<HksvClipCatalog> {
    let root: string | null
    try {
      root = await this.input.resolveRoot()
    } catch (err) {
      return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    if (root === null) return { kind: 'no-root' }
    const dir = this.deviceDir(root, deviceId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return { kind: 'catalog', records: [], files: new Set() }
      return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    const records: HksvClipRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const record = await this.readRecord(join(dir, name), deviceId)
      if (record !== null) records.push(record)
    }
    return {
      kind: 'catalog',
      records: records.toSorted((a, b) => b.startedAtMs - a.startedAtMs),
      files: new Set(names),
    }
  }

  /**
   * Where ONE artifact of a clip lives, or `null` when there is no root.
   *
   * The stem, never a path: the caller (a data-plane route) has a URL segment
   * and the store owns the layout. Nothing else may compose a path into the
   * clips location.
   */
  async artifactPath(
    deviceId: number,
    stem: string,
    kind: keyof HksvClipFileNames,
  ): Promise<string | null> {
    const root = await this.rootOrNull()
    if (root === null) return null
    const names = clipFileNamesForStem(stem)
    return join(this.deviceDir(root, deviceId), names[kind])
  }

  /** iOS sent `ack`: HomeKit itself kept this clip. Recorded on the sidecar. */
  async acknowledge(deviceId: number, clipId: string): Promise<void> {
    const root = await this.rootOrNull()
    if (root === null) return
    const path = join(this.deviceDir(root, deviceId), clipFileNames(clipId).record)
    const record = await this.readRecord(path, deviceId)
    if (record === null) return
    await this.writeRecord(path, { ...record, acknowledgedByHomeKit: true })
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * The root, or `null` with ONE warn. Never throws: the caller's correct move
   * for every refusal is identical — no clip, HomeKit untouched.
   */
  private async resolveRootOrWarn(tags: { deviceId: number }): Promise<string | null> {
    try {
      const root = await this.input.resolveRoot()
      if (root !== null) return root
    } catch (err) {
      this.log.warn('hksv clip store: resolving the clips location FAILED — nothing is teed', {
        tags,
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
    // A branch that drops work says so. The location resolver has already named
    // WHY, at most once; this line is the per-camera consequence of it.
    this.log.warn(
      'hksv clip store: no writable clips location — this camera keeps no HomeKit clips',
      { tags, meta: {} },
    )
    return null
  }

  /** The root for a READ. Quiet: a read with no location is simply empty. */
  private async rootOrNull(): Promise<string | null> {
    try {
      return await this.input.resolveRoot()
    } catch {
      return null
    }
  }

  private deviceDir(root: string, deviceId: number): string {
    return join(root, String(deviceId))
  }

  private async complete(
    clipId: string,
    input: OpenClipInput,
    names: ReturnType<typeof clipFileNames>,
    outcome: ClipWriteOutcome,
    root: string,
  ): Promise<HksvClipRecord | null> {
    this.inFlight.delete(clipId)
    const dir = this.deviceDir(root, input.deviceId)
    const tags = { deviceId: input.deviceId }
    const clipPath = join(dir, names.clip)

    // Undecodable bytes are not a clip. Without an init segment there is no
    // `ftyp`/`moov`, so every fragment in the file describes a stream nothing
    // can read — keeping it would be keeping a promise we cannot honour.
    if (!outcome.sawInit || outcome.bytes === 0) {
      await rm(clipPath, { force: true })
      this.log.warn(
        'hksv clip tee: DROPPED the clip — it carries no init segment, so nothing in it is decodable',
        {
          tags,
          meta: {
            clipId,
            streamId: input.streamId,
            bytes: outcome.bytes,
            fragments: outcome.fragments,
          },
        },
      )
      return null
    }

    // Before the still, on purpose. The thumbnail takes an INPUT seek, which
    // its own docblock calls unreliable on anything but a real seekable file —
    // and until this pass has run, the teed clip is not one.
    const remux = await this.remuxAndVouch(clipPath, tags, clipId)

    const thumbnail = await this.mintAndVouch({
      deviceId: input.deviceId,
      clipPath,
      jpegPath: join(dir, names.thumbnail),
      triggerOffsetSec: input.prebufferSpanMs / 1000,
    })
    const record: HksvClipRecord = {
      schemaVersion: 1,
      clipId,
      source: HKSV_CLIP_SOURCE,
      deviceId: input.deviceId,
      streamId: input.streamId,
      startedAtMs: outcome.startedAtMs,
      endedAtMs: outcome.endedAtMs,
      // What the FILE holds when the remux could measure it, and the tee's own
      // wall clock otherwise. The two differ by the prebuffer: the tee's clock
      // starts when the tee does, and the first fragments it wrote are footage
      // older than itself.
      durationMs:
        remux.ok && remux.durationMs !== undefined
          ? remux.durationMs
          : Math.max(0, outcome.endedAtMs - outcome.startedAtMs),
      prebufferSpanMs: input.prebufferSpanMs,
      // The size of the file AS IT NOW STANDS: the remux rewrote it, and a
      // record stating the tee's own count would be wrong by the pass's
      // +0.7 % for ever, on the one field a Range reader uses.
      bytes: remux.ok ? remux.bytes : outcome.bytes,
      fragments: outcome.fragments,
      file: names.clip,
      ...(thumbnail.ok
        ? { thumbnailFile: names.thumbnail }
        : { thumbnailUnavailable: { reason: thumbnail.reason } }),
      ...(remux.ok ? { seekable: true } : { remuxUnavailable: { reason: remux.reason } }),
      ...(outcome.truncated === null ? {} : { truncated: outcome.truncated }),
      acknowledgedByHomeKit: false,
      width: input.width,
      height: input.height,
      fragmentMs: input.fragmentMs,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
    }
    await this.writeRecord(join(dir, names.record), record)
    this.log.info('hksv clip tee: a HomeKit clip was KEPT', {
      tags,
      meta: {
        clipId,
        streamId: input.streamId,
        bytes: record.bytes,
        fragments: record.fragments,
        durationMs: record.durationMs,
        prebufferSpanMs: record.prebufferSpanMs,
        truncated: record.truncated ?? null,
        thumbnail: record.thumbnailFile ?? null,
        thumbnailUnavailable: record.thumbnailUnavailable?.reason ?? null,
      },
    })
    await this.prune(root, input.deviceId)
    return record
  }

  /**
   * Mint, then CHECK. The minter's own verdict decides nothing on its own: a
   * JPEG is vouched by `stat`, never by a return value.
   */
  /**
   * Run the faststart pass, and never let it cost the clip.
   *
   * The remuxer already vouches for its own output and never throws by
   * contract — this wrapper exists for the one case a contract cannot cover: a
   * remuxer that throws anyway. A clip that does not seek is a clip; a clip
   * this pass ate is a HomeKit recording the operator lost, and that asymmetry
   * is the whole reason the failure is caught here and named on the record.
   */
  private async remuxAndVouch(
    clipPath: string,
    tags: { readonly deviceId: number },
    clipId: string,
  ): Promise<ClipRemuxOutcome> {
    const remux = this.input.remuxClip
    if (remux === undefined) return { ok: false, reason: 'not-attempted' }
    let result: ClipRemuxOutcome
    try {
      result = await remux({ clipPath })
    } catch (err) {
      result = { ok: false, reason: 'remux-failed' }
      this.log.warn('hksv clip tee: the faststart remuxer THREW — the clip is kept unseekable', {
        tags,
        meta: { clipId, error: err instanceof Error ? err.message : String(err) },
      })
    }
    if (!result.ok && result.reason !== 'not-attempted') {
      this.log.warn(
        'hksv clip tee: the clip could not be made SEEKABLE — it plays, but nothing can scrub or Range it',
        { tags, meta: { clipId, reason: result.reason } },
      )
    }
    return result
  }

  private async mintAndVouch(
    mint: ClipThumbnailMintInput,
  ): Promise<{ ok: true } | { ok: false; reason: HksvThumbnailUnavailableReason }> {
    const { deviceId, jpegPath } = mint
    const minter = this.input.mintThumbnail
    if (minter === undefined) return { ok: false, reason: 'not-attempted' }
    let declared: ClipThumbnailMintResult
    try {
      declared = await minter(mint)
    } catch (err) {
      this.log.warn(
        'hksv clip tee: the thumbnail minter threw — the clip is kept WITHOUT a still',
        {
          tags: { deviceId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
      declared = { ok: false, reason: 'decode-failed' }
    }
    const size = await fileSize(jpegPath)
    if (size > 0) return { ok: true }
    // Either the minter said no, or it said yes and wrote nothing. Both are
    // "there is no still", and the leftover must not survive as one.
    await rm(jpegPath, { force: true })
    const reason = declared.ok ? 'decode-failed' : declared.reason
    this.log.warn('hksv clip tee: no thumbnail for this clip', {
      tags: { deviceId },
      meta: { reason, declaredOk: declared.ok },
    })
    return { ok: false, reason }
  }

  /**
   * Enforce every bound, oldest first. Enumerated from the MP4s rather than the
   * sidecars, so a stem whose sidecar never landed — a crash mid-write — is
   * seen and removed instead of occupying the disk invisibly forever.
   */
  private async prune(root: string, deviceId: number): Promise<void> {
    const perDevice = await this.scanDevice(root, deviceId)
    await this.enforce(perDevice, this.bounds.maxClipsPerDevice, this.bounds.maxBytesPerDevice)

    let deviceIds: number[]
    try {
      const entries = await readdir(root, { withFileTypes: true })
      deviceIds = entries
        .filter((e) => e.isDirectory())
        .map((e) => Number.parseInt(e.name, 10))
        .filter((id) => Number.isFinite(id))
    } catch {
      return
    }
    const all: ClipOnDisk[] = []
    for (const id of deviceIds) all.push(...(await this.scanDevice(root, id)))
    // The whole-store rail. The count is per camera and already applied; here
    // only the shared byte ceiling and each camera's own age can fire.
    await this.enforce(all, Number.POSITIVE_INFINITY, this.bounds.maxStoreBytes)
  }

  /**
   * Enforce the bounds, oldest first. The AGE is asked per clip's CAMERA — two
   * cameras with different retentions share this pass, and folding them into
   * one cutoff would silently give every camera the shortest.
   */
  private async enforce(
    clips: readonly ClipOnDisk[],
    maxCount: number,
    maxBytes: number,
  ): Promise<void> {
    const now = this.now()
    // Newest first: everything past the count, past the byte ceiling or older
    // than its camera's retention goes, and it goes as a whole clip.
    const ordered = [...clips].sort((a, b) => b.startedAtMs - a.startedAtMs)
    let kept = 0
    let bytes = 0
    for (const clip of ordered) {
      const tooOld = clip.startedAtMs < now - this.maxAgeMsFor(clip.deviceId)
      const overCount = kept >= maxCount
      const overBytes = bytes + clip.bytes > maxBytes
      if (!tooOld && !overCount && !overBytes) {
        kept += 1
        bytes += clip.bytes
        continue
      }
      await this.deleteClip(clip, tooOld ? 'age' : overCount ? 'count' : 'bytes')
    }
  }

  private async deleteClip(clip: ClipOnDisk, reason: string): Promise<void> {
    for (const name of [`${clip.stem}.mp4`, `${clip.stem}.jpg`, `${clip.stem}.json`]) {
      await rm(join(clip.dir, name), { force: true })
    }
    this.log.info('hksv clip store: pruned a clip', {
      tags: { deviceId: clip.deviceId },
      meta: { stem: clip.stem, bytes: clip.bytes, reason, startedAtMs: clip.startedAtMs },
    })
  }

  private async scanDevice(root: string, deviceId: number): Promise<readonly ClipOnDisk[]> {
    const dir = this.deviceDir(root, deviceId)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const clips: ClipOnDisk[] = []
    for (const name of names) {
      if (!name.endsWith('.mp4')) continue
      const stem = stemOf(name)
      // A clip still being written is NEVER a candidate: deleting it would
      // truncate a HomeKit recording that is happening right now.
      if (this.isInFlight(deviceId, stem)) continue
      const bytes = await fileSize(join(dir, name))
      const record = await this.readRecord(join(dir, `${stem}.json`), deviceId)
      if (record === null) {
        // No sidecar and not in flight: a write that died. Remove it — its
        // bytes are real and nothing will ever name them.
        await rm(join(dir, name), { force: true })
        this.log.warn(
          'hksv clip store: removed an orphaned clip file (no sidecar, not being written)',
          {
            tags: { deviceId },
            meta: { stem, bytes },
          },
        )
        continue
      }
      clips.push({ deviceId, dir, stem, bytes, startedAtMs: record.startedAtMs })
    }
    return clips
  }

  private isInFlight(deviceId: number, stem: string): boolean {
    for (const entry of this.inFlight.values()) {
      if (entry.deviceId === deviceId && entry.stem === stem) return true
    }
    return false
  }

  private async readRecord(path: string, deviceId: number): Promise<HksvClipRecord | null> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return null
    }
    // INSIDE the try, unlike the first cut: `JSON.parse` throws on a truncated
    // file, and that throw escaped through `listRecords` into the caller. It
    // was found by a flaky test reading a sidecar mid-write — the same read a
    // later `videoclips` provider will do on every listing.
    let parsed: ReturnType<typeof HksvClipRecordSchema.safeParse>
    try {
      parsed = HksvClipRecordSchema.safeParse(JSON.parse(raw))
    } catch (err) {
      this.log.warn('hksv clip store: a sidecar is not readable JSON — the clip is not listed', {
        tags: { deviceId },
        meta: { path, error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
    if (parsed.success) return parsed.data
    // A sidecar we cannot read is not a clip we can list, and saying nothing
    // about it would make a corrupt store look like an empty one.
    this.log.warn('hksv clip store: a sidecar could not be read — the clip is not listed', {
      tags: { deviceId },
      meta: { path, error: parsed.error.message },
    })
    return null
  }

  /**
   * ATOMICALLY: a temp file plus a rename, never a `writeFile` in place.
   *
   * The sidecar is the only thing that says a clip exists, and it is read
   * concurrently — by the pruner, and later by whatever lists these clips. A
   * plain write is visible half-finished, and a half-finished sidecar reads as
   * a corrupt clip rather than a clip being written. `rename` within one
   * directory is atomic, so a reader sees the old record or the new one.
   */
  private async writeRecord(path: string, record: HksvClipRecord): Promise<void> {
    const staging = `${path}.tmp`
    await writeFile(staging, JSON.stringify(record, null, 2), 'utf8')
    await rename(staging, path)
  }
}

interface ClipOnDisk {
  readonly deviceId: number
  readonly dir: string
  readonly stem: string
  readonly bytes: number
  readonly startedAtMs: number
}

function stemOf(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '')
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * A sink over a real file that HONOURS backpressure: `write()` returning false
 * means the kernel has not taken the bytes, and ignoring it is how a stream
 * grows a queue nobody bounded (D447).
 */
async function createFileSink(path: string): Promise<ClipSink> {
  const stream = createWriteStream(path)
  await once(stream, 'open')
  return {
    async write(chunk: Uint8Array): Promise<void> {
      if (!stream.write(chunk)) await once(stream, 'drain')
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
    },
  }
}
