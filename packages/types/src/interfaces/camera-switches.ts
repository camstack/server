/**
 * Per-camera FUNCTION SWITCHES.
 *
 * ## The aggregate group is being withdrawn — the BADGE is not (D113)
 *
 * This file shipped as "the one coherent on/off surface over the pipeline
 * functions an operator thinks in terms of". The operator's verdict on
 * 2026-08-12 was that the coherent surface bought complexity and no clarity:
 * every function already had a settings page of its own, and a second place to
 * turn it off is a second place to look. Each switch is going back to its own
 * component's original options — detection to the detection-pipeline wrapper
 * binding, audio analysis to its own, recording to `RecordingConfig.enabled`
 * (which was always first-class; the switch was a veneer over
 * `recordingArchive.setDeviceConfig`), notifications to a notification-center
 * per-device setting, the two camera planes to their own components.
 *
 * What survives is {@link composeSwitchedOff}: `CameraStatus.switchedOff`, the
 * thing that lets a status surface say DISABLED instead of BROKEN, recomposed
 * straight from the authorities with no group in the middle. That rule was
 * never about a control panel.
 *
 * Everything else here — {@link CAMERA_SWITCH_CATALOG}, {@link CameraSwitch},
 * {@link deriveCameraSwitches}, the `pipelineOrchestrator.getCameraSwitches` /
 * `setCameraSwitch` pair — is a COMPATIBILITY surface for as long as deployed
 * viewers (v1.0.305) and the admin UI still call it. It is deleted when they
 * stop; nothing new may be built on it.
 *
 * ## This file adds no state
 *
 * Every switch here is a VIEW onto an authority that already existed
 * ([D62](../../../../docs/decisions/adr-0062.md)). The whole point of the
 * group is that there is exactly one place each function is turned off, and
 * the group routes to it:
 *
 * | Switch | Authority | Proven "off stops the work" gate |
 * | --- | --- | --- |
 * | `stream-broker` | `deviceManager.setDisabled` | `StreamBrokerManager.reconcileAllCatalogs` releases the brokers; `ensureBroker` refuses re-creation |
 * | `object-detection` | `deviceManager.setWrapperActive('detection-pipeline')` | `PipelineSettingsStore.resolvePipelineForDevice` returns `{ steps: [], audio: null }` |
 * | `audio-analysis` | `deviceManager.setWrapperActive('audio-analysis')` | `AudioSubscriptionController.subscribeAudioStream` returns `null` before opening the stream |
 * | `recording` | `recordingArchive.setDeviceConfig` → `RecordingConfig.enabled` | `band-decision.shouldRecord` returns false; the controller detaches the device |
 * | `notifications` | `notificationRules.setDeviceMuted` | `NotificationCenter.evaluateAndEnqueue` returns before any rule is evaluated |
 * | `privacy-mask` | `privacyMask.setMask({ enabled })` → the CAMERA | the camera blanks the masked regions itself; every stream and recording carries the black boxes |
 * | `device-audio` | `privacyMask.setAudioEnabled` → the CAMERA | the camera stops encoding an audio track at all; every consumer sees silent video |
 * | `broker-audio` | `streamBroker.setDeviceAudioMute` → `DeviceOverride.audioMuted` | `StreamBroker.setAudioMuted` drops the audio plane at the source: no `type:'audio'` packet leaves `fanOutEncoded`, no RTP reaches the restreamer, and the restreamer serves the video-only SDP |
 *
 * ## `device-audio` and `broker-audio` are two functions, not two knobs
 *
 * They look adjacent and they are not the same control ([D83](../../../../docs/decisions/adr-0083.md)):
 * `device-audio` writes the CAMERA, so it is hardware privacy — the microphone
 * genuinely stops, it survives CamStack entirely, and it costs a multi-second
 * encoder restart on every flip. `broker-audio` writes THIS server, so it is
 * instant, vendor-independent and reversible without touching the camera, and
 * a camera that ignores or lacks the ISAPI/Reolink control is still silenced.
 * D62 forbids a second switch that *disagrees* with the first; these two
 * cannot disagree, because neither reads the other's store — the camera holds
 * one, the broker holds the other, and each reports its own fact.
 *
 * ## The two switches whose authority is not on this server
 *
 * `privacy-mask` and `device-audio` write the CAMERA. That is not a loophole
 * in "the group stores nothing" — it is the purest form of it: the camera
 * holds the fact, every read is a read-through, and there is no server-side
 * copy that could drift. Their availability therefore cannot come from
 * `listBindableCapsForDeviceType` (a device-NATIVE cap carries no wrappers and
 * is filtered out there); it comes from the cap's own camera-probed
 * `privacyMask.getOptions()`, which is strictly more honest — it answers for
 * THIS camera rather than for the device type
 * ([D74](../../../../docs/decisions/adr-0074.md)).
 *
 * ## `privacy-mask` is the one row whose ON is not "the function is working"
 *
 * Every other switch means *this camera's function is doing its job*, so
 * `enabled: false` is a thing an operator took away. `privacy-mask` means **the
 * MASK is active** — `enabled: true` is video deliberately obscured. The
 * polarity is not a choice made here: `addon-export-hap`'s privacy `Switch`
 * (`builders/privacy-switch.ts`) already mirrors `patch.enabled` verbatim, and
 * a HomeKit toggle that disagreed with the app's toggle for the same camera is
 * worse than either surface not having one.
 *
 * Two consequences follow and both are load-bearing:
 *
 * - **It never counts as `switchedOff`.** `countsAsSwitchedOff` is `false` for
 *   exactly this row. With the polarity above, every camera that has NOT drawn
 *   a privacy mask would otherwise report `switchedOff: ['privacy-mask']` — the
 *   normal, healthy state of most cameras rendered as an operator disablement.
 * - **Its cost line names BOTH directions.** `costWhenOff` is rendered
 *   unconditionally by both clients, so for this row it has to read correctly
 *   whichever way the switch is sitting.
 *
 * The wrapper-binding pair is not a new idea: `legacy-migrations.ts` already
 * migrated the legacy `audioEnabled` / `pipelineEnabled` /
 * `motionDetectionEnabled` booleans ONTO `setWrapperActive`. The group is the
 * surface that decision never got.
 *
 * ## Two rules that are load-bearing
 *
 * - **Recording's switch is `enabled`, never the bands.** `bands` is the only
 *   authored intent and `mode` is derived from it (`deriveRecordingMode`).
 *   Expressing "off" by clearing bands destroys the operator's schedule and
 *   turning the camera back on would then silently record nothing.
 * - **A switch that is off must be reported as off**, not merely produce
 *   nothing. {@link CameraSwitch.enabled} is what a status surface renders as
 *   "disabled by an operator" instead of "broken" — see
 *   `CameraStatus.switchedOff`.
 */
