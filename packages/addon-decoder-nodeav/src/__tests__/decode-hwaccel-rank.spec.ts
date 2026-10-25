import { describe, expect, it } from 'vitest'
import { rankDecodeHwAccels } from '../decode-hwaccel-rank.js'

/**
 * `reprobeHwaccel` reports the HEAD of this ranking as the node's
 * `probedBestHwaccel`, which the egress transcode and HomeKit then use. On an
 * Intel node the kernel resolver lists `qsv` first, and `qsv` decode does not
 * work there — the reported backend must be `vaapi`.
 */
describe('rankDecodeHwAccels', () => {
  it('ranks vaapi above qsv whatever order the kernel resolver gave', () => {
    expect(rankDecodeHwAccels(['qsv', 'vaapi'], [])[0]).toBe('vaapi')
  })

  it('keeps an unranked method after every ranked one', () => {
    expect(rankDecodeHwAccels(['custom', 'cuda'], [])).toEqual(['cuda', 'custom'])
  })

  it('reports nothing for a software-only host', () => {
    expect(rankDecodeHwAccels([], [])).toEqual([])
  })
})
