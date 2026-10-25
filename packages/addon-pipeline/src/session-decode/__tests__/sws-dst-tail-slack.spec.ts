/**
 * Every libswscale destination buffer in the decode worker must carry a 64-byte
 * TAIL SLACK, and this is a source-level guard because the failure it prevents
 * cannot be reproduced in a unit test: it is a native heap corruption inside
 * glibc, several allocations later, in a forked child process.
 *
 * The history, already recorded in `decode-worker-child.ts`'s own docblocks:
 * libswscale writes rows with SIMD and can overshoot a row's byte count. On
 * every row but the last, the overshoot lands in the row below and is
 * immediately overwritten. On the LAST row it lands past the end of the
 * allocation — live `malloc(): corrupted top size` aborts, and a SIGABRT some
 * crops later that killed the worker on every face-detail burst.
 *
 * Aligning the destination stride is NOT sufficient and the code says so: a
 * 320px RGB target makes `tightStride` 960 and a 640px one makes it 1920, both
 * already 64-aligned, so alignment alone yields exactly ZERO slack. The
 * `+ 64` is the part that does the work — it mirrors `av_image_alloc`'s padding.
 *
 * Two of the three `scaleSync` destinations carried it. `scaleRoiToBuffer` —
 * the ROI `toBuffer` path the whole detection pipeline runs through — did not.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SOURCE = path.resolve(__dirname, '../decode-worker-child.ts')

/** `Buffer.allocUnsafe(...)` expressions whose size is a `dstStride * height`
 *  product — i.e. a scaler destination, as opposed to a memcpy destination. */
const SCALER_DST_ALLOC = /Buffer\.allocUnsafe\(\s*dstStride \* [A-Za-z.]+height([^)]*)\)/g

describe('libswscale destination buffers', () => {
  it('every scaler destination allocates a 64-byte tail slack', () => {
    const src = fs.readFileSync(SOURCE, 'utf-8')
    const tails = [...src.matchAll(SCALER_DST_ALLOC)].map((m) => m[1] ?? '')
    // Guard the guard: if the allocations are renamed away this regex must not
    // silently pass by matching nothing.
    expect(tails.length).toBeGreaterThanOrEqual(3)
    for (const tail of tails) expect(tail.replace(/\s/g, '')).toBe('+64')
  })
})
