/**
 * S5 (refactor spec 2026-07-22-post-analysis-maintainability-refactor):
 * the pipeline-analytics GLOBAL settings-form schema plus the pure per-device
 * section transforms, extracted VERBATIM from `index.ts`. Pure move, zero
 * logic change — `buildGlobalSettingsSchema()` returns a schema object
 * byte-identical to the old inline `this.schema({ ... })` literal.
 *
 * The four detection-knob sections live in `settings-schema-sections.ts`
 * (800-line file cap); `buildGlobalSettingsSchema` concatenates them at their
 * original position (end of the form).
 */
import { AUDIO_MACRO_LABELS, type ConfigSection, type ConfigUISchema } from '@camstack/types'
import { PRUNE_WINDOW_DEFAULT_DAYS } from '../notification-center/prune-windows.js'
import { AUDIO_DETECTION_DEFAULTS } from './audio-detection-settings.js'
import { DEVICE_ALERT_DEFAULTS } from './device-alert-settings.js'
import {
  deriveSuggestionMinCosine,
  FACE_DEFAULTS,
  SUGGESTION_BAND_FACTOR,
} from './face-settings.js'
import { PACKAGE_DROP_DEFAULTS } from './package-settings.js'
import { TRACK_RETENTION_DEFAULT_DAYS } from './retention-policy.js'
import { buildDetectionSettingsSections } from './settings-schema-sections.js'

/** Cluster setting key (in the centralized addon store) selecting the SINGLE
 *  node that runs post-analysis (event/media/audio/motion generation). All
 *  other nodes are fully inert. No multi-node balancing. Default: the hub. */
export const POST_PROCESSING_NODE_DEFAULT = 'hub'

/**
 * The ONE default for the object/face embedding dispatcher — the form field
 * below and the addon's `embeddingEnabled` durable handle both read it.
 *
 * They used to disagree: the field declared `false` while the handle's
 * fallback was `true`, so an operator who had never touched the toggle saw
 * OFF on a cluster where the dispatcher was running, and a Save on that form
 * would have written the lie back as truth. Two defaults over one store key
 * is the defect, not the value — so there is exactly one constant now, and
 * the handle imports it rather than restating it.
 */
export const EMBEDDING_ENABLED_DEFAULT = true

/**
 * Re-home the global analytics sections into the per-device `Analytics`
 * top-tab. Every section defaults to the `Analytics` tab (so the
 * device-manager aggregator groups them) AND is marked
 * `location: 'top-tab'` so `DeviceDetail` surfaces them as their own
 * device-detail top-level tab instead of nesting them under Config —
 * mirrors how recording/zones/ptz/live-stats hoist their sections.
 * Pure transform: only the per-device contribution uses it; the global
 * settings page renders the untouched `globalSettingsSchema()`.
 */
export function toAnalyticsDeviceSections<T extends { readonly tab?: string }>(
  sections: readonly T[],
): ReadonlyArray<T & { readonly tab: string; readonly location: 'top-tab' }> {
  return sections.map((s) => ({
    ...s,
    tab: s.tab ?? 'analytics',
    location: 'top-tab' as const,
  }))
}

/**
 * Global-analytics section ids that are really per-camera DETECTION knobs and
 * belong in the consolidated `Detection pipeline → Settings` sub-tab alongside
 * Object Detection — NOT under the generic `Analytics` top-tab:
 *   - `detection-sensitivity` — minHits / cooldown / stationary threshold.
 *   - `confirmation-gate` — hi-res native-crop re-detection before a birth.
 *   - `tracking` — the tracker-tuning form incl. the FP knobs (dedup, person↔
 *     animal dedup, class voting, confirm-bypass, per-class min score).
 *   - `stationary-objects` — stationary promotion + occupancy tuning.
 *   - `stillness-scale` — the per-camera measured "how slow is settled" bar.
 * `DeviceDetail` folds `tab: 'detection-pipeline'` top-tab sections into the
 * structural Detection pipeline tab, so re-tagging is all that's needed —
 * there is no admin-ui change and no duplicate render (a section has one tab).
 */
export const DETECTION_PIPELINE_SECTION_IDS: ReadonlySet<string> = new Set([
  'detection-sensitivity',
  'confirmation-gate',
  'tracking',
  'stationary-objects',
  'stillness-scale',
])

/**
 * Re-home the detection-knob sections from the `Analytics` top-tab onto the
 * `detection-pipeline` top-tab. Pure copy — only the `tab` of a matched
 * section changes; every other section (media policy, retention, faces, track
 * history) stays on Analytics.
 */
export function retagDetectionSections<T extends { readonly id?: string; readonly tab?: string }>(
  sections: readonly T[],
): T[] {
  return sections.map((s) =>
    s.id !== undefined && DETECTION_PIPELINE_SECTION_IDS.has(s.id)
      ? { ...s, tab: 'detection-pipeline' }
      : s,
  )
}

/**
 * Re-home the analytics `retention` section onto the recorder's `recording`
 * top-tab (operator ask, 2026-07-29): footage and analytics retention are ONE
 * unified policy since the follow-recordings default, so their controls
 * belong on ONE tab. Same pure-retag mechanism as the detection sections —
 * `DeviceDetail` folds matching-tab sections together, no admin-ui change.
 */
export function retagRetentionSection<T extends { readonly id?: string; readonly tab?: string }>(
  sections: readonly T[],
): T[] {
  return sections.map((s) => (s.id === 'retention' ? { ...s, tab: 'recording' } : s))
}

