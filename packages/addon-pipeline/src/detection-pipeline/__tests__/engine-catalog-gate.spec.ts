/**
 * Unit tests for the HARDWARE-driven engine catalog in
 * `DetectionPipelineProvider.getAvailableEnginesWithDevices(env)`.
 *
 * Key semantic change (Task 4/5): the offered list depends on `env`
 * (platform / arch / probed hardware), NOT on install state. The offer reflects
 * what the hardware can physically run; Python packages are provisioned on
 * demand (Phase 2).
 *
 *  - N100 (linux/x64, Intel iGPU) → onnx + openvino, never coreml.
 *  - Mac (darwin/arm64, Apple ANE) → onnx + coreml.
 *  - Probe null → onnx floor only (conservative).
 *  - OpenVINO device list excludes 'npu' when no Intel NPU is present.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DetectionPipelineProvider } from '../provider.js'
import type { RuntimeEnv } from '../runtimes.js'

// ---------------------------------------------------------------------------
// Minimal test doubles
// ---------------------------------------------------------------------------

function makeLogger(): IScopedLogger {
  const noop = (): void => undefined
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

class InMemoryStore {
  private data: Record<string, unknown> = {}
  async readAddonStore(): Promise<Record<string, unknown>> {
    return { ...this.data }
  }
  async writeAddonStore(patch: Record<string, unknown>): Promise<void> {
    this.data = { ...this.data, ...patch }
  }
}

function makeProvider(): DetectionPipelineProvider {
  return new DetectionPipelineProvider(new InMemoryStore(), '/tmp/models-test', makeLogger())
}

// ---------------------------------------------------------------------------
// Hardware/env fixtures
// ---------------------------------------------------------------------------

const N100: RuntimeEnv = {
  platform: 'linux',
  arch: 'x64',
  hardware: { npu: null, gpu: { type: 'intel' } },
}
const MAC: RuntimeEnv = {
  platform: 'darwin',
  arch: 'arm64',
  hardware: { npu: { type: 'apple-ane' }, gpu: { type: 'apple' } },
}
const PROBE_NULL: RuntimeEnv = { platform: 'linux', arch: 'x64', hardware: null }

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('getAvailableEnginesWithDevices — hardware-driven offer', () => {
  it('N100 offers onnx + openvino, never coreml — regardless of install state', () => {
    const backends = makeProvider()
      .getAvailableEnginesWithDevices(N100)
      .map((e) => e.engine.backend)
    expect(backends).toEqual(['onnx', 'openvino'])
  })

  it('Mac offers onnx + coreml', () => {
    const backends = makeProvider()
      .getAvailableEnginesWithDevices(MAC)
      .map((e) => e.engine.backend)
    expect(backends).toEqual(['onnx', 'coreml'])
  })

  it('probe null → onnx floor only (conservative)', () => {
    const backends = makeProvider()
      .getAvailableEnginesWithDevices(PROBE_NULL)
      .map((e) => e.engine.backend)
    expect(backends).toEqual(['onnx'])
  })

  it('openvino device list excludes npu when Intel NPU absent', () => {
    const ov = makeProvider()
      .getAvailableEnginesWithDevices(N100)
      .find((e) => e.engine.backend === 'openvino')
    expect(ov).toBeDefined()
    expect(ov!.devices.map((d) => d.id)).not.toContain('npu')
    expect(ov!.devices.map((d) => d.id)).toEqual(['auto', 'cpu', 'gpu'])
  })
})
