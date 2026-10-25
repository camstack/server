/**
 * OUR row of the `recording` device COLLECTION (D625).
 *
 * `recording` stopped being a system singleton on 2026-09-24: a camera's
 * recorded coverage now has SOURCES, listed beside each other, and the
 * operator picks one per camera. This file is the recorder's source — the
 * reserved `camstack` row, which is also the DEFAULT, because the absence of
 * an operator choice means this value and nothing else.
 *
 * It is deliberately thin. Every read here is the same body the archive's
 * batch already calls (`readRecordingCoverage`, `readRecordingDays`), and
 * `getPlayback`'s `hls` arm carries `buildPlaybackManifest` unchanged — the
 * split moved the SURFACE, not the work, and a second definition of "what
 * footage exists" is exactly what this arrangement exists to prevent.
 *
 * ## Legibility is the whole job of this file
 *
 * A half-converted fleet is acceptable during the deploy (the operator's
 * ruling), on one condition: a read that could not be made must never read as
 * a camera with no recordings. So every method here answers
 * `read: 'unreadable'` on a failure rather than an empty list, logs it with
 * `tags: { deviceId }`, and `getPlayback` names its reason when nothing
 * covers the window (D391). There is no `?? []` on this path, anywhere.
 */
import type {
  IRecordingProvider,
  RecordingAvailability,
  RecordingDays,
  RecordingPlayback,
  RecordingSource,
  RecordingSourceAvailability,
  RecordingSourceOptions,
} from '@camstack/types'
import {
  CLIP_BROKER_PACED_RATES,
  deriveRecordingMode,
  errMsg,
  RECORDING_SOURCE_CAMSTACK,
} from '@camstack/types'
import { loadDeviceConfig } from './config-store.js'
import {
  buildPlaybackManifest,
  type RecordingProviderDeps,
  readRecordingCoverage,
  readRecordingDays,
} from './recording-provider.js'

/** What the picker calls us. */
const OUR_LABEL = 'CamStack recordings'

/** Codec probe results per (deviceId, profile) — lives as long as the provider,
 *  exactly as the archive provider's own cache does. */
type CodecCache = Map<string, string>

/**
 * Can we answer for this camera at all, and why not?
 *
 * The five states are `ClipSourceAvailability`'s verbatim, and they mean the
 * same things about a coverage index as about a clip catalog. Ours can only
 * reach three of them: we are never `sleeping` (no camera is woken to answer)
 * and never `no-storage` in the vendor sense — an unreachable ledger is
 * `unreachable`, and a camera the archive holds nothing for is `index-empty`.
 *
 * **`index-empty` is claimed only from the CALENDAR.** It is a statement about
 * what EXISTS, and `deps.index` answers about what is RESIDENT — the live tail
 * plus whatever somebody hydrated (D295). A node with no calendar rung
 * therefore says `ok` and lets the coverage read speak for itself; claiming
 * "this camera has no recordings" off the resident index is how 1.9 TB once
 * reported 60.5 GB.
 */
async function ourAvailability(
  deps: RecordingProviderDeps,
  deviceId: number,
): Promise<RecordingSourceAvailability> {
  const calendar = deps.calendar
  if (calendar === undefined || calendar === null) return { state: 'ok' }
  try {
    const profiles = await calendar.profilesWithFootageFor(deviceId)
    if (profiles.length === 0) {
      return { state: 'index-empty', reason: 'the archive holds no footage for this camera' }
    }
    return { state: 'ok', coverageAsOf: Date.now() }
  } catch (err: unknown) {
    // A branch that cannot answer SAYS so, per camera. An `unreachable` row is
    // the only thing that stops a surface drawing "no recordings" over a
    // ledger nobody could read.
    deps.logger.warn('recording source: the archive could not be asked about this camera', {
      tags: { deviceId },
      meta: { source: RECORDING_SOURCE_CAMSTACK, error: errMsg(err) },
    })
    return { state: 'unreachable', reason: errMsg(err) }
  }
}

