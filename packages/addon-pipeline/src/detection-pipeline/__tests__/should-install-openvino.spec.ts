/**
 * Unit tests for the `shouldInstallOpenvino` hardware gate.
 *
 * The helper is addon-local (addons are self-contained; no @camstack/system
 * imports allowed) and is a pure function with no side effects, making it
 * trivially unit-testable. Three cases cover the gate semantics:
 *
 *  1. Intel hardware on Linux  → true  (proactive install warranted)
 *  2. darwin (any GPU)         → false (coremltools handles Apple Silicon + Intel Mac)
 *  3. Linux + AMD GPU          → true  (OV-CPU for int8 IRs on Zen4 VNNI)
 */
import { describe, it, expect } from 'vitest'
import { shouldInstallOpenvino } from '../index.js'

describe('shouldInstallOpenvino', () => {
  it('returns true for linux + Intel iGPU', () => {
    expect(
      shouldInstallOpenvino({
        platform: 'linux',
        gpu: { type: 'intel' },
        npu: null,
      }),
    ).toBe(true)
  })

  it('returns true for linux + Intel NPU (no iGPU)', () => {
    expect(
      shouldInstallOpenvino({
        platform: 'linux',
        gpu: null,
        npu: { type: 'intel-npu' },
      }),
    ).toBe(true)
  })

  it('returns true for linux + both Intel iGPU and NPU', () => {
    expect(
      shouldInstallOpenvino({
        platform: 'linux',
        gpu: { type: 'intel' },
        npu: { type: 'intel-npu' },
      }),
    ).toBe(true)
  })

  it('returns false for darwin (Apple Silicon)', () => {
    expect(
      shouldInstallOpenvino({
        platform: 'darwin',
        gpu: { type: 'apple' },
        npu: { type: 'apple-ane' },
      }),
    ).toBe(false)
  })

  it('returns false for darwin (Intel Mac)', () => {
    expect(
      shouldInstallOpenvino({
        platform: 'darwin',
        gpu: { type: 'intel' },
        npu: null,
      }),
    ).toBe(false)
  })

  it('returns true for linux + AMD GPU (OpenVINO CPU path)', () => {
    expect(
      shouldInstallOpenvino({
        platform: 'linux',
        gpu: { type: 'amd' },
        npu: null,
      }),
    ).toBe(true)
  })

  it('returns false for linux + NVIDIA GPU', () => {
    expect(
      shouldInstallOpenvino({
        platform: 'linux',
        gpu: { type: 'nvidia' },
        npu: null,
      }),
    ).toBe(false)
  })

  it('returns false for linux with no GPU/NPU', () => {
    expect(
      shouldInstallOpenvino({
        platform: 'linux',
        gpu: null,
        npu: null,
      }),
    ).toBe(false)
  })
})
