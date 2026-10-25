/**
 * Egress decode-hwaccel resolution.
 *
 * There are two hwaccel opinions in this repo and they disagree in the
 * direction that breaks things: the raw kernel resolver returns
 * `['qsv','vaapi']` for an Intel host, while the DECODER ADDON re-ranks vaapi
 * ABOVE qsv because qsv children exit `code=171` producing no frames on that
 * exact hardware. The decoder addon's answer — published per node as
 * `probedBestHwaccel@<node>` and read back through the `decoder` cap — is the
 * authority. These tests exist so nobody "simplifies" the resolver back onto
 * the kernel probe.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  resolveEgressDecodeHwAccel,
  createHwAccelCache,
  type EgressHwAccelDeps,
} from '../ffmpeg/hwaccel.js'

function deps(over: Partial<EgressHwAccelDeps> = {}): EgressHwAccelDeps {
  return {
    readDecoderBackend: vi.fn(async () => 'vaapi'),
    readKernelPreferred: vi.fn(async () => ['qsv', 'vaapi']),
    onFallback: vi.fn(),
    ...over,
  }
}

describe('resolveEgressDecodeHwAccel', () => {
  it("takes the DECODER addon's backend, not the kernel resolver's first preference", async () => {
    const d = deps()
    await expect(resolveEgressDecodeHwAccel(d)).resolves.toBe('vaapi')
    // The kernel resolver must not even be consulted while the decoder answers.
    expect(d.readKernelPreferred).not.toHaveBeenCalled()
  })

  it('is hardware BY DEFAULT for an egress transcode (no opt-in required)', async () => {
    await expect(resolveEgressDecodeHwAccel(deps())).resolves.not.toBeNull()
  })

  it("treats the decoder's 'none' as a deliberate software choice and does NOT consult the kernel", async () => {
    const d = deps({ readDecoderBackend: vi.fn(async () => 'none') })
    await expect(resolveEgressDecodeHwAccel(d)).resolves.toBeNull()
    expect(d.readKernelPreferred).not.toHaveBeenCalled()
  })

  it('falls back to software — LOUDLY — when the decoder cannot be read at all', async () => {
    const onFallback = vi.fn()
    const d = deps({
      readDecoderBackend: vi.fn(async () => {
        throw new Error('decoder cap unreachable')
      }),
      readKernelPreferred: vi.fn(async () => []),
      onFallback,
    })
    await expect(resolveEgressDecodeHwAccel(d)).resolves.toBeNull()
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(onFallback.mock.calls[0]?.[0].reason).toBe('decoder-unreadable')
  })

  it('never silently downgrades: an EMPTY decoder answer reports the fallback', async () => {
    const onFallback = vi.fn()
    const d = deps({
      readDecoderBackend: vi.fn(async () => ''),
      readKernelPreferred: vi.fn(async () => []),
      onFallback,
    })
    await expect(resolveEgressDecodeHwAccel(d)).resolves.toBeNull()
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(onFallback.mock.calls[0]?.[0].reason).toBe('decoder-unprobed')
  })

  it('a decoder that has not probed yet does NOT hand the kernel head over verbatim', async () => {
    // The kernel says qsv first. qsv is exactly the backend that exits 171 on
    // the Intel hub. If the decoder cannot answer we must not adopt its order.
    const d = deps({
      readDecoderBackend: vi.fn(async () => ''),
      readKernelPreferred: vi.fn(async () => ['qsv', 'vaapi']),
    })
    await expect(resolveEgressDecodeHwAccel(d)).resolves.not.toBe('qsv')
  })

  it('honours an explicit operator override without asking anyone', async () => {
    const d = deps()
    await expect(resolveEgressDecodeHwAccel({ ...d, override: 'none' })).resolves.toBeNull()
    expect(d.readDecoderBackend).not.toHaveBeenCalled()

    const d2 = deps()
    await expect(resolveEgressDecodeHwAccel({ ...d2, override: 'vaapi' })).resolves.toBe('vaapi')
    expect(d2.readDecoderBackend).not.toHaveBeenCalled()
  })

  it("passes 'auto' through as the literal instruction to ffmpeg", async () => {
    await expect(resolveEgressDecodeHwAccel({ ...deps(), override: 'auto' })).resolves.toBe('auto')
  })

  it('caches within a TTL so a per-session resolve is not a per-session cap call', async () => {
    const readDecoderBackend = vi.fn(async () => 'vaapi')
    let clock = 1_000
    const cache = createHwAccelCache({ ttlMs: 60_000, now: () => clock })
    const d = deps({ readDecoderBackend })
    await resolveEgressDecodeHwAccel({ ...d, cache })
    await resolveEgressDecodeHwAccel({ ...d, cache })
    expect(readDecoderBackend).toHaveBeenCalledTimes(1)
    clock += 60_001
    await resolveEgressDecodeHwAccel({ ...d, cache })
    expect(readDecoderBackend).toHaveBeenCalledTimes(2)
  })
})
