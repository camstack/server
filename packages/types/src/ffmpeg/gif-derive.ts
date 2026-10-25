/**
 * The notification GIF's filter chain and argv — ONE definition for every
 * process that derives a gif from a notification video.
 *
 * ## Why this lives in `@camstack/types`
 *
 * Two addons derive a notification gif from an mp4, and they may never import
 * each other:
 *
 *  - the stream broker (`addon-pipeline`), from the clip it just cut out of its
 *    own ring (`gif-from-mp4.ts`);
 *  - the notification centre (`addon-post-analysis`), from a clip cut out of
 *    the RECORDINGS when the moment is older than any ring holds
 *    ([D682](../../../../docs/decisions/adr-0682-a-pick-ups-footage-is-cut-around-the-pick-up.md)).
 *
 * Two copies of this chain would be two gifs of the same kind of moment that
 * look different depending on how old the moment was — the class of defect
 * D85/D91 already paid for once. So the chain is here, pure and dependency
 * free, and each caller owns only its own process lifecycle.
 *
 * ## The palette was never the problem
 *
 * The `split` + `palettegen(stats_mode=diff)` + `paletteuse(bayer)` pair is
 * right and stays. The measured cause of "the gif looks de-pixellated" was a
 * 640×360 substream scaled DOWN to 480 px, upstream of the palette. The `split`
 * form is a single READ of the input, not a lesser two-pass.
 */

/**
 * Format a frame rate for an ffmpeg filter argument.
 *
 * `12 / 4` must reach the filter as `3` and `15 / 4` as `3.75`, not as a float
 * tail that `av_parse_video_rate` then has to guess at.
 */
export function ffmpegRate(rate: number): string {
  return String(Math.round(rate * 1000) / 1000)
}

/**
 * The factor the derive must apply ON TOP of the speed the mp4 already carries.
 *
 * The gif is derived from a muxed mp4, so if that mux already ran `setpts` at
 * the caller's `speed`, applying the absolute gif rate again would compound
 * them — a 4× gif beside a 2× video would come out at 8×. Discounting here is
 * what keeps the gif rate ABSOLUTE against real time whatever the video does.
 */
export function gifDeriveSpeed(gifSpeed: number, videoSpeed: number): number {
  if (!Number.isFinite(videoSpeed) || videoSpeed <= 0) return gifSpeed
  return gifSpeed / videoSpeed
}

/** What shapes one gif derive. */
export interface GifDeriveShape {
  readonly maxWidth: number
  /** The gif's PLAYBACK frame rate. */
  readonly fps: number
  /** The rate applied by THIS derive, on top of what the mp4 carries. */
  readonly speed: number
}

/** The argv input: a streamable mp4 on stdin (the default) or a file path. */
export interface GifDeriveArgsInput extends GifDeriveShape {
  /** `pipe:0` when absent. A file path for an mp4 that is not streamable. */
  readonly input?: string
}

/**
 * The filter chain. Extracted so a test can assert the palette pair without
 * spawning ffmpeg — an argv test cannot see quality, but it can see a filter
 * that somebody deleted.
 *
 * `fps` BEFORE `setpts`: decimating an already sped-up timeline yields `speed`
 * times the frames asked for, and a gif pays for every one. So the decimation
 * runs at `fps / speed` in SOURCE time and `setpts` multiplies what survived.
 * The trailing `fps` re-declares the rate, which is NOT redundant: `setpts`
 * leaves the filter link advertising the sampled rate and the gif muxer
 * believes the link — measured on 101 as a 3.01 s gif of ten frames.
 */
export function gifFilterComplex(input: GifDeriveShape): string {
  const speed = input.speed > 0 ? input.speed : 1
  if (speed === 1) {
    return (
      `[0:v]fps=${ffmpegRate(input.fps)},scale=${input.maxWidth}:-2:flags=lanczos,split[a][b];` +
      `[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
    )
  }
  const sampleFps = ffmpegRate(input.fps / speed)
  return (
    `[0:v]fps=${sampleFps},setpts=PTS/${speed},fps=${ffmpegRate(input.fps)},` +
    `scale=${input.maxWidth}:-2:flags=lanczos,split[a][b];` +
    `[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`
  )
}

/** The full argv: mp4 in, gif on stdout. */
export function gifFromMp4Args(input: GifDeriveArgsInput): readonly string[] {
  return [
    '-y',
    '-v',
    'error',
    '-f',
    'mp4',
    '-i',
    input.input ?? 'pipe:0',
    '-filter_complex',
    gifFilterComplex(input),
    '-loop',
    '0',
    '-f',
    'gif',
    'pipe:1',
  ]
}
