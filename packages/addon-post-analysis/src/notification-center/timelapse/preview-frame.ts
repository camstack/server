/**
 * The timelapse PREVIEW frame: one still out of the finished video, titled.
 *
 * The operator's ask, verbatim: the timelapse notification must carry a
 * preview image *"come per le altre rule"* [as for the other rules] — every detection rule's card shows
 * a picture, and a timelapse's showed nothing but text. A notification with no
 * image is a notification you have to open to understand.
 *
 * Three decisions worth the words:
 *
 *  - **The frame comes out of the RENDERED timelapse, not out of live
 *    footage.** A still taken at delivery time shows the camera *now* — 06:05,
 *    daylight, an empty driveway — under a card that claims to be about last
 *    night. A frame of the video itself is the only picture that cannot
 *    contradict the video. It is the MIDDLE frame ({@link previewFrameSeekSec})
 *    because frame 0 is the instant the window opened, which is the least
 *    representative frame in it.
 *
 *  - **The middle frame is the BLURRED BACKGROUND and the title is large and
 *    centred on top** — the advanced-notifier look. The first shipped version
 *    drew a bottom caption bar: at notification-card size the strip is a
 *    footnote you squint at, and it hid the bottom eighth of the only picture
 *    the card has. A blurred frame reads as *this camera, this night* at a
 *    glance and gives the title a background nothing can compete with. The
 *    blur exists ONLY to make the title pop, so an empty `previewText` ships
 *    the plain, unblurred frame — blurring a picture nobody is writing over is
 *    strictly a loss.
 *
 *  - **The title is drawn by sharp compositing an inline SVG, not by ffmpeg
 *    `drawtext`.** `drawtext` needs libfreetype compiled in AND a font file
 *    that exists on that node: the two ffmpeg builds present on the live hub
 *    disagree about it (`/usr/bin/ffmpeg` 6.1.1 has the filter,
 *    `/data/deps/ffmpeg` 7.0.2-static does not), so a preview would appear or
 *    vanish depending on which binary a node resolved. sharp is already this
 *    package's image dependency and already draws labelled overlays this exact
 *    way in `shared/frame/box-drawer.ts` — an SVG composited with `sharp`,
 *    no font file anywhere.
 *
 * NOTHING here throws. A preview is an enhancement; a window that failed to
 * produce one must still deliver its video, and must say in the log which of
 * the steps declined.
 */
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import type { IScopedLogger } from '@camstack/types'
import sharp from 'sharp'
import { readMp4DurationMs } from './mp4-duration.js'

/** Widest preview a notification card ever needs. Bigger costs bytes on every
 *  delivery and buys nothing on a phone. */
export const PREVIEW_FRAME_MAX_WIDTH = 960
/** JPEG quality for the captioned still. */
const PREVIEW_FRAME_QUALITY = 82
/** Title size as a fraction of the frame WIDTH — so it reads the same on a
 *  360p `low` render and on a 1080p `main` one. ~1/12: 80 px on a 960 px
 *  frame, which is a title. The caption bar it replaced drew 40 px there. */
const TITLE_FONT_FRACTION = 1 / 12
/** Below this the title is unreadable rather than fitted; past it, elide. */
export const TITLE_MIN_FONT_PX = 14
/** A title never becomes a paragraph. Two lines, then the ellipsis. */
export const TITLE_MAX_LINES = 2
/** Share of the width the title may occupy — the rest is side margin. */
const TITLE_USABLE_FRACTION = 0.86
/** A title also never eats the frame vertically, however wide the frame is. */
const TITLE_MAX_HEIGHT_FRACTION = 0.22
/** Distance between baselines, as a multiple of the font size. */
const TITLE_LINE_HEIGHT = 1.18
/**
 * Average glyph advance as a fraction of the font size, for bold DejaVu Sans
 * at the sizes used here.
 *
 * An SVG overlay cannot measure text — librsvg lays it out after this string is
 * written — so the fit has to be estimated. It is deliberately generous: a
 * title that shrinks slightly more than it had to is invisible, one that
 * over-estimates its fit runs off the edge, which is exactly what the first
 * live preview did (`Timelapse Camera front door 21:00→07:00` touched the
 * frame border at 640 px).
 */
