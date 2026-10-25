import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { BoundingBoxSchema } from './schemas/detection-shared.js'

const VehicleSchema = z.object({
  id: z.string(),
  name: z.string(),
  sampleCount: z.number().int().nonnegative(),
  coverMediaId: z.number().int().optional(),
  /** Inline base64 of the cover sample's plate crop, resolved from `coverMediaId`. */
  coverBase64: z.string().optional(),
})
export type Vehicle = z.infer<typeof VehicleSchema>

const VehicleSampleInfoSchema = z.object({
  id: z.string(),
  /** The plate text this sample enrolled (self-labeling — no embedding). */
  text: z.string(),
  /** OCR confidence of the enrolled read (0..1). */
  score: z.number(),
  addedAt: z.number().int(),
  deviceId: z.number().int().optional(),
  base64: z.string().optional(), // plate crop image, inline
})
export type VehicleSampleInfo = z.infer<typeof VehicleSampleInfoSchema>

const PlateInfoSchema = z.object({
  plateId: z.string(),
  deviceId: z.number().int(),
  trackId: z.string(),
  timestamp: z.number().int(),
  /** Normalized OCR text (upper, no separators), or the human-corrected value. */
  text: z.string(),
  /** OCR confidence of the stored read (0..1); 1 when manually corrected. */
  score: z.number(),
  /** True when the text was manually corrected (exempt from retention). */
  corrected: z.boolean(),
  /** Recognized vehicle id when a matcher lookup named this read (SQL NULL → absent). */
  recognizedVehicleId: z.string().optional(),
  /** Resolved vehicle name for `recognizedVehicleId` (UI convenience). */
  vehicleName: z.string().optional(),
  /** True once the read was assigned to a vehicle (enrolled as a sample). */
  assigned: z.boolean(),
  /** keyFrame parity: the plate bbox (pixel space) on the native key frame. */
  plateBbox: BoundingBoxSchema.optional(),
  /** keyFrame parity: MediaStore key of the track's native-resolution key frame. */
  keyFrameMediaId: z.number().int().optional(),
  base64: z.string().optional(), // plate crop image, inline — prefer {@link cropUrl}
  /**
   * Same crop as a data-plane URL, always present when the plate has a stored
   * crop. `getPlateByTrack` returns this and never inlines JPEG; `listPlates`
   * and `searchPlates` inline the crop only when their `includeCrops` input is
   * left at its `true` default.
   */
  cropUrl: z.string().optional(),
})
export type PlateInfo = z.infer<typeof PlateInfoSchema>

/**
 * One gallery media row: what the crop is, how big it is, and WHERE its bytes
 * are — never the bytes.
 *
 * `base64` was deleted here rather than deprecated. `MediaFile.base64` (the
 * track/event contract) is still populated because a deployed viewer requires
 * the field to parse a row at all; this method has no such reader. Its ONE
 * caller is the admin UI's detail modal, which was building
 * `data:image/jpeg;base64,…` from a row whose `key` sat right beside it, in a
 * dialog already rendering its key FRAME from the `event-media` plane.
 *
 * `url` is `/addon/<addonId>/event-media/m/<mediaId>` (D482). The plane
 * resolves a media row by its own id, so this needed no new plane and no new
 * access decision.
 */
const MediaFileLiteSchema = z.object({
  /** The media row's own id — the same address `MediaFileRef.mediaId` carries
   *  (D482). It was the row's composite key, which embedded the owner. */
  mediaId: z.number().int(),
  kind: z.string(),
  url: z.string(),
  sizeBytes: z.number(),
  timestamp: z.number(),
})

const PlateClusterSchema = z.object({
  plateIds: z.array(z.string()).readonly(),
  representativePlateId: z.string(),
  representativeText: z.string(),
  size: z.number().int(),
  cohesion: z.number(),
})

/**
 * plate-gallery — review + proximity search for recognized license plates.
 *
 * Unlike faces, a plate is self-labeling (the OCR text IS the identity), so there
 * is no enroll/assign-to-name flow. Reads are grouped dynamically by text
 * edit-distance (`suggestPlateClusters`), searched by proximity (`searchPlates`),
 * and reviewed by correcting the OCR text (`correctPlateText`).
 */
