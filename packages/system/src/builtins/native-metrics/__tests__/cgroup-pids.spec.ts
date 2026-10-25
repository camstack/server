/**
 * The pid ceiling, and why it must be READ rather than inferred.
 *
 * A container cgroup counts THREADS, not processes. This hub runs with
 * `pids.max` 2048 and was measured refusing 22 clone() calls in 45 minutes —
 * every one of them a thread some subsystem needed and silently did without,
 * which surfaced as media that simply stopped. Nothing in the product read
 * that counter, so the only trace was the damage.
 *
 * Live hub, 2026-09-18, verbatim:
 *
 *   /sys/fs/cgroup/pids.current → 973
 *   /sys/fs/cgroup/pids.max     → 2048
 *   /sys/fs/cgroup/pids.events  → max 0
 *
 * `pids.events`' `max` counter is the only PROOF that refusals happened: it is
 * monotonic for the life of the cgroup, so a rise between two samples is a
 * refusal that occurred in that window and nothing else.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ContainerPidsProbe,
  buildContainerPidsSnapshot,
  parsePidsEvents,
  parsePidsMax,
} from '../cgroup-pids.js'
import type { CgroupFileReader } from '../cgroup-memory.js'

function reader(files: Record<string, string>): CgroupFileReader {
  return { read: (path) => files[path] ?? null }
}

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
}

const V2 = {
  '/proc/self/cgroup': '0::/\n',
  '/sys/fs/cgroup/pids.current': '973\n',
  '/sys/fs/cgroup/pids.max': '2048\n',
  '/sys/fs/cgroup/pids.events': 'max 0\n',
}

describe('parsePidsMax', () => {
  it('reads a numeric ceiling', () => {
    expect(parsePidsMax('2048\n')).toBe(2048)
  })

  it('reads "max" as NO ceiling — null, never a huge number', () => {
    // Charting an unlimited ceiling as a number flattens every real series.
    expect(parsePidsMax('max\n')).toBeNull()
  })
})

describe('parsePidsEvents', () => {
  it('takes the max counter — the number of times a fork was REFUSED', () => {
    expect(parsePidsEvents('max 22\n')).toBe(22)
  })

  it('ignores the local variant and any key it does not know', () => {
    expect(parsePidsEvents('max 3\nsomething 99\n')).toBe(3)
  })

  it('is null when the file says nothing it understands — unknown is not zero', () => {
    expect(parsePidsEvents('\n')).toBeNull()
  })
})

describe('buildContainerPidsSnapshot', () => {
  it('reports the ceiling and how much of it is used', () => {
    const snap = buildContainerPidsSnapshot({
      source: 'cgroup-v2',
      currentText: '973',
      maxText: '2048',
      eventsText: 'max 0',
    })
    expect(snap).toEqual({
      source: 'cgroup-v2',
      current: 973,
      max: 2048,
      usedFraction: 973 / 2048,
      refusals: 0,
    })
  })

  it('has no usedFraction without a ceiling — a fraction of nothing is not 0', () => {
    const snap = buildContainerPidsSnapshot({
      source: 'cgroup-v2',
      currentText: '973',
      maxText: 'max',
      eventsText: null,
    })
    expect(snap?.max).toBeNull()
    expect(snap?.usedFraction).toBeNull()
    expect(snap?.refusals).toBeNull()
  })
})

describe('ContainerPidsProbe', () => {
  it('says what it resolved and where it stands, then samples silently', () => {
    const log = logger()
    const probe = new ContainerPidsProbe({ logger: log, fs: reader(V2), now: () => 0 })
    expect(probe.sample()?.current).toBe(973)
    // Two lines on the first sample: what answered, and the first reading —
    // the operator asked for a DAY of regular readings, so the series starts
    // at boot rather than one heartbeat later.
    expect(log.info).toHaveBeenCalledTimes(2)
    probe.sample()
    expect(log.info).toHaveBeenCalledTimes(2)
  })

  it('reports nothing at all where there is no cgroup — absent, not zero', () => {
    const log = logger()
    const probe = new ContainerPidsProbe({ logger: log, fs: reader({}), now: () => 0 })
    expect(probe.sample()).toBeNull()
  })

  it('logs a heartbeat on its own cadence, not once per tick', () => {
    const log = logger()
    let now = 0
    const probe = new ContainerPidsProbe({
      logger: log,
      fs: reader(V2),
      now: () => now,
      heartbeatMs: 60_000,
    })
    probe.sample() // resolution line + first heartbeat
    const afterFirst = log.info.mock.calls.length
    now = 30_000
    probe.sample()
    expect(log.info.mock.calls.length).toBe(afterFirst)
    now = 60_001
    probe.sample()
    expect(log.info.mock.calls.length).toBe(afterFirst + 1)
  })

  it('WARNS the moment the refusal counter rises, naming how many and the ceiling', () => {
    const log = logger()
    const files = { ...V2 }
    const probe = new ContainerPidsProbe({ logger: log, fs: reader(files), now: () => 0 })
    probe.sample()
    expect(log.warn).not.toHaveBeenCalled()
    files['/sys/fs/cgroup/pids.events'] = 'max 22\n'
    probe.sample()
    expect(log.warn).toHaveBeenCalledTimes(1)
    const [message, payload] = log.warn.mock.calls[0] as [string, { meta: Record<string, unknown> }]
    expect(message).toMatch(/refus/i)
    expect(payload.meta['refusedSinceLastSample']).toBe(22)
    expect(payload.meta['max']).toBe(2048)
  })

  it('warns when the ceiling is being approached, and says so again only on the heartbeat', () => {
    const log = logger()
    let now = 0
    const files = { ...V2, '/sys/fs/cgroup/pids.current': '1900\n' }
    const probe = new ContainerPidsProbe({
      logger: log,
      fs: reader(files),
      now: () => now,
      heartbeatMs: 60_000,
    })
    probe.sample()
    expect(log.warn).toHaveBeenCalledTimes(1)
    now = 1_000
    probe.sample()
    expect(log.warn).toHaveBeenCalledTimes(1)
    now = 61_000
    probe.sample()
    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('says when the pressure is over, so the log has both edges', () => {
    const log = logger()
    let now = 0
    const files = { ...V2, '/sys/fs/cgroup/pids.current': '1900\n' }
    const probe = new ContainerPidsProbe({ logger: log, fs: reader(files), now: () => now })
    probe.sample()
    files['/sys/fs/cgroup/pids.current'] = '400\n'
    now = 1_000
    probe.sample()
    expect(log.info.mock.calls.some(([m]) => /recovered|back (under|below)/i.test(String(m)))).toBe(
      true,
    )
  })
})
