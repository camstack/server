import { z } from 'zod'

/**
 * Single source of truth for the addon id used in event-source tags +
 * `device.online`/`device.offline` payloads. Kept in sync with the
 * provider's `addonId` field manually — both must match for the
 * device-manager + alert-center to correlate events back to the
 * provider that produced them.
 */
export const HIKVISION_ADDON_ID = 'provider-hikvision'

/**
 * Default ISAPI channel for single-camera devices. Hikvision encodes
 * channels as `{cameraNumber}{streamSlot}` — `101` is camera 1 / main
 * stream, `102` is camera 1 / sub-stream. Multi-channel NVRs use
 * `201` / `202` for camera 2 etc. The `DEFAULT_CAMERA_NUMBER`
 * is the offset we feed into stream-id derivation when no per-channel
 * routing context exists (probe, snapshot, single-camera devices).
 */
export const DEFAULT_CAMERA_NUMBER = 1

/**
 * Hikvision smart-detection class strings observed in alarm XML.
 * Mapped to the loose camstack `CameraNativeDetection.className`
 * convention so other providers (Reolink) emit the same
 * strings for the same physical concept.
 */
export const HIKVISION_AI_CLASS_MAP: Readonly<Record<string, string>> = {
  human: 'person',
  vehicle: 'vehicle',
  pedestrian: 'person',
  car: 'vehicle',
  animal: 'animal',
  face: 'face',
}

/**
 * Lib-side debug categories. Mirrors Reolink's `debugSocketLogs`
 * pattern — flips per-area request/response logging in the ISAPI
 * client without restarting the device. Each flag turns on a focused
 * trace stream in `HikvisionIsapiClient`.
 */
export const HikvisionDebugFlagSchema = z.enum(['debugIsapi', 'traceAlarmStream', 'traceSnapshot'])

export type HikvisionDebugFlag = z.infer<typeof HikvisionDebugFlagSchema>

/**
 * Live snapshot of the supplemental light state, refreshed at probe time
 * and after an in-form light push. Drives the parent Light tab's hydrated
 * values. Each field is optional — different firmware exposes different
 * subsets.
 */
export const HikvisionLightSnapshotSchema = z.object({
  mode: z.string().optional(),
  whiteLightBrightness: z.number().nullable().optional(),
  irLightBrightness: z.number().nullable().optional(),
  brightnessRegulatorMode: z.enum(['auto', 'manual']).nullable().optional(),
})

/**
 * Image-tuning snapshot: color (brightness/contrast/saturation/sharpness
 * 0..100), WDR (enable + level), IR-cut filter mode. Probed on connect and
 * re-read after an in-form image push; drives the Image settings tab's
 * hydrated values. Each sub-field is optional — legacy firmwares 404 on
 * individual sub-resources.
 */
export const HikvisionImageSnapshotSchema = z.object({
  brightness: z.number().nullable().optional(),
  contrast: z.number().nullable().optional(),
  saturation: z.number().nullable().optional(),
  sharpness: z.number().nullable().optional(),
  wdrEnabled: z.boolean().optional(),
  wdrLevel: z.number().nullable().optional(),
  ircutMode: z.string().optional(),
})

/**
 * Time / NTP snapshot: sync mode (`NTP`/`manual`), opaque timezone string,
 * and the NTP server/port/interval. Probed on connect via `getTimeConfig()`
 * and re-read after an in-form time push; hydrates the Time / NTP settings
 * section.
 */
export const HikvisionNtpSnapshotSchema = z.object({
  timeMode: z.string().optional(),
  timeZone: z.string().optional(),
  ntpServer: z.string().nullable().optional(),
  ntpPort: z.number().nullable().optional(),
  syncInterval: z.number().nullable().optional(),
  // Camera's current local wall-clock as reported by `<localTime>`
  // (zoned ISO-8601). Seeds the "Manual date & time" picker so it shows
  // the time the camera is actually displaying, instead of an empty field.
  localTime: z.string().nullable().optional(),
})

