/**
 * The Benchmark addon page (`/addon/benchmark`): the node benchmark tab with the
 * "Suggested defaults" card (cluster detection defaults, D1104). The plan
 * recommends a stream profile and no rate (an unmeasured fact), a stored
 * default exists, and two cameras pin their own value.
 */
import { defineFixtures } from './_define'

const PLAN = {
  recommendation: {
    detectionStreamProfile: 'mid',
    detectionFps: null,
    reasons: [
      { kind: 'decode-4k-below-cameras', nodeId: 'hub', maxStreams: 2, cameras: 5 },
      { kind: 'unknown', nodeId: 'agent-1', dimension: 'fps', missing: 'accelerator' },
    ],
  },
  current: { detectionStreamProfile: 'high', detectionFps: 10 },
  overrides: { count: 2, deviceIds: [101, 102] },
  planHash: 'demo-plan-hash',
}

export default defineFixtures({
  area: 'benchmark',
  description: 'Benchmark addon: node benchmark tab with the suggested cluster detection defaults',
  handlers: {
    'pipelineOrchestrator.planDetectionDefaults': PLAN,
    'mut:pipelineOrchestrator.applyDetectionDefaults': {
      kind: 'applied',
      written: { detectionStreamProfile: 'mid', detectionFps: 10 },
    },
    'mut:pipelineOrchestrator.setClusterDetectionDefaults': {},
    'pipelineOrchestrator.getNodeBenchmarkStatus': { run: null, modeNodeId: null },
    'pipelineOrchestrator.getNodeBenchmarkCandidates': { devices: [], steps: [] },
    'pipelineOrchestrator.listNodeBenchmarkResults': [],
  },
})
