import {
  nodePin,
  type ConvertResult,
  type ConvertTarget,
  type ModelConvertInput,
} from '@camstack/types'

export interface NodeHardware {
  platform: string
  gpu?: { type: string }
  npu?: { type: string }
  openvino?: boolean
}

export interface RecommendDeps {
  listNodes(): Promise<readonly string[]>
  hardwareOf(nodeId: string): Promise<NodeHardware>
}

export interface NodeRecommendation {
  nodeId: string
  reason: string
  supported: boolean
}

function supports(
  hw: NodeHardware,
  targets: readonly ConvertTarget[],
): { ok: boolean; reason: string } {
  const needsCoreml = targets.some((t) => t.format === 'coreml')
  const needsOv = targets.some((t) => t.format === 'openvino')
  if (needsCoreml && hw.platform !== 'darwin')
    return { ok: false, reason: 'coreml needs a darwin node' }
  if (needsOv && !hw.openvino) return { ok: false, reason: 'openvino unavailable' }
  if (needsCoreml && hw.platform === 'darwin') return { ok: true, reason: 'darwin/ANE' }
  return { ok: true, reason: 'openvino node' }
}

export async function recommendConvertNode(
  input: { targets: readonly ConvertTarget[] },
  deps: RecommendDeps,
): Promise<NodeRecommendation[]> {
  const nodes = await deps.listNodes()
  const ranked = await Promise.all(
    nodes.map(async (nodeId) => {
      const hw = await deps.hardwareOf(nodeId)
      const verdict = supports(hw, input.targets)
      return { nodeId, reason: verdict.reason, supported: verdict.ok }
    }),
  )
  return ranked.toSorted((a, b) => Number(b.supported) - Number(a.supported))
}

export interface ConvertModelDeps {
  recommend(input: { targets: readonly ConvertTarget[] }): Promise<NodeRecommendation[]>
  convert(input: ModelConvertInput, pin: ReturnType<typeof nodePin>): Promise<ConvertResult>
  register(result: ConvertResult): Promise<void>
  markAvailable(
    nodeId: string,
    modelId: string,
    artifacts: ConvertResult['artifacts'],
  ): Promise<void>
}

export async function convertModel(
  input: {
    sourceUrl: string
    metadata: ModelConvertInput['metadata']
    targets: readonly ConvertTarget[]
    targetNodeId?: string
    calibrationRef?: string
  },
  deps: ConvertModelDeps,
): Promise<{
  entry: ConvertResult['entry']
  nodeId: string
  artifacts: ConvertResult['artifacts']
}> {
  let nodeId = input.targetNodeId
  if (!nodeId) {
    const ranked = await deps.recommend({ targets: input.targets })
    const best = ranked.find((r) => r.supported)
    if (!best) throw new Error('no node can satisfy the requested conversion targets')
    nodeId = best.nodeId
  }
  const convertInput: ModelConvertInput = {
    sourceUrl: input.sourceUrl,
    metadata: input.metadata,
    targets: input.targets,
    ...(input.calibrationRef !== undefined ? { calibrationRef: input.calibrationRef } : {}),
  }
  const result = await deps.convert(convertInput, nodePin(nodeId))
  if (result.artifacts.length === 0) throw new Error('conversion produced no validated artifacts')
  await deps.register(result)
  await deps.markAvailable(nodeId, input.metadata.id, result.artifacts)
  return { entry: result.entry, nodeId, artifacts: result.artifacts }
}