import { z } from 'zod'

/**
 * The functions the operator named — five on 2026-08-05, plus the camera's own
 * microphone on 2026-08-07. Deliberately NOT one id per pipeline step: face
 * recognition and plate/LPR are per-step toggles on
 * `pipelineOrchestrator.setCameraStepToggle` and belong in the pipeline
 * editor, not in a safety group.
 */
export const CameraSwitchIdSchema = z.enum([
  'stream-broker',
  'object-detection',
  'privacy-mask',
  'device-audio',
  'broker-audio',
  'audio-analysis',
  'event-saving',
  'recording',
  'notifications',
])
export type CameraSwitchId = z.infer<typeof CameraSwitchIdSchema>

/**
 * Stable render order — broadest blast radius first, and a source before the
 * thing that consumes it. `device-audio` sits ABOVE `audio-analysis` because
 * turning the microphone off leaves the analyzer with nothing to analyse; the
 * reverse is not true.
 *
 * `privacy-mask` sits directly ABOVE `device-audio` because they are literal
 * siblings — one cap, one device plane, video then audio — and NOT above
 * `object-detection` despite feeding it: a mask blanks REGIONS, so its blast
 * radius is partial, and the "broadest first" rule does not rank a partial
 * control above a whole-function one.
 *
 * `broker-audio` sits directly BELOW `device-audio` by the same source-first
 * rule: the camera's microphone feeds the broker, so silencing the camera
 * leaves the broker's mute with nothing to suppress; the reverse is not true.
 */
export const CAMERA_SWITCH_ORDER: readonly CameraSwitchId[] = [
  'stream-broker',
  'object-detection',
  'privacy-mask',
  'device-audio',
  'broker-audio',
  'audio-analysis',
  // Below both analysers and above `recording` by the source-first rule: the
  // detection and audio planes FEED event saving, and event-triggered
  // recording consumes what it writes.
  'event-saving',
  'recording',
  'notifications',
] as const

/**
 * WHERE the switch's state actually lives. A discriminated union rather than a
 * string so both the writer (the orchestrator's `setCameraSwitch`) and any
 * reader can exhaustively narrow — and so "the group added a parallel map" is
 * a compile error rather than a review comment.
 */
