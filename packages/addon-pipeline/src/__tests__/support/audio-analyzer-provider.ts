import type {
  AudioAnalysisSettings,
  ConfigUISchemaWithValues,
  IScopedLogger,
} from '@camstack/types'
import { AudioDeviceAttachments } from '../../audio-analyzer/audio-device-attachments.js'
import type { AudioBackend, IAudioPipeline } from '../../audio-analyzer/audio-pipeline.js'
import { AudioAnalyzerProvider } from '../../audio-analyzer/addons/analyzer/index.js'

export interface TestAudioAnalyzerProviderHooks {
  readonly deviceSettingsResolver?: (deviceId: number) => Promise<AudioAnalysisSettings | null>
  readonly deviceContributionResolver?: (
    deviceId: number,
  ) => Promise<ConfigUISchemaWithValues | null>
  readonly deviceSettingsPatcher?: (
    deviceId: number,
    patch: Record<string, unknown>,
  ) => Promise<void>
  readonly reprobeImpl?: () => Promise<{ backend: string }>
}

/** {@link AudioAnalyzerProvider} with the 8-arg constructor wired for unit specs. */
export function makeTestAudioAnalyzerProvider(
  log: IScopedLogger,
  pipeline: IAudioPipeline,
  backend: AudioBackend = 'yamnet-onnx',
  hooks: TestAudioAnalyzerProviderHooks = {},
): AudioAnalyzerProvider {
  const attachments = new AudioDeviceAttachments({
    api: () => null,
    localNodeId: () => 'hub',
    logger: log,
    analyse: async () => null,
    emitResult: () => undefined,
  })
  return new AudioAnalyzerProvider(
    log,
    async () => pipeline,
    backend,
    hooks.deviceSettingsResolver ?? (async () => null),
    hooks.deviceContributionResolver ?? (async () => null),
    hooks.deviceSettingsPatcher ?? (async () => {}),
    hooks.reprobeImpl ?? (async () => ({ backend: 'yamnet-onnx' })),
    attachments,
  )
}
