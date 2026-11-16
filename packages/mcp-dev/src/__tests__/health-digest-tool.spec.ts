/**
 * `hub_health_digest` (planning#572) — the orchestrator's latest health digest
 * from the ops MCP. One gated query; the answer is summarised, not re-derived.
 */
import { describe, expect, it } from 'vitest'
import { healthDigest } from '../ops/health.js'
import { fakeHub } from './model-fakes.js'

const PATH = 'pipelineOrchestrator.getHealthDigest'

const DIGEST = {
  generatedAt: 1000,
  tickMs: 2,
  camerasSeen: 3,
  findings: [
    {
      id: 'inference-too-slow:7',
      kind: 'inference-too-slow',
      severity: 'critical',
      subject: { type: 'camera', deviceId: 7 },
      what: 'slow',
      evidence: { allowedFps: 2.5, configuredFps: 10 },
      action: 'lower fps',
    },
    {
      id: 'frames-shed:8',
      kind: 'frames-shed',
      severity: 'warning',
      subject: { type: 'camera', deviceId: 8 },
      what: 'shed',
      evidence: { droppedFrames: 3, queueDepth: null },
      action: 'move',
    },
  ],
  nodes: [],
  sources: [{ source: 'placement', entries: null }],
  notCovered: ['decode hwaccel'],
}

describe('hub_health_digest', () => {
  it('asks the orchestrator for the requested history and summarises by severity', async () => {
    const hub = fakeHub({ [PATH]: { latest: DIGEST, previous: [] } })
    const out = JSON.stringify(await healthDigest(hub, { history: 2 }))
    expect(hub.queries).toEqual([{ path: PATH, input: { history: 2 } }])
    expect(out).toContain('"critical":1')
    expect(out).toContain('"warning":1')
    expect(out).toContain('inference-too-slow:7')
    // a number that could not be read stays null in the answer
    expect(out).toContain('"queueDepth":null')
  })

  it('says so plainly before the first tick, instead of an empty success', async () => {
    const hub = fakeHub({ [PATH]: { latest: null, previous: [] } })
    const out = JSON.stringify(await healthDigest(hub, {}))
    expect(out).toMatch(/no digest yet/i)
    expect(hub.queries[0]?.input).toEqual({ history: 1 })
  })

  it('refuses a payload that does not match the wire shape', async () => {
    const hub = fakeHub({ [PATH]: { latest: { findings: 'nope' }, previous: [] } })
    await expect(healthDigest(hub, {})).rejects.toThrow()
  })
})