export const CameraSwitchAuthoritySchema = z.discriminatedUnion('kind', [
  /** `deviceManager.setDisabled` — the whole-device soft disable. */
  z.object({ kind: z.literal('device-disabled') }),
  /** `deviceManager.setWrapperActive` on a device-scoped wrapper capability. */
  z.object({ kind: z.literal('wrapper-binding'), capName: z.string() }),
  /** `recordingArchive.setDeviceConfig` — the `enabled` field ONLY; `bands` untouched. */
  z.object({ kind: z.literal('recording-config') }),
  /** `notificationRules.setDeviceMuted` — the permanent per-camera mute. */
  z.object({ kind: z.literal('notification-mute') }),
  /**
   * `privacyMask.setAudioEnabled` — the microphone switch ON THE CAMERA,
   * reached through the device-native cap named by `capName`.
   *
   * The store is the camera itself: there is no server-side copy, so this
   * switch cannot disagree with anything. `capName` travels rather than being
   * hardcoded at the call site for the same reason `wrapper-binding` carries
   * one — the writer narrows on the union, and a rename is a compile error
   * instead of a silent no-op.
   */
  z.object({ kind: z.literal('camera-audio'), capName: z.string() }),
  /**
   * `privacyMask.setMask({ patch: { enabled } })` — the VIDEO mask master
   * switch ON THE CAMERA, `camera-audio`'s sibling on the same cap.
   *
   * `patch.enabled` and nothing else. `regions` is the operator's authored
   * geometry, exactly as `bands` is on `recording-config`: expressing "off" by
   * clearing the shapes would destroy the drawing and turning the mask back on
   * would then obscure nothing.
   */
  z.object({ kind: z.literal('camera-mask'), capName: z.string() }),
  /**
   * `streamBroker.setDeviceAudioMute` — the BROKER's per-device audio-plane
   * policy, stored in the stream-broker's existing `DeviceOverride` blob
   * (store key `deviceOverrides`, the same one that already holds
   * `preBuffer`, `streamingDebug` and `hwaccel`).
   *
   * This switch adds no store. It writes the one fact the broker already
   * owns — what it distributes for a device — and the broker is the only
   * reader. It cannot disagree with `camera-audio`: that one lives on the
   * camera, this one lives here, and each is reported separately.
   *
   * The write is node-pinned to the device's SOURCE owner, because that is
   * where the brokers are.
   */
  z.object({ kind: z.literal('broker-audio-mute') }),
])
export type CameraSwitchAuthority = z.infer<typeof CameraSwitchAuthoritySchema>

/**
 * Why a switch is not offered for this camera. Rendered instead of the
 * control, never as a dead control — an absent function and a broken one must
 * not look the same.
 */
export const CameraSwitchUnavailableReasonSchema = z.enum([
  /** The capability is not bindable for this device type (no provider anywhere). */
  'no-provider',
  /** The owning addon did not answer — availability is unknown, so no control. */
  'source-unreachable',
  /**
   * The operator switched the CAMERA off (`deviceManager` soft-disable). The
   * camera planes are not read for a disabled camera — there is no session to
   * ask through, and dialling one waited the full authority bound twice per
   * poll for a control the panel would not offer anyway. Distinct from
   * `source-unreachable`: nothing is broken, and the action that brings the
   * controls back is the camera switch itself.
   */
  'device-disabled',
])
export type CameraSwitchUnavailableReason = z.infer<typeof CameraSwitchUnavailableReasonSchema>

/**
 * Something true about a switch that is nonetheless OFFERED.
 *
 * The distinction from {@link CameraSwitchUnavailableReasonSchema} is the
 * whole point: a reason replaces the control, a warning travels WITH it. The
 * privacy mask taught us the difference — greying the one button that starts
 * the feature teaches the operator the feature is broken, while a live toggle
 * that flips nothing teaches them the switch is broken. Neither is true; the
 * honest surface is a working toggle that says what is missing.
 */
export const CameraSwitchWarningSchema = z.enum([
  /**
   * The camera CAN mask and no zone is drawn. The master enable is real and
   * persists; it just blanks nothing until a zone exists, and the zones live
   * on the camera, not in this app.
   */
  'no-privacy-zones',
])
export type CameraSwitchWarning = z.infer<typeof CameraSwitchWarningSchema>

/**
 * One switch, resolved for one camera.
 *
 * `label` and `costWhenOff` travel ON THE WIRE rather than being looked up
 * client-side: the viewer is a separate repository that does not import
 * `@camstack/types`, and a cost line duplicated in two clients is a cost line
 * that will disagree with itself. Five rows per camera is nothing.
 */
