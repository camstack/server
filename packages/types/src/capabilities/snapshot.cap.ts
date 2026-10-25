import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import {
  type CapabilityDefinition,
  type InferProvider,
  method,
  systemMethod,
} from './capability-definition.js'

/**
 * A single device snapshot returned as base64 JPEG/PNG.
 *
 * The `SnapshotAddon` wrapper returns this shape whether the frame came from
 * the device-native provider (onboard capture) or from the stream-broker
 * prebuffer fallback.
 */
const SnapshotImageSchema = z.object({
  base64: z.string(),
  contentType: z.string(),
})

/**
 * snapshot — device-scoped capability for camera image capture.
 *
 * Two kinds of providers coexist behind this cap name:
 *
 *   - **Native** providers (kind:'native'): registered per-device by
 *     device-driver addons (RtspCamera, OnvifCamera, …) via
 *     `DeviceContext.registerNativeCap`. Each knows how to fetch a frame
 *     straight from the camera (HTTP snapshot URL, ONVIF action, etc.).
 *
 *   - **Wrapper** providers (kind:'wrapper'): register as a system
 *     provider (SnapshotAddon in `@camstack/system/builtins/snapshot`). The
 *     wrapper owns the cache and invokes the native via
 *     `ctx.getNativeProvider(snapshotCapability, deviceId)` on miss.
 *
 * Device-scoped routing: callers use `ctx.fetchDevice(id).snapshot.*`;
 * the DeviceProxy auto-injects `deviceId` + `nodeId` and dispatches to
 * the provider currently active for that device (wrapper wins when
 * activated via `setWrapperActive`, otherwise the native).
 */
/**
 * Live readable snapshot state — diagnostic info that a consumer can
 * pull to know when the last image was captured, how stale the cache
 * is, and which stream was used. Distinct from `getSnapshot` which
 * returns the JPEG itself.
 */
const SnapshotStatusSchema = z.object({
  /** Ms epoch of the last successful capture. Null if none yet. */
  lastCapturedAt: z.number().nullable(),
  /** Age of the cached image in ms. Null if no cache. */
  cacheAgeMs: z.number().nullable(),
  /** Size in bytes of the last captured image. Null if no capture. */
  lastBytes: z.number().nullable(),
  /** Stream id used for the last capture ('high'|'mid'|'low' or custom). Null if via HTTP endpoint. */
  lastStreamId: z.string().nullable(),
})

