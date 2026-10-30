/**
 * The slices of hub payloads the ops tools actually read, validated at the
 * boundary (a hub answer is external data). Loose objects: fields we do not name
 * are carried, not rejected — the hub adds fields faster than this file.
 */
import { z } from 'zod'

const BBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
})

export interface TrackBBox {
  x: number
  y: number
  w: number
  h: number
}

export interface TrackPosition {
  timestamp: number
  bbox: TrackBBox
}

export interface TrackEnvelope {
  maxX?: number
  maxY?: number
}

export interface Track {
  trackId: string
  deviceId: number
  className: string
  source?: string
  firstSeen: number
  lastSeen: number
  state?: string
  active?: boolean
  positions: TrackPosition[]
  envelope?: TrackEnvelope
}

const trackSchema = z.looseObject({
  trackId: z.string(),
  deviceId: z.number(),
  className: z.string(),
  source: z.string().optional(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  state: z.string().optional(),
  active: z.boolean().optional(),
  positions: z
    .array(z.looseObject({ timestamp: z.number(), bbox: BBoxSchema }))
    .optional()
    .default([]),
  envelope: z
    .looseObject({
      maxX: z.number().optional(),
      maxY: z.number().optional(),
    })
    .optional(),
})
export const TrackSchema: z.ZodType<Track> = trackSchema

export interface RecentTracksPage {
  tracks: Track[]
  nextCursor?: string | null
}

export const RecentTracksPageSchema: z.ZodType<RecentTracksPage> = z.looseObject({
  tracks: z.array(trackSchema),
  nextCursor: z.string().nullable().optional(),
})

export interface MediaInfo {
  mediaId: number
  kind: string
  sizeBytes: number
  timestamp: number
}

const mediaInfoSchema = z.looseObject({
  mediaId: z.number(),
  kind: z.string(),
  sizeBytes: z.number(),
  timestamp: z.number(),
})
export const MediaInfoSchema: z.ZodType<MediaInfo> = mediaInfoSchema

export interface MediaWithBytes extends MediaInfo {
  base64?: string
}

export const MediaWithBytesSchema: z.ZodType<MediaWithBytes> = mediaInfoSchema.extend({
  base64: z.string().optional(),
})

export const CameraStatusSchema: z.ZodType<{ deviceId: number }> = z.looseObject({
  deviceId: z.number(),
})

export interface LogDestinationProvider {
  addonId: string
  isActive?: boolean
  mode?: string
}

export const LogDestinationProviderSchema: z.ZodType<LogDestinationProvider> = z.looseObject({
  addonId: z.string(),
  isActive: z.boolean().optional(),
  mode: z.string().optional(),
})

/** Parse a hub answer, naming the method on failure instead of throwing a bare zod dump. */
export function parseWire<S extends z.ZodType>(
  schema: S,
  value: unknown,
  label: string,
): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new Error(
      `${label}: unexpected answer shape (${result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}) — the hub and this tool may be on different versions`,
    )
  }
  return result.data
}