export const CameraSwitchSchema = z.object({
  id: CameraSwitchIdSchema,
  label: z.string(),
  /**
   * What the operator LOSES while this is off, in one sentence. Required, not
   * optional: a switch that cannot say what it costs should not ship.
   */
  costWhenOff: z.string(),
  /** False = do not render a control. `unavailableReason` says why. */
  available: z.boolean(),
  unavailableReason: CameraSwitchUnavailableReasonSchema.optional(),
  /**
   * Present on an AVAILABLE switch only. Rendered beside the live control;
   * never a substitute for one.
   */
  warning: CameraSwitchWarningSchema.optional(),
  /** Current state. Meaningless when `available` is false — read it as `true`. */
  enabled: z.boolean(),
  authority: CameraSwitchAuthoritySchema,
})
export type CameraSwitch = z.infer<typeof CameraSwitchSchema>

/** The whole group for one camera. */
export const CameraSwitchGroupSchema = z.object({
  deviceId: z.number().int(),
  switches: z.array(CameraSwitchSchema).readonly(),
  /** Unix ms when the group was composed server-side. */
  fetchedAt: z.number(),
})
export type CameraSwitchGroup = z.infer<typeof CameraSwitchGroupSchema>

/**
 * The wrapper capability each wrapper-backed switch controls. Named constants
 * because the same strings appear in `legacy-migrations.ts`, in
 * `isCapActiveForDevice` call sites and in the fake harness — a typo in any of
 * them is a switch that silently writes a binding nobody reads.
 */
export const DETECTION_PIPELINE_CAP_NAME = 'detection-pipeline'
export const AUDIO_ANALYSIS_CAP_NAME = 'audio-analysis'
/**
 * The device-NATIVE cap that owns what the camera does not capture — masked
 * video regions and, since 2026-08-07, the microphone. Named here because the
 * `camera-audio` authority, the orchestrator's gather and the fake harness all
 * have to agree on it.
 */
export const PRIVACY_MASK_CAP_NAME = 'privacy-mask'
/**
 * The wrapper that TURNS DETECTIONS INTO STORED HISTORY — tracks, events and
 * their media. Named here for the same reason as the others, and with one
 * extra: it has no gate of its own except this binding, so it is the only
 * thing standing between a camera's detections and the database.
 */
export const PIPELINE_ANALYTICS_CAP_NAME = 'pipeline-analytics'

/**
 * Every analyser a camera CamStack BUILDS is created with switched off.
 *
 * A grid and a Terminal camera are `DeviceType.Camera`, so every wrapper that
 * declares `defaultActive: true` for a camera binds to them the instant they
 * exist — the whole analysis family included. There is nothing there to
 * analyse: a grid's subjects are already counted on the cameras it composes (a
 * person in the bottom-right cell is a person on THAT camera, not on the grid),
 * and a Terminal camera shows a shell.
 *
 * ONE list, in the package both already depend on, because there were two and
 * they had already drifted: the Terminal's and the grid's each named three caps
 * and neither named `pipeline-analytics` — which has no gate of its own except
 * this binding, so a grid that forwards its sources' motion (so the viewer can
 * light its tile) would open a motion EPISODE per forwarded event, duplicating
 * the rows those sources already write.
 *
 * `motion-detection` sits first deliberately: it is the one that holds the
 * decode session open, so its absence is the difference between a derived
 * camera costing a composition and costing a full decode pipeline.
 *
 * Applied ONLY at creation. An operator who deliberately turns analysis back on
 * for a grid must win, and a reconcile that re-asserted this every pass would
 * silently overrule them once a minute.
 */
export const DERIVED_CAMERA_SILENCED_CAP_NAMES: readonly string[] = [
  'motion-detection',
  DETECTION_PIPELINE_CAP_NAME,
  AUDIO_ANALYSIS_CAP_NAME,
  // No gate but this binding — see above.
  PIPELINE_ANALYTICS_CAP_NAME,
  'scene-monitor',
]

/** Static half of a switch: everything that does not depend on a device. */
export interface CameraSwitchDescriptor {
  readonly id: CameraSwitchId
  readonly label: string
  readonly costWhenOff: string
  readonly authority: CameraSwitchAuthority
  /**
   * May `enabled: false` on this row appear in {@link switchedOffIds}?
   *
   * `true` for every switch that means "this camera's function is doing its
   * job", where OFF is something a person took away and a status surface must
   * render as disabled rather than broken.
   *
   * `false` for `privacy-mask` alone, and only because its polarity is
   * inverted: OFF there means the mask is not obscuring anything, which is the
   * ordinary state of nearly every camera. Reporting it would put a
   * `switchedOff` badge on healthy cameras and drown the badge that matters.
   */
  readonly countsAsSwitchedOff: boolean
}

/**
 * THE catalog. One entry per switch; the cost lines are the operator-facing
 * contract and are written to be true rather than reassuring.
 */