export type HikvisionLightSnapshot = z.infer<typeof HikvisionLightSnapshotSchema>
export type HikvisionImageSnapshot = z.infer<typeof HikvisionImageSnapshotSchema>
export type HikvisionNtpSnapshot = z.infer<typeof HikvisionNtpSnapshotSchema>

/**
 * Persisted per-device cache of the last successful probe — saves a
 * round-trip on every reconnect by remembering whether the camera is
 * a single-channel or NVR, the model string, and the firmware
 * version. Mirrors Reolink's `deviceCache` blob — same purpose, same
 * "trust but refresh on capability mismatch" semantics.
 */
export const HikvisionDeviceCacheSchema = z
  .object({
    deviceType: z.enum(['camera', 'nvr']).optional(),
    model: z.string().optional(),
    serialNumber: z.string().optional(),
    firmwareVersion: z.string().optional(),
    /** Hikvision firmware version detail (`firmwareVersionInfo` field —
     *  e.g. `B-R-G5-0`). Surfaced in the hardware metadata blob. */
    firmwareVersionInfo: z.string().optional(),
    /** ISAPI `<hardwareVersion>` — typically `0x0` on consumer units; kept
     *  for completeness so the metadata sub-tab can show whatever the
     *  firmware advertises. */
    hardwareVersion: z.string().optional(),
    /** ISAPI `<deviceType>` (e.g. `IPCamera`, `NVR`). Driver-side cache. */
    isapiDeviceType: z.string().optional(),
    /** Hardware MAC address (no separators, lowercased) from
     *  `/ISAPI/System/Network/interfaces/1`. Drives `generateStableId` so
     *  re-adding the same device by IP after a DHCP renewal lands on the
     *  same row. */
    mac: z.string().optional(),
    channelCount: z.number().int().positive().optional(),
    hasPtz: z.boolean().optional(),
    hasSupplementalLight: z.boolean().optional(),
    /**
     * Modes the supplemental light advertises in
     * `/ISAPI/Image/channels/{cam}/supplementLight/capabilities`. Persisted
     * so the LightAccessory can render a "mode" select with the camera-
     * specific options (`colorVuWhiteLight`, `manual`, `irLight`, `mixed`,
     * `auto`, ...) without a fresh probe on every settings open.
     */
    lightSupportedModes: z.array(z.string()).optional(),
    /**
     * Default "on" mode picked at probe time. The LightAccessory uses this
     * as the schema default for its `mode` setting; operator-driven changes
     * persist on the accessory's own config row.
     */
    lightDefaultMode: z.string().optional(),
    /**
     * True when the supplemental light has at least one operator-driven
     * white-light mode (`colorVuWhiteLight`, `whiteLight`, `manual`, or
     * `mixed`). IR-only models (`irLight,close`) report false — the
     * camera's IR LEDs are auto-driven by the light sensor and there's
     * no meaningful operator switch, so we don't spawn a child Switch /
     * Light accessory device for them. Their tuning lives on the
     * parent's Light tab instead.
     */
    lightHasWhiteLight: z.boolean().optional(),
    /**
     * Live snapshot of the supplemental light state, refreshed at probe
     * time. Drives the parent Light tab's hydrated values. Each field
     * is optional — different firmware exposes different subsets.
     */
    lightSnapshot: HikvisionLightSnapshotSchema.optional(),
    hasAlarmIo: z.boolean().optional(),
    /**
     * Alarm input ports the camera enumerates via `/ISAPI/System/IO/inputs`.
     * Persisted so the SirenAccessory can render a "port" select with valid
     * ids on multi-input cameras; single-port devices stay on `1`.
     */
    alarmInputPorts: z.array(z.number().int().positive()).optional(),
    /**
     * True when the firmware exposes
     * `/ISAPI/PTZCtrl/channels/{cam}/smartTracking` (autotrack
     * subsystem). Drives `DeviceFeature.PtzAutotrack` + the
     * `ptz-autotrack` cap registration on the parent camera.
     */
    hasAutotrack: z.boolean().optional(),
    /** Whether the firmware accepts the `<duration>` knob — set at probe
     *  time. Used by the cap's `setSettings` to decide whether to push
     *  `stopDelaySeconds`. */
    autotrackSupportsDuration: z.boolean().optional(),
    /** Whether the firmware accepts the `<smartTrackingType>` knob. */
    autotrackSupportsType: z.boolean().optional(),
    /**
     * True when the camera advertises at least one TwoWayAudio channel
     * via `/ISAPI/System/TwoWayAudio/channels`. Drives
     * `DeviceFeature.TwoWayAudio` + the `intercom` cap registration.
     */
    hasIntercom: z.boolean().optional(),
    /**
     * The `privacy-mask` cap's per-camera AVAILABILITY facts, as the last
     * successful read saw them.
     *
     * Persisted for the same reason Reolink persists its `capOptionsSnapshot`:
     * `privacyMask.getOptions` sits on a POLLED path (the admin Cameras badge
     * asks it per camera every 5s), and these describe what the model can do —
     * they change on a firmware update, not during operation. Reading them from
     * here costs no ISAPI round trip, and it survives an addon restart, which
     * an in-process value does not.
     *
     * They come out of the SAME two reads that build the cap's status slice, so
     * they cannot drift from it.
     */
    privacyMaskOptions: z
      .object({
        /** Zones the firmware advertises. */
        maxRegions: z.number().int().nonnegative(),
        /** True only when a streaming channel reported an audio flag we can
         *  patch — a switch that writes nothing must never be offered. */
        supportsAudioMute: z.boolean(),
        /** Epoch ms of the read that produced this. */
        fetchedAt: z.number(),
      })
      .optional(),
    /** ISAPI codec the firmware reports for the talk channel (e.g.
     *  `G.711ulaw`, `G.711alaw`). Persisted so the intercom session
     *  doesn't have to re-discover on every open. Optional — discovery
     *  re-runs at session start regardless. */
    intercomAudioCompressionType: z.string().optional(),
    /**
     * Audio TwoWayAudio capabilities snapshot from `/capabilities`.
     * Drives the Audio settings tab's select options (codec / input
     * type) + slider bounds (speaker volume) without re-probing on
     * every form open. Refreshed at every successful connect.
     */
    audioCapabilities: z
      .object({
        audioCodecs: z.array(z.string()).default([]),
        audioInputTypes: z.array(z.string()).default([]),
        speakerVolumeMin: z.number().int().default(0),
        speakerVolumeMax: z.number().int().default(100),
        supportsNoiseReduction: z.boolean().default(false),
      })
      .optional(),
    /**
     * Per-channel streaming snapshot keyed by Hikvision channel id
     * (`'101'` = camera-1 main, `'102'` = sub, `'103'` = third). The
     * camera's `/ISAPI/Streaming/channels` enumeration drives this list
     * — we probe every entry it returns. Drives the Stream settings
     * tab: per-channel sub-tab is rendered dynamically off this map's
     * keys. Range bounds (vbr/cbr/govLength) are firmware-advertised
     * via the same probe so each channel's slider honours its own
     * limits (sub-streams typically allow lower max bitrate).
     */
    /**
     * Image-tuning snapshot: color (brightness/contrast/saturation/
     * sharpness 0..100), WDR (enable + level), IR-cut filter mode
     * (day/night/auto/schedule). Probed on connect; drives the Image
     * settings tab's hydrated values. Each sub-field is optional —
     * legacy firmwares 404 on individual sub-resources; we record
     * what we got and the form falls back to safe defaults for the
     * rest.
     */
    imageSnapshot: HikvisionImageSnapshotSchema.optional(),
    /**
     * Time / NTP snapshot: sync mode (`NTP`/`manual`), opaque timezone
     * string, and the NTP server/port/interval. Probed on connect via
     * `getTimeConfig()`; hydrates the Time / NTP settings section.
     * Best-effort — the NTP sub-fields stay undefined on firmwares that
     * lack the `/ntpServers` endpoint.
     */
    ntpSnapshot: HikvisionNtpSnapshotSchema.optional(),
    streamSnapshots: z
      .record(
        z.string(),
        z.object({
          channelName: z.string().nullable().optional(),
          /**
           * The CHANNEL's own `<enabled>` — read element-scoped via
           * `readStreamingChannelEnabled`, never the `<Video>` / `<Audio>`
           * sub-element flag that shares the tag name. Drives the
           * "disabled on camera" hint on the snapshot-source select.
           */
          enabled: z.boolean().optional(),
          videoCodecType: z.string().nullable().optional(),
          maxFrameRate: z.number().nullable().optional(),
          videoQualityControlType: z.enum(['VBR', 'CBR']).nullable().optional(),
          vbrUpperCap: z.number().nullable().optional(),
          vbrUpperCapMin: z.number().optional(),
          vbrUpperCapMax: z.number().optional(),
          constantBitRate: z.number().nullable().optional(),
          constantBitRateMin: z.number().optional(),
          constantBitRateMax: z.number().optional(),
          fixedQuality: z.number().nullable().optional(),
          govLength: z.number().nullable().optional(),
          govLengthMin: z.number().optional(),
          govLengthMax: z.number().optional(),
          smartCodecEnabled: z.boolean().optional(),
          resolutionWidth: z.number().nullable().optional(),
          resolutionHeight: z.number().nullable().optional(),
          /** FPS values the firmware advertises in `/dynamicCap`, sorted
           *  descending. Drives the FPS select on the Stream tab — when
           *  empty (legacy firmware without dynamicCap) the form falls back
           *  to a free-typed number input. */
          supportedFrameRates: z.array(z.number().int().positive()).optional(),
        }),
      )
      .optional(),
    probedAt: z.number().optional(),
  })
  .loose()
  .optional()

