import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import {
  type CapabilityDefinition,
  type InferNativeProvider,
  method,
} from './capability-definition.js'

/** One of the camera's stream profiles. */
export const StreamProfileSchema = z.enum(['main', 'sub', 'ext'])

/** The current encoding config of one stream profile. */
const StreamProfileConfigSchema = z.object({
  width: z.number(),
  height: z.number(),
  codec: z.enum(['h264', 'h265']),
  framerate: z.number(),
  bitrate: z.number(), // kbps
  bitrateMode: z.enum(['vbr', 'cbr']).optional(),
  encoderProfile: z.enum(['high', 'main', 'baseline']).optional(),
  gop: z.number().optional(),
  /**
   * Whether THIS profile currently carries an audio track. READ-ONLY here.
   *
   * There is no matching field on {@link StreamProfilePatchSchema}: the
   * camera's microphone is owned by `privacy-mask` (`setAudioEnabled`), which
   * writes every profile at once so "audio off" means silent everywhere. A
   * per-profile writer beside it would let a camera be half-muted and would be
   * a second knob onto one device register — the failure D62 exists to
   * prevent. Absent when the firmware does not report the flag.
   */
  audio: z.boolean().optional(),
})

export const StreamParamsStatusSchema = z.object({
  /** Per-profile current config. A profile absent = the camera doesn't have it. */
  main: StreamProfileConfigSchema.optional(),
  sub: StreamProfileConfigSchema.optional(),
  ext: StreamProfileConfigSchema.optional(),
  lastFetchedAt: z.number(),
})

/** What a profile CAN be set to — drives the UI selectors. */
const StreamProfileOptionsSchema = z.object({
  resolutions: z.array(z.object({ width: z.number(), height: z.number() })),
  codecs: z.array(z.enum(['h264', 'h265'])),
  framerates: z.array(z.number()),
  /** Allowed bitrate values (kbps). Empty if the camera takes a free range. */
  bitrates: z.array(z.number()),
  /** Optional [min,max] kbps when the camera accepts a continuous range. */
  bitrateRange: z.tuple([z.number(), z.number()]).optional(),
  supportsBitrateMode: z.boolean(),
  supportsEncoderProfile: z.boolean(),
  supportsGop: z.boolean(),
  /** Allowed GOP / keyframe-interval range, in seconds — drives the
   *  I-frame-interval selector. Absent when the camera advertises GOP
   *  support but no concrete range (callers then fall back to a free
   *  numeric input). `{ min, max, step }` per the getOptions convention. */
  gop: z.object({ min: z.number(), max: z.number(), step: z.number() }).optional(),
})

export const StreamParamsOptionsSchema = z.object({
  main: StreamProfileOptionsSchema.optional(),
  sub: StreamProfileOptionsSchema.optional(),
  ext: StreamProfileOptionsSchema.optional(),
})

/** A partial change to one profile — every field optional; a provider
 *  ignores fields it doesn't support.
 *
 *  There is deliberately NO `audio` here. It existed until 2026-08-07,
 *  reachable from no form and honoured by exactly one provider, while the
 *  camera's microphone is a whole-device fact. It now has one writer,
 *  `privacyMask.setAudioEnabled`, which writes every profile — see
 *  `privacy-mask.cap.ts`. */
export const StreamProfilePatchSchema = z.object({
  width: z.number().optional(),
  height: z.number().optional(),
  codec: z.enum(['h264', 'h265']).optional(),
  framerate: z.number().optional(),
  bitrate: z.number().optional(),
  bitrateMode: z.enum(['vbr', 'cbr']).optional(),
  encoderProfile: z.enum(['high', 'main', 'baseline']).optional(),
  gop: z.number().optional(),
})

export type StreamParamsStatus = z.infer<typeof StreamParamsStatusSchema>
export type StreamParamsOptions = z.infer<typeof StreamParamsOptionsSchema>
export type StreamProfile = z.infer<typeof StreamProfileSchema>
export type StreamProfilePatch = z.infer<typeof StreamProfilePatchSchema>

export const streamParamsCapability = {
  name: 'stream-params',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  deviceConfig: {
    ui: { kind: 'derived-form', builderId: 'stream-params', tab: 'streaming' },
  },
  methods: {
    getOptions: method(z.object({ deviceId: z.number() }), StreamParamsOptionsSchema),
    setProfile: method(
      z.object({
        deviceId: z.number(),
        profile: StreamProfileSchema,
        patch: StreamProfilePatchSchema,
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Build the `ConfigUISchema` (admin-ui `ConfigFormBuilder` input
     * shape) for this camera's stream-encoder settings — one section per
     * profile (main / sub / ext) with the resolution / codec / framerate
     * / bitrate / bitrate-mode / encoder-profile / GOP controls the
     * firmware actually exposes.
     *
     * Driven by `getOptions` (camera-probed availability) + `getStatus`
     * (current per-profile config); each field's `default` is seeded
     * from the live config so the form renders the camera state in one
     * pass. Returns `null` when the camera exposes no configurable
     * stream property — the renderer then shows the unsupported message.
     *
     * Output is `z.unknown().nullable()` — the same convention every
     * other `ConfigUISchema`-returning cap method uses (`device-ops`,
     * `device-manager`); `ConfigUISchema` is a TS-only type with no
     * companion Zod schema, and a concrete object would collapse
     * unrelated AppRouter branches to `unknown` during codegen.
     */
    getConfigSchema: method(z.object({ deviceId: z.number() }), z.unknown().nullable()),
  },
  status: {
    schema: StreamParamsStatusSchema,
    kind: 'poll',
  },
  runtimeState: StreamParamsStatusSchema,

  /**
   * Runtime-state durability: **restored** — operator-set encoder profile; mutation-driven.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): the configured bitrate and frame rate of the main and sub
   * profiles. Configuration, so change-only on the default floor: a point is an
   * operator's (or a tuner's) edit, which is exactly what a chart of a stream's
   * quality over time must show.
   */
  history: {
    fields: {
      'main.bitrate': { kind: 'gauge', unit: 'kbps' },
      'main.framerate': { kind: 'gauge', unit: 'fps' },
      'sub.bitrate': { kind: 'gauge', unit: 'kbps' },
      'sub.framerate': { kind: 'gauge', unit: 'fps' },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IStreamParamsProvider = InferNativeProvider<typeof streamParamsCapability>

export { StreamProfileConfigSchema, StreamProfileOptionsSchema }
