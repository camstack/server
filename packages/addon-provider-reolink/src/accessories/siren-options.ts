import type { SirenOptions } from '@camstack/types'

/**
 * Reolink counts PLAYS, not seconds: `setSiren(channel, true, n)` plays the
 * alarm tone n times. The camera (Baichuan) advertises neither a range of
 * allowed counts nor how long one play lasts, so the options are a documented
 * fallback — `source: 'fallback'` — and the seconds-per-play factor is a
 * setting the operator can calibrate against the real camera.
 */
export const DEFAULT_SECONDS_PER_PLAY = 2
/** Counts offered when the camera says nothing; bounded to keep a siren from sounding for minutes. */
export const SIREN_MIN_PLAYS = 1
export const SIREN_MAX_PLAYS = 60
/** Plays used when no default count is configured. */
export const SIREN_FALLBACK_PLAYS = 5

export function secondsForPlays(plays: number, secondsPerPlay: number): number {
  return plays * secondsPerPlay
}

/** The play count that approximates `seconds`; at least one play, within the bounds. */
export function playsForSeconds(seconds: number, secondsPerPlay: number): number {
  const plays = Math.round(seconds / secondsPerPlay)
  return Math.min(SIREN_MAX_PLAYS, Math.max(SIREN_MIN_PLAYS, plays))
}

export function buildReolinkSirenOptions(input: {
  readonly configuredPlays: number | undefined
  readonly secondsPerPlay: number
  readonly nowMs: number
}): SirenOptions {
  const { secondsPerPlay } = input
  const defaultPlays =
    input.configuredPlays !== undefined && input.configuredPlays > 0
      ? input.configuredPlays
      : SIREN_FALLBACK_PLAYS
  return {
    allowedSeconds: null,
    rangeSeconds: {
      min: secondsForPlays(SIREN_MIN_PLAYS, secondsPerPlay),
      max: secondsForPlays(SIREN_MAX_PLAYS, secondsPerPlay),
      step: secondsPerPlay,
    },
    defaultSeconds: secondsForPlays(defaultPlays, secondsPerPlay),
    unit: 'plays',
    secondsPerPlay,
    source: 'fallback',
    fetchedAt: input.nowMs,
  }
}
