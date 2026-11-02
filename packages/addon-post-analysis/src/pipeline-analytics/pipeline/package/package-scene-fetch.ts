/**
 * One native zone crop for the packages scene path (D931).
 *
 * No `maxWidth`: a downscaled preview is not a scene. `ram-fullframe` is
 * refused by name. JPEG bytes are what the `llm` cap already takes.
 */

import type { FrameHandle, NativeCropCapResult } from '@camstack/types'
import { nodePin } from '@camstack/types'
import { decodeJpegToRgb, encodeRgbCropToJpeg } from '../../../shared/frame/encode-crop.js'

export interface PackageSceneCropBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface PackageSceneCropRequest {
  readonly deviceId: number
  readonly handle: FrameHandle
  readonly bbox: PackageSceneCropBox
}

export type PackageSceneCropFetch =
  | {
      readonly kind: 'ok'
      readonly width: number
      readonly height: number
      readonly luma: Uint8Array
      readonly chromaSpread: number
      readonly jpeg: Uint8Array
    }
  | { readonly kind: 'preview' }
  | { readonly kind: 'miss'; readonly reason: string }

export interface PackageSceneNativeQuery {
  (input: {
    readonly handle: FrameHandle
    readonly bbox: PackageSceneCropBox
    readonly acceptJpegBytes: true
    readonly encodeJpeg: true
    readonly pin: ReturnType<typeof nodePin>
  }): Promise<NativeCropCapResult | null>
}

export async function fetchPackageSceneCrop(
  query: PackageSceneNativeQuery,
  request: PackageSceneCropRequest,
): Promise<PackageSceneCropFetch> {
  try {
    const reply = await query({
      handle: request.handle,
      bbox: request.bbox,
      acceptJpegBytes: true,
      encodeJpeg: true,
      pin: nodePin(request.handle.nodeId),
    })
    if (reply === null) return { kind: 'miss', reason: 'no-crop' }
    return await cropOf(reply)
  } catch (err) {
    return {
      kind: 'miss',
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

async function cropOf(reply: NativeCropCapResult): Promise<PackageSceneCropFetch> {
  if (reply.tier === 'ram-fullframe') return { kind: 'preview' }
  if (reply.jpegBytes !== undefined && reply.jpegBytes.byteLength > 0) {
    const rgb = await decodeJpegToRgb(reply.jpegBytes)
    return okCrop(rgb.bytes, rgb.width, rgb.height, reply.jpegBytes)
  }
  if (reply.bytes !== undefined && reply.bytes.length === reply.width * reply.height * 3) {
    const jpeg = await encodeRgbCropToJpeg(reply.bytes, reply.width, reply.height)
    return okCrop(reply.bytes, reply.width, reply.height, jpeg)
  }
  return { kind: 'miss', reason: 'empty-crop' }
}

function okCrop(
  rgb: Uint8Array,
  width: number,
  height: number,
  jpeg: Uint8Array,
): PackageSceneCropFetch {
  return {
    kind: 'ok',
    width,
    height,
    luma: lumaFromRgb(rgb, width, height),
    chromaSpread: chromaSpreadFromRgb(rgb, width, height),
    jpeg: new Uint8Array(jpeg),
  }
}

/** Integer luma. The scene diff never sees chroma. */
export function lumaFromRgb(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const luma = new Uint8Array(width * height)
  const n = Math.min(luma.length, Math.floor(bytes.length / 3))
  for (let i = 0; i < n; i++) {
    const o = i * 3
    const r = bytes[o] ?? 0
    const g = bytes[o + 1] ?? 0
    const b = bytes[o + 2] ?? 0
    luma[i] = (77 * r + 150 * g + 29 * b) >> 8
  }
  return luma
}

/** The grid `IR_CHROMA_THRESHOLD` was calibrated on (`chromaSpread`, scene-crop.ts). */
const CHROMA_GRID = 32

/**
 * Mean of max(r,g,b) - min(r,g,b), 0..255, measured on a 32x32 box-averaged
 * copy of the crop: the same measure and grid as `chromaSpread` in
 * `scene-crop.ts` (which needs sharp), so `IR_CHROMA_THRESHOLD` means the same
 * thing. Averaging first matters: sensor noise and JPEG chroma speckle on an IR
 * frame cancel out, where per-pixel they read as colour.
 */
export function chromaSpreadFromRgb(bytes: Uint8Array, width: number, height: number): number {
  if (width <= 0 || height <= 0 || bytes.length < width * height * 3) return 0
  const gw = Math.min(CHROMA_GRID, width)
  const gh = Math.min(CHROMA_GRID, height)
  const sum = new Float64Array(gw * gh * 3)
  const count = new Float64Array(gw * gh)
  for (let y = 0; y < height; y++) {
    const cy = Math.min(gh - 1, Math.floor((y * gh) / height))
    for (let x = 0; x < width; x++) {
      const cx = Math.min(gw - 1, Math.floor((x * gw) / width))
      const cell = cy * gw + cx
      const o = (y * width + x) * 3
      sum[cell * 3] = (sum[cell * 3] ?? 0) + (bytes[o] ?? 0)
      sum[cell * 3 + 1] = (sum[cell * 3 + 1] ?? 0) + (bytes[o + 1] ?? 0)
      sum[cell * 3 + 2] = (sum[cell * 3 + 2] ?? 0) + (bytes[o + 2] ?? 0)
      count[cell] = (count[cell] ?? 0) + 1
    }
  }
  let total = 0
  let cells = 0
  for (let cell = 0; cell < gw * gh; cell++) {
    const n = count[cell] ?? 0
    if (n === 0) continue
    const r = (sum[cell * 3] ?? 0) / n
    const g = (sum[cell * 3 + 1] ?? 0) / n
    const b = (sum[cell * 3 + 2] ?? 0) / n
    total += Math.max(r, g, b) - Math.min(r, g, b)
    cells += 1
  }
  return cells === 0 ? 0 : total / cells
}