export const CAMERA_SWITCH_CATALOG: Readonly<Record<CameraSwitchId, CameraSwitchDescriptor>> = {
  'stream-broker': {
    id: 'stream-broker',
    label: 'Camera',
    costWhenOff:
      'Off: the whole camera stops. No live view, no recording, no detection and no notifications — ' +
      'its streams are released and nothing dials it again until you turn it back on.',
    authority: { kind: 'device-disabled' },
    countsAsSwitchedOff: true,
  },
  'object-detection': {
    id: 'object-detection',
    label: 'Object detection & tracking',
    costWhenOff:
      'Off: nothing is detected or tracked on this camera, so it produces no events — and with no events ' +
      'there are no object notifications and no event-triggered recording. Live view and continuous recording are unaffected.',
    authority: { kind: 'wrapper-binding', capName: DETECTION_PIPELINE_CAP_NAME },
    countsAsSwitchedOff: true,
  },
  'privacy-mask': {
    id: 'privacy-mask',
    label: 'Privacy mask',
    // Rendered unconditionally by both clients, so it has to read correctly in
    // both positions — and this is the one row where guessing the polarity
    // wrong means an operator un-blanks a bedroom believing they blanked it.
    costWhenOff:
      'On: the zones you drew on this camera are blacked out by the camera itself — live view, ' +
      'playback, exports and detection all see the black boxes, and nothing behind them was ever ' +
      'recorded. Off: the camera captures the whole frame, and your zones are kept for when you ' +
      'turn it back on.',
    authority: { kind: 'camera-mask', capName: PRIVACY_MASK_CAP_NAME },
    // Inverted polarity — see the file header. OFF here is the ordinary state
    // of a camera nobody has masked, not a function somebody took away.
    countsAsSwitchedOff: false,
  },
  'device-audio': {
    id: 'device-audio',
    label: 'Camera microphone',
    costWhenOff:
      'Off: the camera captures no sound at all. Live view and recordings become silent video, and ' +
      'audio detection and classification have nothing left to analyse — turning them back on will not ' +
      'recover it. The picture, motion and object detection are unaffected, and two-way talk still works. ' +
      'Applies at the camera, so every consumer sees the same silence.',
    authority: { kind: 'camera-audio', capName: PRIVACY_MASK_CAP_NAME },
    countsAsSwitchedOff: true,
  },
  'broker-audio': {
    id: 'broker-audio',
    label: 'Audio distribution',
    // The permanence line is not a warning bolted on: it is the whole
    // difference between this row and every other one in the group. Turning
    // recording off keeps the footage already on disk; turning audio
    // distribution off makes the footage recorded FROM NOW silent, and
    // turning it back on cannot restore a second of it.
    costWhenOff:
      'Off: this server distributes no sound for this camera — live view is silent and everything ' +
      'recorded while it is off is silent FOREVER, even after you turn it back on. Audio detection ' +
      'and classification also have nothing to analyse. The camera keeps capturing sound, so nothing ' +
      'about the camera changes and turning this back on is instant, with no interruption to the picture.',
    authority: { kind: 'broker-audio-mute' },
    countsAsSwitchedOff: true,
  },
  'audio-analysis': {
    id: 'audio-analysis',
    label: 'Audio detection & classification',
    costWhenOff:
      'Off: no audio is decoded or classified for this camera. Tracks carry no audio labels and no ' +
      'audio-triggered rule can fire. Audio recorded alongside video is unaffected.',
    authority: { kind: 'wrapper-binding', capName: AUDIO_ANALYSIS_CAP_NAME },
    countsAsSwitchedOff: true,
  },
  'event-saving': {
    id: 'event-saving',
    label: 'Event saving',
    // What it costs is not "no events in the list": it is that the camera's
    // history stops being written at all, while everything upstream keeps
    // running and looking healthy. That gap — detection on, timeline empty —
    // is exactly what an operator cannot explain without this row.
    costWhenOff:
      'Off: nothing about this camera is written to its history — no tracks, no events and no event ' +
      'snapshots or clips. Detection keeps running and live boxes still appear, so the camera looks ' +
      'busy while its timeline stays empty, and anything that fires ON an event (notification rules, ' +
      'event-triggered recording) has nothing to fire on. Continuous recording is unaffected, and ' +
      'history already written is kept.',
    authority: { kind: 'wrapper-binding', capName: PIPELINE_ANALYTICS_CAP_NAME },
    countsAsSwitchedOff: true,
  },
  recording: {
    id: 'recording',
    label: 'Recording',
    costWhenOff:
      'Off: nothing new is written to disk. Footage already recorded stays, but retention keeps deleting it — ' +
      'so this camera’s history shrinks and is not replaced. Your recording schedule is kept and resumes when you turn it back on.',
    authority: { kind: 'recording-config' },
    countsAsSwitchedOff: true,
  },
  notifications: {
    id: 'notifications',
    label: 'Notifications',
    costWhenOff:
      'Off: this camera never notifies anyone, on any rule, with no expiry. Detection, events and recording ' +
      'carry on exactly as before — you simply stop being told about them.',
    authority: { kind: 'notification-mute' },
    countsAsSwitchedOff: true,
  },
} as const

