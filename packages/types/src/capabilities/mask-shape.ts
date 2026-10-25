import { z } from 'zod'

/**
 * Shared geometry vocabulary for on-frame shape caps — privacy-mask,
 * motion-zones, and the detection zones/lines editor all speak this one
 * language so a single drawing-plane editor and the providers stay
 * decoupled from each cap's storage.
 *
 * All coordinates are normalized 0..1 of the camera frame (top-left
 * origin). Each cap composes the SUBSET of shape kinds it supports and
 * advertises it via `supportedShapes` in its `getOptions`.
 */

/** A normalized 0..1 point (top-left origin). */
export const MaskPointSchema = z.object({
  x: z.number(),
  y: z.number(),
})

/** Axis-aligned rectangle (normalized 0..1). */
export const MaskRectShapeSchema = z.object({
  kind: z.literal('rect'),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

/** Free polygon — an ordered list of normalized vertices (≥3). */
export const MaskPolygonShapeSchema = z.object({
  kind: z.literal('polygon'),
  points: z.array(MaskPointSchema),
})

/** Boolean cell grid — row-major, length === gridWidth*gridHeight. */
export const MaskGridShapeSchema = z.object({
  kind: z.literal('grid'),
  gridWidth: z.number(),
  gridHeight: z.number(),
  cells: z.array(z.boolean()),
})

/** Directed line / tripwire — an ordered list of normalized points (≥2). */
export const MaskLineShapeSchema = z.object({
  kind: z.literal('line'),
  points: z.array(MaskPointSchema),
})

/** The full shape vocabulary. Caps compose the subset they support. */
export const MaskShapeSchema = z.discriminatedUnion('kind', [
  MaskRectShapeSchema,
  MaskPolygonShapeSchema,
  MaskGridShapeSchema,
  MaskLineShapeSchema,
])

/** Every shape-kind discriminant, for `supportedShapes` advertisement. */
export const MaskShapeKindSchema = z.enum(['rect', 'polygon', 'grid', 'line'])

/** Polygon vertex bounds when a cap supports 'polygon' (e.g. Hikvision {min:4,max:4}). */
export const MaskPolygonVerticesSchema = z.object({
  min: z.number(),
  max: z.number(),
})

/** Grid dimensions when a cap supports 'grid'. */
export const MaskGridDimsSchema = z.object({
  width: z.number(),
  height: z.number(),
})

export type MaskPoint = z.infer<typeof MaskPointSchema>
export type MaskRectShape = z.infer<typeof MaskRectShapeSchema>
export type MaskPolygonShape = z.infer<typeof MaskPolygonShapeSchema>
export type MaskGridShape = z.infer<typeof MaskGridShapeSchema>
export type MaskLineShape = z.infer<typeof MaskLineShapeSchema>
export type MaskShape = z.infer<typeof MaskShapeSchema>
export type MaskShapeKind = z.infer<typeof MaskShapeKindSchema>
export type MaskPolygonVertices = z.infer<typeof MaskPolygonVerticesSchema>
export type MaskGridDims = z.infer<typeof MaskGridDimsSchema>
