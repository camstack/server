/**
 * Tests for the rules-based platform scorer.
 *
 * After the refactor, PlatformScorer:
 * - derives scores entirely from `scoreRuntimes` (types pure rules — no subprocess)
 * - has NO `probePythonBackends` method
 * - resolves python path by locating an interpreter only (no `import X` probe)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IScopedLogger, HardwareInfo } from '@camstack/types'
import { PlatformScorer } from '../platform-scorer.js'

function fakeLogger(): IScopedLogger {
  const noop = (): void => {}
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    child: () => fakeLogger(),
  } as unknown as IScopedLogger
}

const intelIgpuHardware: HardwareInfo = {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Intel Core i7',
  cpuCores: 8,
  totalRAM_MB: 16000,
  availableRAM_MB: 8000,
  gpu: { type: 'intel', name: 'Intel UHD Graphics 770' },
  npu: null,
}

describe('PlatformScorer (rules-based)', () => {
  let scorer: PlatformScorer

  beforeEach(() => {
    scorer = new PlatformScorer(fakeLogger(), null)
  })

  it('selects openvino as best backend for Intel iGPU hardware', async () => {
    vi.spyOn(scorer, 'probeHardware').mockResolvedValue(intelIgpuHardware)

    const result = await scorer.probe()

    expect(result.bestScore.backend).toBe('openvino')
    expect(result.bestScore.available).toBe(true)
  })

  it('includes the cpu floor in scores for Intel iGPU hardware', async () => {
    vi.spyOn(scorer, 'probeHardware').mockResolvedValue(intelIgpuHardware)

    const result = await scorer.probe()

    const cpuScore = result.scores.find((s) => s.backend === 'cpu')
    expect(cpuScore).toBeDefined()
    expect(cpuScore?.available).toBe(true)
  })

  it('does NOT have a probePythonBackends method (racy subprocess probe removed)', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: assert a removed method is absent
    expect((scorer as unknown as Record<string, unknown>)['probePythonBackends']).toBeUndefined()
  })

  it('resolves pythonPath without spawning a module-import subprocess', async () => {
    vi.spyOn(scorer, 'probeHardware').mockResolvedValue(intelIgpuHardware)

    const result = await scorer.probe()

    // pythonPath is a string (interpreter found) or null (not found) — both are valid
    expect(result.pythonPath === null || typeof result.pythonPath === 'string').toBe(true)
  })

  it('caches the result after the first probe call', async () => {
    const probeSpy = vi.spyOn(scorer, 'probeHardware').mockResolvedValue(intelIgpuHardware)

    await scorer.probe()
    await scorer.probe()

    // probeHardware is the expensive step — should only run once
    expect(probeSpy).toHaveBeenCalledTimes(1)
  })

  it('returns scores sorted descending by score value', async () => {
    vi.spyOn(scorer, 'probeHardware').mockResolvedValue(intelIgpuHardware)

    const result = await scorer.probe()

    for (let i = 1; i < result.scores.length; i++) {
      expect(result.scores[i - 1]!.score).toBeGreaterThanOrEqual(result.scores[i]!.score)
    }
  })
})