/**
 * Everything the pure derivation needs, gathered by the caller. A `null`
 * sub-state means the owning source did not answer — which produces
 * `available: false` with `source-unreachable`, NEVER a control defaulted to
 * "on". Guessing a switch is on when we could not read it is how an operator
 * learns a function is off a week later.
 */
export interface CameraSwitchDerivationInput {
  readonly deviceId: number
  /** `deviceManager` soft-disable flag for this device. */
  readonly deviceDisabled: boolean
  /**
   * Capability names bindable for this device's TYPE
   * (`deviceManager.listBindableCapsForDeviceType`). This is what makes the
   * group derived rather than hardcoded: a deployment with no audio analyzer
   * has no `audio-analysis` here, so no audio switch is rendered.
   * `null` = the lookup failed.
   */
  readonly bindableCapNames: readonly string[] | null
  /**
   * Capability names currently bound `kind: 'wrapped'` for this device
   * (`deviceManager.getBindings`). Absence IS how a deactivated wrapper is
   * represented — there is no `active: false` row.
   */
  readonly activeWrapperCapNames: readonly string[] | null
  /** `RecordingConfig.enabled`; `null` when the recording cap did not answer. */
  readonly recordingEnabled: boolean | null
  /** `notificationRules` per-camera mute; `null` when the cap did not answer. */
  readonly notificationsMuted: boolean | null
  /**
   * The camera's own microphone, read through the `privacy-mask` native cap.
   * `null` = the cap is bound to this camera but did not answer.
   *
   * A camera with no `privacy-mask` provider at all is `{ supported: false }`,
   * not `null` — "this camera has no such control" and "we could not read it"
   * are different answers and the operator is shown different copy for each.
   */
  readonly deviceAudio: DeviceAudioSwitchState | null
  /**
   * The camera's own VIDEO privacy mask, read through the same `privacy-mask`
   * native cap and the same pair of round trips as {@link deviceAudio} — one
   * `getOptions` + one `getStatus` answer both, so the second switch is free.
   *
   * `null` = the cap is bound to this camera but did not answer.
   */
  readonly privacyMask: PrivacyMaskSwitchState | null
  /**
   * The BROKER's audio-plane policy for this camera, read from the
   * stream-broker on the device's source-owner node. `null` = the broker did
   * not answer, which renders no control rather than a control defaulted to
   * "audio flows".
   */
  readonly brokerAudio: BrokerAudioSwitchState | null
}

/** What the stream-broker reported about its audio plane for one camera. */
export interface BrokerAudioSwitchState {
  /**
   * `DeviceOverride.audioMuted` — the broker's own persisted policy. `true`
   * means the broker drops this camera's audio on every plane it serves.
   *
   * There is no `supported` companion, deliberately. Muting a camera that is
   * currently silent is not a dead control: the policy governs what happens
   * when sound DOES appear (a camera unmuted at the device, a stream that
   * only carries audio at night), so it is meaningful to set in advance.
   * That is the opposite of the privacy mask with zero zones, where flipping
   * the master enable is provably a no-op until something else changes.
   */
  readonly muted: boolean
}

/** What the camera-probed audio switch reported for one camera. */
export interface DeviceAudioSwitchState {
  /**
   * `privacyMask.getOptions().supportsAudioMute` — camera-probed, never a
   * device-type guess. A camera that does not expose the control renders no
   * switch rather than a toggle that silently does nothing.
   */
  readonly supported: boolean
  /**
   * `privacyMask.getStatus().audioEnabled` — the camera's current answer.
   * `null` when unsupported, or when supported but unreadable; the second
   * case yields `source-unreachable`, never a control defaulted to "on".
   */
  readonly enabled: boolean | null
}

/** What the camera-probed VIDEO privacy mask reported for one camera. */
export interface PrivacyMaskSwitchState {
  /**
   * Can this camera store privacy zones at all? Derived from the probed
   * `getOptions()`: `maxRegions > 0` AND at least one supported shape kind.
   * Reolink answers `maxNum: 0` / `supportedShapes: []` honestly on models
   * that cannot, and that must render no control rather than a toggle whose
   * write the camera discards.
   */
  readonly supported: boolean
  /**
   * How many zones are actually drawn on the camera right now
   * (`getStatus().regions.length`). `null` = supported, but the status could
   * not be read.
   *
   * **Zero is not "off", it is "nothing to blank yet".** The master enable
   * still writes to the camera and still persists; it just has no region to
   * act on. So the switch is offered with the `no-privacy-zones` warning,
   * which names the missing thing. `null` is a different answer entirely and
   * stays unavailable.
   */
  readonly configuredRegions: number | null
  /**
   * `getStatus().enabled` — the camera's master mask flag, `true` when the
   * zones are being blanked. `null` when unreadable; never defaulted.
   */
  readonly enabled: boolean | null
}