const TITLE_GLYPH_ADVANCE = 0.62
/** How far the dark shadow copy of each line sits behind the white one. */
const TITLE_SHADOW_FRACTION = 0.06
const TITLE_SHADOW_OPACITY = 0.55
/** The scrim over the blurred frame. Enough that white always reads over a
 *  daylight frame, little enough that the picture is still a picture. */
const TITLE_SCRIM_OPACITY = 0.38
/** Each shrink step while the title still needs more than {@link
 *  TITLE_MAX_LINES} lines. */
const TITLE_SHRINK_STEP = 0.9

/** Blur radius as a fraction of the frame width, so a 480 px and a 1920 px
 *  preview are blurred to the same DEGREE and not by the same pixels. */
const BLUR_WIDTH_DIVISOR = 96
/** Below this the frame stops reading as a photograph of anything. */
export const PREVIEW_BLUR_SIGMA_MIN = 4
/** Above this it is mush, and sharp spends real time on it. */
export const PREVIEW_BLUR_SIGMA_MAX = 12

/** Hard bound on one extraction: a stuck ffmpeg must never hold a delivery. */
const PREVIEW_FRAME_TIMEOUT_MS = 20_000

/** Where in the finished video the representative frame lives. */
export function previewFrameSeekSec(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0
  return durationSec / 2
}

export interface PreviewFrameArgsInput {
  readonly inputPath: string
  readonly atSec: number
  /** Cap on the extracted frame's width. Defaults to
   *  {@link PREVIEW_FRAME_MAX_WIDTH}; the animated preview passes its own,
   *  smaller cap, because a dozen 960 px frames is not an attachment. */
  readonly maxWidth?: number
}

/**
 * ffmpeg argv for "one JPEG from this mp4, on stdout".
 *
 * `-ss` goes BEFORE `-i` deliberately: an input seek lands on the nearest
 * keyframe at or before the offset without decoding what precedes it. After
 * `-i` it is an output seek, which decodes the whole file to get there.
 */
export function buildPreviewFrameArgs(input: PreviewFrameArgsInput): readonly string[] {
  const maxWidth = input.maxWidth ?? PREVIEW_FRAME_MAX_WIDTH
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-ss',
    String(Math.max(0, input.atSec)),
    '-i',
    input.inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${maxWidth},iw)':-2`,
    '-f',
    'image2',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ]
}

/**
 * The finished video's duration, in seconds, read from its OWN bytes — or `0`
 * when they carry none (the seek then lands on frame 0: a worse picture, not a
 * missing one).
 *
 * Needed because the MIDDLE of the video is not derivable from the rule: the
 * frame-select predicate keeps a frame when the cadence has ELAPSED since the
 * last one it kept, so a window with gaps in its footage yields fewer frames
 * than `windowSec / cadenceSec` — live, a 10 h window at 30 s produced 576
 * frames where the arithmetic says 1,200. A wrong seek is an empty preview.
 *
 * A byte-walk of `mvhd`, not an `ffprobe`: the bytes are already in memory, and
 * the pinned build this node downloads provisions `ffmpeg` only — an `ffprobe`
 * could only ever have come from the host's PATH, which D540 forbids.
 */
export function previewDurationSec(mp4: Uint8Array): number {
  const ms = readMp4DurationMs(mp4)
  return ms === null ? 0 : ms / 1000
}

/** `<`, `>`, `&`, `'` and `"` in an operator's free-text caption would each
 *  turn the overlay into a document librsvg refuses. */
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) => {
    switch (ch) {
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '&':
        return '&amp;'
      case "'":
        return '&apos;'
      default:
        return '&quot;'
    }
  })
}

/** How hard to blur the background frame of a preview this wide. */
export function previewBlurSigma(frameWidth: number): number {
  const scaled = Math.round(Math.max(0, frameWidth) / BLUR_WIDTH_DIVISOR)
  return Math.min(PREVIEW_BLUR_SIGMA_MAX, Math.max(PREVIEW_BLUR_SIGMA_MIN, scaled))
}

