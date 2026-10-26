import { z } from 'zod'
import {
  method,
  type CapabilityDefinition,
  type InferNativeProvider,
} from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import {
  CamProfileSchema,
  CamStreamKindSchema,
  CamStreamResolutionSchema,
} from './schemas/streaming-shared.js'
import { readingMeta } from '../units/quantity.js'

/**
 * One publishable camera stream as its OWNING PROVIDER describes it — the same
 * payload the (legacy) push `streamBroker.publishCameraStream` carried, minus
 * `deviceId`.
 *
 * The stream-broker PULLS this catalog per camera (on start, on a configurable
 * reconcile poll, and on device / stream-params events) to (re)build its
 * cam-stream registry, instead of relying on providers to push. Pull is
 * authoritative (RPC); the poll is the backstop for any missed event. This
 * makes the broker self-heal after a restart — it re-derives the full catalog
 * from the providers rather than waiting to be re-fed.
 *
 * `url` is the dial source where the provider can resolve it synchronously
 * (rtsp / rtmp / http). For lazy sources (Reolink rfc4571) it carries the
 * `lazy:rfc4571:` sentinel; the real URL is still materialised at DIAL time via
 * the broker's `onRequestStreamSourceRefresh` round-trip — unchanged by the
 * pull model. `push-annexb` sources carry no URL (the provider pushes frames).
 */
export const CamStreamDescriptorSchema = z.object({
  camStreamId: z.string().min(1),
  kind: CamStreamKindSchema,
  url: z.string().optional(),
  codec: z.string().optional(),
  resolution: CamStreamResolutionSchema.optional(),
  fps: z.number().positive().optional().meta(readingMeta('rate')),
  label: z.string().optional(),
  /** Device-level features (e.g. `battery-operated`) — drives broker policy. */
  deviceFeatures: z.array(z.string()).optional(),
  /** Eligible for automatic profile assignment. Absent = `true`. */
  autoEligible: z.boolean().optional(),
  /** The slot the publisher says this stream IS — see `CameraStreamSchema.profileHint`. */
  profileHint: CamProfileSchema.optional(),
  /** Transport-specific opaque metadata (e.g. rfc4571 SDP). */
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type CamStreamDescriptor = z.infer<typeof CamStreamDescriptorSchema>

/**
 * `stream-catalog` — device-scoped, provider-implemented. The pull counterpart
 * of the removed `publishCameraStream` push: a camera provider returns the full
 * set of stream descriptors it can offer for the device, synchronously, so the
 * broker can reconcile its registry against the authoritative provider state.
 */
/**
 * The catalog as a DURABLE fact rather than a live answer.
 *
 * A battery camera's descriptors are profile-stable — they change when the
 * operator rewrites an encoder profile, not minute to minute — but building
 * them costs a Baichuan login, which on a sleeping Argus IS a wake. So the
 * provider is allowed to build them exactly once per profile and must serve
 * every later pull from a cache.
 *
 * Holding that cache only in RAM is what turned a restart into an outage. The
 * runner comes back with the camera asleep, `buildStreamCatalogUncached`
 * correctly refuses to wake it, the pull answers `[]`, the broker has no
 * cam-stream entry to build a broker from, and `webrtcSession.handleOffer`
 * fails with a flat "No broker for stream" — for as long as the camera sleeps,
 * which on a battery cam is most of the day. The camera was fine. The stream
 * was unreachable because the process had forgotten what the camera offers.
 *
 * Declaring it here puts it in `device-runtime-state`, the kernel's canonical
 * declared collection, with the same `restored` durability `battery` uses for
 * the same reason: the last known value is the only value there is while the
 * device is asleep. The broker's brokers are therefore always DEFINABLE — it
 * is the DIAL that wakes a camera, never the catalog (D173).
 */
const StreamCatalogStateSchema = z.object({
  /** The descriptors as last built from a real camera response. Never a guess:
   *  a failed or refused build writes NOTHING, so a restored catalog is always
   *  one the camera itself once produced. */
  descriptors: z.array(CamStreamDescriptorSchema),
  /** Ms epoch of the build that produced {@link descriptors}. Lets the wake
   *  path decide whether the camera's own awake window is worth spending on a
   *  re-read. */
  lastFetchedAt: z.number(),
})

export type StreamCatalogState = z.infer<typeof StreamCatalogStateSchema>

export const streamCatalogCapability = {
  name: 'stream-catalog',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  methods: {
    getCatalog: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      z.array(CamStreamDescriptorSchema).readonly(),
    ),
  },
  runtimeState: StreamCatalogStateSchema,

  /**
   * Runtime-state durability: **restored** — see the schema doc. A cold
   * catalog on a sleeping battery camera is not a slow first frame, it is a
   * camera that cannot be watched at all until it happens to wake.
   *
   * Churn is nil by construction: the slice is written only by a SUCCESSFUL
   * build, and a build only runs when there is no cached copy (or the copy is
   * a day old and the camera is awake anyway).
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): none — stream inventory.
   */
  history: 'none',
  /** Clock field: written, but excluded from the compare that decides whether
   *  persisting is worth a SQLite commit — the descriptors are the value. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IStreamCatalogProvider = InferNativeProvider<typeof streamCatalogCapability>
