import { z } from 'zod'

/**
 * Single source of truth for the addon id used in event source tags +
 * `device.online`/`device.offline` payloads. Kept in sync with the
 * provider's `addonId` field manually — both must match for the device-
 * manager + alert center to correlate events back to the provider.
 */
export const REOLINK_ADDON_ID = 'provider-reolink'

/**
 * Default Baichuan channel for single-camera devices. NVR per-channel
 * routing is handled by the stream-routing helpers from the
 * `ch{N}-main` stream id format (Slice 8). This constant is the
 * fallback for snapshot, sleep poll, abilities probe, etc. — anything
 * that doesn't carry a channel context.
 */
export const DEFAULT_CHANNEL = 0

/**
 * Map nodelink ReolinkSimpleEvent.type values to the loose
 * CameraNativeDetection class strings the rest of camstack consumes.
 * Keeping the loose-string contract — face/package etc are valid.
 */
/**
 * Baichuan AI class name → the cap's `NativeObjectClass`.
 *
 * TWO vocabularies arrive here and both must be keyed. The simple-event push
 * (cmd 33 `<AItype>`) says `animal`; the capability probe (cmd 299
 * `getAiDetectTypes`) says `dog_cat` for the same class. Keying only the first
 * made `buildSupportedClasses` drop it, so camera 108 reported
 * `supportedClasses: ["person","vehicle"]` while its own `lastByClass` held a
 * live `animal` detection — the camera detected a class the system said it
 * could not. The two key-spaces do not collide, so one map serves both.
 */
export const AI_CLASS_MAP: Readonly<Record<string, string>> = {
  people: 'person',
  vehicle: 'vehicle',
  animal: 'animal',
  dog_cat: 'animal',
  face: 'face',
  package: 'package',
}

/**
 * Detected device class (Slice 15). The creation form never asks the
 * operator to pick this — `autoDetectDeviceType` from nodelink decides
 * at probe time. Persisted on the device so future reconnects don't
 * have to re-run autodetect (it's slower than a direct login).
 */
export const ReolinkDeviceTypeSchema = z.enum([
  'camera',
  'udp-camera',
  'battery-cam',
  'nvr',
  'multifocal',
])

export const ReolinkUdpDiscoveryMethodSchema = z.enum([
  'local-direct',
  'local-broadcast',
  'remote',
  'relay',
  'map',
])

/**
 * Lib-side socket debug categories — the names and semantics the lib
 * itself uses, so they are recognizable. Each flag is forwarded
 * verbatim into the `DebugOptions` blob `ReolinkBaichuanApi` accepts.
 */
export const ReolinkSocketDebugFlagSchema = z.enum([
  'debugRtsp',
  'traceNativeStream',
  'traceRecordings',
  'traceTalk',
  'traceEvents',
])

export type ReolinkSocketDebugFlag = z.infer<typeof ReolinkSocketDebugFlagSchema>

/**
 * Persisted shape of one stream profile's encoder OPTION list.
 *
 * Kept structurally identical to `StreamProfileOptionsSchema` in
 * `@camstack/types` (the `stream-params` cap) so the same
 * `mapEncStreamOptionsToProfileOptions` helper feeds both the cap's
 * live `getOptions` AND the persisted `deviceCache.encOptionsSnapshot`
 * that the editable Stream settings section reads synchronously.
 *
 * Declared here (rather than importing the cap schema) so the config
 * schema stays self-contained — `DeviceConfig.fromSchema` parses this
 * blob and a cross-package schema-identity dependency would be fragile
 * across the self-contained-addon boundary.
 */
export const ReolinkStreamProfileOptionsSchema = z.object({
  resolutions: z.array(z.object({ width: z.number(), height: z.number() })),
  codecs: z.array(z.enum(['h264', 'h265'])),
  framerates: z.array(z.number()),
  bitrates: z.array(z.number()),
  bitrateRange: z.tuple([z.number(), z.number()]).optional(),
  supportsBitrateMode: z.boolean(),
  supportsEncoderProfile: z.boolean(),
  supportsGop: z.boolean(),
  /** Mirrors `StreamProfileOptionsSchema.gop` — the GOP `{min,max,step}`
   *  range that drives the I-frame-interval selector. */
  gop: z.object({ min: z.number(), max: z.number(), step: z.number() }).optional(),
})

