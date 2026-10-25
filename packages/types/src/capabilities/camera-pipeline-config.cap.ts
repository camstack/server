import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * camera-pipeline-config — device-scoped wrapper that carries the
 * pipeline-orchestrator's PER-DEVICE settings contribution into the
 * binding-driven device-detail aggregate (D12).
 *
 * Why this cap exists: the orchestrator's per-camera settings (motion
 * sources / fps / cooldown, detection + audio mode, cluster assignment,
 * the Detection-Zones top-tab widget, onboard-motion + onboard-object-
 * detection toggles) were historically contributed via the
 * `pipeline-orchestrator` cap's `exposesDeviceSettings` methods. But
 * `pipeline-orchestrator` is `scope:'system'` and never appears in
 * `getBindings(deviceId)`, so the D12 binding-driven aggregate
 * (`device-manager.getDeviceAggregate`) silently dropped the entire
 * contribution — the zones tab and the pipeline/motion settings vanished
 * from device-detail.
 *
 * `kind:'wrapper'` + `defaultActive:true` makes this cap auto-bind to every
 * camera (it appears in `getBindings` as `kind:'wrapped'`), so the aggregate
 * invokes the orchestrator's contribution methods through it — restoring the
 * tabs without violating D12 (contributions come only from bound providers).
 *
 * `exposesDeviceSettings:true` (NOT `deviceConfig`) is intentional: the
 * contribution is a dynamic, multi-section, per-device hand-built structure
 * (it probes bindings for onboard-motion / native-object-detection presence,
 * cluster nodes, etc.), which the derived-UI `deviceConfig` archetype cannot
 * express. This mirrors the `detection-pipeline` / `motion-detection`
 * wrapper pattern. The orchestrator class is the provider; it already
 * implements the three DeviceSettingsContribution methods.
 */
export const cameraPipelineConfigCapability = {
  name: 'camera-pipeline-config',
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  deviceTypes: [DeviceType.Camera],
  exposesDeviceSettings: true,
  methods: {},
} as const satisfies CapabilityDefinition

export type ICameraPipelineConfigProvider = InferProvider<typeof cameraPipelineConfigCapability>
