import type { BoundingBox, FrameViewCrop, FrameViewGeometry, FrameViewSpec } from '@camstack/types'

function positiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`)
  return Math.max(1, Math.round(value))
}

function clampCrop(sourceWidth: number, sourceHeight: number, crop?: FrameViewCrop): FrameViewCrop {
  if (!crop) return { left: 0, top: 0, width: sourceWidth, height: sourceHeight }
  const left = Math.max(0, Math.min(sourceWidth - 1, Math.floor(crop.left)))
  const top = Math.max(0, Math.min(sourceHeight - 1, Math.floor(crop.top)))
  const right = Math.max(left + 1, Math.min(sourceWidth, Math.ceil(crop.left + crop.width)))
  const bottom = Math.max(top + 1, Math.min(sourceHeight, Math.ceil(crop.top + crop.height)))
  return { left, top, width: right - left, height: bottom - top }
}

/** Pure geometry for worker-side crop/resize without model padding. */
export function resolveFrameViewGeometry(
  sourceWidthInput: number,
  sourceHeightInput: number,
  spec: FrameViewSpec,
): FrameViewGeometry {
  const sourceWidth = positiveInteger(sourceWidthInput, 'source width')
  const sourceHeight = positiveInteger(sourceHeightInput, 'source height')
  const targetWidth = positiveInteger(spec.content.width, 'content width')
  const targetHeight = positiveInteger(spec.content.height, 'content height')
  const sourceCrop = clampCrop(sourceWidth, sourceHeight, spec.crop)
  const output =
    spec.fit === 'stretch'
      ? { width: targetWidth, height: targetHeight }
      : (() => {
          const scale = Math.min(targetWidth / sourceCrop.width, targetHeight / sourceCrop.height)
          return {
            width: Math.max(1, Math.round(sourceCrop.width * scale)),
            height: Math.max(1, Math.round(sourceCrop.height * scale)),
          }
        })()
  return {
    source: { width: sourceWidth, height: sourceHeight },
    sourceCrop,
    output,
    scale: {
      x: output.width / sourceCrop.width,
      y: output.height / sourceCrop.height,
    },
  }
}

/** Map a view-space pixel bbox back into the original source frame. */
export function invertViewBbox(bbox: BoundingBox, geometry: FrameViewGeometry): BoundingBox {
  return {
    x: geometry.sourceCrop.left + bbox.x / geometry.scale.x,
    y: geometry.sourceCrop.top + bbox.y / geometry.scale.y,
    w: bbox.w / geometry.scale.x,
    h: bbox.h / geometry.scale.y,
  }
}
