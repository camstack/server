/**
 * Which broker slot an Alexa session is served from, for one camera.
 *
 * ONE function for two callers: the session handler (`rtc-session.ts`) and the
 * doorbell pre-warm (`alexa-egress-prewarm.ts`). The pre-warmed transcode is
 * only found by the session when both name the same slot, because the slot is
 * part of the egress sharing key, so the decision must not exist twice.
 */
import type { AddonApi, IScopedLogger } from '@camstack/types'
import type { ExposedDeviceEntry } from '../types.js'
import {
  ALEXA_MAX_LINES,
  ALEXA_MIN_LINES,
  ALEXA_TARGET_LINES,
  profileForCamStream,
} from './alexa-source-pick.js'

export interface ResolveAlexaSourceProfileInput {
  readonly api: AddonApi
  readonly deviceId: number
  readonly exposedEntry: ExposedDeviceEntry | undefined
  readonly logger: IScopedLogger
}

export async function resolveAlexaSourceProfile(
  input: ResolveAlexaSourceProfileInput,
): Promise<'high' | 'mid' | 'low'> {
  const { api, deviceId, exposedEntry } = input
  const log = input.logger
  // Source profile priority:
  //   1. Explicit `sourceProfile` setting (advanced operator override)
  //   2. Map `streamPreference` ('low'/'mid'/'high') to the matching slot
  //   3. `'auto'` or unset → fall back to 'high'
  // The previous wiring read only `sourceProfile`, ignoring the
  // operator's `streamPreference` choice in the form — flipping the
  // form to 'low' had no effect on which source profile the derived
  // broker pulled from.
  // `settings.sourceProfile` is DEAD and deliberately not read.
  //
  // It was a second pin for a function `streamPreference` already owned: no
  // form field has ever written it (`buildDeviceSettingsContribution` renders
  // `enabled`, `streamPreference` and the transcode switch, and nothing else),
  // so any persisted value came from a release whose UI is gone — invisible,
  // unchangeable, and silently outranking the operator's actual choice.
  //
  // It cost exactly that, measured on device 106 on 2026-09-13: the panel said
  // `auto`, a stale `sourceProfile: 'low'` outvoted it, and every Echo session
  // was served a 640x360 picture — below Amazon's documented floor — from a
  // camera that publishes 2304x1296. The scoring added the same day never ran,
  // because the pin short-circuited it.
  //
  // Two knobs for one function, where the second disagrees with the first, is
  // worse than no knob (D62). `streamPreference` is the single authority:
  // `auto` scores, `high`/`mid`/`low` pin.
  const explicitSourceProfile: 'high' | 'mid' | 'low' | undefined = undefined
  const mappedFromPreference = (() => {
    const pref = exposedEntry?.settings?.streamPreference
    if (pref === 'low' || pref === 'mid' || pref === 'high') return pref
    return undefined
  })()
  const pinnedProfile = explicitSourceProfile ?? mappedFromPreference
  // `auto` SCORES, it does not fall through to a slot name. A slot name is a
  // fact about our own naming; what an Echo can take is a fact about Amazon's
  // requirements — H.264 up to High 4.1, 480p to 1080p — and on device 106 the
  // two disagreed badly enough to serve a 640x360 picture, below Amazon's own
  // floor, from a camera that also publishes 2304x1296.
  //
  // ONE scoring surface. Alexa passes AMAZON's numbers to
  // `cameraStreams.pickStream` — the picker every consumer already scores
  // through. A private scorer briefly stood here because the picker could not
  // express Amazon's ceiling; the picker learned `maxHeight`, `allowTranscode`
  // and `targetHeight` instead, because a second authority for a question that
  // already had one is what this addon has paid for all day.
  const allowTranscode = exposedEntry?.settings?.allowTranscode !== false
  const scored =
    pinnedProfile === undefined
      ? await api.cameraStreams.pickStream
          .query({
            deviceId,
            requirements: {
              acceptCodecs: ['h264'],
              minHeight: ALEXA_MIN_LINES,
              maxHeight: ALEXA_MAX_LINES,
              excludeDerived: true,
              allowTranscode,
            },
            preferences: { targetHeight: ALEXA_TARGET_LINES },
          })
          .catch((err: unknown) => {
            log.warn('alexa rtc-session: pickStream threw — falling back to the high slot', {
              tags: { deviceId },
              meta: {
                error: err instanceof Error ? err.message : String(err),
              },
            })
            return null
          })
      : null
  const scoredProfile =
    scored === null
      ? null
      : await profileForCamStream({
          api,
          deviceId,
          camStreamId: scored.camStreamId,
          logger: log,
        })
  const sourceProfile: 'high' | 'mid' | 'low' = pinnedProfile ?? scoredProfile ?? 'high'
  if (pinnedProfile === undefined) {
    log.info('alexa rtc-session: source scored against the Echo requirements', {
      tags: { deviceId },
      meta: {
        chosen: sourceProfile,
        // Two branches that must never be silent: nothing the camera publishes
        // clears Amazon's floor, and a stream that won but sits in no profile
        // slot. Either way we fall back to `high` and serve something possibly
        // out of spec, because serving nothing is worse — and the line says so.
        scored: scored === null ? 'none-eligible' : scored.reason,
        camStreamId: scored?.camStreamId ?? null,
        slot: scoredProfile ?? (scored === null ? null : 'no-slot'),
        height: scored?.resolution?.height ?? null,
        transcodes: scored?.transcodes ?? null,
        allowTranscode,
      },
    })
  }
  return sourceProfile
}
