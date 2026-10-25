/**
 * S5 (refactor spec 2026-07-22-post-analysis-maintainability-refactor):
 * the four DETECTION-knob sections of the pipeline-analytics global settings
 * form (`detection-sensitivity`, `confirmation-gate`, `tracking`,
 * `stationary-objects`) — extracted VERBATIM from the `globalSettingsSchema()`
 * literal in `index.ts`. Pure move, zero logic change: these are exactly the
 * sections `DETECTION_PIPELINE_SECTION_IDS` re-homes onto the Detection
 * pipeline tab. Split out of `settings-schema.ts` only to respect the
 * 800-line file cap.
 */
import type { ConfigSection } from '@camstack/types'
import { CONFIRMATION_GATE_DEFAULTS, CONFIRMATION_GATE_KEYS } from './confirmation-gate-settings.js'
import { DETECTION_SENSITIVITY_DEFAULTS } from './detection-sensitivity-settings.js'
import { STILLNESS_BAR_MAX } from './pipeline/tracker/stillness-scale.js'
import { STATIONARY_DEFAULTS } from './stationary-settings.js'
import { STILLNESS_DEFAULTS } from './stillness-settings.js'
import { TRACKING_DEFAULTS } from './tracking-settings.js'

/** The detection-knob sections, in their original in-form order. */
export function buildDetectionSettingsSections(): readonly ConfigSection[] {
  return [
    {
      id: 'detection-sensitivity',
      title: 'Detection sensitivity',
      description:
        'Per-device tracking and event-emission tuning. Lower values produce more events; higher values suppress noise.',
      columns: 2,
      fields: [
        {
          type: 'number',
          key: 'minTrackAge',
          label: 'Min track age',
          description: 'Minimum tracker hits before a track is exposed to the event emitter.',
          min: 0,
          step: 1,
          default: DETECTION_SENSITIVITY_DEFAULTS.minTrackAge,
        },
        {
          type: 'number',
          key: 'cooldownSec',
          label: 'Event cooldown',
          description: 'Minimum seconds between repeated events for the same track.',
          min: 0.5,
          step: 0.5,
          default: DETECTION_SENSITIVITY_DEFAULTS.cooldownSec,
          unit: 's',
        },
        {
          type: 'number',
          key: 'minHits',
          label: 'Min detection hits',
          description: 'Minimum consecutive detection hits before a track is promoted to output.',
          min: 1,
          step: 1,
          default: DETECTION_SENSITIVITY_DEFAULTS.minHits,
        },
        {
          type: 'number',
          key: 'stationaryThresholdSec',
          label: 'Stationary threshold',
          description: 'Seconds without significant movement before a track is marked stationary.',
          min: 0.5,
          step: 0.5,
          default: DETECTION_SENSITIVITY_DEFAULTS.stationaryThresholdSec,
          unit: 's',
        },
      ],
    },
    {
      id: 'confirmation-gate',
      title: 'Confirmation gate',
      description:
        'Before a NEW track is born, re-run object detection on the hi-res native crop of the detection box. If the crop does not confirm a compatible object above the threshold, the birth is suppressed as a false positive. Fail-DEFERRED: a crop miss, unavailable inference, or a timeout leaves the birth UNDECIDED and looks again on later frames — it is not confirmed by default. Only an exhausted deferral with no crop at all lets a birth through unmeasured.',
      columns: 2,
      fields: [
        {
          type: 'boolean',
          key: CONFIRMATION_GATE_KEYS.enabled,
          label: 'Confirm new tracks',
          description:
            'Re-detect the native crop before a birth. Off = every track is born from the low-res detection frame directly.',
          default: CONFIRMATION_GATE_DEFAULTS.enabled,
        },
        {
          type: 'slider',
          key: CONFIRMATION_GATE_KEYS.minConfidence,
          label: 'Min confirmation score',
          description:
            'Minimum re-detection score (0..1) required in the crop, class-compatible with the track, for a birth to be confirmed.',
          min: 0,
          max: 1,
          step: 0.05,
          default: CONFIRMATION_GATE_DEFAULTS.minConfidence,
          showValue: true,
        },
        {
          type: 'slider',
          key: CONFIRMATION_GATE_KEYS.minCropPx,
          label: 'Min crop size',
          description:
            'Subject boxes smaller than this (longest side, detection-frame px) are too tiny to confirm reliably — the gate defers them and looks again as the subject approaches and the box grows. 0 = confirm every birth regardless of size.',
          min: 0,
          max: 256,
          step: 8,
          default: CONFIRMATION_GATE_DEFAULTS.minCropPx,
          showValue: true,
          unit: 'px',
        },
        {
          type: 'slider',
          key: CONFIRMATION_GATE_KEYS.timeoutMs,
          label: 'Confirmation timeout',
          description:
            'Per-ATTEMPT budget for crop fetch + re-detection. If it does not resolve in time the attempt ends undecided, so the frame path never stalls on inference.',
          min: 50,
          max: 2_000,
          step: 50,
          default: CONFIRMATION_GATE_DEFAULTS.timeoutMs,
          showValue: true,
          unit: 'ms',
        },
        {
          type: 'slider',
          key: CONFIRMATION_GATE_KEYS.maxDeferralMs,
          label: 'Max deferral',
          description:
            'How long an undecided birth may wait for a native crop before the gate decides on the sub-native fallback. Measured from the first attempt, so retries cannot push it out. 0 = decide on the first attempt.',
          min: 0,
          max: 10_000,
          step: 250,
          default: CONFIRMATION_GATE_DEFAULTS.maxDeferralMs,
          showValue: true,
          unit: 'ms',
        },
        {
          type: 'slider',
          key: CONFIRMATION_GATE_KEYS.maxAttempts,
          label: 'Max gate attempts',
          description:
            'How many times one birth may be put through the gate, the first attempt included. The deferral ends on this or on the max deferral, whichever comes first.',
          min: 1,
          max: 12,
          step: 1,
          default: CONFIRMATION_GATE_DEFAULTS.maxAttempts,
          showValue: true,
        },
      ],
    },
    {
      id: 'tracking',
      title: 'Tracking',
      description:
        'Per-device tracker tuning: association, coasting, spawn floors, sub-floor continuation and detector-dropout handling. Use the deviceId-tagged logs (track started/lost/ended, frame processed) to measure the effect.',
      columns: 2,
      fields: [
        {
          type: 'number',
          key: 'iouThreshold',
          label: 'IoU match threshold',
          description:
            'Overlap required to match a (predicted) track to a detection. Higher = stricter.',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.iouThreshold,
        },
        {
          type: 'number',
          key: 'maxMissedMs',
          label: 'Max coasting time',
          description:
            'How long (ms) a track may miss detections before it is dropped. Time-based so it behaves the same on a 5fps and a 23fps camera.',
          min: 0,
          step: 100,
          default: TRACKING_DEFAULTS.maxMissedMs,
          unit: 'ms',
        },
        {
          type: 'number',
          key: 'minTrackAgeMs',
          label: 'Min track age',
          description:
            'A track must exist for at least this long (ms) before it can produce events — stops sub-second flicker fragments from becoming events.',
          min: 0,
          step: 100,
          default: TRACKING_DEFAULTS.minTrackAgeMs,
          unit: 'ms',
        },
        {
          type: 'boolean',
          key: 'predictiveCoasting',
          label: 'Predictive coasting',
          description:
            'Extrapolate a coasting track by its velocity so a moved object re-matches instead of spawning a duplicate.',
          default: TRACKING_DEFAULTS.predictiveCoasting,
        },
        {
          type: 'boolean',
          key: 'classGating',
          label: 'Class-consistent matching',
          description: 'Only match a detection to a track of the same class.',
          default: TRACKING_DEFAULTS.classGating,
        },
        {
          type: 'boolean',
          key: 'dedupEnabled',
          label: 'Duplicate-track suppression',
          description:
            'Suppress and merge concurrent duplicate tracks. Stops one subject the detector double-fires (two boxes for one object, or a person misdetected as an animal) from becoming several time-overlapping tracks that each fire their own event. Off = legacy behaviour.',
          default: TRACKING_DEFAULTS.dedupEnabled,
        },
        {
          type: 'number',
          key: 'dedupSpawnIou',
          label: 'Duplicate spawn IoU',
          description:
            'Overlap at/above which a NEW track is treated as a duplicate of a concurrent same-kind track and not created. High so two distinct subjects appearing close together are still tracked separately.',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.dedupSpawnIou,
        },
        {
          type: 'boolean',
          key: 'personAnimalDedup',
          label: 'Person/animal duplicate merge',
          description:
            'Treat an animal track overlapping a person track as the same subject (a person in a crouching / bending pose is often misdetected as an animal). The person track wins.',
          default: TRACKING_DEFAULTS.personAnimalDedup,
        },
        {
          type: 'number',
          key: 'animalOverPersonMaxScore',
          label: 'Animal-over-person max score',
          description:
            'A low-confidence animal detection (score below this) sitting on a concurrent person track is suppressed — the common person-in-odd-pose false animal.',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.animalOverPersonMaxScore,
        },
        {
          type: 'number',
          key: 'animalOverPersonIou',
          label: 'Animal-over-person IoU',
          description:
            'Overlap with a concurrent person track that triggers the low-confidence animal spawn suppression.',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.animalOverPersonIou,
        },
        {
          type: 'boolean',
          key: 'dropoutSkipEnabled',
          label: 'Detector-dropout skip',
          description:
            'Skip frames where detections suddenly drop to zero (likely a detector glitch) to protect coasting tracks.',
          default: TRACKING_DEFAULTS.dropoutSkipEnabled,
        },
        {
          type: 'number',
          key: 'dropoutMaxSkipFrames',
          label: 'Dropout max skip frames',
          description:
            'Max consecutive all-zero frames absorbed as a glitch before the scene is treated as genuinely empty.',
          min: 0,
          step: 1,
          default: TRACKING_DEFAULTS.dropoutMaxSkipFrames,
        },
        {
          type: 'boolean',
          key: 'classVotingEnabled',
          label: 'Per-track class voting',
          description:
            'Report a track’s class by a confidence-weighted majority over its whole life instead of the latest frame — a person read as an animal on a single crouch/bend frame keeps the person label.',
          default: TRACKING_DEFAULTS.classVotingEnabled,
        },
        {
          type: 'number',
          key: 'classVoteMinFraction',
          label: 'Class-vote min fraction',
          description:
            'The winning class must hold at least this fraction of a track’s total vote weight to override the latest frame; below it the latest frame wins (so a genuine mid-life reclassification is not frozen out).',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.classVoteMinFraction,
        },
        {
          type: 'boolean',
          key: 'perClassMinScoreEnabled',
          label: 'Per-class spawn confidence',
          description:
            'Require a per-class minimum detection score before a NEW track is created. Kills static-object / reflection false spawns from the FP-prone classes. An already-tracked object still matches on a low-confidence frame.',
          default: TRACKING_DEFAULTS.perClassMinScoreEnabled,
        },
        {
          type: 'number',
          key: 'minScorePerson',
          label: 'Min spawn score — person',
          description: 'Minimum score to spawn a person track. 0 keeps person fully sensitive.',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.minScorePerson,
        },
        {
          type: 'number',
          key: 'minScoreAnimal',
          label: 'Min spawn score — animal',
          description:
            'Minimum score to spawn an animal track (FP-prone — a higher floor drops low-confidence static-object false animals).',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.minScoreAnimal,
        },
        {
          type: 'number',
          key: 'minScoreVehicle',
          label: 'Min spawn score — vehicle',
          description:
            'Minimum score to spawn a vehicle track (FP-prone — a higher floor drops low-confidence false vehicles).',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.minScoreVehicle,
        },
        {
          type: 'boolean',
          key: 'confirmBypassEnabled',
          label: 'Fast high-confidence confirm',
          description:
            'Let a single very-high-confidence detection confirm a track for events before it reaches the min-hits gate, so a fast subject crossing in 1-2 frames (a passing car) still registers. Off by default (strict N-hit confirmation).',
          default: TRACKING_DEFAULTS.confirmBypassEnabled,
        },
        {
          type: 'number',
          key: 'confirmBypassScore',
          label: 'Fast-confirm score',
          description:
            'Score at/above which a detection confirms its track immediately, bypassing min-hits. Only used when fast high-confidence confirm is on.',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.confirmBypassScore,
        },
        {
          type: 'number',
          key: 'byteTrackLowIouThreshold',
          label: 'Sub-floor recovery IoU',
          description:
            'The IoU a sub-floor box needs with a moving tracklet’s prediction to re-attach it. Which boxes count as sub-floor is decided by the "keep tracks through low-confidence frames" option below.',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.byteTrackLowIouThreshold,
        },
        {
          type: 'boolean',
          key: 'lowScoreContinuationEnabled',
          label: 'Keep tracks through low-confidence frames',
          description:
            'Boxes below the class confidence floor may keep an EXISTING track alive while the detector is unsure, so a person read at 0.5 for a few seconds keeps one id instead of splitting. They never start a track and never produce events, notifications or snapshots.',
          default: TRACKING_DEFAULTS.lowScoreContinuationEnabled,
        },
        {
          type: 'number',
          key: 'lowScoreContinuationFloor',
          label: 'Low-confidence continuation floor',
          description:
            'Score at or above which a box the class floor dropped still counts as evidence that a tracked subject is there. Only used with the option above.',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.lowScoreContinuationFloor,
        },
        {
          type: 'boolean',
          key: 'trackingTape',
          label: 'Record the track history (kept 1 day)',
          description:
            'Write, continuously, what the tracker is given on this camera — boxes, classes, scores, before the tracker decides — and the ids it produced, never pixels, so a track that went wrong can be promoted and kept as a test case within a day. About 43–72 MB per day per camera on the Artifacts location. Off by default; Events → Debug → Tapes shows what each recording camera costs.',
          default: TRACKING_DEFAULTS.trackingTape,
        },
        {
          type: 'boolean',
          key: 'minSpawnAreaEnabled',
          label: 'Minimum spawn size',
          description:
            'Require a new track’s box to cover at least a minimum fraction of the frame before it is created — stops tiny far-field / vanishing-point blips from spawning full tracks. An already-tracked subject that shrinks into the distance is unaffected.',
          default: TRACKING_DEFAULTS.minSpawnAreaEnabled,
        },
        {
          type: 'number',
          key: 'minSpawnAreaFracPerson',
          label: 'Min spawn area — person',
          description:
            'Smallest person box (as a fraction of the frame area) allowed to start a NEW track. 0 = ungated. Conservative default (0.0005 = 0.05% of frame) drops only vanishing-point noise. Raise on cameras with a distant road / horizon.',
          min: 0,
          max: 1,
          step: 0.0005,
          default: TRACKING_DEFAULTS.minSpawnAreaFracPerson,
        },
        {
          type: 'number',
          key: 'minSpawnAreaFracAnimal',
          label: 'Min spawn area — animal',
          description:
            'Smallest animal box (fraction of frame area) allowed to start a NEW track. 0 = ungated (animal already has a spawn-score floor).',
          min: 0,
          max: 1,
          step: 0.0005,
          default: TRACKING_DEFAULTS.minSpawnAreaFracAnimal,
        },
        {
          type: 'number',
          key: 'minSpawnAreaFracVehicle',
          label: 'Min spawn area — vehicle',
          description:
            'Smallest vehicle box (fraction of frame area) allowed to start a NEW track. 0 = ungated (vehicle already has a spawn-score floor).',
          min: 0,
          max: 1,
          step: 0.0005,
          default: TRACKING_DEFAULTS.minSpawnAreaFracVehicle,
        },
        {
          type: 'boolean',
          key: 'classGroupAssoc',
          label: 'Person/animal group matching',
          description:
            'Let a detection that flips between person and animal for a frame (a crouching / bending person is often read as an animal) re-match its existing track instead of spawning a concurrent animal track. A flip is the same subject in the same place, weakly read: the cross-class match happens only on the strict predicted-box pass and only for a full-frame box below the "animal over person max score" bar — a confident animal beside a person, or a person beside an animal, is its own subject and keeps its own track. The reported class is still decided by the per-track class vote.',
          default: TRACKING_DEFAULTS.classGroupAssoc,
        },
        {
          type: 'number',
          key: 'zoneMembershipMinOverlap',
          label: 'Zone membership minimum overlap',
          description:
            'How much of a detection box must fall inside a zone for the detection to be STAMPED with it — as a fraction of the BOX area, not of the zone. Same bar for live tracks and parked (stationary) occupancy. 0 stamps on any touch, which is what let a plant brushing a zone by 6% fire a "person on the doorstep" rule. Only a stamped zone can match a zone-scoped notification rule. Read the "zone membership stamped on event" log line to choose the value: it prints the achieved percentage per zone.',
          min: 0,
          max: 1,
          step: 0.05,
          default: TRACKING_DEFAULTS.zoneMembershipMinOverlap,
        },
      ],
    },
    {
      id: 'stationary-objects',
      title: 'Stationary objects',
      tab: 'analytics',
      description:
        'Parked / idle object suppression — keeps a stopped car from re-spawning tracks and re-flooding events. Per-device overrides on each camera. Defaults match today’s behaviour.',
      columns: 2,
      fields: [
        {
          type: 'boolean',
          key: 'enabled',
          label: 'Suppress parked objects',
          description:
            'Promote a stopped object to a lightweight registry entry and suppress its detections from re-spawning tracks. Off = every parked object keeps spawning normal tracks on this camera.',
          default: STATIONARY_DEFAULTS.enabled,
        },
        {
          type: 'slider',
          key: 'suppressIou',
          label: 'Suppress IoU',
          description:
            'Overlap at/above which a detection is the SAME parked object (unmoved) → its spawn is suppressed. Lower can suppress genuine new tracks near a parked object.',
          min: 0.3,
          max: 0.9,
          step: 0.05,
          default: STATIONARY_DEFAULTS.suppressIou,
          showValue: true,
        },
        {
          type: 'slider',
          key: 'wakeAssocIou',
          label: 'Wake / associate IoU',
          description:
            'Minimum overlap for a detection to be treated as a parked entry’s OWN object (confirm or wake it). Too low lets a passing object wake a parked entry (re-flood); too high can miss the real departure.',
          min: 0.02,
          max: 0.5,
          step: 0.02,
          default: STATIONARY_DEFAULTS.wakeAssocIou,
          showValue: true,
        },
        {
          type: 'slider',
          key: 'sessionStillnessWindowMs',
          label: 'Session stillness window',
          description:
            'How long (ms) a tracked object must stay put before it stops holding a motion session open. It creates nothing: a parked object becomes an entry by being seen repeatedly in the same place, not by one track surviving this long.',
          min: 5_000,
          max: 120_000,
          step: 1_000,
          default: STATIONARY_DEFAULTS.sessionStillnessWindowMs,
          showValue: true,
          unit: 's',
          displayScale: 1000,
        },
        {
          type: 'slider',
          key: 'entryTtlMs',
          label: 'Observed-time TTL',
          description:
            'Retire a parked entry after this much OBSERVED (frames-flowing) time without a confirming detection — the object was removed while watched, or a long occlusion.',
          min: 60_000,
          max: 1_800_000,
          step: 30_000,
          default: STATIONARY_DEFAULTS.entryTtlMs,
          showValue: true,
          unit: 's',
          displayScale: 1000,
        },
      ],
    },
    buildStillnessScaleSection(),
  ]
}

