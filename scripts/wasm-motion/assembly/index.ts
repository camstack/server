/**
 * WASM Motion Detection — raw pointer approach (no managed arrays)
 *
 * All input/output via linear memory offsets. JS caller writes frames
 * to known offsets, calls detectMotion, reads results from known offsets.
 */

// Layout in linear memory (set by init):
// [0..SIZE)          = prev frame (gray8)
// [SIZE..2*SIZE)     = curr frame (gray8)
// [2*SIZE..3*SIZE)   = blur buffer A
// [3*SIZE..4*SIZE)   = blur buffer B
// [4*SIZE..5*SIZE)   = diff mask
// [5*SIZE..5*SIZE+4*SIZE) = label map (i32)
// [after labels]     = parent buf, remap buf, region output

const MAX_REGIONS: i32 = 256
const REGION_STRIDE: i32 = 5

let W: i32 = 0
let H: i32 = 0
let SIZE: i32 = 0

// Offsets into linear memory
let prevOff: i32 = 0
let currOff: i32 = 0
let blurAOff: i32 = 0
let blurBOff: i32 = 0
let diffOff: i32 = 0
let labelOff: i32 = 0
let parentOff: i32 = 0
let remapOff: i32 = 0
let regionOff: i32 = 0

/** Call once with frame dimensions. Returns offset for prev frame. */
export function init(w: i32, h: i32): i32 {
  W = w
  H = h
  SIZE = w * h
  // All buffers in linear memory, sequentially
  prevOff = 1024 // start after stack
  currOff = prevOff + SIZE
  blurAOff = currOff + SIZE
  blurBOff = blurAOff + SIZE
  diffOff = blurBOff + SIZE
  labelOff = diffOff + SIZE
  parentOff = labelOff + SIZE * 4 // i32 per pixel
  remapOff = parentOff + (MAX_REGIONS + 1) * 4
  regionOff = remapOff + (MAX_REGIONS + 1) * 4

  // Ensure enough memory
  const needed = regionOff + MAX_REGIONS * REGION_STRIDE * 4 + 1024
  const pages = (needed + 65535) >> 16 // 64KB pages
  const currentPages = memory.size()
  if (pages > currentPages) {
    memory.grow(pages - currentPages)
  }

  return prevOff
}

/** Get offset for writing current frame */
export function getCurrOffset(): i32 {
  return currOff
}
/** Get offset for writing previous frame */
export function getPrevOffset(): i32 {
  return prevOff
}
/** Get offset for reading region results */
export function getRegionOffset(): i32 {
  return regionOff
}

// ── Box blur (separable) ──

function boxBlurH(srcOff: i32, dstOff: i32, w: i32, h: i32, r: i32): void {
  const inv: f32 = 1.0 / <f32>(r + r + 1)
  for (let y: i32 = 0; y < h; y++) {
    const row = y * w
    let sum: i32 = 0
    for (let k: i32 = -r; k <= r; k++) {
      const cx = k < 0 ? 0 : k >= w ? w - 1 : k
      sum += <i32>load<u8>(srcOff + row + cx)
    }
    store<u8>(dstOff + row, <u8>(<f32>sum * inv))
    for (let x: i32 = 1; x < w; x++) {
      const addX = x + r < w ? x + r : w - 1
      const remX = x - r - 1 >= 0 ? x - r - 1 : 0
      sum += <i32>load<u8>(srcOff + row + addX) - <i32>load<u8>(srcOff + row + remX)
      store<u8>(dstOff + row + x, <u8>(<f32>sum * inv))
    }
  }
}

function boxBlurV(srcOff: i32, dstOff: i32, w: i32, h: i32, r: i32): void {
  const inv: f32 = 1.0 / <f32>(r + r + 1)
  for (let x: i32 = 0; x < w; x++) {
    let sum: i32 = 0
    for (let k: i32 = -r; k <= r; k++) {
      const cy = k < 0 ? 0 : k >= h ? h - 1 : k
      sum += <i32>load<u8>(srcOff + cy * w + x)
    }
    store<u8>(dstOff + x, <u8>(<f32>sum * inv))
    for (let y: i32 = 1; y < h; y++) {
      const addY = y + r < h ? y + r : h - 1
      const remY = y - r - 1 >= 0 ? y - r - 1 : 0
      sum += <i32>load<u8>(srcOff + addY * w + x) - <i32>load<u8>(srcOff + remY * w + x)
      store<u8>(dstOff + y * w + x, <u8>(<f32>sum * inv))
    }
  }
}

function blur(srcOff: i32, dstOff: i32, tmpOff: i32, w: i32, h: i32, r: i32): void {
  boxBlurH(srcOff, tmpOff, w, h, r)
  boxBlurV(tmpOff, dstOff, w, h, r)
}

// ── Diff + threshold ──

function diffThreshold(aOff: i32, bOff: i32, outOff: i32, size: i32, thresh: i32): i32 {
  let count: i32 = 0
  for (let i: i32 = 0; i < size; i++) {
    const d = <i32>load<u8>(aOff + i) - <i32>load<u8>(bOff + i)
    const ad = d < 0 ? -d : d
    if (ad > thresh) {
      store<u8>(outOff + i, 255)
      count++
    } else {
      store<u8>(outOff + i, 0)
    }
  }
  return count
}

// ── Dilate ──