export const hikvisionCameraSchema = z.object({
  // `name` is now base meta (DB column on `device-meta`, not in this
  // hardware-config schema). Read via `this.name` (resolved by
  // `BaseDevice` from `ctx.deviceMeta.name`); mutated via
  // `kernel.devices.setName(id, name)`.
  /** Camera IP or hostname (no scheme). */
  host: z.string().describe('Camera IP or hostname'),
  /**
   * ISAPI port. Default 80 for HTTP, 443 for HTTPS. Hikvision cameras
   * almost always ship with HTTP enabled on port 80; HTTPS on 443 is
   * common but optional.
   */
  port: z.number().int().positive().default(80).describe('ISAPI port (default 80, 443 for HTTPS)'),
  /**
   * When true, ISAPI requests use HTTPS with `rejectUnauthorized:false`
   * (Hikvision's default cert is self-signed). HTTP is the default
   * because it's what every camera ships with out of the box.
   */
  https: z.boolean().default(false),
  username: z.string().default('admin').describe('ISAPI user'),
  password: z.string().describe('ISAPI password').meta({ secret: true }),
  /**
   * RTSP transport hint forwarded to the broker as `transportmode`.
   * Most installations use `unicast`; multicast needs explicit
   * camera-side configuration and is rare.
   */
  rtspTransport: z.enum(['unicast', 'multicast']).default('unicast'),
  /**
   * Two-way audio source. Hikvision firmware exposes intercom via
   * ISAPI sticky-PUT (`/ISAPI/System/TwoWayAudio/channels/...`); future
   * firmwares + ONVIF Profile T also support backchannel via RTSP
   * `Require: www.onvif.org/ver20/backchannel`. We default to `auto`
   * (probe → ISAPI when the channel list returns ≥1 entry, otherwise
   * stay disabled). Operator can force `'isapi'` to skip the probe or
   * `'off'` to disable intercom registration entirely. The `'onvif'`
   * mode is reserved for the upcoming Phase 2 backchannel support.
   */
  twoWayAudioMode: z
    .enum(['auto', 'isapi', 'onvif', 'off'])
    .default('auto')
    .describe('Two-way audio source (auto/isapi/onvif/off)'),
  /**
   * ISAPI streaming channel the `snapshot` cap captures from
   * (`/ISAPI/Streaming/channels/{id}/picture`).
   *
   * Empty string = "not chosen" → the provider's historical channel
   * (`{cameraNumber}01`, the main stream). That sentinel is what makes an
   * upgrade a no-op: the setting starts at the channel already in use and only
   * an explicit operator save moves it.
   *
   * Options are PROBED from `/ISAPI/Streaming/channels` (persisted into
   * `deviceCache.streamSnapshots`), never hardcoded. A stored id the camera
   * stops enumerating falls back to the default and the provider logs it —
   * see `resolveSnapshotChannelId`.
   */
  snapshotChannelId: z
    .string()
    .default('')
    .describe('ISAPI channel used for snapshots (empty = main stream)'),
  /**
   * Which preset `ptz.goHome` targets on THIS camera.
   *
   * Empty = no operator choice. The provider then falls back to the preset the
   * FIRMWARE names as home (Hikvision returns id 34 "Back to origin" in its
   * reserved band), and only if that is absent too does `goHome` refuse.
   *
   * It has to be stored because the vendor "convention" is wrong here: the code
   * went to preset '1', and on the dispensa camera preset 1 is "Credenza".
   */
  homePresetId: z
    .string()
    .default('')
    .describe('Preset id ptz.goHome targets (empty = use the firmware home)'),
  /**
   * Motion detection master switch + sensitivity (0..100). Maps to
   * ISAPI `/ISAPI/System/Video/inputs/channels/{cam}/motionDetection`.
   * Disabling this stops the camera from emitting `<eventType>VMD</eventType>`
   * frames on the alarm stream — useful when an external pipeline owns
   * motion detection and the on-camera VMD is just noise.
   *
   * Sensitivity range: firmware-advertised (older builds use step=20 →
   * 5 discrete levels; newer builds use step=1 → continuous). The lib
   * clamps to the firmware's accepted range on PUT.
   */
  motionEnabled: z
    .boolean()
    .default(true)
    .describe('On-camera motion detection (VMD) master switch'),
  motionSensitivity: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(60)
    .describe('Motion detection sensitivity (0..100). Higher = triggers on smaller motion.'),
  /**
   * VCA (Video Content Analysis) resource allocation. Camera firmware
   * trades smart-detection compute for the third stream slot:
   *   - `smart`    — runs smart detection (motion-AI, line crossing,
   *                   region entrance/exit, intrusion). Third stream
   *                   slot DISABLED.
   *   - `facesnap` — face capture mode. Third stream DISABLED.
   *   - `close`    — VCA off, third stream slot AVAILABLE.
   *
   * Switching modes triggers a camera reboot; the lib's
   * `setVcaResource` returns a flag the provider uses to surface a
   * notice to the operator instead of auto-rebooting.
   */
  vcaResource: z
    .enum(['smart', 'facesnap', 'close'])
    .default('smart')
    .describe('VCA resource allocation (smart / facesnap / close)'),
  /**
   * Active audio codec on `/ISAPI/System/TwoWayAudio/channels/1`.
   * Operator picks from `deviceCache.audioCapabilities.audioCodecs`;
   * empty string = use whatever the firmware advertises as default.
   */
  audioCompressionType: z.string().default(''),
  /**
   * Speaker volume 0..100 (clamped to firmware-advertised
   * speakerVolumeMin/Max range on push). Used by the camera-side
   * audio output AND by the intercom's playback path.
   */
  audioSpeakerVolume: z.number().int().min(0).max(100).default(80),
  /** Hikvision noise-reduction toggle on the audio channel (`<noisereduce>`). */
  audioNoiseReduction: z.boolean().default(true),
  /**
   * Audio input source — `MicIn` for the built-in microphone,
   * `LineIn` for the rear-panel line input. Empty = firmware default.
   */
  audioInputType: z.string().default(''),
  // Per-channel stream/encoder config (codec / bitrate / FPS / GOP)
  // is owned by the `stream-params` device cap — see
  // `registerStreamParamsCap()` in `hikvision-camera.ts`. The cap
  // reads option lists and current values straight off the camera
  // and pushes via `setStreamingChannel`, so there are no persisted
  // `streamChannels` operator overrides any more (the legacy
  // synthetic-key form fields were removed with them).
  /**
   * Motion-event linkage outputs. Operator toggles each independently;
   * the lib's `setMotionTriggerLinkage` reconciles the camera-side
   * notification-method list while preserving any methods we don't
   * manage (record, email, ftp, …).
   */
  alarmBeep: z.boolean().default(false),
  alarmWhiteLight: z.boolean().default(false),
  alarmIoOutput: z.boolean().default(false),
  alarmCenter: z.boolean().default(false),
  /**
   * Image tuning operator overrides. Each is optional — undefined
   * means "leave firmware as-is" (the form falls back to the probed
   * snapshot for display). Pushed to the matching ISAPI endpoint
   * (`/Image/channels/{cam}/color` / `/WDR` / `/IrcutFilter`).
   */
  imageBrightness: z.number().int().min(0).max(100).optional(),
  imageContrast: z.number().int().min(0).max(100).optional(),
  imageSaturation: z.number().int().min(0).max(100).optional(),
  imageSharpness: z.number().int().min(0).max(100).optional(),
  imageWdrEnabled: z.boolean().optional(),
  imageWdrLevel: z.number().int().min(0).max(100).optional(),
  imageIrcutMode: z.enum(['day', 'night', 'auto', 'schedule']).optional(),
  /**
   * Time / NTP operator overrides. Each is optional — undefined means
   * "leave firmware as-is" (the form falls back to the probed
   * `ntpSnapshot`). Pushed via `setTimeConfig()` to `/System/time` and
   * `/System/time/ntpServers/1`.
   */
  timeMode: z.enum(['NTP', 'manual']).optional(),
  ntpServer: z.string().max(253).optional(),
  ntpPort: z.number().int().min(1).max(65535).optional(),
  ntpSyncInterval: z.number().int().min(1).max(10080).optional(),
  /**
   * Friendly IANA timezone id (e.g. `Europe/Rome`) selected via the
   * `timezone` form field. Resolved through `findTimezone` and pushed
   * to `/System/time` as Hikvision's POSIX-style `<timeZone>` string.
   */
  timeZoneId: z.string().optional(),
  /**
   * Operator-set manual clock, in the `datetime-local` shape
   * `YYYY-MM-DDTHH:MM` (local wall-clock, no seconds / zone). Applied on
   * save when `timeMode === 'manual'`: `applySettingsPatch` appends `:00`
   * seconds + the camera-local offset and PUTs it via
   * `setLocalTime()` to `/System/time`.
   */
  manualTime: z.string().optional(),
  /**
   * Supplemental-light operator overrides — kept on the parent for
   * IR-only models (no accessory device). White-light models still
   * spawn the LightAccessory and tune via the cap; the parent fields
   * here drive the regulator + IR brightness even on those.
   */
  lightMode: z.string().optional(),
  lightIrBrightness: z.number().int().min(0).max(100).optional(),
  lightWhiteBrightness: z.number().int().min(0).max(100).optional(),
  lightBrightnessRegulator: z.enum(['auto', 'manual']).optional(),
  /**
   * Cached probe results — see `HikvisionDeviceCacheSchema`.
   */
  deviceCache: HikvisionDeviceCacheSchema,
  /**
   * General ISAPI debug logs (request/response status, retries).
   * Mirrors Reolink's `debugGeneral`.
   */
  debugGeneral: z.boolean().default(false),
  /**
   * Per-area trace flags — only flip what you need; each adds log
   * volume.
   */
  debugFlags: z.array(HikvisionDebugFlagSchema).default([]),
})

export type HikvisionCameraConfig = z.infer<typeof hikvisionCameraSchema>
export type HikvisionDeviceCache = z.infer<typeof HikvisionDeviceCacheSchema>