export const plateGalleryCapability = {
  name: 'plate-gallery',
  // Every method not labelled otherwise is the 'plate-assignment' feature (D921).
  role: { feature: 'plate-assignment' },
  scope: 'system',
  mode: 'singleton',
  methods: {
    listPlates: method(
      z
        .object({
          deviceId: z.number().int().optional(),
          limit: z.number().int().positive().optional(),
          /**
           * Inline the base64 crop on every row. Default `true` — the existing
           * behaviour, kept so no caller breaks.
           *
           * Set `false` once the caller renders {@link PlateInfo.cropUrl}.
           * Measured on the live hub at the 500 rows the Plates view asks for:
           * 879,403 B and 27.7 s with the crops inline, against a few KiB of
           * metadata without them — and the browser then caches the images.
           *
           * This is the plate twin of `faceGallery.listRecentFaces`'s option;
           * plates were the one gallery list left without it.
           *
           * **This is an INPUT field, so it does not reach the addon until the
           * next train.** The hub router validates cap inputs against its own
           * compiled Zod and strips a key it does not know. Until the train
           * ships, sending `false` is harmless and keeps the crops inline.
           */
          includeCrops: z.boolean().optional(),
        })
        .optional(),
      z.array(PlateInfoSchema).readonly(),
    ),
    // Names in events are shown to anyone who sees the event (D921): this read is viewer baseline.
    getPlateByTrack: method(
      z.object({ deviceId: z.number().int(), trackId: z.string() }),
      PlateInfoSchema.nullable(),
      { role: 'viewer' },
    ),
    getPlateMedia: method(
      z.object({ plateId: z.string() }),
      z.array(MediaFileLiteSchema).readonly(),
    ),
    /** Proximity search: plates whose folded text is within `maxDistance` edits of `text`. */
    searchPlates: method(
      z.object({
        text: z.string().min(1),
        maxDistance: z.number().int().min(0).optional(),
        limit: z.number().int().positive().optional(),
        /** See `listPlates.includeCrops`. Default `true`. */
        includeCrops: z.boolean().optional(),
      }),
      z.array(PlateInfoSchema).readonly(),
    ),
    /** Suggest groups of near-identical reads (same physical plate) for review/merge. */
    suggestPlateClusters: method(
      z
        .object({
          maxDistance: z.number().int().min(0).optional(),
          minClusterSize: z.number().int().min(2).optional(),
          limit: z.number().int().positive().optional(),
        })
        .optional(),
      z.array(PlateClusterSchema).readonly(),
    ),
    /** Manually correct a read's OCR text (marks it corrected). */
    correctPlateText: method(z.object({ plateId: z.string(), text: z.string().min(1) }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    deletePlate: method(z.object({ plateId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    // ── Vehicle identities (text-vicinity analogue of face identities) ──────
    listVehicles: method(
      z
        .object({
          /** Inline {@link VehicleSchema.coverBase64} on every row. Default
           *  `false` — the vehicle twin of `faceGallery.listIdentities`'s
           *  option; `coverMediaId` + the `event-media` plane carry the picture.
           *  INPUT field: stripped by the hub router until the train ships, which
           *  resolves to `false` and is exactly the intended default. */
          includeCrops: z.boolean().optional(),
        })
        .optional(),
      z.array(VehicleSchema).readonly(),
    ),
    createVehicle: method(z.object({ name: z.string().min(1) }), VehicleSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    renameVehicle: method(z.object({ id: z.string(), name: z.string().min(1) }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    deleteVehicle: method(z.object({ id: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    listVehicleSamples: method(
      z.object({ vehicleId: z.string() }),
      z.array(VehicleSampleInfoSchema).readonly(),
    ),
    removeVehicleSample: method(
      z.object({ vehicleId: z.string(), sampleId: z.string() }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    assignPlate: method(z.object({ plateId: z.string(), vehicleId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    unassignPlate: method(z.object({ plateId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    assignPlates: method(
      z.object({ plateIds: z.array(z.string()).min(1), vehicleId: z.string() }),
      z.object({ assigned: z.number().int(), failed: z.array(z.string()).readonly() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    unassignPlates: method(
      z.object({ plateIds: z.array(z.string()).min(1) }),
      z.object({ unassigned: z.number().int(), failed: z.array(z.string()).readonly() }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IPlateGalleryProvider = InferProvider<typeof plateGalleryCapability>