function dilate(off: i32, w: i32, h: i32, r: i32): void {
  for (let y: i32 = 0; y < h; y++) {
    let last: i32 = -r - 1
    for (let x: i32 = 0; x < w; x++) {
      const idx = off + y * w + x
      if (load<u8>(idx)) {
        last = x
      } else if (x - last <= r) {
        store<u8>(idx, 255)
      }
    }
    last = w + r + 1
    for (let x: i32 = w - 1; x >= 0; x--) {
      const idx = off + y * w + x
      if (load<u8>(idx)) {
        last = x
      } else if (last - x <= r) {
        store<u8>(idx, 255)
      }
    }
  }
  for (let x: i32 = 0; x < w; x++) {
    let last: i32 = -r - 1
    for (let y: i32 = 0; y < h; y++) {
      const idx = off + y * w + x
      if (load<u8>(idx)) {
        last = y
      } else if (y - last <= r) {
        store<u8>(idx, 255)
      }
    }
    last = h + r + 1
    for (let y: i32 = h - 1; y >= 0; y--) {
      const idx = off + y * w + x
      if (load<u8>(idx)) {
        last = y
      } else if (last - y <= r) {
        store<u8>(idx, 255)
      }
    }
  }
}

// ── Union-Find CCL ──

function ufFind(x: i32): i32 {
  let cur = x
  while (load<i32>(parentOff + (cur << 2)) !== cur) {
    const p = load<i32>(parentOff + (load<i32>(parentOff + (cur << 2)) << 2))
    store<i32>(parentOff + (cur << 2), p)
    cur = p
  }
  return cur
}

function ufUnion(a: i32, b: i32): void {
  const ra = ufFind(a),
    rb = ufFind(b)
  if (ra !== rb) store<i32>(parentOff + (rb << 2), ra)
}

function labelCCL(maskOff: i32, labelOff_: i32, w: i32, h: i32): i32 {
  let nextLabel: i32 = 1
  for (let i: i32 = 0; i <= MAX_REGIONS; i++) {
    store<i32>(parentOff + (i << 2), i)
  }

  for (let y: i32 = 0; y < h; y++) {
    for (let x: i32 = 0; x < w; x++) {
      const idx = y * w + x
      if (!load<u8>(maskOff + idx)) {
        store<i32>(labelOff_ + (idx << 2), 0)
        continue
      }
      const left: i32 = x > 0 ? load<i32>(labelOff_ + ((idx - 1) << 2)) : 0
      const up: i32 = y > 0 ? load<i32>(labelOff_ + (((y - 1) * w + x) << 2)) : 0

      if (left > 0 && up > 0) {
        store<i32>(labelOff_ + (idx << 2), left)
        if (left !== up) ufUnion(left, up)
      } else if (left > 0) {
        store<i32>(labelOff_ + (idx << 2), left)
      } else if (up > 0) {
        store<i32>(labelOff_ + (idx << 2), up)
      } else if (nextLabel < MAX_REGIONS) {
        store<i32>(labelOff_ + (idx << 2), nextLabel)
        nextLabel++
      } else {
        store<i32>(labelOff_ + (idx << 2), MAX_REGIONS - 1)
      }
    }
  }

  // Flatten
  let distinct: i32 = 0
  for (let i: i32 = 0; i <= MAX_REGIONS; i++) store<i32>(remapOff + (i << 2), 0)
  for (let i: i32 = 1; i < nextLabel; i++) {
    const root = ufFind(i)
    if (!load<i32>(remapOff + (root << 2))) {
      distinct++
      store<i32>(remapOff + (root << 2), distinct)
    }
    store<i32>(remapOff + (i << 2), load<i32>(remapOff + (root << 2)))
  }

  const size = w * h
  for (let i: i32 = 0; i < size; i++) {
    const l = load<i32>(labelOff_ + (i << 2))
    if (l > 0) store<i32>(labelOff_ + (i << 2), load<i32>(remapOff + (l << 2)))
  }
  return distinct
}

// ── Main ──

/**
 * Detect motion between frames at prevOff and currOff.
 * Caller must write gray pixels to getPrevOffset() and getCurrOffset() first.
 * Returns number of regions. Read bboxes from getRegionOffset():
 *   [x, y, w, h, pixelCount] × N as i32 array.
 */
export function detectMotion(
  threshold: i32 = 25,
  blurRadius: i32 = 1,
  dilateRadius: i32 = 4,
  minArea: i32 = 200,
): i32 {
  const w = W,
    h = H,
    size = SIZE

  // Blur prev → blurA, curr → blurB
  blur(prevOff, blurAOff, blurBOff, w, h, blurRadius)
  blur(currOff, blurBOff, blurAOff, w, h, blurRadius)
  // Now blurAOff = blurred prev, blurBOff = blurred curr

  // Diff
  const changed = diffThreshold(blurAOff, blurBOff, diffOff, size, threshold)
  if (changed < minArea) return 0

  // Dilate
  if (dilateRadius > 0) dilate(diffOff, w, h, dilateRadius)

  // CCL
  const numComp = labelCCL(diffOff, labelOff, w, h)

  // Extract bboxes
  let regionCount: i32 = 0
  for (let c: i32 = 1; c <= numComp && regionCount < MAX_REGIONS; c++) {
    let minX: i32 = w,
      minY: i32 = h,
      maxX: i32 = 0,
      maxY: i32 = 0,
      px: i32 = 0
    for (let y: i32 = 0; y < h; y++) {
      for (let x: i32 = 0; x < w; x++) {
        if (load<i32>(labelOff + ((y * w + x) << 2)) === c) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
          px++
        }
      }
    }
    if (px >= minArea) {
      const off = regionOff + regionCount * REGION_STRIDE * 4
      store<i32>(off, minX)
      store<i32>(off + 4, minY)
      store<i32>(off + 8, maxX - minX + 1)
      store<i32>(off + 12, maxY - minY + 1)
      store<i32>(off + 16, px)
      regionCount++
    }
  }
  return regionCount
}
