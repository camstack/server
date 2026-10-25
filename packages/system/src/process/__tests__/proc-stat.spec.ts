import { describe, expect, it } from 'vitest'
import {
  CLOCK_TICKS_PER_SEC,
  elapsedSecSince,
  lifetimeCpuPercent,
  parseProcStat,
  parseProcStatusRss,
} from '../proc-stat.js'

/**
 * `/proc/<pid>/stat` is the one place a process table can be read WITHOUT a
 * fork (D452). The fields after `comm` are positional, and `comm` may contain
 * spaces and parentheses, so the only correct parse cuts at the LAST `)`.
 */
describe('parseProcStat', () => {
  // pid 7, comm node, state S, ppid 1, pgrp 7, session 7, tty 0, tpgid -1,
  // flags, minflt, cminflt, majflt, cmajflt, utime 1500, stime 500, cutime 0,
  // cstime 0, priority 20, nice 0, num_threads 12, itrealvalue 0,
  // starttime 12345, vsize 999, rss 488876 ...
  const line =
    '7 (node) S 1 7 7 0 -1 4194560 100 0 0 0 1500 500 0 0 20 0 12 0 12345 999 488876 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0'

  it('reads pid, comm, state, ppid, pgid, ticks, starttime and rss from their positions', () => {
    expect(parseProcStat(line)).toEqual({
      pid: 7,
      comm: 'node',
      state: 'S',
      ppid: 1,
      pgid: 7,
      ticks: 2000,
      startTicks: 12345,
      rssPages: 488876,
    })
  })

  it('survives a comm with spaces and parentheses by cutting at the last )', () => {
    const weird = line.replace('(node)', '(some (weird) name)')
    const parsed = parseProcStat(weird)
    expect(parsed?.comm).toBe('some (weird) name')
    expect(parsed?.ppid).toBe(1)
    expect(parsed?.ticks).toBe(2000)
    expect(parsed?.startTicks).toBe(12345)
  })

  it('is null for a truncated line — a process that exited mid-read is not an error', () => {
    expect(parseProcStat('')).toBeNull()
    expect(parseProcStat('7 (node')).toBeNull()
    expect(parseProcStat('7 (node) S 1')).toBeNull()
  })
})

describe('parseProcStatusRss', () => {
  const status = [
    'Name:\tnode',
    'VmRSS:\t 1955504 kB',
    'RssAnon:\t 1900000 kB',
    'RssFile:\t   55504 kB',
    'RssShmem:\t       0 kB',
    'Threads:\t12',
  ].join('\n')

  it('reads VmRSS, RssAnon and RssFile in bytes', () => {
    expect(parseProcStatusRss(status)).toEqual({
      rssBytes: 1955504 * 1024,
      privateBytes: 1900000 * 1024,
      sharedBytes: 55504 * 1024,
    })
  })

  it('reports a missing field as undefined, never zero', () => {
    expect(parseProcStatusRss('Name:\tnode\nVmRSS:\t 10 kB')).toEqual({
      rssBytes: 10 * 1024,
      privateBytes: undefined,
      sharedBytes: undefined,
    })
    expect(parseProcStatusRss('Name:\tnode')).toEqual({
      rssBytes: undefined,
      privateBytes: undefined,
      sharedBytes: undefined,
    })
  })
})

describe('ps semantics over /proc', () => {
  it('lifetimeCpuPercent is what `ps pcpu` prints: cpu time over elapsed time, one decimal', () => {
    // 2000 ticks = 20 s of CPU; started at tick 12345 on a host up 1000 s
    // → elapsed 876.55 s → 2.28 % → 2.3
    expect(lifetimeCpuPercent({ ticks: 2000, startTicks: 12345, uptimeSec: 1000 })).toBe(2.3)
  })

  it('a process that started this instant has no elapsed window and reports 0, not Infinity', () => {
    expect(
      lifetimeCpuPercent({ ticks: 5, startTicks: 1000 * CLOCK_TICKS_PER_SEC, uptimeSec: 1000 }),
    ).toBe(0)
  })

  it('elapsedSecSince is `ps etime` in whole seconds', () => {
    expect(elapsedSecSince({ startTicks: 12345, uptimeSec: 1000 })).toBe(876)
  })
})