/** Resolve one switch's `{ available, enabled }` pair. */
function resolveState(
  descriptor: CameraSwitchDescriptor,
  input: CameraSwitchDerivationInput,
): Pick<CameraSwitch, 'available' | 'enabled'> & {
  readonly unavailableReason?: CameraSwitchUnavailableReason
  readonly warning?: CameraSwitchWarning
} {
  switch (descriptor.authority.kind) {
    case 'device-disabled':
      // Every camera has a source; the soft-disable is always offered.
      return { available: true, enabled: !input.deviceDisabled }
    case 'wrapper-binding': {
      const capName = descriptor.authority.capName
      if (input.bindableCapNames === null || input.activeWrapperCapNames === null)
        return { available: false, enabled: true, unavailableReason: 'source-unreachable' }
      if (!input.bindableCapNames.includes(capName))
        return { available: false, enabled: true, unavailableReason: 'no-provider' }
      return { available: true, enabled: input.activeWrapperCapNames.includes(capName) }
    }
    case 'recording-config':
      if (input.recordingEnabled === null)
        return { available: false, enabled: true, unavailableReason: 'source-unreachable' }
      return { available: true, enabled: input.recordingEnabled }
    case 'notification-mute':
      if (input.notificationsMuted === null)
        return { available: false, enabled: true, unavailableReason: 'source-unreachable' }
      return { available: true, enabled: !input.notificationsMuted }
    case 'camera-audio': {
      const audio = input.deviceAudio
      // A disabled camera is not dialled, so an unread plane is the operator's
      // doing, not a fault. A plane that WAS read is honoured either way.
      if (audio === null)
        return {
          available: false,
          enabled: true,
          unavailableReason: input.deviceDisabled ? 'device-disabled' : 'source-unreachable',
        }
      // A camera that cannot answer is not a camera without a microphone.
      // `no-provider` says "this model has no such control"; a supported
      // camera we could not read says "unknown" and renders no control either
      // way — but the operator is told which.
      if (!audio.supported)
        return { available: false, enabled: true, unavailableReason: 'no-provider' }
      if (audio.enabled === null)
        return { available: false, enabled: true, unavailableReason: 'source-unreachable' }
      return { available: true, enabled: audio.enabled }
    }
    case 'camera-mask': {
      const mask = input.privacyMask
      if (mask === null)
        return {
          available: false,
          enabled: false,
          unavailableReason: input.deviceDisabled ? 'device-disabled' : 'source-unreachable',
        }
      // "This model cannot store privacy zones" — Reolink says so honestly
      // (`maxNum: 0`, `supportedShapes: []`) and is the reason this is probed
      // rather than assumed from the cap being bound.
      if (!mask.supported)
        return { available: false, enabled: false, unavailableReason: 'no-provider' }
      if (mask.configuredRegions === null || mask.enabled === null)
        return { available: false, enabled: false, unavailableReason: 'source-unreachable' }
      // The camera CAN mask and there is nothing to mask YET. This used to
      // resolve `not-configured` — no control at all — and that was the wrong
      // half of the trade: every camera on this fleet has zero zones, so the
      // entry point to the whole feature was greyed out everywhere, which
      // reads as "your cameras cannot do this". The master enable is a real,
      // persisted camera setting; it simply blanks nothing until a zone
      // exists. So it is OFFERED, carrying the warning that says so.
      //
      // `configuredRegions === null` above stays unavailable and must: zero
      // zones is a READ answer, an unreadable status is not (D315).
      if (mask.configuredRegions === 0)
        return { available: true, enabled: mask.enabled, warning: 'no-privacy-zones' }
      return { available: true, enabled: mask.enabled }
    }
    case 'broker-audio-mute': {
      const broker = input.brokerAudio
      // The broker not answering is NOT "audio flows". A control defaulted to
      // on here would tell an operator their recordings carry sound when the
      // node holding the brokers is unreachable and nobody can say.
      if (broker === null)
        return { available: false, enabled: true, unavailableReason: 'source-unreachable' }
      // Polarity: the switch is the FUNCTION (audio is distributed), the store
      // is the negation (muted). Same relationship as `notification-mute`.
      return { available: true, enabled: !broker.muted }
    }
  }
}

