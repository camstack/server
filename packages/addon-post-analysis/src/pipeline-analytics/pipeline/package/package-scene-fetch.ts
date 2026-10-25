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
    return { kind: 'miss', reason: err instanceof Error ? err.message : String(err) }
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