/**
 * Key of the read-only readout that replaced the `suggestionMinCosine` knob
 * (D222).
 *
 * It is `readonlyField: true`, so the form renders it display-only with no
 * mutation handler and it can never enter a settings patch — it carries a
 * derived value and must not become the second stored authority it replaced.
 * Its value is injected at hydrate time by the addon's `getGlobalSettings`
 * override, the same mechanism `detection-pipeline` uses for its live
 * model-substitution readout.
 */
export const SUGGESTION_THRESHOLD_READOUT_KEY = 'suggestionThresholdReadout'

/** `getGlobalSettings({ cap })` scope for the face matching form. */
const FACE_GALLERY_SETTINGS_CAP = 'face-gallery'
const FACE_RECOGNITION_SECTION_ID = 'face-recognition'

/** Percent, at most one decimal, without a trailing `.0`. Cosines here are
 *  two-decimal operator values; `36.0%` reads like false precision. */
function asPercent(value: number): string {
  return `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`
}

/**
 * The sentence beside the similarity threshold: what is being suggested from,
 * and the rule it comes from. Both, always — a number that moves whenever
 * another number moves reads as a bug unless the rule is on screen with it.
 */
export function formatSuggestionThresholdReadout(similarityThreshold: number): string {
  const floor = deriveSuggestionMinCosine(similarityThreshold)
  return `${asPercent(floor)} — ${asPercent(SUGGESTION_BAND_FACTOR)} of the ${asPercent(
    similarityThreshold,
  )} match threshold`
}

/**
 * Fields that live ONLY on the global settings page and must never surface in a
 * per-device contribution. The face-recognition `enabled` switch is the GLOBAL
 * master kill for the whole subsystem — per-camera face production is governed
 * by each device's detection-pipeline steps, so a per-device toggle would be
 * misleading. Keyed by section id → set of field keys to drop.
 */
const GLOBAL_ONLY_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  'face-recognition': new Set(['enabled', SUGGESTION_THRESHOLD_READOUT_KEY]),
}

/**
 * Whole sections that are cluster-wide (global page only) and must NOT appear
 * in a per-device contribution (D62: a per-camera field whose reader only ever
 * consults the global addon store is a knob that writes a store nobody reads).
 *
 *   - `cluster-post-processing` — which node runs post-analysis.
 *   - `embedding-index` — rebuild / wipe buttons that act on the whole index.
 *   - `device-alerts` — battery / offline thresholds; read from the global
 *     store into `deviceAlertSettingsMirror`, one value for the installation.
 *   - `prune-windows` — outbox / timelapse / artefact shelf / digest mosaic
 *     windows; `pruneWindows()` resolves them from the global store only.
 */
export const GLOBAL_ONLY_SECTIONS: ReadonlySet<string> = new Set([
  'cluster-post-processing',
  'embedding-index',
  'device-alerts',
  'prune-windows',
])

/** Drop global-only sections + global-only fields from per-device sections. */
export function stripGlobalOnlyFields<
  T extends {
    readonly id?: string
    readonly fields?: readonly { readonly key?: string }[]
  },
>(sections: readonly T[]): T[] {
  return sections
    .filter((s) => !(s.id && GLOBAL_ONLY_SECTIONS.has(s.id)))
    .map((s) => {
      const drop = s.id ? GLOBAL_ONLY_FIELDS[s.id] : undefined
      if (!drop || !s.fields) return s
      return {
        ...s,
        fields: s.fields.filter((f) => f.key === undefined || !drop.has(f.key)),
      }
    })
}

/**
 * Fields that live ONLY on the per-device contribution and must never surface
 * on the GLOBAL settings page — the mirror of {@link GLOBAL_ONLY_FIELDS}.
 * `trackingTape` (D681, final review L3) arms continuous recording on the
 * camera it is set on; a global click must never arm every camera at once
 * (43–72 MB/day each). Keyed by section id → set of field keys to drop.
 */
const DEVICE_ONLY_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  tracking: new Set(['trackingTape']),
}

/** Drop device-only fields before the sections reach the GLOBAL settings
 *  page — the mirror of {@link stripGlobalOnlyFields}. The per-device
 *  contribution builds its own sections straight off `globalSettingsSchema()`
 *  (this function is never in that path), so it keeps every device-only
 *  field untouched. */
export function stripDeviceOnlyFields<
  T extends {
    readonly id?: string
    readonly fields?: readonly { readonly key?: string }[]
  },
>(sections: readonly T[]): T[] {
  return sections.map((s) => {
    const drop = s.id ? DEVICE_ONLY_FIELDS[s.id] : undefined
    if (!drop || !s.fields) return s
    return {
      ...s,
      fields: s.fields.filter((f) => f.key === undefined || !drop.has(f.key)),
    }
  })
}

/**
 * The global settings-form schema (P8 cascade: global defaults here, per-
 * device overrides via the device settings aggregator). The addon wraps this
 * in `BaseAddon.schema()`; the general sections below are followed by the
 * detection-knob sections in the original order.
 */
