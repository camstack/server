/**
 * The ONE place an Amcrest clip becomes a `/cam/playback` URL.
 *
 * ## The camera addresses a clip by its TIME WINDOW and by nothing else
 *
 * Measured on 3836, 2026-09-23. Only `channel + starttime + endtime` exists:
 * `?channel=1&filename=<FilePath>` answers **404**, and the bare path form
 * `rtsp://…/mnt/sd/…mp4` answers **404**. `FilePath` is what `RPC_Loadfile`
 * takes and it is not an RTSP identity. That is the opposite of Hikvision,
 * whose replay is addressed by a file name, and it is why `clip-identity.ts`
 * mints a clip id from the window rather than from the path.
 *
 * ## The timestamps are the CAMERA's wall clock
 *
 * `starttime=2026_09_23_15_02_20`, underscore-separated, no zone. It is the
 * same local clock `mediaFileFind` stamps its rows with, so it goes through
 * the one measured offset (`clip-clock.ts`) exactly as the catalog does. A UTC
 * window would be two hours off in summer on this camera and would return the
 * WRONG FOOTAGE rather than an error.
 *
 * ## Why the credential is in the URL
 *
 * ffmpeg takes RTSP credentials nowhere else — there is no header option for
 * an RTSP digest, and the precedent in this repo is
 * `reolink-camera.ts`'s `rtsp://${user}:${password}@…`. It is built here, held
 * in the provider's own process, and handed straight to a spawn; it is never
 * logged. {@link describeReplayUrl} is what a log line is given instead, and
 * every line in this addon uses it.
 */
import { toCameraWallClock, type AmcrestCameraClock } from './clip-clock.js'

/** The camera's RTSP port. Fixed on this family; a device schema field would
 *  be a second authority for a number nothing has ever varied. */
export const AMCREST_RTSP_PORT = 554

/** An epoch instant as `/cam/playback` spells it: the camera's wall clock,
 *  underscore-separated. */
export function toReplayTimestamp(epochMs: number, clock: AmcrestCameraClock): string {
  return toCameraWallClock(epochMs, clock).replace(/[-: ]/g, '_')
}

export interface ReplayUrlInput {
  readonly host: string
  readonly username: string
  readonly password: string
  /** 1-based. `mediaFileFind` counts from 0, `/cam/playback` from 1. */
  readonly channel: number
  readonly startMs: number
  readonly endMs: number
  readonly clock: AmcrestCameraClock
  readonly port?: number
}

/**
 * The credentialled URL a spawn is given. Never logged — see
 * {@link describeReplayUrl}.
 */
export function buildReplayUrl(input: ReplayUrlInput): string {
  const user = encodeURIComponent(input.username)
  const pass = encodeURIComponent(input.password)
  const port = input.port ?? AMCREST_RTSP_PORT
  const start = toReplayTimestamp(input.startMs, input.clock)
  const end = toReplayTimestamp(input.endMs, input.clock)
  return (
    `rtsp://${user}:${pass}@${input.host}:${String(port)}/cam/playback` +
    `?channel=${String(input.channel)}&starttime=${start}&endtime=${end}`
  )
}

/**
 * The same URL with the credential removed, for a log line.
 *
 * A regex over the finished string rather than a second builder: two builders
 * is two chances for one of them to drift into printing the password, and the
 * one that prints is the one nobody reads until it is in a shipped log.
 */
export function describeReplayUrl(url: string): string {
  return url.replace(/^(rtsp:\/\/)[^@/]*@/, '$1')
}