export function buildRecordingSourceProvider(deps: RecordingProviderDeps): IRecordingProvider {
  const codecCache: CodecCache = new Map()

  return {
    listSources: async ({ deviceId }): Promise<readonly RecordingSource[]> => [
      {
        source: RECORDING_SOURCE_CAMSTACK,
        label: OUR_LABEL,
        availability: await ourAvailability(deps, deviceId),
      },
    ],

    getAvailability: async ({
      deviceId,
      fromMs,
      toMs,
      profile,
    }): Promise<RecordingAvailability> => {
      try {
        const coverage = await readRecordingCoverage(deps, deviceId, fromMs, toMs, profile)
        return {
          deviceId,
          read: 'read',
          ranges: [...coverage.ranges],
          profilesWithFootage: [...coverage.profilesWithFootage],
        }
      } catch (err: unknown) {
        deps.logger.warn('recording availability could not be read', {
          tags: { deviceId },
          meta: { source: RECORDING_SOURCE_CAMSTACK, error: errMsg(err), fromMs, toMs },
        })
        // NOT an empty bar: `unreadable` says nobody looked, and the surface
        // has to draw that differently from "this camera has no footage here".
        return { deviceId, read: 'unreadable', ranges: [], profilesWithFootage: [] }
      }
    },

    getDaysWithRecordings: async ({
      deviceId,
      fromMs,
      toMs,
      tzOffsetMinutes,
    }): Promise<RecordingDays> => {
      try {
        return {
          deviceId,
          read: 'read',
          days: [...(await readRecordingDays(deps, deviceId, fromMs, toMs, tzOffsetMinutes))],
        }
      } catch (err: unknown) {
        deps.logger.warn('recording days could not be read', {
          tags: { deviceId },
          meta: { source: RECORDING_SOURCE_CAMSTACK, error: errMsg(err), fromMs, toMs },
        })
        return { deviceId, read: 'unreadable', days: [] }
      }
    },

    getPlayback: async ({ deviceId, fromMs, toMs }): Promise<RecordingPlayback> => {
      try {
        const manifest = await buildPlaybackManifest(deps, codecCache, deviceId, fromMs, toMs)
        // `buildPlaybackManifest` answers a manifest with every field null when
        // no footage covers the window. That is a real answer and it deserves a
        // reason rather than an `hls` arm the player cannot load (D391).
        if (manifest.localMasterPath === null && manifest.playbackUrl === null) {
          return {
            kind: 'none',
            reason: 'no CamStack footage covers this window on the recording node',
          }
        }
        return { kind: 'hls', manifest }
      } catch (err: unknown) {
        deps.logger.warn('recording playback could not be built', {
          tags: { deviceId },
          meta: { source: RECORDING_SOURCE_CAMSTACK, error: errMsg(err), fromMs, toMs },
        })
        return { kind: 'none', reason: `the recorder could not answer: ${errMsg(err)}` }
      }
    },

    /**
     * What a surface may draw over OUR archive.
     *
     * Every value but `coverage` is a constant, and `coverage` is the one that
     * is not: 98.8 % of 592's day and 1.2 % of 1436's are the same recorder
     * with different bands. `deriveRecordingMode` is THE definition of that
     * and is read here rather than re-derived (D612's rule about second
     * authorities applies to our own source too).
     */
    getPlaybackOptions: async ({ deviceId }): Promise<RecordingSourceOptions> => {
      const config = await loadDeviceConfig(deps.configStore, deviceId)
      return {
        transport: 'archive',
        coverage: deriveRecordingMode(config) === 'continuous' ? 'continuous' : 'sparse',
        seek: 'free',
        stepBack: true,
        scrub: true,
        rates: CLIP_BROKER_PACED_RATES,
        exclusive: false,
      }
    },
  }
}
