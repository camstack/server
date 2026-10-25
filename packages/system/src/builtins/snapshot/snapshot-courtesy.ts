/**
 * State treatment for a camera that cannot produce a current frame.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * A disabled, offline or sleeping camera has no frame, and until 2026-08-11 the
 * snapshot service simply had nothing to say about it: the media route answered
 * **404** and the client painted "Unavailable". Measured on the live grid that
 * day, 10 of 26 tiles were 404s — one genuinely disabled camera plus nine dead
 * legacy rows. A 404 is indistinguishable from a broken camera, so an operator
 * who deliberately switched a camera off saw the same thing as a fault ([D62]:
 * "an off switch is REPORTED off; disabled must never look like broken").
 *
 * So the service answers with an image that SAYS what is going on, carrying
 * the camera's own name. When a real cached frame exists it remains visible
 * under the treatment; otherwise the generated courtesy background is used.
 *
 * ── Why sharp and not ffmpeg ──────────────────────────────────────────────
 * The first draft of this file shelled out to `ffmpeg` with a `drawtext`
 * filter. That was written before the resize path was measured, and it was the
 * wrong call for the same reason: this runs in the snapshot wrapper, a system
 * builtin loaded in the hub's ROOT process, so every render was a fork + exec
 * on the loop that serves the API — 52 ms against sharp's 4.8 ms in that
 * container, to draw two lines of text.
 *
 * `terminal-frame-renderer.ts` already renders text this way (SVG → sharp), so
 * this is the house pattern rather than a new one. It also drops the font-PATH
 * probing the ffmpeg version needed: an SVG names a font FAMILY and fontconfig
 * resolves it — verified in the hub image, where `fc-match "DejaVu Sans Mono"`
 * answers with the real file.
 *
 * Rendering is pure input → bytes with no I/O of its own, and the geometry and
 * escaping are separated out so they stay testable without rasterizing.
 */
import sharp from 'sharp'

/**
 * Why a camera cannot produce a frame right now.
 *
 * `sleeping` and `unreachable` are deliberately two reasons and not one. A
 * battery camera in low-power mode is WORKING — that tile must not read as a
 * fault, which is D62's rule in the third state — while a battery camera
 * nothing has been heard from for hours is a genuine fault the operator has to
 * see (a flat battery, or a camera off the LAN). Painting the second as the
 * first is how a dead camera stayed green for 30 hours. The two are separated
 * by `deriveBatteryPresence`, never by a caller's own guess.
 */
export type CourtesyReason = 'disabled' | 'offline' | 'sleeping' | 'unreachable' | 'waking'

/** Default tile size when the caller asks for no particular width. */
export const COURTESY_DEFAULT_WIDTH = 640

/**
 * Font stack for the rendered text. Family names, not paths — librsvg resolves
 * them through fontconfig, and the trailing generics keep a host without DejaVu
 * rendering something legible instead of nothing.
 */
const COURTESY_FONT_STACK = 'DejaVu Sans,DejaVu Sans Mono,Helvetica,Arial,sans-serif'

/** The word the frame carries. Deliberately the operator's vocabulary. */
export function courtesyLabel(reason: CourtesyReason): string {
  switch (reason) {
    case 'disabled':
      return 'Disabled'
    case 'offline':
      return 'Offline'
    case 'sleeping':
      return 'Sleeping'
    case 'unreachable':
      return 'Unreachable'
    case 'waking':
      return 'Waking'
  }
}

/**
 * Background per reason. A disabled camera is a DELIBERATE state and must not
 * read as an alarm, so it is neutral grey; offline is a fault and is warmer.
 */
export function courtesyBackground(reason: CourtesyReason): string {
  switch (reason) {
    case 'disabled':
      return '#2b2b31'
    case 'offline':
      return '#3a2b2b'
    case 'sleeping':
      return '#232b3a'
    case 'waking':
      return '#243247'
    // A battery camera nothing has been heard from IS a fault — same warm
    // ground as `offline`, never the calm blue of a healthy sleeper.
    case 'unreachable':
      return '#3a2b2b'
  }
}

/** XML escaping for text placed inside an SVG `<text>` node. */
export function escapeCourtesyText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export interface CourtesyFrameSpec {
  readonly deviceName: string
  readonly reason: CourtesyReason
  readonly width: number
  readonly height: number
}

/**
 * The SVG the frame is rasterized from: the state large and centred, the
 * camera's name under it, smaller and dimmer.
 *
 * Sizes derive from the width so a 240 px grid tile and a 1920 px full-bleed
 * frame read the same, with a floor so a thumbnail stays legible.
 */
export function buildCourtesySvg(spec: CourtesyFrameSpec): string {
  return buildStateSvg(spec)
}

