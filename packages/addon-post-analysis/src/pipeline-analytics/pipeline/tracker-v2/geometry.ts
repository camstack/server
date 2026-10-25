/**
 * Box arithmetic for tracker v2 (D683). Pure. One copy: L1 and L2 both
 * measure with these, so "overlap" means one thing everywhere.
 */
import type { BoundingBox } from '@camstack/types'

export interface Point {
  readonly x: number
  readonly y: number
}

export function iou(a: BoundingBox, b: BoundingBox): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/** Larger area over smaller; `Infinity` when either box is empty. */
export function areaRatio(a: BoundingBox, b: BoundingBox): number {
  const aa = a.w * a.h
  const bb = b.w * b.h
  if (!(aa > 0) || !(bb > 0)) return Number.POSITIVE_INFINITY
  return aa >= bb ? aa / bb : bb / aa
}

export function centreOf(b: BoundingBox): Point {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

export function centreDistance(a: BoundingBox, b: BoundingBox): number {
  const ca = centreOf(a)
  const cb = centreOf(b)
  return Math.hypot(ca.x - cb.x, ca.y - cb.y)
}

export function diagonal(b: BoundingBox): number {
  return Math.hypot(b.w, b.h)
}