export const reolinkCameraSchema = z.object({
  /**
   * Which preset `ptz.goHome` targets on THIS camera.
   *
   * Empty = nothing configured, and `goHome` then REFUSES. It used to go to a
   * hardcoded slot on a vendor "convention" this fleet contradicts: reolink
   * went to preset 0, which on device 107 holds "stanza"; amcrest went to
   * preset 1, which on device 3836 holds "Preset1". Both swallowed the failure
   * in a bare catch, so a head that never moved was indistinguishable from a
   * head that went home.
   */
  homePresetId: z
    .string()
    .default('')
    .describe('Preset id ptz.goHome targets (empty = goHome refuses)'),
  // `name` is now base meta (DB column on `device-meta`, not in this
  // hardware-config schema). Read via `this.name` (resolved by
  // `BaseDevice` from `ctx.deviceMeta.name`); mutated via
  // `kernel.devices.setName(id, name)`.
  host: z.string().describe('Camera IP or hostname'),
  port: z.number().default(9000).describe('Baichuan port (default 9000)'),
  username: z.string().default('admin').describe('Username'),
  password: z.string().describe('Password').meta({ secret: true }),
  // NOTE: `channels` removed in the architectural cleanup pass —
  // channel layout is fully determined by `deviceCache.channelCount`
  // (single-channel default 1) plus the lib's `buildVideoStreamOptions()`
  // result fetched runtime by `publishToBroker`. Single-channel devices
  // always run on channel 0; NVR routing carries the channel inside
  // each `ch{N}-main`/`ch{N}-sub` stream id.
  /**
   * Transport mode resolved at creation time by autodetect (Slice 15).
   * - `tcp`  : standard TCP-based Baichuan (regular cameras, NVR/Hub)
   * - `udp`  : BCUDP-based Baichuan (battery cams, UDP-only models like
   *            Elite Floodlight WiFi)
   */
  transport: z.enum(['tcp', 'udp']).default('tcp'),
  /**
   * Camera UID (BCUDP). Required for battery / UDP cameras when the
   * library cannot reach them over local-direct discovery. Empty string
   * for TCP-only devices.
   */
  uid: z.string().optional(),
  /**
   * UDP discovery method selected by autodetect — preserved across
   * reconnects so we don't waste time re-discovering each time.
   */
  udpDiscoveryMethod: ReolinkUdpDiscoveryMethodSchema.optional(),
  /**
   * Channel index for cameras that live behind a Hub / NVR. When
   * present (>= 0), the camera class:
   *   1. Skips its own Baichuan login — `ensureApi()` delegates to
   *      the parent Hub's already-warm socket via `parent.getApi()`.
   *   2. Routes per-channel cmd_ids (snapshot / motion / setEnc /
   *      status / reboot / ...) at this channel index instead of
   *      the default 0. Returned by `this.getChannel()`.
   *   3. Skips its own simpleEvent subscription + watchdog — the
   *      Hub owns the subscription and dispatches events into
   *      `handleSimpleEvent` via `routeSimpleEvent`.
   *
   * Standalone cameras (no parent) leave this undefined → channel 0
   * fallback, matching the pre-Hub behavior verbatim.
   */
  channel: z.number().int().nonnegative().optional(),
  /**
   * Cached probe results: autodetect-derived class (Slice 15) +
   * abilities/streams probe (Slice 4). NOT to be confused with the
   * top-level `BaseDevice.features: DeviceFeature[]` array — that one
   * is the public capability list surfaced via `device-manager.getDevice`
   * and lives on the class, not in config. This blob is Reolink-specific
   * persistence so we don't re-probe at every boot.
   *
   * Both `deviceType` and the `hasBattery`/`hasPtz`/… booleans are kept
   * for syntactic convenience downstream — they're always consistent
   * (enforced by the writers).
   */
  deviceCache: z
    .object({
      deviceType: ReolinkDeviceTypeSchema.optional(),
      channelCount: z.number().int().positive().optional(),
      model: z.string().optional(),
      /** Globally-unique Reolink serial number (`getInfo` → cmd 80).
       *  Used as a fallback stableId discriminator when uid is absent. */
      serialNumber: z.string().optional(),
      /** MAC address from `getNetworkInfo` / autodetect's
       *  `hostNetworkInfo.mac`. Used as a stableId discriminator after
       *  uid + serialNumber. Stored as raw firmware-reported string;
       *  the stableId derivation strips separators. */
      mac: z.string().optional(),
      /** Hardware revision string (e.g. "IPC_523128M5MP"). */
      hardwareVersion: z.string().optional(),
      /** Firmware version string. */
      firmwareVersion: z.string().optional(),
      // NOTE: the feature flags (hasPtz/hasIntercom/hasDoorbell/hasFloodlight/
      // hasSiren/hasPirSensor/hasAutotrack/hasBattery) and `probedAt` are
      // NOT declared here but ARE persisted (via `.loose()`) by
      // `probeAndPersistFeatures` → `withPersistedProbe`. The live store is
      // the `feature-probe` runtime-state slice; this persisted copy is what
      // `getAccessoryChildren()` falls back on when a battery camera is
      // asleep at boot and skips its probe.
      /**
       * Snapshot of the current motion-alarm config from
       * `getMotionAlarm` (cmdId=46). Drives the Motion tab's
       * hydrated values + sensitivity-range bounds.
       */
      motionSnapshot: z
        .object({
          enabled: z.boolean().optional(),
          sensitivity: z.number().nullable().optional(),
        })
        .optional(),
      /**
       * Per-AI-class sensitivity + stay-time snapshot from
       * `getAiAlarmRaw` (cmdId=342) for every type the camera
       * advertises in its `getAiDetectTypes` response. Drives the
       * "AI sensitivity" section on the Motion tab — one
       * sensitivity slider per supported class. Empty / missing
       * keys mean the camera doesn't expose that detector.
       */
      aiSensitivitySnapshot: z
        .record(
          z.string(),
          z.object({
            sensitivity: z.number().nullable().optional(),
            stayTime: z.number().nullable().optional(),
            // Min/max target-SIZE gates (fractions of the frame in [0, 1]),
            // read via `getAiDetectionFull` (cmdId=342). Seed the Motion-tab
            // sliders and provide the carry-over value when a consolidated
            // `setAiDetectionFull` writes only the un-touched dimensions.
            minTargetWidth: z.number().nullable().optional(),
            minTargetHeight: z.number().nullable().optional(),
            maxTargetWidth: z.number().nullable().optional(),
            maxTargetHeight: z.number().nullable().optional(),
          }),
        )
        .optional(),
      /**
       * Cached list of AI types the camera advertises
       * (`getAiDetectTypes`). Keys are the canonical lib names —
       * `people`, `vehicle`, `dog_cat`, `face`, `package`. Used
       * to gate which AI sensitivity sliders render.
       */
      aiDetectTypes: z.array(z.string()).optional(),
      /**
       * Snapshot of the camera's image input config from
       * `getVideoInput` (cmdId=49). Drives the Image tab defaults.
       */
      imageSnapshot: z
        .object({
          bright: z.number().nullable().optional(),
          contrast: z.number().nullable().optional(),
          saturation: z.number().nullable().optional(),
          hue: z.number().nullable().optional(),
          irCutSwap: z.number().nullable().optional(),
          dayNight: z.string().optional(),
        })
        .optional(),
      /**
       * Snapshot of the camera's encoder config from `getEnc`
       * (cmdId=56). Drives the Stream/Encoder tab defaults +
       * channel-codec readouts.
       */
      encSnapshot: z
        .object({
          audio: z.number().nullable().optional(),
          mainStream: z
            .object({
              bitRate: z.number().nullable().optional(),
              frameRate: z.number().nullable().optional(),
              videoEncType: z.string().nullable().optional(),
              width: z.number().nullable().optional(),
              height: z.number().nullable().optional(),
              /** Current keyframe interval (`<gop><cur>` seconds) — drives the
               *  GOP slider default. Null when the firmware omits `<gop>`. */
              gop: z.number().nullable().optional(),
            })
            .optional(),
          subStream: z
            .object({
              bitRate: z.number().nullable().optional(),
              frameRate: z.number().nullable().optional(),
              videoEncType: z.string().nullable().optional(),
              width: z.number().nullable().optional(),
              height: z.number().nullable().optional(),
            })
            .optional(),
        })
        .optional(),
      /**
       * Per-profile encoder OPTION lists from `getEncOptions` (the
       * advertised resolution / codec / framerate / bitrate sets).
       * Structurally a `StreamParamsOptions` from `@camstack/types` —
       * persisted so the camera driver's `getSettingsUISchema()` can
       * render the editable Stream section synchronously without an
       * async round-trip. Refreshed by the same probe that fills
       * `encSnapshot`; the `stream-params` cap's `getOptions` keeps
       * its own live read. The profile keys mirror the cap
       * (`main` / `sub` / `ext`).
       */
      encOptionsSnapshot: z
        .object({
          main: ReolinkStreamProfileOptionsSchema.optional(),
          sub: ReolinkStreamProfileOptionsSchema.optional(),
          ext: ReolinkStreamProfileOptionsSchema.optional(),
        })
        .optional(),
      /**
       * Persisted `getOptions` descriptors for the device-config caps
       * (`stream-params`, `motion-zones`, `privacy-mask`, `day-night`,
       * `image-settings`, `ptz`), keyed by cap name.
       *
       * WHY: the device-detail aggregate (`deviceManager.getDeviceAggregate`)
       * calls `getOptions` + `getStatus` on EVERY bound device-config cap,
       * and the admin UI polls it every 2.5s while the Config tab is open.
       * Un-cached, that is ~7 Baichuan round-trips every 2.5s — which keeps
       * a battery camera permanently awake and wakes a sleeping one on a
       * plain page visit. These descriptors are static per camera model
       * (advertised ranges / codec sets / supported axes), so they are read
       * once, persisted here, and served from the blob until the TTL
       * expires (see `ReolinkCamera.resolveCapOptions`).
       *
       * `value` is intentionally `unknown`: this blob stays self-contained
       * (no cross-package schema identity — same rationale as
       * `ReolinkStreamProfileOptionsSchema` above). The reader validates
       * each entry with the cap's own Zod schema, so a stale/incompatible
       * shape is discarded instead of cast.
       */
      capOptionsSnapshot: z
        .record(
          z.string(),
          z.object({
            value: z.unknown(),
            fetchedAt: z.number(),
          }),
        )
        .optional(),
      /**
       * Snapshot of the camera's privacy mask master switch from
       * `getMask` (cmdId=52). Zone editing is a separate flow —
       * we only expose the master enable.
       */
      maskSnapshot: z
        .object({
          enabled: z.boolean().nullable().optional(),
        })
        .optional(),
      /**
       * Snapshot of the camera's audio noise reduction config
       * from `getAudioNoise` (cmdId=439).
       */
      audioNoiseSnapshot: z
        .object({
          enabled: z.boolean().nullable().optional(),
          level: z.number().nullable().optional(),
        })
        .optional(),
      /**
       * Snapshot of the camera's auto-focus state from
       * `getAutoFocus` (cmdId=224). `supported=false` when the
       * probe returns nothing — used to gate the AutoFocus
       * section in the UI so non-zoom cams don't see it.
       */
      autoFocusSnapshot: z
        .object({
          enabled: z.boolean().nullable().optional(),
          supported: z.boolean().optional(),
        })
        .optional(),
      /**
       * Snapshot of the camera's OWN email/SMTP config read from the device
       * via `getEmail` (cmd 42) + `getEmailTask` (cmd 216). Lets the Email
       * Push settings section render the camera's CURRENT mail config
       * synchronously (the read itself wakes a battery cam, so it is on-demand
       * via the Refresh button, never auto). Mirrors the manager app's
       * Email Push tab. `lastReadAt = 0` until the first successful read.
       */
      emailConfigSnapshot: z
        .object({
          smtpServer: z.string().optional(),
          smtpPort: z.number().int().nullable().optional(),
          userName: z.string().optional(),
          recipients: z.array(z.string()).optional(),
          ssl: z.boolean().optional(),
          attachmentType: z.string().optional(),
          sendNickname: z.string().optional(),
          /** EmailTask master enable (schedule active). */
          taskEnabled: z.boolean().optional(),
          lastReadAt: z.number().default(0),
        })
        .optional(),
      /**
       * Snapshot of the camera's network service ports from
       * `getNetPort` (cmd_id=37). Drives the Network ports section's
       * hydrated defaults. `server` is the Baichuan control port (the
       * connection `port` config field); the other five are the
       * toggleable service ports.
       */
      netPortSnapshot: z
        .object({
          http: z
            .object({
              enable: z.boolean().optional(),
              port: z.number().int().nullable().optional(),
            })
            .optional(),
          https: z
            .object({
              enable: z.boolean().optional(),
              port: z.number().int().nullable().optional(),
            })
            .optional(),
          rtsp: z
            .object({
              enable: z.boolean().optional(),
              port: z.number().int().nullable().optional(),
            })
            .optional(),
          rtmp: z
            .object({
              enable: z.boolean().optional(),
              port: z.number().int().nullable().optional(),
            })
            .optional(),
          onvif: z
            .object({
              enable: z.boolean().optional(),
              port: z.number().int().nullable().optional(),
            })
            .optional(),
          server: z.object({ port: z.number().int().nullable().optional() }).optional(),
        })
        .optional(),
      /**
       * Snapshot of the camera's NTP / time-sync config. Populated once
       * the native nodelink-js NTP read lands (see the TODO(nodelink-ntp)
       * marker in `reolink-camera.ts`); drives the Time / NTP section's
       * hydrated defaults.
       */
      ntpSnapshot: z
        .object({
          enabled: z.boolean().optional(),
          server: z.string().optional(),
          port: z.number().int().nullable().optional(),
          interval: z.number().int().nullable().optional(),
        })
        .optional(),
      /**
       * Snapshot of the camera's SystemGeneral (`getSystemGeneral`, cmd 104).
       * `timeZone` is the numeric POSIX offset in seconds (UTC+1 → -3600);
       * used to SEED the Timezone picker from the camera's current zone.
       */
      systemGeneralSnapshot: z
        .object({
          timeZone: z.number().optional(),
        })
        .optional(),
      /**
       * Snapshot of the camera's OSD overlay config from `getOsd` (cmd_id
       * 44) — the command modern Reolink firmwares actually answer for the
       * overlays. Before `@apocaliss92/nodelink-js` 0.7.0 that method was a
       * placeholder issuing cmd_id 26 (GetImage, the ISP block) and
       * text-grepping it for OSD tags it does not contain; every camera
       * therefore reported the same fabricated tuple. `channelName`
       * is the text overlay; `channelEnabled` / `timeEnabled` toggle the two
       * overlays; `watermark` is the camera's `<enWatermark>` flag, which
       * lives inside the channel-name block on the wire.
       */
      osdSnapshot: z
        .object({
          channelEnabled: z.boolean().nullable().optional(),
          channelName: z.string().optional(),
          timeEnabled: z.boolean().nullable().optional(),
          watermark: z.boolean().nullable().optional(),
          /**
           * Overlay anchors exactly as the camera reported them (cmd_id 44).
           * Each axis is a normalised 16.16 coordinate: the start edge is 0
           * (some firmwares echo 1) and the far edge is 65536 (= 1.0).
           * Tri-state: `null` means the camera did not report the axis. The
           * library's `readOsdPosition` decodes a pair into a corner, or
           * reports it as a custom placement, and only the four corner pairs
           * are ever written back.
           */
          channelX: z.number().nullable().optional(),
          channelY: z.number().nullable().optional(),
          timeX: z.number().nullable().optional(),
          timeY: z.number().nullable().optional(),
          /**
           * Wall-clock ms when this slice last landed from the camera.
           * Absent on snapshots persisted before freshness tracking —
           * `isOsdSnapshotStale` treats those as stale, which retires the
           * adoption-frozen readings this stamp was added for (D224).
           */
          fetchedAt: z.number().int().optional(),
        })
        .optional(),
      /**
       * Snapshot of the camera's status + doorbell LED state from
       * `getIrLights` (cmd_id 208). The IR LED itself is the operator-
       * facing `irLightsState`; these two are the separate
       * `<lightState>` (status/power LED) + `<doorbellLightState>`
       * fields. `doorbellSupported` gates the doorbell-LED toggle so
       * non-doorbell cams don't show a no-op control.
       */
      ledSnapshot: z
        .object({
          statusEnabled: z.boolean().nullable().optional(),
          doorbellEnabled: z.boolean().nullable().optional(),
          doorbellSupported: z.boolean().optional(),
        })
        .optional(),
      /**
       * Snapshot of the camera's PIR config from `getPirInfo`
       * (cmd_id 212). Only the `reduceFalseAlarm` toggle is surfaced in
       * the parent settings form (PIR sensitivity/interval live on the
       * PIR accessory child). `supported=false` when the probe returns
       * nothing — gates the section so non-PIR cams don't see it.
       */
      pirSnapshot: z
        .object({
          reduceFalseAlarm: z.boolean().nullable().optional(),
          supported: z.boolean().optional(),
        })
        .optional(),
      /**
       * Snapshot of the camera's auto-reboot schedule from
       * `getAutoReboot` (cmd_id 101). Drives the "Auto reboot" section
       * defaults on the Advanced tab. `weekDay` is the lib's `DayOfWeek`
       * string. `supported=false` when the probe errors — gates the
       * section so models without the maintenance schedule hide it.
       */
      autoRebootSnapshot: z
        .object({
          enabled: z.boolean().nullable().optional(),
          weekDay: z.string().optional(),
          hour: z.number().int().nullable().optional(),
          minute: z.number().int().nullable().optional(),
          supported: z.boolean().optional(),
        })
        .optional(),
      /**
       * Per-snapshot freshness stamps (D224 generalised, D346): wall-clock
       * ms when each `*Snapshot` group in this cache was last WRITTEN from
       * a camera read, keyed by the group's field name (`encSnapshot`,
       * `osdSnapshot`, …). Written only by the persist sites that write
       * the group itself (`stampSnapshotFreshness`) — a failed probe
       * writes no snapshot and gets no stamp. A group with no entry here
       * (legacy persist) is of UNKNOWN age and must never read as fresh;
       * `resolveSnapshotAge` owns the tri-state.
       */
      snapshotFetchedAt: z.record(z.string(), z.number().int()).optional(),
    })
    .loose()
    .optional(),
  /**
   * Generic Baichuan debug logs. Forwarded as `DebugOptions.general`
   * on the lib's `ReolinkBaichuanApi` constructor.
   */
  debugGeneral: z.boolean().default(false),
  /**
   * Lib-side socket trace categories. Each flag flips the matching
   * `DebugOptions.<flag>` on the api.
   */
  debugSocketLogs: z.array(ReolinkSocketDebugFlagSchema).default([]),
  /**
   * Trigger types enabled in the camera's email-push schedule when
   * Auto-configuring battery-cam motion push. Reolink firmware names:
   * `MD` (motion), `people`, `vehicle`, `dog_cat` (animal), `face`,
   * `package`. The Auto-configure flow patches each listed type's email
   * schedule to 24/7. Empty / unset falls back to MD + people + vehicle.
   */
  emailPushTriggers: z.array(z.string()).optional(),
  /**
   * Attachment kind the camera includes in the motion email. We don't
   * use the attachment (a live snapshot is fetched instead), but
   * `picture` keeps the email small + the camera's send path reliable.
   */
  emailPushAttachment: z.enum(['picture', 'video', 'none']).optional(),
  /**
   * Which sleep-push path to prefer when both HaCfg webhook and Email/SMTP
   * are available. `auto` (default) picks webhook when cmd 806 probes
   * supported, else email. Only one path should be armed so both do not
   * fire into `handleSimpleEvent`.
   */
  batterySleepPushMethod: z.enum(['auto', 'webhook', 'email']).optional(),
  /**
   * On-camera motion detection master switch + sensitivity.
   * Pushed via `setMotionAlarm` (cmdId=47). The Reolink mobile
   * app + camera web UI use 1..50 (1 = least sensitive,
   * 50 = most sensitive). The camera-side raw value is the
   * INVERSE of the displayed value (`raw = 51 - value`) — same
   * convention as reolink_aio's `set_md_sensitivity`. The
   * driver does the conversion both on push (in
   * `applySettingsPatch`) and on read (in
   * `refreshParentSettingsSnapshot`), so this field is always
   * the user-facing value.
   */
  motionEnabled: z.boolean().optional(),
  motionSensitivity: z.number().int().min(1).max(50).optional(),
  /**
   * Per-device clip-catalog refresh interval, in minutes — the OVERRIDE half
   * of the cascade whose global default lives in the addon store under the
   * same key. Absent means "use the global", which is the same thing a reset
   * means (`resolveClipCatalogRefreshMinutes`, D562). `0` turns the timer off
   * for this camera. What the timer DOES with it differs by topology and the
   * field description says both: a free read on a hub child and on mains, and
   * stale-marking only on a standalone battery camera.
   */
  clipCatalogRefreshMinutes: z.number().int().min(0).max(1440).optional(),
  /**
   * Let the clip timer WAKE this standalone battery camera. Off by default and
   * per device only — a 15-minute forced timer is 96 wakes/day against a
   * natural rate of 1–20 clips/day on this fleet (D562). Inert on every other
   * topology, which is why it is one switch and not a second meaning.
   */
  clipCatalogForcedWake: z.boolean().optional(),
  /**
   * Battery cameras only: the window, in minutes, in which the camera refreshes
   * ALL its metadata and its cached snapshot exactly once (D847). Absent means
   * the default (60); `0` turns the scheduled refresh off for this camera; a
   * value is clamped to 15..240 (below the 6 h presence budget).
   */
  batteryRefreshMinutes: z.number().int().min(0).max(240).optional(),
  /**
   * Per-AI-class sensitivity overrides — pushed via
   * `setAiDetection(aiType, sensitivity)` (cmdId=343). Reolink
   * range 0..100 — same scale the reolink_aio CGI exposes
   * (`set_ai_sensitivity` validates 0..100). Each field gates on
   * the matching `cache.aiDetectTypes` entry. Keys mirror the
   * lib's canonical names (people / vehicle / animal=dog_cat /
   * face / package) so the dispatcher can fan them out via the
   * lib `setAiDetection(aiType, ...)` overload.
   */
  aiPersonSensitivity: z.number().int().min(0).max(100).optional(),
  aiVehicleSensitivity: z.number().int().min(0).max(100).optional(),
  aiAnimalSensitivity: z.number().int().min(0).max(100).optional(),
  aiFaceSensitivity: z.number().int().min(0).max(100).optional(),
  aiPackageSensitivity: z.number().int().min(0).max(100).optional(),
  /**
   * Per-AI-class stay-time (dwell, seconds) overrides — pushed via
   * `setAiDetection(channel, aiType, sensitivity, stayTime)` (cmdId=343).
   * The same setter that carries `sensitivity`: the dispatcher reads the
   * current sensitivity from the AI snapshot first so a stayTime-only edit
   * doesn't clobber it (and vice-versa). Keys mirror the lib's canonical
   * AI names (people / vehicle / animal=dog_cat / face / package) so each
   * field gates on the matching `cache.aiDetectTypes` entry. Range mirrors
   * the camera's `<AiDetectCfg><stayTime>` seconds field (0..600 is a safe
   * superset of every firmware we've probed; the camera clamps internally).
   */
  aiPersonStayTime: z.number().int().min(0).max(600).optional(),
  aiVehicleStayTime: z.number().int().min(0).max(600).optional(),
  aiAnimalStayTime: z.number().int().min(0).max(600).optional(),
  aiFaceStayTime: z.number().int().min(0).max(600).optional(),
  aiPackageStayTime: z.number().int().min(0).max(600).optional(),
  /**
   * Per-AI-class min/max target-SIZE gates — pushed via
   * `setAiDetectionFull(channel, aiType, { minTargetWidth, minTargetHeight,
   * maxTargetWidth, maxTargetHeight, sensitivity, stayTime })` (cmdId=343,
   * the SAME setter that carries sensitivity + stayTime — consolidated into
   * one round-trip so a target-size edit doesn't clobber sens/stay and
   * vice-versa). Each value is a FRACTION of the frame in [0, 1]: an object
   * whose bounding box is smaller than the min or larger than the max is
   * ignored by the camera's AI. The camera serializes these in scientific
   * notation (`5.000000e-01`); the lib formats that. Width and height are
   * independent axes, matching the lib's four distinct
   * `min/maxTarget{Width,Height}` fields. Each field gates on the matching
   * `cache.aiDetectTypes` entry; keys mirror the lib's canonical AI names
   * (people / vehicle / animal=dog_cat / face / package).
   */
  aiPersonMinTargetWidth: z.number().min(0).max(1).optional(),
  aiPersonMinTargetHeight: z.number().min(0).max(1).optional(),
  aiPersonMaxTargetWidth: z.number().min(0).max(1).optional(),
  aiPersonMaxTargetHeight: z.number().min(0).max(1).optional(),
  aiVehicleMinTargetWidth: z.number().min(0).max(1).optional(),
  aiVehicleMinTargetHeight: z.number().min(0).max(1).optional(),
  aiVehicleMaxTargetWidth: z.number().min(0).max(1).optional(),
  aiVehicleMaxTargetHeight: z.number().min(0).max(1).optional(),
  aiAnimalMinTargetWidth: z.number().min(0).max(1).optional(),
  aiAnimalMinTargetHeight: z.number().min(0).max(1).optional(),
  aiAnimalMaxTargetWidth: z.number().min(0).max(1).optional(),
  aiAnimalMaxTargetHeight: z.number().min(0).max(1).optional(),
  aiFaceMinTargetWidth: z.number().min(0).max(1).optional(),
  aiFaceMinTargetHeight: z.number().min(0).max(1).optional(),
  aiFaceMaxTargetWidth: z.number().min(0).max(1).optional(),
  aiFaceMaxTargetHeight: z.number().min(0).max(1).optional(),
  aiPackageMinTargetWidth: z.number().min(0).max(1).optional(),
  aiPackageMinTargetHeight: z.number().min(0).max(1).optional(),
  aiPackageMaxTargetWidth: z.number().min(0).max(1).optional(),
  aiPackageMaxTargetHeight: z.number().min(0).max(1).optional(),
  /**
   * Image controls — pushed via `setImage` (cmd_id=25, read via 26).
   * Reolink ranges are 0..100 for the core sliders. Undefined → the
   * driver doesn't push that slider on save and the camera keeps its
   * existing value (operator never wrote it).
   */
  imgBright: z.number().int().min(0).max(255).optional(),
  imgContrast: z.number().int().min(0).max(255).optional(),
  imgSaturation: z.number().int().min(0).max(255).optional(),
  imgHue: z.number().int().min(0).max(255).optional(),
  imgSharpen: z.number().int().min(0).max(255).optional(),
  /**
   * ISP (advanced image) — pushed via `setIsp` (cmd_id=25 +
   * cmd_id=297 for dayNightThreshold). dayNight values are
   * camera-specific enum strings; the driver normalizes case
   * before push.
   */
  ispDayNight: z.string().optional(),
  ispExposure: z.string().optional(),
  ispHdr: z.union([z.literal(0), z.literal(1)]).optional(),
  ispBinningMode: z.number().int().min(0).optional(),
  ispDayNightThreshold: z.number().int().min(0).max(255).optional(),
  /**
   * IR + status LED — pushed via `setIrLights` (cmd_id=209, read via
   * cmd_id=208). Operator-friendly enums; the driver normalizes to
   * the camera's `open`/`close` lowercase form before push.
   */
  irLightsState: z.enum(['On', 'Off', 'Auto']).optional(),
  irLightsBrightness: z.number().int().min(0).max(255).optional(),
  /**
   * Status LED + doorbell LED — same `setIrLights` (cmd_id 209, read via
   * 208) call as the IR fields above. The lib accepts the friendly
   * `'On' | 'Off'` strings and normalises to the camera-side
   * `open`/`close` form. `statusLedEnabled` drives `<LedState><lightState>`
   * (the visible status/power LED); `doorbellLedEnabled` drives
   * `<doorbellLightState>` (only meaningful on doorbell models — non-
   * doorbell firmwares silently ignore the field). Booleans here →
   * `'On'`/`'Off'` at push time.
   */
  statusLedEnabled: z.boolean().optional(),
  doorbellLedEnabled: z.boolean().optional(),
  // On-screen display (OSD) overlay: deliberately NO `osd*` config keys.
  // The camera is the only authority (D62/D224-shape) — the form's `osd*`
  // patch keys are written straight to the camera via a read-modify-write
  // `setOsd` (cmd_id 25) and re-read into `deviceCache.osdSnapshot`; a
  // stored copy here shadowed the camera forever after one CamStack write.
  // Legacy stored values are stripped by this schema on the next re-parse.
  /**
   * Audio output volume — pushed via `setAudioCfg` (cmd_id=265,
   * read via 264). Reolink-spec range 0..100.
   */
  audioVolume: z.number().int().min(0).max(100).optional(),
  audioTalkAndReplyVolume: z.number().int().min(0).max(100).optional(),
  audioVisitorVolume: z.number().int().min(0).max(100).optional(),
  /**
   * Network service ports — pushed via `setPortConfig` (cmd_id 36,
   * read via cmd_id 37). Each protocol has an enable flag + a port
   * number. The Baichuan/server port is the connection `port` field
   * above — not duplicated here. Changing a port number breaks
   * existing URLs for that protocol until consumers are reconfigured.
   */
  netHttpEnable: z.boolean().optional(),
  netHttpPort: z.number().int().min(1).max(65535).optional(),
  netHttpsEnable: z.boolean().optional(),
  netHttpsPort: z.number().int().min(1).max(65535).optional(),
  netRtspEnable: z.boolean().optional(),
  netRtspPort: z.number().int().min(1).max(65535).optional(),
  netRtmpEnable: z.boolean().optional(),
  netRtmpPort: z.number().int().min(1).max(65535).optional(),
  netOnvifEnable: z.boolean().optional(),
  netOnvifPort: z.number().int().min(1).max(65535).optional(),
  /**
   * Network time (NTP). Persisted to the driver config now; the
   * camera-side push activates once the native nodelink-js NTP commands
   * land — see the `TODO(nodelink-ntp)` markers in `reolink-camera.ts`.
   * `ntpInterval` is the sync interval in minutes.
   */
  ntpEnabled: z.boolean().optional(),
  ntpServer: z.string().max(253).optional(),
  ntpPort: z.number().int().min(1).max(65535).optional(),
  ntpInterval: z.number().int().min(1).max(10080).optional(),
  /**
   * IANA timezone id (e.g. 'Europe/Rome') selected via the friendly
   * Timezone picker in the Time/NTP section. Resolved through
   * `findTimezone` and pushed to the camera as the standard UTC offset
   * (`setSystemGeneral.timeZone`) + a DST rule (`setDst`) on save.
   */
  timeZoneId: z.string().optional(),
  // Stream/Encoder config (bitrate / framerate / codec / resolution
  // / audio) is now owned by the `stream-params` device cap — see
  // `registerStreamParamsCap()` in `reolink-camera.ts`. The cap reads
  // option lists live off `getEncOptions` and pushes via `setEnc`, so
  // there are no static `streamMain*`/`streamSub*` config keys here
  // any more (the old read-only form fields were removed with it).
  /**
   * Privacy mask master switch — pushed via `setMask` (cmd_id 53,
   * read via 52). Toggles the `<Shelter><enable>` flag. Zone
   * editing is a separate flow not exposed by this driver.
   */
  /**
   * Audio noise reduction level — pushed via `setAudioNoise`
   * (cmd_id 440, read via 439). 0 disables; 1..3 maps to
   * Reolink's low/medium/high. Lib treats `level <= 0` as off
   * and any positive value as on with that strength.
   */
  audioNoiseLevel: z.number().int().min(0).max(3).optional(),
  /**
   * Auto-focus master switch — pushed via `setAutoFocus`
   * (cmd_id 225). UI-friendly polarity (true = AF on, false =
   * AF off); the driver inverts before push because the
   * camera-side field is named `disable`. Only rendered when
   * `deviceCache.autoFocusSnapshot.supported === true`.
   */
  autoFocusEnabled: z.boolean().optional(),
  /**
   * PIR reduce-false-alarm toggle — pushed via `setPirInfo`
   * (cmd_id 213, read via 212) as the `reduceAlarm` field. Distinct from
   * the PIR accessory child's sensitivity/interval controls: this is the
   * camera's PIR false-positive filter. The lib's `setPirInfo` requires
   * `enable` in the payload, so the dispatcher reads the current PIR
   * enable + sensitivity from `getPirInfo` before pushing so a
   * reduce-alarm-only edit doesn't disable PIR or reset its sensitivity.
   * Only meaningful on PIR-equipped models — non-PIR cams silently no-op.
   */
  pirReduceFalseAlarm: z.boolean().optional(),
  /**
   * Keyframe interval / GOP (seconds) for the main stream — pushed via
   * `setEnc` (cmd_id 57, read via 56) as `mainStream.gop`. The published
   * nodelink-js `EncStreamPatch` exposes `gop` (sets `<gop><cur>`); the
   * setter does a read-modify-write so the other encoder dimensions
   * (resolution / bitrate / framerate / codec — owned by the
   * `stream-params` cap) stay put. Range mirrors the camera's typical
   * `<gop>` bounds (1..10s on every firmware probed); the camera clamps
   * to its advertised `{min,max}` internally.
   */
  gop: z.number().int().min(1).max(10).optional(),
  /**
   * Auto-reboot schedule — pushed via `setAutoReboot` (cmd_id 100, read
   * via 101). `setAutoReboot` does a read-modify-write of the
   * `<AutoReboot>` block (`enable`/`weekDay`/`hour`/`minute`/`second`),
   * so a partial patch is safe. `autoRebootWeekDay` mirrors the lib's
   * `DayOfWeek` union — the seven day names plus `everyday`; the
   * dispatcher maps the form string straight through. Disabling keeps
   * the stored day/time so re-enabling restores the schedule.
   */
  autoRebootEnabled: z.boolean().optional(),
  autoRebootWeekDay: z
    .enum([
      'everyday',
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ])
    .optional(),
  autoRebootHour: z.number().int().min(0).max(23).optional(),
  autoRebootMinute: z.number().int().min(0).max(59).optional(),
  /**
   * Intercom (browser→cam talk channel) tuning. Only consumed
   * when the camera advertises two-way audio (`hasIntercom` in the
   * feature-probe slice). The names, ranges and defaults are the ones
   * the lib itself documents, so the user-facing latency is predictable.
   *
   * `intercomBlocksPerPayload` — number of IMA-ADPCM blocks bundled
   * into each `sendAudio` call against the lib's dedicated talk
   * session. Lower = smaller chunks, more sends/sec, lower latency.
   * Higher = fewer sends, less per-call socket overhead. Default 1
   * = lowest latency.
   */
  intercomBlocksPerPayload: z.number().int().min(1).max(8).optional(),
  /**
   * `intercomMaxBacklogMs` — bound on the PCM backlog before the
   * pump drops oldest samples to cap latency. Default 120ms; raise
   * via the Settings UI on systems where the cross-
   * process Opus→PCM path is bursty enough to trigger frequent
   * `intercom backlog clamped` warnings.
   */
  intercomMaxBacklogMs: z.number().int().min(20).max(5000).optional(),
  /**
   * `intercomGain` — output gain multiplier applied to s16le PCM
   * samples before IMA-ADPCM encode. 1.0 = neutral; 2.0 ≈ +6dB;
   * 0.5 ≈ -6dB. Sample clipping is hard-capped at int16 bounds.
   */
  intercomGain: z.number().min(0.1).max(10).optional(),
})