/** A title laid out for the frame it will be drawn on. */
export interface FittedTitle {
  readonly lines: readonly string[]
  readonly fontPx: number
}

/** Break a word too long for one line into line-width pieces. Without this a
 *  single 200-character token wraps to nothing and overflows both edges. */
function chunk(word: string, size: number): readonly string[] {
  const pieces: string[] = []
  for (let i = 0; i < word.length; i += size) pieces.push(word.slice(i, i + size))
  return pieces
}

/** Greedy word wrap at a character budget — the only measurement available,
 *  since librsvg lays the text out long after this string is written. */
function wrapLines(text: string, maxChars: number): readonly string[] {
  const words = text.split(' ').filter((w) => w.length > 0)
  return words.reduce<readonly string[]>(
    (lines, word) =>
      (word.length > maxChars ? chunk(word, maxChars) : [word]).reduce<readonly string[]>(
        (acc, piece) => {
          const last = acc.at(-1)
          if (last === undefined) return [piece]
          const merged = `${last} ${piece}`
          return merged.length <= maxChars ? [...acc.slice(0, -1), merged] : [...acc, piece]
        },
        lines,
      ),
    [],
  )
}

/**
 * Lay a title out over the frame: wrap, then shrink, then elide.
 *
 * `previewText` is operator free text up to 200 characters and the overlay
 * cannot measure it, so the width is ESTIMATED and the estimate is generous —
 * a title that shrank a little more than it had to is invisible, one that
 * overflowed runs off the edge. The first live preview did exactly that.
 *
 * Shrinking stops at {@link TITLE_MIN_FONT_PX}; past that the tail is cut with
 * an ellipsis rather than drawn at an unreadable size.
 */
export function fitTitle(text: string, frameWidth: number, frameHeight = 0): FittedTitle {
  const flat = text.trim().replace(/\s+/g, ' ')
  const byWidth = Math.round(frameWidth * TITLE_FONT_FRACTION)
  const byHeight =
    frameHeight > 0 ? Math.round(frameHeight * TITLE_MAX_HEIGHT_FRACTION) : Number.MAX_SAFE_INTEGER
  const base = Math.max(TITLE_MIN_FONT_PX, Math.min(byWidth, byHeight))
  const usable = Math.max(1, Math.round(frameWidth * TITLE_USABLE_FRACTION))
  const budget = (fontPx: number): number =>
    Math.max(1, Math.floor(usable / (fontPx * TITLE_GLYPH_ADVANCE)))

  const fitted = (function shrink(fontPx: number): FittedTitle {
    const lines = wrapLines(flat, budget(fontPx))
    if (lines.length <= TITLE_MAX_LINES || fontPx <= TITLE_MIN_FONT_PX) return { lines, fontPx }
    return shrink(Math.max(TITLE_MIN_FONT_PX, Math.floor(fontPx * TITLE_SHRINK_STEP)))
  })(base)

  if (fitted.lines.length <= TITLE_MAX_LINES) return fitted
  const kept = fitted.lines.slice(0, TITLE_MAX_LINES)
  const last = kept.at(-1) ?? ''
  return {
    fontPx: fitted.fontPx,
    lines: [...kept.slice(0, -1), `${last.slice(0, Math.max(1, last.length - 1))}…`],
  }
}

export interface TitleSvgInput {
  readonly width: number
  readonly height: number
  readonly title: FittedTitle
}

/**
 * The overlay: a full-frame scrim, then every line centred on both axes.
 *
 * Centring is `text-anchor="middle"` at the frame's horizontal midpoint — it
 * needs no text metrics, so a line the estimate mis-measured is still centred
 * rather than pushed off one edge. Each line is drawn TWICE, an offset dark
 * copy first: a white title over a bright blurred frame otherwise disappears
 * into it, and librsvg's filter support is not worth betting a preview on.
 */