/**
 * The state treatment for a frame that HAS a picture under it: a band along the
 * bottom, and nothing else touched.
 *
 * It was a full-frame wash at 0.62 opacity, under a docblock claiming the frame
 * "remains visible underneath". A 38 % view of a dark room is not a view of it,
 * and the operator read the result as a placeholder rather than as their own
 * camera: *"ma perché Waking? Dovremmo mostrare l'ultimo snapshot
 * disponibile"* [but why Waking? We should show the last available snapshot] (Baby monitor, 2026-09-16).
 *
 * The marker still has to earn its place — a stale frame shown clean gets
 * mistaken for live, which is the reason the treatment exists at all. A band
 * says the same thing a wash said. Covering the picture was never the message.
 */
export function buildCourtesyOverlaySvg(spec: CourtesyFrameSpec): string {
  const state = escapeCourtesyText(courtesyLabel(spec.reason))
  const name = escapeCourtesyText(spec.deviceName)
  // Sized off the WIDTH, like the card's text, so a tile and a full frame read
  // alike — and floored, because a thumbnail's band still has to be legible.
  const stateSize = Math.max(11, Math.round(spec.width / 34))
  const bandHeight = Math.max(26, Math.round(stateSize * 2.2))
  const bandTop = Math.max(0, spec.height - bandHeight)
  // The band is nearly opaque where it IS — it is a label, and a label you can
  // read through is not one. What matters is that it is only a band.
  const baselineY = Math.round(bandTop + bandHeight * 0.68)
  const textStroke = Math.max(1, Math.round(spec.width / 320))
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(spec.width)}" height="${String(spec.height)}">`,
    `<rect x="0" y="${String(bandTop)}" width="${String(spec.width)}" height="${String(bandHeight)}" fill="${courtesyBackground(spec.reason)}" fill-opacity="0.82"/>`,
    `<g font-family="${COURTESY_FONT_STACK}" text-anchor="middle" paint-order="stroke" stroke="#111118" stroke-width="${String(textStroke)}">`,
    `<text x="50%" y="${String(baselineY)}" font-size="${String(stateSize)}" fill="#e8e8ee">${state}`,
    `<tspan fill="#9a9aa8"> · ${name}</tspan>`,
    `</text></g></svg>`,
  ].join('')
}

/**
 * The GENERATED card: no picture exists, so this IS the picture. Opaque by
 * necessity — anything translucent here shows black through it.
 */
function buildStateSvg(spec: CourtesyFrameSpec): string {
  const stateSize = Math.max(12, Math.round(spec.width / 12))
  const nameSize = Math.max(9, Math.round(spec.width / 26))
  const state = escapeCourtesyText(courtesyLabel(spec.reason))
  const name = escapeCourtesyText(spec.deviceName)
  const midY = spec.height / 2
  const textStroke = Math.max(1, Math.round(spec.width / 320))
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(spec.width)}" height="${String(spec.height)}">`,
    `<rect width="100%" height="100%" fill="${courtesyBackground(spec.reason)}" fill-opacity="1"/>`,
    `<g font-family="${COURTESY_FONT_STACK}" text-anchor="middle" paint-order="stroke" stroke="#111118" stroke-width="${String(textStroke)}">`,
    `<text x="50%" y="${String(Math.round(midY))}" font-size="${String(stateSize)}" fill="#e8e8ee">${state}</text>`,
    `<text x="50%" y="${String(Math.round(midY + stateSize))}" font-size="${String(nameSize)}" fill="#9a9aa8">${name}</text>`,
    `</g></svg>`,
  ].join('')
}

/** Cache key — a courtesy frame is a pure function of these four. */
export function courtesyCacheKey(spec: CourtesyFrameSpec): string {
  return `${spec.reason}:${String(spec.width)}x${String(spec.height)}:${spec.deviceName}`
}

/**
 * Render the frame.
 *
 * Rejects on failure — the caller decides what to do, exactly as `resizeJpeg`
 * does, so a broken courtesy path is never mistaken for a broken camera.
 */
export function renderCourtesyJpeg(spec: CourtesyFrameSpec): Promise<Buffer> {
  return sharp(Buffer.from(buildCourtesySvg(spec)))
    .jpeg({ quality: 82 })
    .toBuffer()
    .then((bytes) => {
      if (bytes.length === 0) throw new Error('courtesy frame produced no bytes')
      return bytes
    })
}

/**
 * Paint the state treatment over a real cached frame.
 *
 * The source dimensions are authoritative: overlays preserve the original
 * frame rather than resizing it to the generated courtesy-frame default.
 */
export async function renderCourtesyOverlayJpeg(
  background: Buffer,
  spec: Pick<CourtesyFrameSpec, 'deviceName' | 'reason'>,
): Promise<Buffer> {
  const metadata = await sharp(background).metadata()
  if (!metadata.width || !metadata.height) {
    throw new Error('cached snapshot has no renderable dimensions')
  }
  const overlay = Buffer.from(
    buildCourtesyOverlaySvg({
      ...spec,
      width: metadata.width,
      height: metadata.height,
    }),
  )
  const bytes = await sharp(background)
    .composite([{ input: overlay }])
    .jpeg({ quality: 82 })
    .toBuffer()
  if (bytes.length === 0) throw new Error('courtesy overlay produced no bytes')
  return bytes
}
