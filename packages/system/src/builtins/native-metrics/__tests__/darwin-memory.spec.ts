import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeDarwinMemory, parseVmStat } from '../darwin-memory.js'

// Captured from a real Apple Silicon Mac (36 GiB, 16 KiB pages).
const SAMPLE = fs.readFileSync(path.join(__dirname, 'vm-stat-sample.txt'), 'utf-8')
const TOTAL = 38654705664

describe('darwin memory', () => {
  it('parses the page size and counters', () => {
    const pages = parseVmStat(SAMPLE)
    expect(pages?.pageSize).toBe(16384)
    expect(pages?.wired).toBeGreaterThan(0)
    expect(pages?.compressor).toBeGreaterThan(0)
  })

  it('counts used as app + wired + compressed, not total - free', () => {
    const pages = parseVmStat(SAMPLE)!
    const mem = computeDarwinMemory(pages, TOTAL)!
    const expected = (pages.anonymous - pages.purgeable + pages.wired + pages.compressor) * 16384
    expect(mem.usedBytes).toBe(expected)
    const freememStyle = ((TOTAL - pages.free * 16384) / TOTAL) * 100
    expect(freememStyle).toBeGreaterThan(90)
    expect(mem.percent).toBeLessThan(80)
    expect(mem.availableBytes).toBe(TOTAL - expected)
  })

  it('returns null on garbage or missing counters', () => {
    expect(parseVmStat('')).toBeNull()
    expect(
      parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.'),
    ).toBeNull()
    expect(computeDarwinMemory(parseVmStat(SAMPLE)!, 0)).toBeNull()
  })
})
