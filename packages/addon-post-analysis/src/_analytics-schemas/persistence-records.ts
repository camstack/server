/**
 * Zod schemas for analytics-suite persisted record types.
 * Used by persistence services to parse settings-store query results.
 */
import { z } from 'zod'

// ── Track Trail ─────────────────────────────────────────────────────

export const TrackPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  timestamp: z.number(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
})

export const TrackSnapshotSchema = z.object({
  timestamp: z.number(),
  position: TrackPositionSchema,
  thumbnailPath: z.string(),
})

const TrackTrailSchema = z.object({
  trackId: z.string(),
  deviceId: z.string(),
  className: z.string(),
  label: z.string().optional(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  positions: z.array(TrackPositionSchema),
  snapshots: z.array(TrackSnapshotSchema),
  totalDistance: z.number(),
  zonesVisited: z.array(z.string()),
  active: z.boolean(),
})

export type TrackTrail = z.infer<typeof TrackTrailSchema>

// ── Scene Monitor ───────────────────────────────────────────────────

const SceneMonitorConfigSchema = z.object({
  monitors: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      roi: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      enabled: z.boolean(),
      states: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          prompt: z.string().optional(),
          textPrompts: z.array(z.string()).optional(),
          referenceEmbeddings: z.array(z.array(z.number())).optional(),
          threshold: z.number().optional(),
          notify: z.boolean().optional(),
          severity: z.enum(['info', 'warning', 'alert']).optional(),
        }),
      ),
    }),
  ),
})

export type SceneMonitorConfig = z.infer<typeof SceneMonitorConfigSchema>

/** Single scene monitor entry (element of SceneMonitorConfig.monitors). */
export type SceneMonitor = SceneMonitorConfig['monitors'][number]
