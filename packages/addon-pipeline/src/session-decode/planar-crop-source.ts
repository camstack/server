/**
 * Where a software native crop READS from — the plane views and strides a
 * libswscale crop is fed, for each pixel format a retained frame can arrive in.
 *
 * ## Why this exists
 *
 * The native-crop / subject-tile cutter offsets the retained frame's plane
 * pointers to the crop origin and scales ONLY that ROI (zero-copy, no full-frame
 * copy). That math was written inline against **YUV420P** — three planes, both
 * chroma planes half-width and half-height — and any other layout hit a
 * `!yPlane || !uPlane || !vPlane` guard and threw.
 *
 * That is exactly what happened on dev:102 (macmini, videotoolbox): a frame with
 * two planes threw `retained frame missing planar YUV420P data` for every
 * subject of every frame — 533 failures across a handful of sessions, a tile
 * tier that could never cut, and a message that never named the format it had
 * actually been given.
 *
 * ## What NV12 needs, and why it costs nothing extra
 *
 * NV12 is Y plus ONE plane of interleaved (U,V) pairs at half resolution. It is
 * a source format libswscale reads natively, so supporting it is not a
 * conversion pass and not a de-interleave: it is the correct plane offsets and
 * the right `AV_PIX_FMT_*` on the scaler. One sws call, identical to the
 * YUV420P path — which matters because this runs per subject per frame.
 *
 * The chroma byte offset is the part worth stating: a chroma COLUMN in NV12 is
 * two bytes wide (U then V), so the horizontal byte offset for an even `left` is
 * `left / 2 * 2 = left` — not `left / 2` as in YUV420P. Getting that wrong does
 * not throw; it shifts the colour of every tile by half the crop's x offset.
 *
 * Kept pure and node-av-free so the offsets are unit-testable without a decoder,
 * and so the ONE derivation is shared by every caller instead of copied.
 */

/** The retained pixel layouts the software crop path can read. */
export type PlanarCropKind = 'yuv420p' | 'nv12'

/** Every source layout the native-crop scaler cache must keep apart. */
export type NativeCropSourceFormat = PlanarCropKind | 'rgb24'

/** Pixel-format constants the software ROI path needs — a slice of node-av. */
export interface SoftwareRoiPixFmts {
  readonly AV_PIX_FMT_YUV420P: number
  readonly AV_PIX_FMT_NV12: number
  readonly AV_PIX_FMT_RGB24: number
}

/** Layout a detection `toBuffer` can read, or `null` when it must name the
 *  format and refuse. RGB24 is the VAAPI `pinnedRgbCrop` lease; NV12 is the
 *  videotoolbox download. The old path only accepted 3-plane YUV420P. */
export function softwareRoiKind(
  format: number,
  C: SoftwareRoiPixFmts,
): NativeCropSourceFormat | null {
  if (format === C.AV_PIX_FMT_RGB24) return 'rgb24'
  if (format === C.AV_PIX_FMT_YUV420P) return 'yuv420p'
  if (format === C.AV_PIX_FMT_NV12) return 'nv12'
  return null
}