/**
 * The per-camera STILLNESS SCALE — one measured number plus its provenance.
 *
 * Its own section rather than a field on `detection-sensitivity` because the
 * two answer different questions: `stationaryThresholdSec` is HOW LONG a
 * settled subject must stay settled, which is an operator preference; this is
 * HOW SLOW counts as settled, which is a fact about the camera and is
 * measured. Mixing them is how a measurement ends up being guessed at.
 */
function buildStillnessScaleSection(): ConfigSection {
  return {
    id: 'stillness-scale',
    title: 'Stillness scale (per camera)',
    description:
      'How slowly a subject has to move on THIS camera before it counts as settled. A camera looking down a 30 m driveway and one watching a doorway two metres away disagree about this by more than an order of magnitude, so one fleet-wide number cannot be right for both. Leave it at 0 and the camera behaves exactly as it always has (a flat 2 px-per-update bar). Run the `stillness.calibrate` action to measure it from the camera’s own recorded tracks — the run reports what it measured and REFUSES, with a reason, when the evidence is too thin.',
    columns: 1,
    fields: [
      {
        type: 'number',
        key: 'stillnessSpeedFracPerSec',
        label: 'Stillness speed bar',
        description:
          'Centroid speed, as a fraction of the subject’s OWN box diagonal, per second, at or below which the subject is not travelling. Subject-relative, so perspective is already divided out; per second, so an irregular on-motion cadence cannot masquerade as speed. 0 = not calibrated (the shipped absolute bar decides, exactly as before). Live reference: 0.0136 on a close, mostly-parked view; 0.3081 on a far view whose subjects only transit.',
        min: 0,
        max: STILLNESS_BAR_MAX,
        step: 0.001,
        default: STILLNESS_DEFAULTS.stillnessSpeedFracPerSec,
      },
      {
        type: 'text',
        key: 'stillnessCalibrationNote',
        label: 'Last calibration',
        description:
          'What the last run measured, from how many samples and tracks, and what it chose — or which named reason it refused for. Display only.',
        default: STILLNESS_DEFAULTS.stillnessCalibrationNote,
        readonlyField: true,
      },
      {
        // The action was reachable only through the API until now, which made
        // a per-camera measurement something an operator could not run on the
        // camera they were looking at. `includeDeviceId` is what lets an addon
        // action sit on a device form at all: the camera is context, not a
        // value anyone types.
        type: 'addon-action-button',
        key: '__stillness-calibrate',
        addonId: 'pipeline-analytics',
        action: 'stillness.calibrate',
        label: 'Calibrate from this camera',
        description:
          'Measure this camera’s own recent tracks and WRITE the bar above from them. It refuses — with a reason, and without writing — when the evidence is too thin: no tracks, too few tracks, too few samples, or no movement to scale against. The reading it took is left in “Last calibration” either way, so a refusal is as legible as a result.',
        buttonLabel: 'Calibrate now',
        variant: 'primary',
        includeDeviceId: true,
        // `apply` is explicit: reading the camera and WRITING a threshold are
        // different enough in consequence that the button says which it did.
        paramsStatic: { apply: true },
        confirmMessage:
          'Measure this camera’s recent tracks and overwrite its stillness bar with what they show?',
        successMessage: '{note}',
      },
    ],
  }
}