export type ReolinkCameraConfig = z.infer<typeof reolinkCameraSchema>

/**
 * Hub / NVR config schema. The Hub holds the long-lived Baichuan
 * control + event channel (one socket per device, not per child) and
 * acts as the discovery source for the channels populated behind it.
 * Streaming and per-channel settings live on the child `ReolinkCamera`
 * instances; this schema only carries connection + debug + the cached
 * channels summary so we can re-render the Discovery panel offline.
 *
 * The NVR device's own settings scope and fields, just
 * adapted to the Zod conventions used elsewhere in this package.
 */
export const reolinkHubSchema = z.object({
  host: z.string().describe('Hub IP or hostname'),
  port: z.number().default(9000).describe('Baichuan port (default 9000)'),
  username: z.string().default('admin'),
  password: z.string().meta({ secret: true }),
  /** Hubs are TCP-only on supported firmwares — kept here for symmetry. */
  transport: z.enum(['tcp', 'udp']).default('tcp'),
  /** UID is unused on Hubs (no UDP discovery), but persisted for symmetry. */
  uid: z.string().optional(),
  /** Lib-side socket trace categories. Same flag set as the camera schema. */
  debugGeneral: z.boolean().default(false),
  debugSocketLogs: z.array(ReolinkSocketDebugFlagSchema).default([]),
  /**
   * Cached probe results. `channelCount` is authoritative for the
   * Discovery panel's "X channels" badge; `model` is what autodetect
   * read from `getInfo` (e.g. "Reolink Home Hub").
   */
  deviceCache: z
    .object({
      deviceType: z.literal('nvr').optional(),
      channelCount: z.number().int().positive().optional(),
      model: z.string().optional(),
      /** Globally-unique Reolink serial; `getInfo` cmd 80. Stable id
       *  fallback after uid. Hub firmware sometimes returns a sentinel
       *  `00000000000000` — `generateStableId`'s isMeaningfulIdentifier
       *  filters that out. */
      serialNumber: z.string().optional(),
      /** MAC address from `getNetworkInfo` / autodetect's
       *  `hostNetworkInfo.mac`. Stable id fallback after serial. */
      mac: z.string().optional(),
      hardwareVersion: z.string().optional(),
      firmwareVersion: z.string().optional(),
      probedAt: z.number().optional(),
    })
    .loose()
    .optional(),
})

export type ReolinkHubConfig = z.infer<typeof reolinkHubSchema>
