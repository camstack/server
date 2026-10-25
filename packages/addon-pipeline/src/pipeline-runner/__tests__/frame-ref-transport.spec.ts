import { describe, expect, it } from 'vitest'
import type { FrameInput, FrameRef } from '@camstack/types'
import { selectExecutorFrameSource } from '../frame-ref-transport.js'

const frame: FrameInput = {
  data: new Uint8Array([1, 2, 3]),
  width: 1,
  height: 1,
  format: 'rgb',
  timestamp: 1,
}

const frameRef: FrameRef = {
  registryId: 'process-a',
  id: 'frame-1',
  width: 1920,
  height: 1080,
  format: 'rgb',
  timestamp: 1,
}

describe('executor frame transport selection', () => {
  it('uses frameRef only for a co-located executor', () => {
    expect(selectExecutorFrameSource(true, frameRef, frame)).toEqual({ frameRef })
  })

  it('uses inline compatibility for split/cross-node execution', () => {
    expect(selectExecutorFrameSource(false, frameRef, frame)).toEqual({ frame })
  })

  it('keeps inline rollback when a local reference is unavailable', () => {
    expect(selectExecutorFrameSource(true, undefined, frame)).toEqual({ frame })
  })
})
