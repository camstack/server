/**
 * The `videoclips` SOURCE over the clips this addon teed to HomeKit.
 *
 * ## Where it runs, and why there is no hand-off
 *
 * `export-hap` is `placement: 'hub-only'` and the teed clips live on a
 * `local-path` storage location this process writes with `node:fs`. D550
 * recorded the open question as "the store lives in the hub-only `export-hap`
 * runner, so listing and serving must REACH it from wherever the provider
 * mounts". The answer is that the provider mounts HERE: `videoclips` is a
 * `scope:'device'` + `mode:'collection'` wrapper, so every addon that declares
 * it becomes one of the camera's bindings (`collectionBindings`, gated only by
 * the cap's `deviceTypes`), and `resolveWrapperNodeId` routes a wrapper to the
 * hub — which is where this addon already is. Nothing about a `videoclips`
 * provider requires owning the device.
 *
 * That removes the hand-off rather than building one, and it is the only shape
 * that obeys both rules D550 named: addons never import each other (this one
 * imports nothing — it reads its own store), and frames never cross a process
 * boundary (the bytes never enter a cap call at all; `getClipPlayback` answers
 * a URL into this addon's own data plane and the file is streamed with `Range`
 * from the disk it was written to). The rejected alternative was to register
 * the provider in the recorder and have it fetch clips over `ctx.api` — a
 * cross-addon byte move by handle at best, and the repo's one existing such
 * move carries a 50 MiB cap and a docblock naming the OOM it caused.
 *
 * ## The source EXISTS because of HomeKit, and is not a switch
 *
 * A camera has this source because it is exported to HomeKit and HomeKit has
 * not said no to recording it; un-export it, or switch recording off in the
 * Home app, and the row is gone (D550, D569 § 5, D589).
 * There is deliberately no enable control of its own — a knob over somebody
 * else's decision is D62's defect. `keepClips` is NOT that gate either: it
 * governs the TEE, and the clips already kept remain the truth about this
 * camera, so the row stays and its `reason` says the copies are off.
 *
 * ## `ok` is measured, and an empty list is not always an answer
 *
 * D561: `ok` may never be a default. Here the measurement is a real read of the
 * clips directory, and every answer this source gives — the source row and the
 * clip list — comes from ONE such read. The states are the existing five, and
 * no sixth was needed:
 *
 *  - `ok` — the directory answered. Including with nothing: a camera that has
 *    recorded no HomeKit clip yet is a complete list of zero, and the `reason`
 *    says which flavour of nothing it is.
 *  - `no-storage` — there is no writable `homekitClips` location: none seeded,
 *    or it is `readonly` / `drain` / `disabled` (D385, named by
 *    `clip-location.ts`, which is the only module that may interpret the mode).
 *    Exactly the Reolink meaning: the medium is not there.
 *  - `unreachable` — the storage cap could not be reached, or the directory
 *    read threw. A measurement that failed is never folded into "no clips"
 *    (D393).
 *  - `index-empty` — HomeKit recording is switched ON for this camera and the
 *    store holds nothing, because `buildHksvRecording` WITHHELD the
 *    advertisement (no H.264 slot ≤ 1080p, a GOP longer than any fragment
 *    length, or unreadable profiles). The camera's own switch disagrees with
 *    its own index, which is what this state means on the Reolink surface too,
 *    and the refusal travels verbatim in `reason`.
 *  - `sleeping` — never. There is no camera to wake: the read is a local
 *    directory read.
 */
import { readFile } from 'node:fs/promises'

import type {
  Clip,
  ClipBytes,
  ClipPlayback,
  ClipSource,
  ClipSourceAvailability,
  IScopedLogger,
  IVideoclipsProvider,
} from '@camstack/types'
import { VIDEOCLIPS_MAX_READ_BYTES } from '@camstack/types'

import type { HksvBuildOutcome } from './build-outcome.js'
import type { ClipLocationRefusal } from './clip-location.js'
import type { HksvClipRecord, HksvThumbnailUnavailableReason } from './clip-record.js'
import { clipFileNames, HKSV_CLIP_SOURCE } from './clip-record.js'
import type { HksvClipCatalog } from './clip-store.js'

