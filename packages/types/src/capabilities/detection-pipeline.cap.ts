import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * detection-pipeline — device-scoped facade over the system
 * `pipeline-executor`.
 *
 * Pairs with `pipeline-executor` (system, singleton) the way
 * `audio-analysis` pairs with `audio-analyzer`: the system cap owns the
 * engine lifecycle (engines, templates, models, runPipeline) while
 * `detection-pipeline` is the per-camera binding row in the
 * device-manager UI.
 *
 * The cap definition itself declares `kind: 'wrapper'` and
 * `defaultActive: true`, so every camera opts into detection automatically
 * without any runtime flag in the addon's registration. Operators disable
 * per-device via `device-manager.setWrapperActive` — replaces the legacy
 * `pipelineEnabled` / `disableInference` flags previously stored in the
 * orchestrator's device-settings.
 *
 * `exposesDeviceSettings: true` is intentional — the three
 * DeviceSettingsContribution methods auto-added to the provider
 * interface serve the per-device detection settings panel in the admin
 * UI (model selection, class filters, confidence thresholds).
 */
export const detectionPipelineCapability = {
  name: 'detection-pipeline',
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  deviceTypes: [DeviceType.Camera],
  exposesDeviceSettings: true,
  methods: {},
} as const satisfies CapabilityDefinition

export type IDetectionPipelineProvider = InferProvider<typeof detectionPipelineCapability>