export function buildGlobalSettingsSchema(cap?: string): ConfigUISchema {
  const generalSections: readonly ConfigSection[] = [
    {
      id: 'cluster-post-processing',
      title: 'Cluster post-processing',
      description:
        'Which node runs detection post-processing (events, media, audio/motion events). A SINGLE node — no multi-node balancing; every other node stays fully inert. Default: hub.',
      columns: 1,
      fields: [
        {
          type: 'text',
          key: 'postProcessingNodeId',
          label: 'Post-processing node',
          description:
            'Node id that persists events + media (e.g. "hub"). Leave "hub" unless you intentionally move post-processing to an agent. Takes effect on addon restart.',
          default: POST_PROCESSING_NODE_DEFAULT,
        },
        {
          type: 'boolean',
          key: 'embeddingEnabled',
          label: 'Object/face embedding dispatcher',
          description:
            'ON by default, and running on an untouched cluster. The dispatcher pulls the native key frame for a closed track, crops each qualifying detection and encodes it through the embedding-encoder capability, on the post-processing node only. Turning it OFF stops that CPU cost and changes nothing already indexed. Takes effect on addon restart.',
          default: EMBEDDING_ENABLED_DEFAULT,
        },
      ],
    },
    {
      // Maintenance for the CLIP semantic-search index. These are buttons
      // rather than settings because they are OPERATIONS, and the two that
      // matter are slow: a rebuild is ~1s per track, so it runs detached and
      // the status button is the only way to watch it.
      id: 'embedding-index',
      title: 'Semantic search index',
      description:
        'The CLIP vector index behind text search. Rebuild re-embeds stored tracks from their native key frames — the only way to change what a vector means, since a new crop convention or encoder model leaves two incomparable feature spaces in one index. Vectors live in the vector-store capability, alongside the events they are shown with.',
      columns: 1,
      fields: [
        // The rebuild crop margin used to be a field HERE, applied only to
        // rebuilds — so pressing this button produced vectors the live path
        // could not be compared against. The crop convention is now cluster-
        // wide (Pipeline → Enrichment crop) and the rebuild reproduces it
        // exactly, because both paths cut through the same runner code.
        {
          type: 'addon-action-button',
          key: 'rebuildEmbeddingsButton',
          label: 'Rebuild index',
          description:
            "Re-embed every stored track from its key frame, through the detection pipeline, into the index of the cluster's Semantic search model, using the cluster Enrichment crop setting — so a rebuilt vector is comparable with a live one. Tracks already in that model's index are skipped, so a pass can be re-run to resume. Runs in the background; press Progress to watch it. Tracks whose key frame has aged out, or whose camera is detached, are reported as skipped rather than dropped.",
          addonId: 'pipeline-analytics',
          action: 'embedding.rebuild',
          buttonLabel: 'Rebuild',
          variant: 'primary',
          successMessage: 'Rebuild started — press Progress to follow it.',
        },
        {
          type: 'addon-action-button',
          key: 'rebuildStatusButton',
          label: 'Progress',
          description:
            "The running (or last) pass: the CLIP model it pinned, the rows in that model's index, and what it scanned, rebuilt and had to skip.",
          addonId: 'pipeline-analytics',
          action: 'embedding.rebuildStatus',
          buttonLabel: 'Check progress',
          successMessage:
            '{modelId} → {index}: indexed {indexed} · scanned {scanned} · rebuilt {rebuilt} · no key frame {missingKeyFrame} · no box {missingBbox} · no event {missingEvent} · not runnable {notRunnable} · failed {failed}',
        },
        {
          type: 'addon-action-button',
          key: 'wipeEmbeddingsButton',
          label: 'Empty the index',
          description:
            "Deletes every vector in EVERY semantic-search index (each CLIP model's own). Search returns nothing until a rebuild repopulates it, and only tracks still inside the retention window can be rebuilt — anything older is gone for good.",
          addonId: 'pipeline-analytics',
          action: 'embedding.wipe',
          buttonLabel: 'Empty index',
          variant: 'danger',
          confirmMessage:
            'Delete every semantic-search vector? Search stops working until a rebuild finishes, and vectors whose tracks have aged out cannot be recovered.',
          successMessage: 'Removed {deleted} vectors.',
        },
      ],
    },
    // ── REMOVED 2026-08-20: the `tracking-core` section ──────────────────
    //
    // It offered two sliders, `trackTtlMs` ("Track TTL — milliseconds without a
    // sighting before a track is finalized") and `maxPositionHistory`. Both
    // wrote per-device keys that NOTHING ever read back: `TrackStore` accepts a
    // `TrackStoreConfig`, `buildStores` constructs it without one, and every
    // camera on every cluster has always run the 30 s / 300-position
    // `DEFAULT_CONFIG`.
    //
    // `trackTtlMs` was also a SECOND AUTHORITY on a function that already had
    // one (D62). "How long without a sighting before a track dies" is owned,
    // per camera and live, by the tracker: `maxMissedMs` in the `tracking`
    // section (the occlusion and hard-lifetime variants, `occlusionMaxMissedMs`
    // and `maxTrackLifetimeSec`, were retired with the rest of the old
    // tracker's settings — D683, Task 13). An operator who dropped the TTL
    // slider to 5 s and saw nothing change had every reason to conclude the
    // tracker was broken.
    //
    // `TrackStore.ttlMs` stays a CONSTANT deliberately: it is the store-side
    // backstop for a track the tracker never closed, and a net that can be
    // dialled below the budget it backstops is not a net. Pinned by
    // `settings-schema-dead-knobs.spec.ts`.
    {
      id: 'media-policy',
      title: 'Snapshots & media',
      columns: 2,
      fields: [
        {
          type: 'boolean',
          key: 'debugMediaEnabled',
          label: 'Debug media',
          description:
            'Off (the default) keeps first/last frame, key frames, thumbnails and face/plate crops, and reduces motion-only stills to one marker per detection drought. On also stores the per-track filmstrip and a still on EVERY motion transition — diagnostic volume, roughly 95 KiB per transition.',
          default: false,
        },
        {
          type: 'slider',
          key: 'motionMarkerQuietMs',
          label: 'Motion marker after',
          description:
            'With debug media off: a motion still is kept only when no detection has run on this camera for this long, and at most one per window. Fleet p90 of detection-free stretches is ~13 min.',
          min: 60_000,
          max: 21_600_000,
          step: 60_000,
          default: 900_000,
          showValue: true,
          unit: 'min',
          displayScale: 60_000,
        },
        {
          type: 'slider',
          key: 'snapshotIntervalMs',
          label: 'Snapshot interval',
          description: 'How often a snapshot is persisted per active track.',
          min: 500,
          max: 60_000,
          step: 500,
          default: 5_000,
          showValue: true,
          unit: 's',
          displayScale: 1000,
        },
        {
          type: 'slider',
          key: 'snapshotMovementThreshold',
          label: 'Snapshot movement gate',
          description:
            'After the interval elapses, only capture a snapshot if the object moved this fraction of the frame since the last one. Higher = fewer near-identical frames. 0 disables the gate.',
          min: 0,
          max: 0.15,
          step: 0.005,
          default: 0.03,
          showValue: true,
          unit: '%',
          displayScale: 0.01,
        },
        {
          type: 'slider',
          key: 'snapshotMaxIdleMs',
          label: 'Snapshot max idle',
          description:
            'Force a snapshot for a stationary but still-present track after this long without one, so its filmstrip is never empty.',
          min: 5_000,
          max: 120_000,
          step: 5_000,
          default: 30_000,
          showValue: true,
          unit: 's',
          displayScale: 1000,
        },
      ],
    },
    {
      id: 'audio-metrics-report',
      title: 'Audio metrics reporting',
      description:
        "Coalesce audio-metrics state updates so the events tab + bus aren't flooded by per-second dBFS jitter on idle scenes. Per-camera override.",
      columns: 2,
      fields: [
        {
          type: 'boolean',
          key: 'audioMetricsReportEnabled',
          label: 'Mirror to device-state',
          description:
            'When off, the audio classifier still runs (the live AUDIO METRICS panel reads through the cap method), but the periodic state-changed events are suppressed. Use for cameras where audio is informational only.',
          default: true,
        },
        {
          type: 'slider',
          key: 'audioMetricsReportThresholdDb',
          label: 'Report threshold',
          description:
            'Minimum dBFS delta between consecutive snapshots to trigger an emit. 2dB means quiet noise jitter (±1dB) is suppressed; class changes always emit regardless. Lower = more updates.',
          min: 0,
          max: 10,
          step: 1,
          default: 2,
          showValue: true,
          unit: 'dB',
        },
      ],
    },
    {
      id: 'device-alerts',
      title: 'Battery & offline alerts',
      // THREE knobs, cluster-wide, and no per-rule copy of any of them. A rule
      // selects the KINDS and the devices; how low is low, how often it is
      // repeated and whether the all-clear is announced are properties of the
      // installation, and two rules disagreeing about when a battery is low is
      // the D62 shape.
      description:
        'What counts as a low battery, how often a still-true alert is repeated, and whether the return to normal is announced. These govern the device-event rules; the rules themselves still choose which devices and which kinds — and each rule sets its own consumable threshold. A device with a binary low-battery indicator (no real percentage) is judged by the indicator, and the threshold below does not apply to it.',
      columns: 2,
      fields: [
        {
          type: 'number',
          key: 'batteryLowPercent',
          label: 'Low battery at',
          description:
            'At or below this, a measured battery is low. The alert fires once when the band is entered and clears only once the reading is well clear of it, so a battery sitting on the threshold does not send pairs of notifications.',
          min: 1,
          max: 99,
          step: 1,
          default: DEVICE_ALERT_DEFAULTS.batteryLowPercent,
          unit: '%',
        },
        {
          type: 'number',
          key: 'alertRenotifyMinutes',
          label: 'Repeat while still true',
          description:
            'How long before a still-flat battery or a still-offline device is announced again. 0 says it once and never repeats. The repeat goes through the same rules, mutes and schedules as the first one, so a quiet-hours rule still silences it.',
          min: 0,
          step: 15,
          default: DEVICE_ALERT_DEFAULTS.alertRenotifyMinutes,
          unit: 'min',
        },
        {
          type: 'boolean',
          key: 'alertNotifyRecovery',
          label: 'Announce the all-clear',
          description:
            'Send a notification when a battery comes back above the threshold, or a device comes back online. Off suppresses the message only — the hub still records the recovery, so the next fall is announced normally.',
          default: DEVICE_ALERT_DEFAULTS.alertNotifyRecovery,
        },
      ],
    },
    {
      id: 'retention',
      title: 'Retention',
      description:
        "ONE window per camera. Everything this camera produces — tracks, their events, media, faces, plates and search vectors, plus motion, audio and sensor events — is deleted on it. Default: as long as the camera's recordings, so footage and analytics stay one policy. Enrolled faces and plates are never pruned.",
      columns: 2,
      fields: [
        {
          type: 'select',
          key: 'retentionMode',
          label: 'Mode',
          description:
            'Follow recordings: history lives exactly as long as retained footage (age retention AND disk eviction; never prunes the last 7 days). Custom: the window below.',
          default: 'follow-recordings',
          options: [
            {
              value: 'follow-recordings',
              label: 'Follow recordings (default)',
            },
            { value: 'custom', label: 'Custom window' },
          ],
        },
        {
          type: 'number',
          key: 'trackRetentionDays',
          label: 'Window',
          description:
            "How long this camera's analytics history is kept in Custom mode — and the bound in Follow mode when the camera has no footage at all. 0 = keep forever, which switches retention OFF for this camera entirely (motion and audio events included, and those grow by thousands of rows a day).",
          min: 0,
          max: 365,
          step: 1,
          default: TRACK_RETENTION_DEFAULT_DAYS,
          unit: 'days',
        },
      ],
    },
    {
      id: 'prune-windows',
      title: 'What else is kept, and for how long',
      description:
        "These are CLUSTER-wide and independent of the per-camera window above: notification history, rendered timelapses, the browsable artefact shelf and a rule's digest mosaics. 0 = keep forever, except the timelapse window, which has a minimum of 1 day because the export engine cannot hold a file indefinitely. The artefact shelf is bounded by this window ALONE — there is no row or byte cap behind it, and nothing else sweeps that disk.",
      columns: 2,
      fields: [
        {
          type: 'number',
          key: 'outboxDays',
          label: 'Notification history',
          description:
            'How long a delivered or failed notification stays in the outbox. Pruned once, at boot. Shrinking this does not undeliver anything — it only forgets what was already sent.',
          min: 0,
          max: 365,
          step: 1,
          default: PRUNE_WINDOW_DEFAULT_DAYS.outboxDays,
          unit: 'days',
        },
        {
          type: 'number',
          key: 'timelapseExportDays',
          label: 'Rendered timelapses',
          description:
            'How long a scheduled timelapse\'s video file is kept by the export engine. Minimum 1 day: this is the one window with no "forever", because the export capability requires a positive lifetime.',
          min: 1,
          max: 365,
          step: 1,
          default: PRUNE_WINDOW_DEFAULT_DAYS.timelapseExportDays,
          unit: 'days',
        },
        {
          type: 'number',
          key: 'artifactShelfDays',
          label: 'Artefact shelf',
          description:
            'How far back the browsable gallery goes (timelapses, GIFs, clips, mosaics). This window is now the ONLY bound on that shelf — the old 2 000-row and 2 GiB caps are gone, so the number means what it says, and nothing else protects the disk. Measured 2026-09-13: 901 files, ~710 MB at 14 days, the busiest camera at 580 MB. A change takes effect on addon restart.',
          min: 0,
          max: 365,
          step: 1,
          default: PRUNE_WINDOW_DEFAULT_DAYS.artifactShelfDays,
          unit: 'days',
        },
        {
          type: 'number',
          key: 'summaryMosaicDays',
          label: 'Digest mosaics',
          description:
            'How long a rule keeps the mosaic image attached to its digests. Held by the writer at each digest, not by a sweep. The busiest rule on this hub makes ~27 MiB a day, so 14 days is ~370 MiB for that one rule; a rule that fires once a night costs almost nothing.',
          min: 0,
          max: 365,
          step: 1,
          default: PRUNE_WINDOW_DEFAULT_DAYS.summaryMosaicDays,
          unit: 'days',
        },
      ],
    },
    // The LOCATION DESCRIPTIONS section lived here — an editable array where
    // the operator retyped each location name by hand, matched exactly and
    // case-sensitively. Moved 2026-09-16 to the location itself
    // (`deviceManager.setLocationDescription`, edited on the Locations page
    // beside the icon): two authorities for one thing, joined by two different
    // rules, meant a rename carried the icon and silently orphaned the
    // description.
    {
      id: 'package-drop',
      title: 'Package detection',
      description:
        'Detect a delivered package (a package-class object left parked inside a package zone) and, symmetrically, its pick-up. Draw the package zone in the zone editor; enable the package class in the object-detection step. Per-device override.',
      columns: 2,
      fields: [
        {
          type: 'boolean',
          key: 'packageDropEnabled',
          label: 'Enable package detection',
          description:
            'Turn package delivered / picked-up detection on for this camera (off elsewhere).',
          default: PACKAGE_DROP_DEFAULTS.packageDropEnabled,
        },
        {
          type: 'boolean',
          key: 'packageDropPickupEnabled',
          label: 'Emit pick-up',
          description: 'Also emit a package-picked-up event when the delivered package leaves.',
          default: PACKAGE_DROP_DEFAULTS.packageDropPickupEnabled,
        },
        {
          type: 'boolean',
          key: 'packageDropEarlyPickupEnabled',
          label: 'Early pick-up',
          description:
            'Report a pick-up as soon as the package detector has looked three times over at least 10 s, found the spot empty and unblocked, and somebody was in the drop-off zone — instead of after 5 minutes without a sighting. Off by default until it is measured on more pick-ups.',
          default: PACKAGE_DROP_DEFAULTS.packageDropEarlyPickupEnabled,
        },
        {
          type: 'slider',
          key: 'packageDropMinFrames',
          label: 'Confirmation frames',
          description:
            'How many frames the box must be seen on before it counts as a delivery. One is a flicker; two can still be a passer-by; three is the default bar against false positives. Independent of dwell.',
          min: 1,
          max: 10,
          step: 1,
          default: PACKAGE_DROP_DEFAULTS.packageDropMinFrames,
          showValue: true,
        },
        {
          type: 'slider',
          key: 'packageDropDwellSec',
          label: 'Minimum dwell',
          description:
            'Extra time the package must stay parked after the confirmation frames. 0 (default) means N frames is enough — a courier who drops and leaves in a couple of seconds still delivers. Raise to reject a bag briefly set down.',
          min: 0,
          max: 300,
          step: 5,
          default: PACKAGE_DROP_DEFAULTS.packageDropDwellSec,
          showValue: true,
          unit: 's',
        },
        {
          type: 'slider',
          key: 'packageDropMinBboxAreaFrac',
          label: 'Minimum package size',
          description:
            'Reject tiny far-field blobs: the package box must cover at least this fraction of the frame.',
          min: 0,
          max: 0.1,
          step: 0.001,
          default: PACKAGE_DROP_DEFAULTS.packageDropMinBboxAreaFrac,
          showValue: true,
        },
        {
          type: 'slider',
          key: 'packageDropMaxBboxAreaFrac',
          label: 'Maximum package size',
          description:
            'Reject scene-sized blobs: a "package" covering more of the frame than this is scenery (a light patch, a doormat), not a parcel. Real parcels measure 1–2% of the frame; the recurring false positive measured 8–9.5%. This — not confidence — is the lever against a static false positive.',
          min: 0.01,
          max: 0.5,
          step: 0.005,
          default: PACKAGE_DROP_DEFAULTS.packageDropMaxBboxAreaFrac,
          showValue: true,
        },
        {
          type: 'slider',
          key: 'packageDropActivityWindowSec',
          label: 'Deliverer window',
          description:
            'A delivery only counts if a person or vehicle was in the configured package drop-off zone within this many seconds before the package appeared — and a pick-up only with somebody in that zone when it vanished. Motion elsewhere on the camera does not count. 0 disables the requirement.',
          min: 0,
          max: 1800,
          step: 30,
          default: PACKAGE_DROP_DEFAULTS.packageDropActivityWindowSec,
          showValue: true,
          unit: 's',
        },
      ],
    },
    {
      id: 'audio-detection',
      title: 'Audio detection',
      description: 'Thresholds for audio-level and classification events. Per-device override.',
      columns: 2,
      fields: [
        {
          type: 'number',
          key: 'classificationMinScore',
          label: 'Classification min score',
          description: 'Minimum confidence (0–1) for a classification result to be accepted.',
          min: 0,
          max: 1,
          step: 0.05,
          default: AUDIO_DETECTION_DEFAULTS.classificationMinScore,
        },
        {
          type: 'multiselect',
          key: 'audioAllowedClasses',
          label: 'Event classes',
          description:
            'Which sounds may become an event on this camera. Leave empty to allow every class. ' +
            'The classifier is untouched — it keeps hearing and labelling everything; this only ' +
            'narrows what is worth an event and a notification here.',
          options: AUDIO_MACRO_LABELS.filter((l) => l.id !== 'silence').map((l) => ({
            value: l.id,
            label: l.name,
          })),
          default: AUDIO_DETECTION_DEFAULTS.audioAllowedClasses,
        },
        {
          type: 'number',
          key: 'audioConfirmHits',
          label: 'Occurrences to confirm',
          description:
            'How many times the same sound must be heard inside the window below before it ' +
            'becomes an event. 1 disables the window — every occurrence is an event.',
          min: 1,
          step: 1,
          default: AUDIO_DETECTION_DEFAULTS.audioConfirmHits,
        },
        {
          type: 'number',
          key: 'audioConfirmWindowSec',
          label: 'Confirmation window',
          description:
            'Width of the corroboration window. Occurrences are counted per class, so two ' +
            'different sounds never confirm each other. Ignored when occurrences is 1.',
          min: 1,
          step: 1,
          default: AUDIO_DETECTION_DEFAULTS.audioConfirmWindowSec,
          unit: 's',
        },
        {
          type: 'number',
          key: 'levelDeviationDb',
          label: 'Level deviation',
          description: 'dB above the rolling mean required to trigger a peak event.',
          min: 1,
          step: 1,
          default: AUDIO_DETECTION_DEFAULTS.levelDeviationDb,
          unit: 'dB',
        },
        {
          type: 'number',
          key: 'levelWindowSec',
          label: 'Level window',
          description: 'Rolling baseline window length for peak detection.',
          min: 1,
          step: 1,
          default: AUDIO_DETECTION_DEFAULTS.levelWindowSec,
          unit: 's',
        },
        {
          type: 'number',
          key: 'levelMaxWaitSec',
          label: 'Level max wait',
          description: 'Maximum silence between events before a heartbeat sample is emitted.',
          min: 1,
          step: 1,
          default: AUDIO_DETECTION_DEFAULTS.levelMaxWaitSec,
          unit: 's',
        },
      ],
    },
    {
      id: 'audio-markers',
      title: 'Audio markers',
      description:
        'A synthetic timeline marker (with a snapshot) for audio that is out of the ordinary FOR THIS CAMERA, loud, and heard while nothing visual is happening. Off by default: leave it off for a day and read the “audio anomaly gate (window)” log line — its `wouldFire` count is how many markers this camera would have produced, per camera, before you pay for any of them.',
      columns: 2,
      fields: [
        {
          type: 'boolean',
          key: 'audioMarkerEnabled',
          label: 'Create audio markers',
          description:
            'When off the criteria are still evaluated and counted (wouldFire) — only the marker is not created.',
          default: AUDIO_DETECTION_DEFAULTS.audioMarkerEnabled,
        },
        {
          type: 'number',
          key: 'audioMarkerBaselineSec',
          label: 'Baseline window',
          description:
            'How much of its own history defines this camera’s “normal” loudness. Also the warm-up: no marker until this much audio has been heard.',
          min: 30,
          step: 30,
          default: AUDIO_DETECTION_DEFAULTS.audioMarkerBaselineSec,
          unit: 's',
        },
        {
          type: 'number',
          key: 'audioMarkerMinDbfs',
          label: 'Minimum volume',
          description:
            'Absolute loudness floor. A sound quieter than this is never a marker, however unusual it is for the camera. 0 dBFS is digital full scale, so this is negative.',
          min: -60,
          max: 0,
          step: 1,
          default: AUDIO_DETECTION_DEFAULTS.audioMarkerMinDbfs,
          unit: 'dBFS',
        },
        {
          type: 'number',
          key: 'audioMarkerMinDeviations',
          label: 'Out-of-the-ordinary factor',
          description:
            'How many multiples of this camera’s OWN loudness jitter the sound must exceed. A camera on a busy road needs a bigger jump than one in a garden — that is the point of measuring it per camera.',
          min: 1,
          step: 0.5,
          default: AUDIO_DETECTION_DEFAULTS.audioMarkerMinDeviations,
        },
        {
          type: 'number',
          key: 'audioMarkerMinDeviationDb',
          label: 'Minimum jump',
          description:
            'Floor, in dB, on how far above its own normal the sound must sit. Holds when a camera is so steady that the factor above would pass on any nudge.',
          min: 1,
          step: 1,
          default: AUDIO_DETECTION_DEFAULTS.audioMarkerMinDeviationDb,
          unit: 'dB',
        },
        {
          type: 'number',
          key: 'audioMarkerMotionQuietSec',
          label: 'Motion-quiet window',
          description:
            'Suppress the marker if a track was alive or motion was reported within this long. An audio marker laid over an active track is noise.',
          min: 0,
          step: 5,
          default: AUDIO_DETECTION_DEFAULTS.audioMarkerMotionQuietSec,
          unit: 's',
        },
        {
          type: 'number',
          key: 'audioMarkerCooldownSec',
          label: 'Minimum gap',
          description: 'Shortest interval between two markers on this camera.',
          min: 5,
          step: 5,
          default: AUDIO_DETECTION_DEFAULTS.audioMarkerCooldownSec,
          unit: 's',
        },
        {
          type: 'number',
          key: 'audioMarkerMaxPerHour',
          label: 'Ceiling per hour',
          description: 'Hard burst ceiling per camera. Drops past it are counted, not silent.',
          min: 1,
          step: 1,
          default: AUDIO_DETECTION_DEFAULTS.audioMarkerMaxPerHour,
        },
        {
          type: 'number',
          key: 'audioMarkerMaxPerDay',
          label: 'Ceiling per day',
          description:
            'Hard daily ceiling per camera — this, not the thresholds, is what bounds the worst case. A mis-tuned threshold can only ever cost you this many markers a day.',
          min: 1,
          step: 1,
          default: AUDIO_DETECTION_DEFAULTS.audioMarkerMaxPerDay,
        },
      ],
    },
    {
      id: 'audio-episodes',
      title: 'Audio episodes',
      description:
        'One timeline track and one event per classified sound, held open with hysteresis so a long cry is not four tracks. No class filter: speech, crying, a bark — the knobs below are what stop repeats. Leave on for a day or two and judge the spam, then tighten per camera.',
      columns: 2,
      fields: [
        {
          type: 'boolean',
          key: 'audioEpisodeEnabled',
          label: 'Create audio episodes',
          description:
            'Off switches off the GROUPING only: classified audio still persists an event and still notifies, but no timeline track is opened and a long sound is no longer collapsed into one episode (one event per class change, then one every 5 s while it lasts).',
          default: AUDIO_DETECTION_DEFAULTS.audioEpisodeEnabled,
        },
        {
          type: 'number',
          key: 'audioEpisodeOpenHoldSec',
          label: 'Open hold',
          description:
            'The class must be heard continuously this long before an episode opens. Filters 200 ms blips.',
          min: 0,
          step: 0.5,
          default: AUDIO_DETECTION_DEFAULTS.audioEpisodeOpenHoldSec,
          unit: 's',
        },
        {
          type: 'number',
          key: 'audioEpisodeCloseGapSec',
          label: 'Close gap',
          description:
            'The class must be absent this long before the episode closes. A pause inside a cry does not start a second track.',
          min: 1,
          step: 1,
          default: AUDIO_DETECTION_DEFAULTS.audioEpisodeCloseGapSec,
          unit: 's',
        },
        {
          type: 'number',
          key: 'audioEpisodeCooldownSec',
          label: 'Cooldown',
          description: 'After an episode closes, the same class cannot reopen until this elapses.',
          min: 0,
          step: 5,
          default: AUDIO_DETECTION_DEFAULTS.audioEpisodeCooldownSec,
          unit: 's',
        },
      ],
    },
    {
      id: 'face-recognition',
      title: 'Face recognition',
      description:
        'How a face is matched to a person. Which cameras look for faces is set per camera, in its detection steps. The switch turns matching off everywhere; the other values can also be set per camera.',
      columns: 2,
      fields: [
        {
          type: 'boolean',
          key: 'enabled',
          label: 'Face recognition on',
          description: 'Off stops face matching for every camera. On by default.',
          default: FACE_DEFAULTS.enabled,
        },
        {
          type: 'number',
          key: 'similarityThreshold',
          label: 'Similarity threshold',
          description:
            'How alike (0–1) a face must be to a known person to be matched. Higher = stricter. Near misses (from 80% of this value) are offered as suggestions.',
          min: 0,
          max: 1,
          step: 0.05,
          default: FACE_DEFAULTS.similarityThreshold,
        },
        {
          type: 'number',
          key: 'margin',
          label: 'Ambiguity margin',
          description:
            'The best match must beat the second best by at least this much, or the face stays unassigned.',
          min: 0,
          max: 1,
          step: 0.01,
          default: FACE_DEFAULTS.margin,
        },
        {
          type: 'number',
          key: 'minFacePx',
          label: 'Min face size to keep (px)',
          description:
            'Faces smaller than this (short side, full-resolution pixels) are dropped and not stored. Applied after the embedding floor in Faces & recognition.',
          min: 0,
          step: 1,
          default: FACE_DEFAULTS.minFacePx,
          unit: 'px',
        },
        {
          type: 'number',
          key: 'recognitionMinFacePx',
          label: 'Min face size to auto-assign (px)',
          description:
            'Stored faces smaller than this (short side, full-resolution pixels) can be assigned by hand but are never matched automatically — small faces give wrong matches. Raise it if distant faces get the wrong name.',
          min: 0,
          step: 1,
          default: FACE_DEFAULTS.recognitionMinFacePx,
          unit: 'px',
        },
        // `suggestionMinCosine` was an editable number here. It is gone (D222):
        // it was a SECOND knob over the same band as the similarity threshold,
        // and the two disagreed — a 0.45 threshold against a 0.50 floor made
        // the band [0.50, 0.45) empty, so no suggestion could be produced at
        // all and nothing said so. What stands in its place is the READ-ONLY
        // readout below: the operator sees the effect of the threshold they
        // set, and cannot put a second number in contradiction with it.
        {
          type: 'text',
          key: SUGGESTION_THRESHOLD_READOUT_KEY,
          label: 'Suggestion threshold (derived)',
          description:
            'Read-only: 80% of the similarity threshold. A face scoring between this and the threshold, or a match too small to auto-assign, is offered as a one-tap suggestion.',
          readonlyField: true,
          default: '',
        },
        {
          type: 'number',
          key: 'minIdentitySamples',
          label: 'Min identity samples',
          description:
            'A person needs at least this many saved faces before new faces are matched to them automatically.',
          min: 1,
          step: 1,
          default: FACE_DEFAULTS.minIdentitySamples,
        },
        {
          type: 'number',
          key: 'confirmFrames',
          label: 'Confirm frames',
          description: 'Frames an identity must be seen before a track is assigned. Minimum 1.',
          min: 1,
          step: 1,
          default: FACE_DEFAULTS.confirmFrames,
        },
        // `bufferRetentionDays` was here. It is gone (D62): D61 deleted the age
        // half of the buffer prune — a face/plate buffer row carries a trackId,
        // so it is track-owned and cascades — and left the number on screen
        // reading nothing. The buffer is now bounded by capacity alone.
        {
          type: 'number',
          key: 'maxEmbeddingMagnitude',
          label: 'Max embedding magnitude (0 = off)',
          description:
            'Reject a face whose embedding is abnormally strong — a blank or garbled crop that would match everyone. Leave at 0 until the "face: embedding magnitude" log lines show where your cameras sit.',
          min: 0,
          step: 0.5,
          default: FACE_DEFAULTS.maxEmbeddingMagnitude,
        },
        {
          type: 'number',
          key: 'bufferMaxPerDevice',
          label: 'Buffer max per device',
          description: 'Maximum buffered face entries kept per device.',
          min: 0,
          step: 10,
          default: FACE_DEFAULTS.bufferMaxPerDevice,
        },
        {
          type: 'boolean',
          key: 'keepSourceFrames',
          label: 'Keep the source frame of every buffered face',
          description:
            'Also store the whole frame each face came from (about 1.6 MB at 4K), so faces can be re-extracted later with a better model. Off by default.',
          default: FACE_DEFAULTS.keepSourceFrames,
        },
      ],
    },
  ]
  return scopeGlobalSettingsToCap(
    { sections: [...generalSections, ...buildDetectionSettingsSections()] },
    cap,
  )
}

/**
 * The `cap` argument on `getGlobalSettings` is how a page asks for ONE
 * capability's knobs instead of the addon's whole form. Pipeline → Cluster
 * → Settings asks for `face-gallery`; System → Settings omits `cap` and
 * still gets every section. An unknown cap is empty so this addon cannot
 * appear on a page that meant someone else.
 */
function scopeGlobalSettingsToCap(schema: ConfigUISchema, cap?: string): ConfigUISchema {
  if (cap === undefined || cap === '') return schema
  if (cap === FACE_GALLERY_SETTINGS_CAP) {
    return {
      ...schema,
      sections: schema.sections.filter((s) => s.id === FACE_RECOGNITION_SECTION_ID),
    }
  }
  return { ...schema, sections: [] }
}
