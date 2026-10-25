/**
 * The window a DETECTED sample's source frame is analysed through (D644).
 *
 * The photo analyze path runs SCRFD on its whole input at 640 px. A camera
 * face is small in a 4K frame (median 76 px native on the live hub, 10th
 * percentile 37 px), so on the whole frame it shrinks to 7–13 px — below the
 * landmark-precision floor, and no face is found. The window restores the
 * resolution the live detail plane gave the detector: a square
 * {@link FACE_SOURCE_WINDOW_FACTOR}× the face's long side, centred on it and
 * clamped into the frame. A 28 px face becomes a 112 px window, which the
 * detector sees at 640 px.
 *
 * This is NOT the live path, and "re-derive exactly" holds only for the
 * alignment: the template is still cut by the aligner from five landmarks,
 * but the detector's input framing here is a hub-side window, where the live
 * detail plane lets the RUNNER cut around the person (D52). The path is to
 * move to `runDetailSubtree({ frameJpeg })` on the runner; until then this
 * window is the interim, and it is only used for detected samples.
 *
 * Measured on the live hub (2026-09-26): the same window over a keyFrame gave
 * one face for 13 of 14 same-track pairs, centred within 8–46 px of the stored
 * box.
 */
import sharp from 'sharp'
import type { PhotoBbox, PhotoFace } from './photo-enrollment.js'

/** Window side as a multiple of the face's long side. */
const FACE_SOURCE_WINDOW_FACTOR = 4

/** A pixel rectangle on the source frame. */
export interface SourceWindow {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The window around `face` on a `frameWidth`×`frameHeight` frame. Pure. */
export function faceSourceWindow(
  face: PhotoBbox,
  frameWidth: number,
  frameHeight: number,
): SourceWindow {
  const side = Math.max(
    1,
    Math.min(
      Math.round(Math.max(face.width, face.height) * FACE_SOURCE_WINDOW_FACTOR),
      frameWidth,
      frameHeight,
    ),
  )
  const cx = face.x + face.width / 2
  const cy = face.y + face.height / 2
  const left = Math.max(0, Math.min(frameWidth - side, Math.round(cx - side / 2)))
  const top = Math.max(0, Math.min(frameHeight - side, Math.round(cy - side / 2)))
  return { left, top, width: side, height: side }
}

/** Put a face found in the window back into frame coordinates. Pure. */
function faceToFrame(face: PhotoFace, window: SourceWindow): PhotoFace {
  return {
    ...face,
    bbox: {
      x: face.bbox.x + window.left,
      y: face.bbox.y + window.top,
      width: face.bbox.width,
      height: face.bbox.height,
    },
  }
}

/**
 * Analyse the window around `face` on `frameJpeg` and answer in frame
 * coordinates, so the caller's IoU against the stored box stays meaningful.
 */
export async function analyzeFaceSourceWindow(
  frameJpeg: Buffer,
  face: PhotoBbox,
  analyze: (jpeg: Buffer) => Promise<readonly PhotoFace[]>,
): Promise<readonly PhotoFace[]> {
  const meta = await sharp(frameJpeg).metadata()
  const frameWidth = meta.width ?? 0
  const frameHeight = meta.height ?? 0
  if (frameWidth <= 0 || frameHeight <= 0) {
    throw new Error('the source frame decoded to no dimensions')
  }
  const window = faceSourceWindow(face, frameWidth, frameHeight)
  const cut = await sharp(frameJpeg).extract(window).jpeg({ quality: 95 }).toBuffer()
  return (await analyze(cut)).map((f) => faceToFrame(f, window))
}
