import type { ConfigUISchema } from '@camstack/types'
import { pickDetailCropConvention } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import { enabledNodesFromBroker, makeFakeBroker, makeFakeContext } from './e2e-helpers.js'

/**
 * D986 M4: the orchestrator's cluster form is declared by `clusterSettingsSchema('pipeline-orchestrator')`.
 * Other addons read these values through `addonSettings.getGlobalSettings({ addonId })` (no cap),
 * so the stored value has to come back unchanged through the scoped declaration.
 */
const CLUSTER_KEYS = [
  'audioNode',
  'clusterModel:clip-embedding',
  'clusterModel:face-embedding',
  'clusterStepSetting:face-embedding:minLandmarkFaceSize',
  'detailCropPaddingRatio',
  'detailCropSquare',
  'faceRescoreIntervalMinutes',
  'fpsLowWindowMs',
  'fpsMinThreshold',
  'ingestNode',
  'motionNode',
  'nativeLeaseActivityMs',
  'nativeLeaseAdmission',
  'nativeLeaseBudgetMb',
  'nativeLeaseHoldFrames',
  'nativeSceneBudgetMb',
  'nativeTileBudgetMb',
  'nodeStressMode',
  'onDisconnect',
  'onReconnect',
  'pinnedOnDisconnect',
  'sessionPlacement',
].sort()

class Probe extends PipelineOrchestratorAddon {
  caps(): readonly string[] {
    return this.scopedSettingsCapabilities()
  }
}

function keysOf(schema: ConfigUISchema | null): string[] {
  if (schema === null) throw new Error('no schema declared')
  return schema.sections
    .flatMap((section) => section.fields)
    .flatMap((field) =>
      'key' in field && field.type !== 'info' && field.type !== 'separator' ? [field.key] : [],
    )
    .sort()
}

describe('the pipeline orchestrator scoped settings', () => {
  let addon: Probe | null = null
  let initialized = false
  afterEach(async () => {
    if (initialized) await addon?.shutdown()
    addon = null
    initialized = false
  })

  it('declares the cluster form on pipeline-orchestrator and nothing else', async () => {
    addon = new Probe()
    expect(addon.caps()).toContain('pipeline-orchestrator')
    expect(keysOf(await addon.getScopedSettingsSchema('cluster', 'pipeline-orchestrator'))).toEqual(
      CLUSTER_KEYS,
    )
    expect(await addon.getScopedSettingsSchema('node', 'pipeline-orchestrator')).toBeNull()
    expect(
      await addon.getScopedSettingsSchema('device-defaults', 'pipeline-orchestrator'),
    ).toBeNull()
    expect(await addon.getScopedSettingsSchema('cluster', 'camera-pipeline-config')).toBeNull()
  })

  it('serves a stored cluster value, to a reader that names no capability, unchanged', async () => {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        enabledDecoderNodes: enabledNodesFromBroker(broker),
        detailCropPaddingRatio: 0.37,
        detailCropSquare: true,
        ingestNode: 'agent-marked',
      },
    })
    addon = new Probe()
    await addon.initialize(ctx)
    initialized = true
    const view = await addon.getGlobalSettings()
    expect(pickDetailCropConvention(view)).toEqual({ paddingRatio: 0.37, square: true })
    const values = new Map<string, unknown>()
    for (const section of view?.sections ?? []) {
      for (const field of section.fields) {
        if ('key' in field && 'value' in field) values.set(field.key, field.value)
      }
    }
    expect(values.get('ingestNode')).toBe('agent-marked')
  })
})