export const snapshotCapability = {
  name: 'snapshot',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  deviceTypes: [DeviceType.Camera],
  // Owns per-device snapshot settings (preferred stream, debug logging).
  // The three DeviceSettingsContribution methods are auto-added to the
  // provider interface via `InferProvider` — `SnapshotAddon` implements
  // them and persists per-device state through `ctx.settings.writeDeviceStore`.
  exposesDeviceSettings: true,
  methods: {
    getSnapshot: method(
      z.object({
        deviceId: z.number(),
        streamId: z.string().optional(),
        /**
         * Bypass the cache freshness check and fetch directly from the
         * native (or stream-broker fallback). Triggered by the UI's
         * "refresh" button so an operator can force a fresh frame
         * even when the cache is well within the device's
         * `snapshotMaxAgeS` window.
         *
         * **`force` is an OPERATOR signal, not a freshness preference.** On a
         * battery camera it is the one thing that walks past the wrapper's
         * sleep gate and wakes the camera, so a background caller — a poller,
         * an event handler, a thumbnail — must NEVER set it. Every such caller
         * gets the cached frame, which on a sleeping battery camera is the
         * correct answer: stale but honest beats woken.
         */
        force: z.boolean().optional(),
      }),
      SnapshotImageSchema.nullable(),
    ),
    invalidateCache: method(z.object({ deviceId: z.number() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Cache-only batch overview — answers from the wrapper's in-memory cache in
     * O(n) and NEVER triggers a capture. Lets a grid skip requesting images for
     * devices that never produced a frame, and gives it an ETag per device for
     * conditional (304-able) image fetches. `lastCapturedAt`/`cacheAgeMs`/`etag`
     * are null for a device with no cached frame.
     */
    getSnapshotOverview: systemMethod(
      z.object({ deviceIds: z.array(z.number()).min(1).max(200) }),
      z.array(
        z.object({
          deviceId: z.number(),
          lastCapturedAt: z.number().nullable(),
          cacheAgeMs: z.number().nullable(),
          etag: z.string().nullable(),
        }),
      ),
    ),
    /**
     * The full decision chain for ONE device, for the viewer's debug readout —
     * the answer to "why does this tile show what it shows" in a single poll:
     * the battery slice the state was derived from, the resolved state + its
     * reason, the cached frame's identity/age, whether a wake window is open,
     * and whether a fresh capture is in flight. Cache-only and capture-free:
     * a debug read must never wake a battery camera.
     */
    getDebugState: systemMethod(
      z.object({ deviceId: z.number() }),
      z.object({
        /** The battery slice as read, or null when the device has none. */
        battery: z
          .object({
            sleeping: z.boolean(),
            lastUpdated: z.number(),
            lastContactAt: z.number().optional(),
          })
          .nullable(),
        /** The resolved snapshot state (what the overlay decision used). */
        state: z.object({
          isBattery: z.boolean(),
          reason: z.enum(['disabled', 'offline', 'sleeping', 'unreachable', 'waking']).nullable(),
        }),
        /** The cached frame behind the next paint. */
        frame: z.object({
          capturedAt: z.number().nullable(),
          ageMs: z.number().nullable(),
        }),
        /** A wake window is currently open (the Waking overlay's source). */
        waking: z.boolean(),
      }),
    ),
    /**
     * Signed, expiring links to a CLIENT-SIZED frame — and the demand signal
     * that makes those frames current.
     *
     * ## The problem it replaces
     *
     * `getSnapshotOverview` is cache-only by contract: it answers from whatever
     * the wrapper happens to hold and never captures. Under D93 the client
     * versions its image URL on that answer, and an image REQUEST was the only
     * demand signal. Both of those are satisfiable by the client's own image
     * cache — `expo-image` is URL-keyed and never revalidates — so a URL painted
     * in a previous session comes off disk with no network, no demand, and no
     * capture. Measured on the live hub: reopening after two minutes idle
     * painted 15 of 16 tiles at **168 s old** with zero HTTP requests, and the
     * fleet only recovered because a later poll happened to observe a different
     * identity.
     *
     * ## The two properties that fix it
     *
     * **It is an RPC, so no client cache can answer it.** The demand signal
     * always reaches the wrapper. This method therefore CAPTURES, where
     * `getSnapshotOverview` must never (D93) — the distinction is not "one is
     * newer" but that the overview poll is app-wide (a capturing overview would
     * dial every camera on the install) while this is called by a rendered
     * surface naming the tiles it is actually painting, at the width it is
     * painting them.
     *
     * Since 2026-08-11 this is the ONLY thing that refreshes a snapshot: the
     * server-side keep-warm loop was removed (operator directive — on-demand,
     * always), so a camera nobody is looking at costs nothing at all.
     *
     * **It waits, briefly and boundedly, for the capture it triggered.** The
     * returned `capturedAt` is the frame the link will serve, not the frame the
     * cache held when the client asked, so a first paint is honest and current
     * instead of a generation behind. A device that does not settle inside the
     * bound still gets a link and its real (older) `capturedAt` — the next poll
     * carries it forward.
     *
     * `force` is never set on behalf of a client here. A sleeping battery camera
     * is reported with `sleeping: true` and the last frame it produced, however
     * old; the wrapper's existing sleep gate owns that decision and this method
     * adds no second one.
     */
    getSnapshotLinks: systemMethod(
      z.object({
        /** The tiles a surface is actually rendering. One entry per (device,
         *  width) the caller will paint — the width is snapped to the server's
         *  ladder and becomes part of the link's SIGNED identity. */
        targets: z
          .array(
            z.object({
              deviceId: z.number(),
              /** Target width in px. Omit for the frame as captured — correct
               *  for a full-bleed surface, wrong (and expensive) for a grid. */
              width: z.number().int().positive().optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
      z.array(
        z.object({
          deviceId: z.number(),
          /** Root-relative signed path, or null when the link plane is not
           *  served (no data-plane facility). Present even for a device that has
           *  never captured — the request is what triggers the first one (D94). */
          url: z.string().nullable(),
          /** Epoch ms of the frame this link serves. Null = never captured.
           *  THE honest age: the tRPC path carried none before this. */
          capturedAt: z.number().nullable(),
          /** Age of that frame at the moment the answer was built. */
          ageMs: z.number().nullable(),
          /** Epoch ms after which `url` stops verifying. */
          expiresAt: z.number().nullable(),
          /** Ladder rung the bytes are at; null = the frame as captured. */
          width: z.number().nullable(),
          /** The device has never produced a frame. An empty state, not a
           *  failure — and never a reason to withhold the link (D94). */
          neverCaptured: z.boolean(),
          /** A sleeping battery camera: the frame is deliberately stale and will
           *  NOT refresh in the background. A surface should say so rather than
           *  present it as current. */
          sleeping: z.boolean(),
          /** Current device state rendered over the cached frame. State images
           *  remain authoritative even when their photographic background is
           *  old; null means the link must carry a current camera frame.
           *
           *  **This is the ONLY source a surface may derive an inactive tile
           *  from.** A client that reads a device's `online`/`disabled` flags and
           *  draws its own verdict will disagree with the pixels it is painting
           *  — the frame comes from here, and so must the sentence over it
           *  (D190). Pair with `ageMs` for the age of the photograph behind the
           *  state. */
          stateReason: z
            .enum(['disabled', 'offline', 'sleeping', 'unreachable', 'waking'])
            .nullable(),
          /** A battery camera (whatever its current state). An AWAKE battery
           *  camera is deliberately NOT recaptured on the poll cadence — every
           *  capture is a camera hit that would keep it out of sleep — so its
           *  cached frame legitimately ages past the currency ceiling while
           *  nothing is streaming. A surface must keep painting it (a fresh
           *  frame is captured at each wake), not blank to "unavailable". */
          battery: z.boolean(),
        }),
      ),
    ),
  },
  status: {
    schema: SnapshotStatusSchema,
    kind: 'poll',
  },
} as const satisfies CapabilityDefinition

export type ISnapshotOrchestrator = InferProvider<typeof snapshotCapability>

export { SnapshotImageSchema, SnapshotStatusSchema }
