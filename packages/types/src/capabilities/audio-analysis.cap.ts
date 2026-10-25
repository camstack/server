import { z } from 'zod'
import {
  method,
  event,
  type CapabilityDefinition,
  type InferProvider,
} from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import type { AudioAnalysisSettings } from '../types/io.js'

/**
 * audio-analysis — device-scoped facade over the system `audio-analyzer`.
 *
 * Pairs with `audio-analyzer` (system, singleton) the way `camera-streams`
 * pairs with `stream-broker`: the system cap owns the compute path
 * (`processChunk`, engine lifecycle) while `audio-analysis` exposes the
 * per-device surface — settings resolution, device-settings contribution,
 * audio-level events — and is the binding row every camera sees in the
 * device-manager bindings UI.
 *
 * The cap definition itself declares `kind: 'wrapper'` and `defaultActive: true`,
 * so every camera picks up audio analysis automatically without any runtime flag
 * in the addon's registration. Operators can disable per-device via
 * `device-manager.setWrapperActive` when they don't want a given camera to be
 * analysed (e.g. muted / motion-only cams).
 */
export const audioAnalysisCapability = {
  name: 'audio-analysis',
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  deviceTypes: [DeviceType.Camera],
  exposesDeviceSettings: true,
  methods: {
    /**
     * Resolve per-device audio analysis settings (minConfidence,
     * allowedClasses) from the addon settings store for a given camera.
     * Orchestrator callers use this before handing chunks to
     * `audio-analyzer.processChunk`.
     */
    resolveDeviceSettings: method(
      z.object({ deviceId: z.number() }),
      z.custom<AudioAnalysisSettings | null>(),
    ),
  },
  events: {
    onAudioLevel: event(
      z.object({
        deviceId: z.number(),
        rms: z.number(),
        dbfs: z.number(),
      }),
    ),
  },
} as const satisfies CapabilityDefinition

export type IAudioAnalysisProvider = InferProvider<typeof audioAnalysisCapability>
