import { describe, expect, it } from 'vitest'
import { describeToBufferMiss, toBufferMissRung } from '../to-buffer-miss.js'

const base = {
  frameId: 10,
  reservedFrameId: 12,
  marked: true,
  leaseFrames: 3,
  holdFrames: 8,
  holdOverflow: 0,
}

describe('toBufferMissRung — the rung is named, not guessed', () => {
  it('an id newer than anything delivered was never delivered', () => {
    expect(toBufferMissRung({ ...base, frameId: 13 })).toBe('not-yet-delivered')
  })

  it('an unmarked frame was never leased — the runner never admitted it', () => {
    expect(toBufferMissRung({ ...base, marked: false })).toBe('never-leased')
  })

  it('a marked frame missing from a FULL hold was evicted by the bound', () => {
    expect(toBufferMissRung({ ...base, leaseFrames: 8 })).toBe('hold-full')
  })

  it('a marked frame missing from a hold with room was released already', () => {
    expect(toBufferMissRung(base)).toBe('released')
  })
})

describe('describeToBufferMiss', () => {
  it('names who withdrew the mark when the frame was unmarked early', () => {
    expect(describeToBufferMiss({ ...base, marked: false, unmarkedBy: 'release' })).toContain(
      'never-leased {reserved=12 marked=false leaseFrames=3/8 holdOverflow=0 unmarkedBy=release}',
    )
  })

  it('leads with the rung and carries the numbers', () => {
    expect(describeToBufferMiss({ ...base, leaseFrames: 8, holdOverflow: 41 })).toBe(
      'decode-worker-child: toBuffer miss for frameId 10 — hold-full {reserved=12 marked=true leaseFrames=8/8 holdOverflow=41}',
    )
  })
})