/** What the picker calls this source. */
export const HKSV_CLIP_SOURCE_LABEL = 'HomeKit clips'

/** Why a listed row has no bytes behind it. Verbatim on `unplayableReason`. */
export const CLIP_FILE_MISSING = 'clip-file-missing'

/**
 * What the ADDON knows about one camera, read from the authorities that already
 * own each fact — never a second copy (D62).
 *
 * `exported` is the persisted exposure the operator made, `homekitRecording`
 * is HomeKit's OWN characteristic read at call time (`null` when this camera
 * was never offered recording — never folded into `false`, D315),
 * `keepingClips` is `resolveKeepHomekitClips`, and `lastBuild` is the mirror
 * `buildHksvRecording` writes.
 */
export interface HksvCameraFacts {
  readonly exported: boolean
  readonly homekitRecording: boolean | null
  readonly keepingClips: boolean
  readonly lastBuild: HksvBuildOutcome | null
}

export interface HksvVideoclipsDeps {
  readonly logger: IScopedLogger
  /** Stamped on the source row so a surface can address `listClips` at us. */
  readonly addonId: string
  describeCamera(deviceId: number): HksvCameraFacts
  readCatalog(deviceId: number): Promise<HksvClipCatalog>
  /** Why there is no root, from the ONE module that resolves the location. */
  locationRefusal(): ClipLocationRefusal | null
  mediaUrl(deviceId: number, stem: string): string
  thumbnailUrl(deviceId: number, stem: string): string
  /**
   * The absolute path of one clip's fMP4 — the ONE place the layout lives
   * (`HksvClipStore.artifactPath`). `null` when there is no writable location.
   */
  clipFilePath(deviceId: number, stem: string): Promise<string | null>
  now?(): number
}

/** The source row plus the read it was measured from — never measured twice. */
interface MeasuredSource {
  readonly availability: ClipSourceAvailability
  readonly catalog: HksvClipCatalog
}