/** The crop origin + size, in source-frame pixels (see `crop-geometry.ts`). */
export interface PlanarCropRegion {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** Zero-copy plane views at the crop origin, plus the strides to read them at. */
export interface PlanarCropSource {
  readonly planes: readonly Uint8Array[]
  readonly strides: readonly number[]
}

/** How many planes each layout must present before the offsets mean anything. */
const PLANE_COUNT: Readonly<Record<PlanarCropKind, number>> = {
  yuv420p: 3,
  nv12: 2,
}

/**
 * Cache tag for a native-crop scaler's SOURCE format. `yuv420p` is the empty
 * string on purpose: it keeps the historical, unprefixed cache key byte-for-byte
 * (`320x240->160x120`), so adding formats cannot silently move an existing
 * session onto a different scaler.
 */
export function nativeCropSourceTag(format: NativeCropSourceFormat): string {
  switch (format) {
    case 'yuv420p':
      return ''
    case 'nv12':
      return 'nv12:'
    case 'rgb24':
      return 'rgb:'
  }
}

/**
 * Bytes a crop of `rows` rows actually reads, measured from the crop's ORIGIN.
 *
 * The LAST row needs only its own `rowBytes`, never a whole stride — the stride
 * is the distance to the NEXT row, and for the last row there is no next row.
 * Demanding `stride * rows` instead overshoots the plane's end by exactly the
 * horizontal offset, which is invisible everywhere except where the crop's
 * bottom IS the frame's bottom. See {@link resolvePlanarCropSource}.
 */
function planarSpan(rows: number, stride: number, rowBytes: number): number {
  if (rows <= 0) return 0
  return (rows - 1) * stride + rowBytes
}

/** A plane view starting at `offset`, or `null` when the plane is too short. */
function viewAt(
  plane: Uint8Array | undefined,
  offset: number,
  requiredSpan: number,
): Uint8Array | null {
  if (!plane) return null
  if (offset < 0 || plane.length - offset < requiredSpan) return null
  return plane.subarray(offset)
}

/**
 * Resolve the plane views a crop of `region` reads, for `kind`.
 *
 * Returns `null` — never a partial or clamped view — when the frame does not
 * present the planes the layout requires, or when the region would run past a
 * plane's end. The caller counts that as a crop miss and says so ONCE; a short
 * view would hand libswscale a buffer to read past, which is how this path
 * previously produced heap corruption rather than an error.
 *
 * An odd origin is floored onto the chroma grid rather than rejected: the
 * geometry helper already aligns to even, and flooring reads the chroma sample
 * that CONTAINS the origin instead of inventing a half sample.
 *
 * ## The bottom edge (2026-09-07)
 *
 * The span demanded from each plane used to be `stride * region.height` from
 * the crop ORIGIN. A stride is the distance to the NEXT row, and the last row
 * of a crop has no next row — it needs only `left + width` bytes. So the demand
 * overshot the plane's end by exactly `left`, which is invisible everywhere
 * except when the crop's bottom IS the frame's last row. `resolveNativeTileRegion`
 * clamps a padded box to precisely that, and `clampEven` floors both `top` and
 * `height`, so a bottom-clamped tile lands flush every time.
 *
 * The result was that every subject standing near the camera — the biggest, the
 * closest, the best shot — lost its native tile, and the hold path threw for
 * the same rectangles. Measured over 6 h on the live cluster: **100 of 100**
 * logged `missing plane data` geometries had `top + height === frameHeight`
 * with `left > 0`, 101 of 102 on dev:104 (hall, 3840x2160).
 *
 * The check is now the region's real extent, so a crop that genuinely runs past
 * a plane — one row too tall, or a last row reaching past the stride — is still
 * refused. The views handed back are unchanged: `subarray(offset)` always ran
 * to the plane's true end, so nothing here ever sized a buffer, and tightening
 * the predicate cannot shorten one.
 */
export function resolvePlanarCropSource(
  kind: PlanarCropKind,
  planes: readonly (Uint8Array | undefined)[] | null | undefined,
  strides: readonly (number | undefined)[] | null | undefined,
  region: PlanarCropRegion,
): PlanarCropSource | null {
  if (!planes || planes.length < PLANE_COUNT[kind]) return null
  const yStride = strides?.[0] ?? 0
  const cStride = strides?.[1] ?? 0
  if (yStride <= 0 || cStride <= 0) return null
  const top = Math.max(0, region.top)
  const left = Math.max(0, region.left)
  const chromaRow = Math.floor(top / 2)
  const chromaHeight = Math.ceil(region.height / 2)
  // Chroma is half-width; an odd crop width still needs the sample that
  // CONTAINS its last column, hence `ceil`.
  const chromaWidth = Math.ceil(Math.max(0, region.width) / 2)
  const y = viewAt(
    planes[0],
    top * yStride + left,
    planarSpan(region.height, yStride, region.width),
  )

  if (kind === 'nv12') {
    // One interleaved plane: a chroma column is 2 bytes (U,V), so an even `left`
    // lands at byte `left`. Floor to the pair boundary for an odd origin.
    const uvOffset = chromaRow * cStride + Math.floor(left / 2) * 2
    const uv = viewAt(planes[1], uvOffset, planarSpan(chromaHeight, cStride, chromaWidth * 2))
    if (!y || !uv) return null
    return { planes: [y, uv], strides: [yStride, cStride] }
  }

  const vStride = strides?.[2] ?? cStride
  const chromaOffset = chromaRow * cStride + Math.floor(left / 2)
  const u = viewAt(planes[1], chromaOffset, planarSpan(chromaHeight, cStride, chromaWidth))
  const v = viewAt(
    planes[2],
    chromaRow * vStride + Math.floor(left / 2),
    planarSpan(chromaHeight, vStride, chromaWidth),
  )
  if (!y || !u || !v) return null
  return { planes: [y, u, v], strides: [yStride, cStride, vStride] }
}
