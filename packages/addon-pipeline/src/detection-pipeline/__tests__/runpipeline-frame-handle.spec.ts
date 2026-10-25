/**
 * CB5 — `runPipeline({ frameHandle })` shm passthrough, failure paths.
 *
 * The executor maps the named shm segment and reads pixels back zero-copy for
 * a LOCAL handle. A FOREIGN handle (segment on another node) and a recycled /
 * unmappable LOCAL segment both yield a null read → an empty `FrameResult`
 * (the runner ships pixels via `frame` as the fallback). Both paths return
 * BEFORE any engine work, so they can be exercised on a bare provider without
 * a Python pool.
 */
import { describe, it, expect } from 'vitest'
import { DetectionPipelineProvider } from '../provider.js'
import type { FrameHandle, IScopedLogger, PipelineStepInput } from '@camstack/types'

function stubLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeHandle(nodeId: string): FrameHandle {
  return {
    shmId: 'csf.nonexistent.deadbeef',
    slot: 0,
    seq: 1,
    width: 8,
    height: 8,
    format: 'rgb',
    pts: 1,
    byteLength: 8 * 8 * 3,
    nodeId,
    slotCount: 4,
  }
}

const STEPS: readonly PipelineStepInput[] = [
  { addonId: 'object-detection', modelId: 'yolo', enabled: true },
]

function makeProvider(): DetectionPipelineProvider {
  return new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    '/tmp/camstack-test-models',
    stubLogger(),
  )
}

describe('DetectionPipelineProvider.runPipeline — CB5 frameHandle', () => {
  it('returns an empty FrameResult for a FOREIGN frameHandle (never takes the local-map path)', async () => {
    const provider = makeProvider()
    // ownNodeId() defaults to 'hub' (no addonCtx); a handle from another node
    // must NOT be shm_open'd here.
    const result = await provider.runPipeline({
      steps: STEPS,
      frameHandle: makeHandle('agent-remote'),
      deviceId: 7,
    })
    expect(result.kind).toBe('frame')
    expect(result.detections).toEqual([])
    expect(result.deviceId).toBe(7)
  })

  it('returns an empty FrameResult when a LOCAL frameHandle segment is unmappable (recycled / null read)', async () => {
    const provider = makeProvider()
    // Local handle (nodeId 'hub' === own) but a segment that does not exist →
    // openSegment fails → null read → empty result, no crash, no engine work.
    const result = await provider.runPipeline({
      steps: STEPS,
      frameHandle: makeHandle('hub'),
      deviceId: 9,
    })
    expect(result.kind).toBe('frame')
    expect(result.detections).toEqual([])
    expect(result.deviceId).toBe(9)
  })
})
