/**
 * Generates `_camera-aggregate.generated.json`: the settings sections a camera's
 * device page receives from the pipeline addons, built by the REAL schema
 * builders so the documentation screenshots show the shipped labels, ranges and
 * defaults rather than a hand-copied approximation.
 *
 *   npx tsx scripts/ui/shots/fixtures/_gen-camera-aggregate.ts
 *
 * Invented data only: every field is hydrated with an empty device store, so
 * each control shows its schema default.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConfigSection } from '@camstack/types'
import { deriveFormContribution } from '../../../../packages/system/src/builtins/device-manager/device-config-contribution'
import { buildBatteryRefreshDeviceSection } from '../../../../packages/addon-provider-reolink/src/battery-refresh-settings'
import { DEFAULT_CONFIG as MOTION } from '../../../../packages/addon-pipeline/src/motion-wasm/wasm-motion-detector'
import { buildDeviceSettingsSections } from '../../../../packages/addon-pipeline-orchestrator/src/settings-ui-schemas'
import {
  buildGlobalSettingsSchema,
  retagDetectionSections,
  retagRetentionSection,
  stripGlobalOnlyFields,
  toAnalyticsDeviceSections,
} from '../../../../packages/addon-post-analysis/src/pipeline-analytics/settings-schema'

interface Taggable {
  readonly id: string
  readonly fields: readonly unknown[]
}

const STRUCTURAL = new Set(['separator', 'info', 'button'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What the device-manager aggregator does at its boundary: value + writer routing per editable field. */
function tagField(field: unknown, capName: string, addonId: string): unknown {
  if (!isRecord(field)) return field
  if (field['readonlyField'] === true || STRUCTURAL.has(String(field['type']))) return field
  const value = 'value' in field ? field['value'] : field['default']
  return { ...field, value, source: 'settings', writerCapName: capName, writerAddonId: addonId }
}

function tag(sections: readonly Taggable[], capName: string, addonId: string): unknown[] {
  return sections.map((s) => ({
    ...s,
    fields: s.fields.map((f) => tagField(f, capName, addonId)),
  }))
}

const orchestrator = buildDeviceSettingsSections({ runnerNodeIds: ['hub', 'agent-2'] })

const analyticsSchema = buildGlobalSettingsSchema()
const analytics = retagRetentionSection(
  retagDetectionSections(
    stripGlobalOnlyFields(toAnalyticsDeviceSections(analyticsSchema.sections)),
  ),
)

const analyzerOnly = { field: 'motionSources', includes: 'analyzer' } as const
const motionWasm: ConfigSection[] = [
  {
    id: 'motion-wasm-settings',
    title: '',
    tab: 'motion',
    order: 10,
    columns: 2,
    fields: [
      {
        type: 'slider',
        key: 'threshold',
        label: 'Threshold',
        description: 'Pixel intensity difference to count as changed (higher = less sensitive)',
        min: 1,
        max: 255,
        step: 1,
        default: MOTION.threshold,
        showValue: true,
        showWhen: analyzerOnly,
      },
      {
        type: 'slider',
        key: 'minAreaFraction',
        label: 'Min Subject Size',
        description:
          'Smallest subject that triggers motion, as a share of the analysed view. Fragments of one subject are merged before this is applied, so a partly hidden animal counts once at its full size. Only in effect when Min Area is 0.',
        min: 0.001,
        max: 0.05,
        step: 0.0005,
        default: MOTION.minAreaFraction,
        showValue: true,
        showWhen: analyzerOnly,
      },
      {
        type: 'number',
        key: 'minArea',
        label: 'Min Area',
        description:
          'Absolute pixel bar, applied to each motion region on its own. This is how motion has always worked, and it stays the default. Set it to 0 to move THIS camera to Min Subject Size, which merges the fragments of one subject before measuring it and keeps its meaning at any resolution - expect more motion, so move one camera at a time.',
        min: 0,
        max: 50000,
        step: 100,
        default: MOTION.minArea,
        unit: 'px',
        showWhen: analyzerOnly,
      },
      {
        type: 'slider',
        key: 'maxCoverageFraction',
        label: 'Storm Cutoff',
        description:
          'A merged region whose changed pixels cover more of the view than this is weather, an IR cut or an exposure step, not a subject, and does not fire motion. A real mover inside the storm still fires on its own region. Only in effect when Min Area is 0; 1 disables the cutoff.',
        min: 0.2,
        max: 1,
        step: 0.05,
        default: MOTION.maxCoverageFraction,
        showValue: true,
        showWhen: analyzerOnly,
      },
      {
        type: 'slider',
        key: 'blurRadius',
        label: 'Blur Radius',
        description: 'Gaussian blur before diff (reduces noise)',
        min: 0,
        max: 10,
        step: 1,
        default: MOTION.blurRadius,
        showValue: true,
        showWhen: analyzerOnly,
      },
      {
        type: 'slider',
        key: 'dilateRadius',
        label: 'Dilation Radius',
        description: 'Expand motion regions to merge nearby changes',
        min: 0,
        max: 10,
        step: 1,
        default: MOTION.dilateRadius,
        showValue: true,
        showWhen: analyzerOnly,
      },
    ],
  },
]
const snapshotSection: ConfigSection[] = [
  {
    id: 'snapshot-preferences',
    title: 'Snapshot',
    tab: 'snapshot',
    fields: [
      {
        type: 'select',
        key: 'snapshotStreamId',
        label: 'Preferred stream',
        description: 'Stream used when grabbing a snapshot',
        options: [
          { value: '', label: 'Not assigned' },
          { value: 'main', label: 'Main (3840x2160, h265)' },
          { value: 'sub', label: 'Sub (640x360, h264)' },
        ],
      },
      {
        type: 'number',
        key: 'snapshotMaxAgeS',
        label: 'Max cache age (s)',
        min: 0,
        max: 24 * 3600,
        step: 1,
        description:
          'Serve cached snapshot up to this age before re-capturing. Default 15s for non-battery cams (live-feel). The UI refresh button always forces a fresh capture regardless of this value.',
      },
      {
        type: 'boolean',
        key: 'snapshotDebug',
        label: 'Debug logging',
        description: 'Log stream selection and timing details for this device.',
      },
    ],
  },
]
const mb = (n: number) => ({ min: 0, max: 100, step: n })
const resolutions = [
  { width: 3840, height: 2160 },
  { width: 2560, height: 1440 },
  { width: 1920, height: 1080 },
]
const profileOptions = {
  resolutions,
  codecs: ['h264', 'h265'],
  framerates: [10, 15, 20, 25, 30],
  bitrates: [1024, 2048, 4096, 6144, 8192],
  supportsBitrateMode: true,
  supportsEncoderProfile: true,
  supportsGop: true,
  gop: { min: 1, max: 10, step: 1 },
}
const derived = (builderId: string, options: unknown, status: unknown): readonly Taggable[] =>
  deriveFormContribution(builderId, options, status)?.sections ?? []
