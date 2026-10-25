/**
 * Reference area for package min-size fractions — the same union-bbox the
 * `package-detection` crop-zone step uses, without importing addon-pipeline.
 */

export interface PackageReferenceZone {
  readonly id: string
  readonly polygon: readonly { readonly x: number; readonly y: number }[]
}

export type PackageReferenceKind = 'zone-crop' | 'frame'

export interface PackageReferenceAreaInput {
  readonly zones: readonly PackageReferenceZone[]
  readonly packageZoneIds: ReadonlySet<string>
  readonly frameWidth: number
  readonly frameHeight: number
}

export interface PackageReferenceAreaResult {
  readonly areaPx: number
  readonly kind: PackageReferenceKind
}

/** Normalized union of the package zones. Null when the crop would be the frame. */
export interface PackageZoneCropRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export function packageZoneCropRect(input: PackageReferenceAreaInput): PackageZoneCropRect | null {
  if (input.frameWidth <= 0 || input.frameHeight <= 0) return null
  if (input.packageZoneIds.size === 0) return null
  const bounds = unionBounds(input)
  if (bounds === null) return null
  const x = clamp01(bounds.minX)
  const y = clamp01(bounds.minY)
  const w = clamp01(bounds.maxX) - x
  const h = clamp01(bounds.maxY) - y
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

export function packageReferenceArea(input: PackageReferenceAreaInput): PackageReferenceAreaResult {
  const frameArea = input.frameWidth * input.frameHeight
  const rect = packageZoneCropRect(input)
  if (rect === null) return { areaPx: frameArea, kind: 'frame' }
  return { areaPx: rect.w * input.frameWidth * (rect.h * input.frameHeight), kind: 'zone-crop' }
}

interface ZoneBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

function unionBounds(input: PackageReferenceAreaInput): ZoneBounds | null {
  const zoneById = new Map(input.zones.map((z) => [z.id, z]))
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let sawPoint = false
  for (const id of input.packageZoneIds) {
    const zone = zoneById.get(id)
    if (!zone || zone.polygon.length === 0) continue
    for (const point of zone.polygon) {
      sawPoint = true
      if (point.x < minX) minX = point.x
      if (point.y < minY) minY = point.y
      if (point.x > maxX) maxX = point.x
      if (point.y > maxY) maxY = point.y
    }
  }
  if (!sawPoint) return null
  return { minX, minY, maxX, maxY }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