/**
 * Pure derivation of the whole group. No I/O — the orchestrator gathers, this
 * decides, so the decision is testable without a hub.
 *
 * Order is {@link CAMERA_SWITCH_ORDER}; unavailable switches are RETURNED
 * rather than filtered out, so a client can explain the gap instead of
 * silently rendering four buttons where another camera shows five.
 */
export function deriveCameraSwitches(input: CameraSwitchDerivationInput): readonly CameraSwitch[] {
  return CAMERA_SWITCH_ORDER.map((id): CameraSwitch => {
    const descriptor = CAMERA_SWITCH_CATALOG[id]
    const state = resolveState(descriptor, input)
    return {
      id: descriptor.id,
      label: descriptor.label,
      costWhenOff: descriptor.costWhenOff,
      available: state.available,
      ...(state.unavailableReason !== undefined
        ? { unavailableReason: state.unavailableReason }
        : {}),
      ...(state.warning !== undefined ? { warning: state.warning } : {}),
      enabled: state.enabled,
      authority: descriptor.authority,
    }
  })
}

/**
 * The ids an operator has switched OFF, for a status surface.
 *
 * This is the answer to "a disabled function must be visible as DISABLED, not
 * merely quiet": a camera reporting zero detections with
 * `switchedOff: ['object-detection']` was turned off; the same camera with an
 * empty list is broken. Unavailable switches never appear — a function nobody
 * provides was not switched off by anyone.
 *
 * `privacy-mask` never appears either, whichever way it is sitting, because its
 * ON means "the mask is active" rather than "the function works"
 * ({@link CameraSwitchDescriptor.countsAsSwitchedOff}). Without that filter the
 * ordinary state of every camera nobody has masked would carry a
 * "switched off" badge, and the badge that matters would be lost in it.
 */
export function switchedOffIds(switches: readonly CameraSwitch[]): readonly CameraSwitchId[] {
  return switches
    .filter((s) => CAMERA_SWITCH_CATALOG[s.id].countsAsSwitchedOff && s.available && !s.enabled)
    .map((s) => s.id)
}

/**
 * The badge, and whether the badge is a TOTAL.
 *
 * Two lists rather than one because an empty `switchedOff` means two opposite
 * things depending on the second: with an empty `unreadable` it is the positive
 * claim "the operator turned nothing off" (so a quiet camera is BROKEN); with a
 * non-empty one it is a FLOOR, and a surface that renders it as the positive
 * claim reproduces the 2026-08-08 inversion exactly.
 */
export interface SwitchedOffComposition {
  /** Functions a person switched off, in {@link CAMERA_SWITCH_ORDER}. */
  readonly switchedOff: readonly CameraSwitchId[]
  /**
   * Functions whose AUTHORITY did not answer. Non-empty ⇒ `switchedOff` is a
   * floor, not a total, and the caller must say so (`CameraStatus.degraded`
   * naming `'switches'`).
   */
  readonly unreadable: readonly CameraSwitchId[]
}

/**
 * Compose the `switchedOff` badge STRAIGHT from the authorities (D113).
 *
 * This is the half of this file that outlives the switch group.
 * {@link deriveCameraSwitches} exists to paint a control panel — labels, cost
 * lines, `available`/`unavailableReason` — and that panel is being dismantled:
 * each function is going back to its own component's settings. The BADGE is
 * not: "a switched-off camera must read as DISABLED, not broken" is a rule
 * about status, not about a control group, and it survives every surface change
 * underneath it.
 *
 * So the badge gets its own entry point over the same authority reads, and the
 * caller that only needs the badge never builds eight labelled rows to throw
 * seven of them away.
 *
 * `privacy-mask` appears in NEITHER list, whichever way it is sitting and
 * whether or not it could be read — its ON means "the mask is obscuring video",
 * not "this function works" ({@link CameraSwitchDescriptor.countsAsSwitchedOff}).
 * Counting it unreadable would be its own bug: the mask cannot contribute to
 * the badge, so failing to read it cannot make the badge incomplete.
 */
export function composeSwitchedOff(input: CameraSwitchDerivationInput): SwitchedOffComposition {
  const switchedOff: CameraSwitchId[] = []
  const unreadable: CameraSwitchId[] = []
  for (const id of CAMERA_SWITCH_ORDER) {
    const descriptor = CAMERA_SWITCH_CATALOG[id]
    if (!descriptor.countsAsSwitchedOff) continue
    const state = resolveState(descriptor, input)
    if (state.unavailableReason === 'source-unreachable') unreadable.push(id)
    else if (state.available && !state.enabled) switchedOff.push(id)
  }
  return { switchedOff, unreadable }
}
