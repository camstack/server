import { describe, it, expect, vi } from 'vitest'
import { warmFragment } from '../warm-fragment'
import { ScrubFragmentCache } from '../scrub-fragment-cache'
import type { AccessUnit } from '../segment-demux'

const AU = (ptsMs: number, key = false): AccessUnit => ({
  data: new Uint8Array([0, 0, 0, 1, key ? 0x26 : 0x02]),
  ptsMs,
  keyframe: key,
  codec: 'H264',
})

function deps(cache = new ScrubFragmentCache()) {
  const logs: Array<{ msg: string; data: Record<string, unknown> }> = []
  return {
    cache,
    logs,
    deviceId: 101,
    locate: vi.fn(
      async ({ epochMs }: { epochMs: number }) =>
        ({
          kind: 'segment',
          startMs: Math.floor(epochMs / 12_000) * 12_000,
          durMs: 12_000,
          bytes: 3,
        }) as const,
    ),
    readGop: vi.fn(
      async ({ segmentStartMs, epochMs }: { segmentStartMs: number; epochMs: number }) => {
        const gopIdx = Math.floor((epochMs - segmentStartMs) / 4_000)
        return {
          gopStartMs: segmentStartMs + gopIdx * 4_000,
          gopDurMs: 4_000,
          bytes: new Uint8Array([gopIdx]),
        }
      },
    ),
    demux: vi.fn(async () => [AU(0, true), AU(500), AU(1000)]),
    onLog: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
  }
}

describe('warmFragment — the first-scrub chain, pre-run on timeline open', () => {
  it('warms the GOP under the cursor into the session cache, with the chain timings logged', async () => {
    const d = deps()
    await warmFragment(d, 'low', 1_005_000)
    const frag = d.cache.covering('low', 1_005_000)
    expect(frag).not.toBeNull()
    expect(frag!.startMs).toBe(1_004_000)
    expect(frag!.aus.length).toBe(3)
    const line = d.logs.find((l) => l.msg === 'recorded:warmed')
    expect(line?.data).toMatchObject({ profile: 'low', gopStartMs: 1_004_000 })
    expect(typeof line?.data.locateMs).toBe('number')
  })

  it('a warm on an already-covered instant is a no-op — no RPC, no read', async () => {
    const d = deps()
    await warmFragment(d, 'low', 1_005_000)
    await warmFragment(d, 'low', 1_006_500) // same GOP
    expect(d.locate).toHaveBeenCalledTimes(1)
    expect(d.readGop).toHaveBeenCalledTimes(1)
    expect(d.logs.some((l) => l.msg === 'recorded:warm-hit')).toBe(true)
  })

  it('no footage under the cursor logs and warms nothing — never a throw', async () => {
    const d = deps()
    const gapLocate = vi.fn(async () => ({ kind: 'gap', nearestEdgeMs: null }) as const)
    await warmFragment({ ...d, locate: gapLocate }, 'low', 1_005_000)
    expect(d.cache.size).toBe(0)
    expect(d.logs.some((l) => l.msg === 'recorded:warm-no-footage')).toBe(true)
  })

  it('warming is profile-scoped — a low warm never answers a mid drag', async () => {
    const d = deps()
    await warmFragment(d, 'low', 1_005_000)
    expect(d.cache.covering('mid', 1_005_000)).toBeNull()
  })
})
