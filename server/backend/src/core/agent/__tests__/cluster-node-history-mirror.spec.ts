import { describe, expect, it } from 'vitest'
import { ClusterNodeHistoryMirror } from '../cluster-node-history-mirror.js'
import type { PersistedClusterNode } from '../cluster-node-history-store.js'

const row = (id: string): PersistedClusterNode => ({
  id,
  name: id,
  hostname: id,
  platform: 'linux',
  arch: 'x64',
  cpuModel: null,
  cpuCores: 1,
  memoryMB: 1,
  engines: [],
  isHub: false,
  localIps: [],
  addonIds: [],
  lastActive: 0,
})

type Answer = readonly PersistedClusterNode[] | null

/** A scripted history read: each call takes the next answer and is counted. */
interface ScriptedRead {
  readonly read: () => Promise<Answer>
  readonly calls: () => number
  readonly answers: Answer[]
}

function scripted(...answers: Answer[]): ScriptedRead {
  let calls = 0
  const queue = [...answers]
  return {
    answers: queue,
    calls: () => calls,
    read: async () => {
      calls += 1
      return queue.length > 0 ? (queue.shift() ?? null) : null
    },
  }
}

interface Clock {
  readonly now: () => number
  advance: (ms: number) => void
}

function clock(): Clock {
  let t = 1_000
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
}

describe('ClusterNodeHistoryMirror', () => {
  it('before any read has answered, current() reads, and a failed read is null', async () => {
    const r = scripted(null)
    const mirror = new ClusterNodeHistoryMirror(r.read, clock().now, 60_000)
    expect(await mirror.current()).toBeNull()
    expect(r.calls()).toBe(1)
  })

  it('serves a fresh mirror without reading again (the topology pass fed it)', async () => {
    const r = scripted([row('a')])
    const c = clock()
    const mirror = new ClusterNodeHistoryMirror(r.read, c.now, 60_000)
    await mirror.refresh()
    c.advance(59_000)
    expect((await mirror.current())?.map((n) => n.id)).toEqual(['a'])
    expect(r.calls()).toBe(1)
  })

  it('re-reads a stale mirror, and falls back to the last SUCCESSFUL read when that fails', async () => {
    const r = scripted([row('a')], null, [row('b')])
    const c = clock()
    const mirror = new ClusterNodeHistoryMirror(r.read, c.now, 60_000)
    await mirror.refresh()
    c.advance(61_000)
    expect((await mirror.current())?.map((n) => n.id)).toEqual(['a'])
    expect(r.calls()).toBe(2)
    expect((await mirror.current())?.map((n) => n.id)).toEqual(['b'])
    expect(r.calls()).toBe(3)
  })

  it('refresh() reports the read itself: null on failure even with a mirror', async () => {
    const r = scripted([row('a')], null)
    const mirror = new ClusterNodeHistoryMirror(r.read, clock().now, 60_000)
    await mirror.refresh()
    expect(await mirror.refresh()).toBeNull()
  })

  it('concurrent callers share ONE read (single-flight)', async () => {
    const r = scripted([row('a')])
    const mirror = new ClusterNodeHistoryMirror(r.read, clock().now, 60_000)
    const [x, y, z] = await Promise.all([mirror.current(), mirror.current(), mirror.refresh()])
    expect(r.calls()).toBe(1)
    expect([x, y, z].map((v) => v?.length)).toEqual([1, 1, 1])
  })

  it('invalidate() drops the mirror: the next current() re-reads, a failure is null', async () => {
    const r = scripted([row('a')], null)
    const mirror = new ClusterNodeHistoryMirror(r.read, clock().now, 60_000)
    await mirror.refresh()
    mirror.invalidate()
    expect(await mirror.current()).toBeNull()
    expect(r.calls()).toBe(2)
  })

  it('a read in flight when invalidate() lands does not resurrect the dropped mirror', async () => {
    let release: (value: Answer) => void = () => {}
    let calls = 0
    const read = (): Promise<Answer> => {
      calls += 1
      if (calls === 1) return new Promise<Answer>((resolve) => (release = resolve))
      return Promise.resolve([row('fresh')])
    }
    const mirror = new ClusterNodeHistoryMirror(read, clock().now, 60_000)
    const pending = mirror.refresh()
    mirror.invalidate()
    release([row('forgotten')])
    await pending
    expect((await mirror.current())?.map((n) => n.id)).toEqual(['fresh'])
    expect(calls).toBe(2)
  })
})