const nativeSections = [
  ...derived(
    'day-night',
    {
      modes: ['auto', 'day', 'night'],
      supportsSensitivity: true,
      sensitivity: mb(1),
      supportsSwitchDelay: true,
      switchDelaySec: { min: 5, max: 120, step: 1 },
    },
    { mode: 'auto', sensitivity: 50, switchDelaySec: 10, lastFetchedAt: 0 },
  ),
  ...derived(
    'image-settings',
    {
      supportsBrightness: true,
      brightness: mb(1),
      supportsContrast: true,
      contrast: mb(1),
      supportsSaturation: true,
      saturation: mb(1),
      supportsSharpness: true,
      sharpness: mb(1),
      supportsMirror: true,
      supportsFlip: true,
      rotateOptions: ['0', '180'],
      whiteBalanceModes: ['auto', 'manual'],
      supportsWarmth: true,
      warmth: mb(1),
      exposureModes: ['auto', 'manual'],
      backlightModes: ['off', 'blc', 'wdr'],
    },
    {
      brightness: 50,
      contrast: 50,
      saturation: 50,
      sharpness: 50,
      mirror: false,
      flip: false,
      rotate: '0',
      whiteBalance: 'auto',
      exposureMode: 'auto',
      backlightMode: 'off',
      lastFetchedAt: 0,
    },
  ),
  ...derived(
    'stream-params',
    {
      main: profileOptions,
      sub: { ...profileOptions, resolutions: [{ width: 640, height: 360 }] },
    },
    {
      main: {
        width: 3840,
        height: 2160,
        codec: 'h265',
        framerate: 25,
        bitrate: 6144,
        bitrateMode: 'vbr',
        encoderProfile: 'main',
        gop: 4,
      },
      sub: {
        width: 640,
        height: 360,
        codec: 'h264',
        framerate: 15,
        bitrate: 512,
        bitrateMode: 'vbr',
        encoderProfile: 'main',
        gop: 4,
      },
      lastFetchedAt: 0,
    },
  ),
]
const reolinkBattery: ConfigSection[] = [
  ...buildBatteryRefreshDeviceSection({ isBattery: true }),
  {
    id: 'sleep-push',
    title: 'Battery motion (sleep push)',
    tab: 'motion',
    fields: [
      {
        type: 'select',
        key: 'batterySleepPushMethod',
        label: 'Preferred sleep-push path',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Auto (webhook if supported, else email)' },
          { value: 'webhook', label: 'HaCfg webhook only' },
          { value: 'email', label: 'Email/SMTP only' },
        ],
      },
    ],
  },
]
const reolinkMotion: ConfigSection[] = [
  {
    id: 'motion',
    title: 'On-camera motion (MdAlarm)',
    tab: 'motion',
    fields: [
      {
        type: 'boolean',
        key: 'motionEnabled',
        label: 'Motion detection',
        default: true,
        description:
          "Master switch for the camera's on-board motion detector. Disabling stops the camera from emitting motion events on the alarm channel.",
      },
      {
        type: 'slider',
        key: 'motionSensitivity',
        label: 'Sensitivity',
        default: 25,
        min: 1,
        max: 50,
        step: 1,
        description: 'Higher = triggers on smaller motion. Reolink user-facing range 1..50.',
      },
    ],
  },
]

const out = {
  native: tag(nativeSections, 'stream-params', 'provider-reolink'),
  motionWasm: tag(motionWasm, 'motion-detection', 'motion-wasm'),
  snapshot: tag(snapshotSection, 'snapshot', 'snapshot'),
  reolinkBattery: tag(reolinkBattery, 'device-config', 'provider-reolink'),
  reolinkMotion: tag(reolinkMotion, 'device-config', 'provider-reolink'),
  orchestrator: tag(orchestrator, 'pipeline-orchestrator', 'pipeline-orchestrator'),
  analytics: tag(analytics, 'pipeline-analytics', 'pipeline-analytics'),
}
const here = path.dirname(fileURLToPath(import.meta.url))
writeFileSync(
  path.join(here, '_camera-aggregate.generated.json'),
  `${JSON.stringify(out, null, 1)}\n`,
)
console.log('sections', out.orchestrator.length, out.analytics.length)
