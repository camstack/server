/**
 * Stream-broker transcode hwaccel resolution is NODE-LOCAL.
 *
 * `platform-probe` is a `singleton` cap and a forked agent child's `nodePin`
 * does not survive its link chain (it resolves to the hub's elected singleton →
 * the wrong hardware). The transcode DECODE and ENCODE hwaccel picks therefore
 * resolve from the LOCAL `ctx.kernel.hwaccel` resolver every forked child is
 * given — no cross-process cap call:
 *
 *   1. `TranscodePipelineManager.resolveSpecificDecodeHwAccel` /
 *      `resolveHardwareBackend` (getStreamWithCodec)
 *   2. `StreamBrokerManager.getHwAccelOptions` (settings option list)
 *
 * The WebRTC transcode leg is NOT in this list any more: it acquires through
 * `streamBroker.acquireEgressTranscode` (D67), whose hwaccel authority is the
 * DECODER ADDON's per-node probe rather than the kernel resolver — the kernel's
 * qsv-first order is the known-bad one on this hardware.
 *
 * No local resolver wired → software (null / static options only).
 */
import type { AddonApi, HwAccelResolution, IKernelHwAccel, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import { TranscodePipelineManager } from '../stream-broker/transcode-pipeline.js'

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  vi.mocked(logger.child).mockReturnValue(logger)
  vi.mocked(logger.withTags).mockReturnValue(logger)
  return logger
}

/** A fake local hwaccel resolver returning a fixed preference list. */
function makeHwAccel(preferred: readonly string[]): IKernelHwAccel & {
  resolve: ReturnType<typeof vi.fn>
} {
  const resolve = vi.fn(
    async (_prefer?: unknown): Promise<HwAccelResolution> => ({
      preferred: [...preferred] as HwAccelResolution['preferred'],
      rationale: 'test',
    }),
  )
  return { resolve }
}

// ── 1. TranscodePipelineManager hwaccel resolution ───────────────────────

interface TranscodePrivate {
  resolveSpecificDecodeHwAccel(prefer: string): Promise<string | null>
  resolveHardwareBackend(): Promise<string | null>
}

function makeTranscodeManager(hwaccel?: IKernelHwAccel): TranscodePrivate {
  const manager = new TranscodePipelineManager({
    logger: makeLogger(),
    cameraStreamLookup: () => [],
    rtspEntryLookup: () => null,
    // Never spawn a real binary in a test — and the ANSWER matters now: a
    // backend the binary does not carry is refused before the child is built
    // (D536), so the fake has to say what this fleet's capable ffmpeg says.
    probeFfmpeg: async (path: string) => ({
      path,
      version: 'ffmpeg version 6.1.1 (fake)',
      hwaccels: new Set(['vaapi', 'qsv', 'vdpau']),
      encoders: new Set(['libx264', 'libx265', 'h264_vaapi', 'hevc_vaapi']),
    }),
    ...(hwaccel ? { hwaccel } : {}),
  })
  return manager as unknown as TranscodePrivate
}

describe('TranscodePipelineManager — hwaccel resolves node-locally', () => {
  it('decode: resolves the forced backend via the local resolver (ranked)', async () => {
    const manager = makeTranscodeManager(makeHwAccel(['qsv', 'vaapi']))

    expect(await manager.resolveSpecificDecodeHwAccel('vaapi')).toBe('vaapi')
  })

  it('encode: names the local backend, ranked, for the encoder decision', async () => {
    // The backend is all this resolves now: which ENCODER it implies, and
    // whether this binary has it, is `chooseVideoEncoder`'s decision — the
    // encoder used to be tied to the DECODE preference and that is what put a
    // hub with a working iGPU on libx264.
    const manager = makeTranscodeManager(makeHwAccel(['qsv', 'vaapi']))

    expect(await manager.resolveHardwareBackend()).toBe('vaapi')
  })

  it('no resolver wired → software (null) on both paths', async () => {
    const manager = makeTranscodeManager()

    expect(await manager.resolveSpecificDecodeHwAccel('vaapi')).toBeNull()
    expect(await manager.resolveHardwareBackend()).toBeNull()
  })
})

// ── 2. StreamBrokerManager.getHwAccelOptions ─────────────────────────────

// `getHwAccelOptions` reads only `this.hwaccel`; `api` is unused there (it backs
// the `decoder` cap), so a bare stub is sufficient.
const FAKE_API = {} as unknown as AddonApi

describe('StreamBrokerManager — getHwAccelOptions from the local resolver', () => {
  it('offers the always-valid settings plus this node ranked backends', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    manager.setApiAccess(FAKE_API, 'dev-agent-0', makeHwAccel(['qsv', 'vaapi']))

    const options = await manager.getHwAccelOptions()

    expect(options).toEqual(expect.arrayContaining(['copy', 'auto', 'none', 'vaapi']))
    // vaapi precedes qsv (rank), and both are offered.
    expect(options.indexOf('vaapi')).toBeLessThan(options.indexOf('qsv'))
  })

  it('no local resolver → always-valid options only', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    manager.setApiAccess(FAKE_API, 'dev-agent-0')

    expect(await manager.getHwAccelOptions()).toEqual(['copy', 'auto', 'none'])
  })
})
