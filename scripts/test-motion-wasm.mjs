#!/usr/bin/env node

/**
 * Test WASM motion detector with synthetic frames.
 *
 * Creates grayscale frames with known motion regions and verifies
 * the WASM detector correctly identifies them.
 *
 * Usage: node scripts/test-motion-wasm.mjs
 */

import { WasmMotionDetector } from '../packages/addon-motion-wasm/dist/index.mjs'

// Helper: extract filtered regions from new WasmMotionResult
function detectFiltered(detector, prev, curr, config) {
  const result = detector.detect(prev, curr, config)
  return { raw: result.raw, filtered: result.filtered }
}

const WIDTH = 640
const HEIGHT = 360

function createGrayFrame(fillValue = 128) {
  return new Uint8Array(WIDTH * HEIGHT).fill(fillValue)
}

function drawRect(frame, x, y, w, h, value) {
  for (let row = y; row < y + h && row < HEIGHT; row++) {
    for (let col = x; col < x + w && col < WIDTH; col++) {
      frame[row * WIDTH + col] = value
    }
  }
}

async function main() {
  const detector = new WasmMotionDetector()
  await detector.load()
  detector.init(WIDTH, HEIGHT)

  console.log(`WASM Motion Test — ${WIDTH}x${HEIGHT}`)
  console.log('─'.repeat(60))

  // Test 1: Two identical frames → no motion
  {
    const frame1 = createGrayFrame(128)
    const frame2 = createGrayFrame(128)
    const { filtered: regions } = detector.detect(frame1, frame2, {
      threshold: 45,
      blurRadius: 1,
      dilateRadius: 4,
      minArea: 3000,
    })
    console.log(`Test 1 (identical frames):   regions=${regions.length} — expected 0`)
    if (regions.length !== 0) console.log('  ❌ FAIL — identical frames should produce 0 regions')
    else console.log('  ✅ PASS')
  }

  // Test 2: Static noise (uniform random ±5) → no motion with threshold 45
  {
    const frame1 = createGrayFrame(128)
    const frame2 = new Uint8Array(WIDTH * HEIGHT)
    for (let i = 0; i < frame2.length; i++) {
      frame2[i] = 128 + Math.floor(Math.random() * 10) - 5 // ±5 noise
    }
    const { filtered: regions } = detector.detect(frame1, frame2, {
      threshold: 45,
      blurRadius: 1,
      dilateRadius: 4,
      minArea: 3000,
    })
    console.log(`Test 2 (±5 noise, thr=45):   regions=${regions.length} — expected 0`)
    if (regions.length !== 0)
      console.log('  ❌ FAIL — low noise should not trigger with threshold 45')
    else console.log('  ✅ PASS')
  }

  // Test 3: Static noise ±20 → no motion with threshold 45
  {
    const frame1 = createGrayFrame(128)
    const frame2 = new Uint8Array(WIDTH * HEIGHT)
    for (let i = 0; i < frame2.length; i++) {
      frame2[i] = 128 + Math.floor(Math.random() * 40) - 20 // ±20 noise
    }
    const { filtered: regions } = detector.detect(frame1, frame2, {
      threshold: 45,
      blurRadius: 1,
      dilateRadius: 4,
      minArea: 3000,
    })
    console.log(`Test 3 (±20 noise, thr=45):  regions=${regions.length} — expected 0`)
    if (regions.length !== 0) {
      console.log('  ⚠️  noise leaking through — may cause false positives')
      for (const r of regions) {
        console.log(`    box: ${r.x},${r.y} ${r.w}x${r.h} pixels=${r.pixels}`)
      }
    } else {
      console.log('  ✅ PASS')
    }
  }

  // Test 4: Large moving object → should detect
  {
    const frame1 = createGrayFrame(128)
    const frame2 = createGrayFrame(128)
    // Draw a bright rectangle (simulating a person walking)
    drawRect(frame2, 200, 100, 80, 200, 255) // 80x200 = 16000px
    const { filtered: regions } = detector.detect(frame1, frame2, {
      threshold: 45,
      blurRadius: 1,
      dilateRadius: 4,
      minArea: 3000,
    })
    console.log(`Test 4 (80x200 rect):        regions=${regions.length} — expected 1`)
    if (regions.length === 0) {
      console.log('  ❌ FAIL — large moving object should be detected')
    } else {
      const r = regions[0]
      console.log(`  box: ${r.x},${r.y} ${r.w}x${r.h} pixels=${r.pixels}`)
      const overlapX = r.x >= 195 && r.x <= 205
      const overlapY = r.y >= 95 && r.y <= 105
      if (overlapX && overlapY) console.log('  ✅ PASS — box position correct')
      else console.log(`  ⚠️  box position off — expected ~200,100 got ${r.x},${r.y}`)
    }
  }

  // Test 5: Small OSD-like region → should NOT detect with minArea 1500
  {
    const frame1 = createGrayFrame(128)
    const frame2 = createGrayFrame(128)
    // Draw small OSD-like rectangles (simulating timestamp digits)
    drawRect(frame2, 10, 10, 30, 15, 255) // 30x15 = 450px
    drawRect(frame2, 50, 10, 30, 15, 255) // 30x15 = 450px
    drawRect(frame2, 90, 10, 30, 15, 255) // 30x15 = 450px
    const { filtered: regions } = detector.detect(frame1, frame2, {
      threshold: 45,
      blurRadius: 1,
      dilateRadius: 4,
      minArea: 3000,
    })
    console.log(`Test 5 (3x OSD 30x15):       regions=${regions.length} — expected 0`)
    if (regions.length !== 0) {
      console.log('  ❌ FAIL — small OSD regions should be filtered by minArea 1500')
      for (const r of regions) {
        console.log(`    box: ${r.x},${r.y} ${r.w}x${r.h} pixels=${r.pixels}`)
      }
    } else {
      console.log('  ✅ PASS')
    }
  }

  // Test 6: Movement from position A to position B → bbox should move
  {
    const frame1 = createGrayFrame(128)
    drawRect(frame1, 100, 150, 60, 150, 255) // person at x=100

    const frame2 = createGrayFrame(128)
    drawRect(frame2, 300, 150, 60, 150, 255) // person moved to x=300

    const { filtered: regions } = detector.detect(frame1, frame2, {
      threshold: 45,
      blurRadius: 1,
      dilateRadius: 4,
      minArea: 3000,
    })
    console.log(
      `Test 6 (move 100→300):       regions=${regions.length} — expected 2 (departure + arrival)`,
    )
    for (const r of regions) {
      console.log(`    box: ${r.x},${r.y} ${r.w}x${r.h} pixels=${r.pixels}`)
    }
    const hasNear100 = regions.some((r) => r.x >= 90 && r.x <= 110)
    const hasNear300 = regions.some((r) => r.x >= 290 && r.x <= 310)
    if (hasNear100 && hasNear300) console.log('  ✅ PASS — detected both departure and arrival')
    else console.log('  ⚠️  missing departure or arrival region')
  }

  // Test 7: Real-world H264 noise simulation — JPEG recompression artifacts
  {
    const frame1 = createGrayFrame(128)
    const frame2 = new Uint8Array(WIDTH * HEIGHT)
    // Simulate H.264 block artifacts: 8x8 blocks with slight uniform shifts
    for (let by = 0; by < HEIGHT; by += 8) {
      for (let bx = 0; bx < WIDTH; bx += 8) {
        const blockShift = Math.floor(Math.random() * 6) - 3 // ±3 per block
        for (let row = by; row < by + 8 && row < HEIGHT; row++) {
          for (let col = bx; col < bx + 8 && col < WIDTH; col++) {
            frame2[row * WIDTH + col] = Math.max(0, Math.min(255, 128 + blockShift))
          }
        }
      }
    }
    const { filtered: regions } = detector.detect(frame1, frame2, {
      threshold: 45,
      blurRadius: 1,
      dilateRadius: 4,
      minArea: 3000,
    })
    console.log(`Test 7 (H264 block noise):   regions=${regions.length} — expected 0`)
    if (regions.length !== 0) {
      console.log('  ⚠️  H264 artifacts leaking through')
      for (const r of regions) {
        console.log(`    box: ${r.x},${r.y} ${r.w}x${r.h} pixels=${r.pixels}`)
      }
    } else {
      console.log('  ✅ PASS')
    }
  }

  console.log('─'.repeat(60))
  console.log('Done.')
}

main().catch(console.error)