export function buildTitleSvg(input: TitleSvgInput): string {
  const { width, height } = input
  const { lines, fontPx } = input.title
  const lineHeight = Math.round(fontPx * TITLE_LINE_HEIGHT)
  const top = Math.round((height - lineHeight * lines.length) / 2)
  const shadow = Math.max(1, Math.round(fontPx * TITLE_SHADOW_FRACTION))
  const cx = Math.round(width / 2)
  // Same stack as snapshot-courtesy: family names for fontconfig (DejaVu is
  // what the hub image ships). A bare `sans-serif` with no fonts installed
  // drew every glyph as tofu on the morning timelapse stills.
  const font = `font-size="${fontPx}" font-family="DejaVu Sans,Helvetica,Arial,sans-serif" font-weight="bold" text-anchor="middle"`
  const texts = lines
    .map((line, i) => {
      const y = top + lineHeight * i + Math.round(fontPx * 0.8)
      const esc = escapeXml(line)
      return [
        `  <text x="${cx + shadow}" y="${y + shadow}" ${font} fill="black" fill-opacity="${TITLE_SHADOW_OPACITY}">${esc}</text>`,
        `  <text x="${cx}" y="${y}" ${font} fill="white">${esc}</text>`,
      ].join('\n')
    })
    .join('\n')
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="black" fill-opacity="${TITLE_SCRIM_OPACITY}"/>
${texts}
</svg>`
}

/**
 * Blur the frame and draw `text` large and centred over it.
 *
 * @returns the titled JPEG; the INPUT buffer verbatim — plain and UNBLURRED —
 *          when the title is empty (the operator's "frame, no title": the blur
 *          exists only to make a title pop); `null` only when sharp could not
 *          read the frame at all — logged, never thrown.
 */
export async function drawPreviewTitle(
  jpeg: Buffer,
  text: string,
  logger: IScopedLogger,
  tags?: { readonly deviceId: number },
): Promise<Buffer | null> {
  if (text.trim().length === 0) return jpeg
  try {
    const meta = await sharp(jpeg).metadata()
    const width = meta.width ?? 0
    const height = meta.height ?? 0
    if (width === 0 || height === 0) {
      logger.warn('timelapse preview title skipped: frame has no dimensions', {
        ...(tags !== undefined ? { tags } : {}),
      })
      return null
    }
    const svg = buildTitleSvg({ width, height, title: fitTitle(text, width, height) })
    return await sharp(jpeg)
      .blur(previewBlurSigma(width))
      .composite([{ input: Buffer.from(svg), top: 0, left: 0, blend: 'over' }])
      .jpeg({ quality: PREVIEW_FRAME_QUALITY })
      .toBuffer()
  } catch (err: unknown) {
    logger.warn('timelapse preview title failed — shipping the bare frame', {
      ...(tags !== undefined ? { tags } : {}),
      meta: { error: String(err) },
    })
    return null
  }
}

/** One child-process run, as a function: stdout bytes, or null on any failure
 *  (missing binary, non-zero exit, timeout). Injected so the orchestration
 *  below is testable without ffmpeg on the machine running the suite. */
export type RunCommand = (cmd: string, args: readonly string[]) => Promise<Buffer | null>

/** Widest stdout one preview may produce. A 960 px JPEG is ~200 KB; this is
 *  headroom, not a budget. */
const RUN_MAX_BUFFER = 16 * 1024 * 1024

/**
 * The production {@link RunCommand}: `execFile`, bounded, stdout as bytes.
 *
 * `null` on EVERY failure mode — ENOENT (no ffmpeg on this node), a non-zero
 * exit, or the timeout — because the caller's answer to all three is the same:
 * ship the notification without a picture, and say so in the log.
 */
export const execFileCapturingStdout: RunCommand = async (cmd, args) =>
  new Promise<Buffer | null>((resolve) => {
    execFile(
      cmd,
      [...args],
      { encoding: 'buffer', maxBuffer: RUN_MAX_BUFFER, timeout: PREVIEW_FRAME_TIMEOUT_MS },
      (err, stdout) => resolve(err !== null ? null : stdout),
    )
  })

export interface TimelapsePreviewPorts {
  readonly logger: IScopedLogger
  readonly run: RunCommand
  /** Write the mp4 somewhere seekable and answer the path; the caller removes
   *  it. A pipe cannot be used: `-ss` before `-i` needs to seek. */
  readonly writeTemp: (bytes: Uint8Array) => Promise<string>
  readonly removeTemp: (path: string) => Promise<void>
  /**
   * The pinned ffmpeg for THIS node — `ctx.deps.ensureFfmpeg()`, never a name
   * looked up on PATH (D540). REQUIRED, with no default: an optional path that
   * fell back to `'ffmpeg'` is exactly how this preview spawned the host's
   * binary while every other video path ran ours. A rejection is a refusal,
   * logged per camera by {@link resolvePreviewFfmpeg}.
   */
  readonly resolveFfmpeg: () => Promise<string>
}

/** Device tags every preview log line carries. A type alias, not an
 *  interface: it must be assignable to the logger's indexed `LogTags`. */
export type PreviewLogTags = { readonly deviceId: number }

/**
 * The pinned binary, or `null` after an ERROR naming why there is none.
 *
 * Asked FIRST, before the video is staged: the cheap question comes before the
 * work it gates. There is no fallback — a node that cannot be given OUR ffmpeg
 * ships the notification without a picture and says so, rather than running
 * whatever the host happens to carry.
 */
export async function resolvePreviewFfmpeg(
  ports: TimelapsePreviewPorts,
  tags: PreviewLogTags,
  what: 'timelapse preview' | 'timelapse gif',
): Promise<string | null> {
  try {
    return await ports.resolveFfmpeg()
  } catch (err: unknown) {
    ports.logger.error(
      `${what} refused: the pinned ffmpeg could not be resolved on this node (never PATH — D540)`,
      { tags, meta: { error: String(err) } },
    )
    return null
  }
}

export interface TimelapsePreviewRequest {
  readonly mp4: Uint8Array
  /** Already-rendered title ('' ⇒ the plain, unblurred frame). */
  readonly text: string
  readonly deviceId: number
}

/**
 * Finished mp4 → titled JPEG.
 *
 * Never throws and never leaves the temp file behind. Every `null` return has
 * a log line naming which step declined, per camera — "the notification had no
 * image" is asked about ONE camera, and a line that cannot be grouped by
 * `deviceId` cannot answer it.
 */
export async function renderTimelapsePreview(
  ports: TimelapsePreviewPorts,
  request: TimelapsePreviewRequest,
): Promise<Buffer | null> {
  const tags = { deviceId: request.deviceId }
  const ffmpeg = await resolvePreviewFfmpeg(ports, tags, 'timelapse preview')
  if (ffmpeg === null) return null
  let path: string
  try {
    path = await ports.writeTemp(request.mp4)
  } catch (err: unknown) {
    ports.logger.warn('timelapse preview skipped: could not stage the video', {
      tags,
      meta: { error: String(err) },
    })
    return null
  }
  try {
    // An unreadable duration costs the MIDDLE frame, never the preview: frame
    // 0 is a worse picture, not a missing one.
    const durationSec = previewDurationSec(request.mp4)
    const atSec = previewFrameSeekSec(durationSec)
    if (durationSec === 0) {
      ports.logger.debug(
        'timelapse preview: the video carries no duration — taking the first frame',
        {
          tags,
        },
      )
    }
    const frame = await ports.run(ffmpeg, buildPreviewFrameArgs({ inputPath: path, atSec }))
    if (frame === null || frame.byteLength === 0) {
      ports.logger.warn('timelapse preview skipped: no frame could be extracted', {
        tags,
        meta: { atSec },
      })
      return null
    }
    // A title that fails costs the TEXT, never the picture.
    return (await drawPreviewTitle(frame, request.text, ports.logger, tags)) ?? frame
  } finally {
    await ports.removeTemp(path).catch(() => {})
  }
}
