/**
 * Zod bodies for phase-5 trackless event record kinds (payload only — `deviceId`
 * and clock live on the record row; `deviceId` is duplicated in the body when an
 * index or aggregate needs it in JSON).
 */
import { z } from 'zod'
import { MotionTriggeredBySchema } from '@camstack/types'

export const MotionEventBodySchema = z.object({
  deviceId: z.number(),
  regionCount: z.number(),
  regions: z.array(z.unknown()).optional(),
  frameWidth: z.number().optional(),
  frameHeight: z.number().optional(),
  durationMs: z.number().nullable().optional(),
  edges: z.string().optional(),
  triggeredBy: MotionTriggeredBySchema.optional(),
})
export type MotionEventBody = z.infer<typeof MotionEventBodySchema>

export const AudioEventBodySchema = z.object({
  deviceId: z.number(),
  rms: z.number(),
  dbfs: z.number(),
  classification: z
    .object({
      className: z.string(),
      originalClass: z.string().optional(),
      score: z.number(),
    })
    .optional(),
})
export type AudioEventBody = z.infer<typeof AudioEventBodySchema>

export const SensorEventBodySchema = z.object({
  deviceId: z.number(),
  sourceDeviceId: z.number(),
  kind: z.string(),
  value: z.record(z.string(), z.unknown()).nullable(),
})
export type SensorEventBody = z.infer<typeof SensorEventBodySchema>

/** Face row payload (`deviceId` / clock on the record row; embedding drained to `[]`). */
export const FaceLedgerBodySchema = z.record(z.string(), z.unknown())
export type FaceLedgerBody = z.infer<typeof FaceLedgerBodySchema>

/** Plate row payload (`deviceId` / clock on the record row). */
export const PlateLedgerBodySchema = z.record(z.string(), z.unknown())
export type PlateLedgerBody = z.infer<typeof PlateLedgerBodySchema>

/** Generic phase-5 events.db ledger payload (clock + device on the record row). */
export const PaEventsLedgerBodySchema = z.record(z.string(), z.unknown())
export type PaEventsLedgerBody = z.infer<typeof PaEventsLedgerBodySchema>

const GalleryPhotoBboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

const GallerySamplePointSchema = z.object({
  x: z.number(),
  y: z.number(),
})

/** Named person registry row (`createdAt` → record `at`; `updatedAt` in body). */
export const IdentityConfigBodySchema = z.object({
  name: z.string(),
  updatedAt: z.number(),
  sampleCount: z.number(),
  coverMediaId: z.number().nullable().optional(),
})
export type IdentityConfigBody = z.infer<typeof IdentityConfigBodySchema>

/**
 * Enrolled face sample (`addedAt` → record `at`; vector in index).
 *
 * `addedAt` is ALSO in the body: the `identity_added` index names it, and an
 * index reads the body, never the header. Optional only because rows written
 * before the fix lacked it (repaired on the operator hubs on 2026-10-22).
 */
export const IdentitySampleLedgerBodySchema = z.object({
  identityId: z.string(),
  addedAt: z.number().optional(),
  embedding: z.array(z.number()).optional(),
  mediaId: z.number().optional(),
  sourceMediaId: z.number().optional(),
  source: z.enum(['detected', 'photo']),
  alignment: z.string().optional(),
  sourceBbox: GalleryPhotoBboxSchema.optional(),
  sourceLandmarks: z.array(GallerySamplePointSchema).optional(),
  replacesSampleId: z.string().optional(),
  deviceId: z.number().optional(),
  modelId: z.string(),
  dim: z.number(),
})
export type IdentitySampleLedgerBody = z.infer<typeof IdentitySampleLedgerBodySchema>

/** Named vehicle registry row (`createdAt` → record `at`; `updatedAt` in body). */
export const VehicleConfigBodySchema = z.object({
  name: z.string(),
  updatedAt: z.number(),
  sampleCount: z.number(),
  coverMediaId: z.number().nullable().optional(),
})
export type VehicleConfigBody = z.infer<typeof VehicleConfigBodySchema>

/** Enrolled plate read (`addedAt` → record `at`, and in the body for `vehicle_added`). */
export const VehicleSampleLedgerBodySchema = z.object({
  vehicleId: z.string(),
  addedAt: z.number().optional(),
  text: z.string(),
  score: z.number(),
  sourcePlateId: z.string().optional(),
  mediaId: z.number().optional(),
  deviceId: z.number().optional(),
})
export type VehicleSampleLedgerBody = z.infer<typeof VehicleSampleLedgerBodySchema>