export function createHksvVideoclipsProvider(deps: HksvVideoclipsDeps): IVideoclipsProvider {
  const now = deps.now ?? Date.now

  /**
   * The one read, and the state it proves.
   *
   * `null` means this camera has no HomeKit clip source at all — it is not
   * exported, or HomeKit recording is off for it. Not an availability: a row
   * that should not exist is not a row saying it is unhappy.
   */
  async function measure(deviceId: number): Promise<MeasuredSource | null> {
    const facts = deps.describeCamera(deviceId)
    // `false` is HomeKit saying no — the row goes, as it always has. `null`
    // is "never offered", and that camera keeps its row so the refusal can be
    // reported instead of the camera silently vanishing from the surface.
    if (!facts.exported || facts.homekitRecording === false) return null
    const catalog = await deps.readCatalog(deviceId)
    return { availability: availabilityFor(facts, catalog), catalog }
  }

  function availabilityFor(
    facts: HksvCameraFacts,
    catalog: HksvClipCatalog,
  ): ClipSourceAvailability {
    if (catalog.kind === 'failed') {
      return {
        state: 'unreachable',
        reason: `the HomeKit clips location could not be read: ${catalog.error}`,
      }
    }
    if (catalog.kind === 'no-root') {
      const refusal = deps.locationRefusal()
      if (refusal === 'unreachable') {
        return {
          state: 'unreachable',
          reason: 'the storage capability could not be reached (unreachable)',
        }
      }
      return {
        state: 'no-storage',
        reason:
          refusal === 'not-writable'
            ? 'the HomeKit clips location is not writable (not-writable) — readonly, draining or disabled'
            : 'no HomeKit clips location exists yet (no-location)',
      }
    }
    const asOf = now()
    if (catalog.records.length > 0) {
      return {
        state: 'ok',
        catalogAsOf: asOf,
        ...(facts.keepingClips
          ? {}
          : { reason: 'copies are switched off for this camera — nothing new is being kept' }),
      }
    }
    const withheld = facts.lastBuild?.withheld
    if (withheld !== undefined && withheld !== null) {
      const detail = facts.lastBuild?.detail
      return {
        state: 'index-empty',
        catalogAsOf: asOf,
        reason:
          `HomeKit recording is switched on for this camera but the advertisement was WITHHELD ` +
          `(${withheld})` +
          (detail === null || detail === undefined ? '' : `: ${detail}`) +
          ' — HomeKit has never recorded it, so there is nothing to keep',
      }
    }
    return {
      state: 'ok',
      catalogAsOf: asOf,
      reason: facts.keepingClips
        ? 'nothing has been recorded by HomeKit for this camera yet'
        : 'copies are switched off for this camera — nothing new is being kept, and nothing was',
    }
  }

  function toClip(deviceId: number, record: HksvClipRecord, files: ReadonlySet<string>): Clip {
    const names = clipFileNames(record.clipId)
    const hasBytes = files.has(record.file)
    const vouchedThumb =
      record.thumbnailFile !== undefined && files.has(record.thumbnailFile)
        ? deps.thumbnailUrl(deviceId, stemOf(names.thumbnail))
        : null
    return {
      id: record.clipId,
      source: HKSV_CLIP_SOURCE,
      kind: 'native',
      timeRange: { startMs: record.startedAtMs, endMs: record.endedAtMs },
      ...(vouchedThumb === null
        ? { thumbnailUnavailable: { reason: thumbnailRefusal(record, files) } }
        : { thumbnail: vouchedThumb }),
      ...(hasBytes ? {} : { playable: false, unplayableReason: CLIP_FILE_MISSING }),
    }
  }

  /**
   * The store's five reasons, narrowed onto the cap's four.
   *
   * The narrowing is LOSSY and it is forced: `ClipSchema.thumbnailUnavailable`
   * is a closed enum that `ui-library` maps exhaustively, so widening it is a
   * breaking change to a consumer, and this source's reasons postdate it. The
   * lossless copy is not lost — it is on the sidecar and on the listing line —
   * and the split preserves the only distinction a surface can act on:
   *
   *  - `no-keyframe` — the CLIP had nothing decodable at the trigger instant
   *    (`no-init-segment`, `decode-failed`, `timed-out`).
   *  - `unsupported` — no still exists and nothing here will make one
   *    (`ffmpeg-missing`, `not-attempted`, or a JPEG that is no longer on
   *    disk). Nothing re-mints a teed clip, so every one of these is final.
   */
  function thumbnailRefusal(
    record: HksvClipRecord,
    files: ReadonlySet<string>,
  ): 'no-keyframe' | 'unsupported' {
    if (record.thumbnailFile !== undefined && !files.has(record.thumbnailFile)) return 'unsupported'
    const reason: HksvThumbnailUnavailableReason | undefined = record.thumbnailUnavailable?.reason
    if (reason === 'no-init-segment' || reason === 'decode-failed' || reason === 'timed-out') {
      return 'no-keyframe'
    }
    return 'unsupported'
  }

  return {
    listSources: async ({ deviceId }): Promise<readonly ClipSource[]> => {
      const measured = await measure(deviceId)
      // Not a camera HomeKit records. `[]` is the honest answer: this source
      // does not exist for it, and a row saying "unavailable" would invite the
      // operator to fix something that is not broken.
      if (measured === null) return []
      deps.logger.info('videoclips: measured the HomeKit clip source', {
        tags: { deviceId },
        meta: {
          source: HKSV_CLIP_SOURCE,
          state: measured.availability.state,
          reason: measured.availability.reason ?? null,
          clips: measured.catalog.kind === 'catalog' ? measured.catalog.records.length : null,
        },
      })
      return [
        {
          source: HKSV_CLIP_SOURCE,
          addonId: deps.addonId,
          label: HKSV_CLIP_SOURCE_LABEL,
          availability: measured.availability,
        },
      ]
    },

    listClips: async ({ deviceId, since, until, limit }): Promise<readonly Clip[]> => {
      const measured = await measure(deviceId)
      if (measured === null) return []
      const tags = { deviceId }
      const catalog = measured.catalog
      const records = catalog.kind === 'catalog' ? catalog.records : []
      const files = catalog.kind === 'catalog' ? catalog.files : new Set<string>()
      // A clip OVERLAPS the window; it is not required to sit inside it. A
      // teed clip's duration is whatever iOS pulled, so a long one that began
      // before `since` is still the clip the operator is looking at.
      const inWindow = records.filter((r) => r.startedAtMs <= until && r.endedAtMs >= since)
      const ordered = inWindow.toSorted((a, b) => b.startedAtMs - a.startedAtMs)
      const capped = limit === undefined ? ordered : ordered.slice(0, limit)
      const clips = capped.map((record) => toClip(deviceId, record, files))

      const unplayable = clips.filter((c) => c.playable === false).length
      const vouched = clips.filter((c) => c.thumbnail !== undefined).length
      deps.logger.info('videoclips: listed the HomeKit clips', {
        tags,
        meta: {
          source: HKSV_CLIP_SOURCE,
          clips: clips.length,
          truncated: limit !== undefined && ordered.length > limit,
          unplayable,
          thumbsVouched: vouched,
          thumbsUnavailable: clips.length - vouched,
          // The lossless copy of every narrowed thumbnail refusal, so the
          // four-value enum on the wire never hides the five on disk.
          thumbnailReason: capped.find((r) => r.thumbnailFile === undefined)?.thumbnailUnavailable
            ?.reason,
          state: measured.availability.state,
        },
      })

      // An empty list is an answer only when the source could ANSWER (D561).
      // `[]` has nowhere to carry a reason, and the caller cannot tell it from
      // a quiet night.
      if (clips.length === 0 && measured.availability.state !== 'ok') {
        deps.logger.warn('videoclips: nothing to list, and the HomeKit clip source cannot answer', {
          tags,
          meta: {
            branch: 'refused-empty',
            state: measured.availability.state,
            reason: measured.availability.reason ?? null,
          },
        })
        throw new Error(
          `videoclips: device ${String(deviceId)} listed no HomeKit clips, and that is not an ` +
            `empty window — the source is "${measured.availability.state}"` +
            (measured.availability.reason === undefined
              ? '.'
              : `: ${measured.availability.reason}`),
        )
      }
      return clips
    },

    getClipPlayback: async ({ deviceId, clipId, profile }): Promise<ClipPlayback> => {
      const record = await findRecord(deviceId, clipId)
      // ONE rendition, always: HKSV is fed by a single `-c:v copy` slot picked
      // by `pickRecordingSource`, so the row carries no `streams` twins and
      // there is nothing for `profile` to choose between. It is logged rather
      // than silently ignored, and `served` is deliberately ABSENT — the
      // sidecar records the clip's pixels, not which broker profile they came
      // from, and naming one would be inventing the answer (D549 15).
      if (profile !== undefined) {
        deps.logger.debug('videoclips: a HomeKit clip has one rendition; the profile is moot', {
          tags: { deviceId },
          meta: { clipId, profile, width: record.width, height: record.height },
        })
      }
      return {
        playbackUrl: deps.mediaUrl(deviceId, stemOf(clipFileNames(clipId).clip)),
        format: 'mp4',
        // The slot the tee recorded from, when it was recorded. Absent — never
        // guessed — for a sidecar that predates the field.
        ...(record.profile === undefined ? {} : { served: record.profile }),
      }
    },

    /**
     * The clip's BYTES, inline and bounded — the seam another ADDON pulls
     * (D558), never the path a player takes.
     *
     * A browser or a viewer session plays `getClipPlayback`'s URL; an addon
     * cannot, because `AddonDataPlane` only lets an addon SERVE. So this is the
     * one place HomeKit clip bytes enter a cap envelope, and the bound is the
     * cap's own 50 MiB — held whole, base64, in this process AND the caller's,
     * on a hub that has already been OOM'd once (D9/D18). Above the bound it
     * REFUSES with the size: half a video is worse than an honest refusal.
     *
     * A 256 MB clip (the tee's per-clip rail) is therefore refusable here and
     * playable through the route, which is stated rather than discovered.
     */
    readClipBytes: async ({ deviceId, clipId, maxBytes }): Promise<ClipBytes> => {
      const record = await findRecord(deviceId, clipId)
      const stem = stemOf(clipFileNames(clipId).clip)
      // `served` is REQUIRED here — an export record persists it, and a row
      // read a week later must say what the panel said. It is a measurement
      // the tee makes; a sidecar that never carried one is refused rather than
      // answered with a guess (D393).
      if (record.profile === undefined) {
        deps.logger.warn('videoclips: a HomeKit clip cannot say which profile it recorded from', {
          tags: { deviceId },
          meta: { clipId, branch: 'no-profile' },
        })
        throw new Error(
          `videoclips: clip "${clipId}" does not record which profile HomeKit recorded from, ` +
            'so the twin it would be served as cannot be named',
        )
      }
      const bound = Math.min(maxBytes ?? VIDEOCLIPS_MAX_READ_BYTES, VIDEOCLIPS_MAX_READ_BYTES)
      if (record.bytes > bound) {
        throw new Error(
          `videoclips: clip "${clipId}" is ${String(record.bytes)} bytes, over the ` +
            `${String(bound)}-byte bound for an inline read — fetch it from its playback URL`,
        )
      }
      const path = await deps.clipFilePath(deviceId, stem)
      if (path === null) {
        throw new Error(
          `videoclips: the HomeKit clips location for device ${String(deviceId)} is not readable`,
        )
      }
      let bytes: Buffer
      try {
        bytes = await readFile(path)
      } catch (err: unknown) {
        deps.logger.warn('videoclips: the fMP4 of a listed HomeKit clip could not be read', {
          tags: { deviceId },
          meta: { clipId, branch: CLIP_FILE_MISSING, error: errorText(err) },
        })
        throw new Error(
          `videoclips: clip "${clipId}" has a sidecar but no readable bytes (${CLIP_FILE_MISSING})`,
          { cause: err },
        )
      }
      deps.logger.info('videoclips: served a HomeKit clip inline', {
        tags: { deviceId },
        meta: { clipId, bytes: bytes.byteLength, served: record.profile },
      })
      return {
        base64: bytes.toString('base64'),
        contentType: 'video/mp4',
        name: `${stem}.mp4`,
        bytes: bytes.byteLength,
        served: record.profile,
        ...(record.durationMs > 0 ? { durationMs: record.durationMs } : {}),
      }
    },
  }

  /**
   * The catalog row for one clip, or a THROW naming which of the three things
   * went wrong: not ours, not held, or held with no bytes behind it. Shared by
   * the two byte paths so they can never disagree about what a clip id means.
   */
  async function findRecord(deviceId: number, clipId: string): Promise<HksvClipRecord> {
    if (!clipId.startsWith(`${HKSV_CLIP_SOURCE}:`)) {
      throw new Error(`videoclips: clip id "${clipId}" was not minted by the HomeKit source`)
    }
    if (!clipId.startsWith(`${HKSV_CLIP_SOURCE}:${String(deviceId)}:`)) {
      throw new Error(
        `videoclips: clip id "${clipId}" belongs to another camera — ids are self-contained ` +
          'and name the device that teed them',
      )
    }
    const measured = await measure(deviceId)
    if (measured === null) {
      throw new Error(
        `videoclips: device ${String(deviceId)} has no HomeKit clip source — it is not exported ` +
          'to HomeKit, or HomeKit recording is off for it',
      )
    }
    const catalog = measured.catalog
    if (catalog.kind !== 'catalog') {
      throw new Error(
        `videoclips: the HomeKit clips for device ${String(deviceId)} cannot be read — ` +
          `the source is "${measured.availability.state}"`,
      )
    }
    const record = catalog.records.find((r) => r.clipId === clipId) ?? null
    if (record === null) {
      deps.logger.warn('videoclips: asked for a HomeKit clip the catalog does not hold', {
        tags: { deviceId },
        meta: { clipId, branch: 'no-catalog-row' },
      })
      throw new Error(`videoclips: no clip "${clipId}" is held for device ${String(deviceId)}`)
    }
    if (!catalog.files.has(record.file)) {
      deps.logger.warn('videoclips: the fMP4 for a listed HomeKit clip is gone', {
        tags: { deviceId },
        meta: { clipId, branch: CLIP_FILE_MISSING, file: record.file },
      })
      throw new Error(
        `videoclips: clip "${clipId}" has a sidecar but no bytes (${CLIP_FILE_MISSING})`,
      )
    }
    return record
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `<stem>.mp4` → `<stem>`. The routes address a stem; the store owns the rest. */
function stemOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot === -1 ? fileName : fileName.slice(0, dot)
}
