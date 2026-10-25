/**
 * WASM Motion Detection Benchmark — JS diff vs WASM blur+diff+dilate+CCL
 */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const W = 640,
  H = 360,
  SIZE = W * H
const ITERATIONS = 500
const RTSP_URL = process.argv[2]

// ── Load WASM ──
const { instance } = await WebAssembly.instantiate(await readFile(join(__dirname, 'motion.wasm')), {
  env: {
    abort: () => {
      throw new Error('abort')
    },
  },
})
const wasm = instance.exports

// ── Create synthetic test frames ──
const prev = new Uint8Array(SIZE)
const curr = new Uint8Array(SIZE)
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    prev[y * W + x] = Math.floor((x / W) * 128 + (y / H) * 64)
    curr[y * W + x] = prev[y * W + x]
  }
// 3 "moving objects"
for (const { x: ox, y: oy, w, h, v } of [
  { x: 100, y: 80, w: 60, h: 40, v: 200 },
  { x: 400, y: 200, w: 80, h: 30, v: 180 },
  { x: 550, y: 300, w: 25, h: 25, v: 220 },
])
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++) {
      const px = ox + dx,
        py = oy + dy
      if (px < W && py < H) curr[py * W + px] = v
    }

// ── JS diff (current production code) ──
function jsDiff(a, b) {
  let c = 0
  for (let i = 0; i < SIZE; i++) if (Math.abs(a[i] - b[i]) > 25) c++
  return c
}

// ── WASM wrapper ──
function wasmDetect(prevBuf, currBuf) {
  const mem = new Uint8Array(wasm.memory.buffer)
  const prevOff = wasm.getPrevOffset()
  const currOff = wasm.getCurrOffset()
  mem.set(prevBuf, prevOff)
  mem.set(currBuf, currOff)
  return wasm.detectMotion(25, 1, 4, 200)
}

function readRegions(count) {
  const off = wasm.getRegionOffset()
  const view = new DataView(wasm.memory.buffer)
  const regions = []
  for (let i = 0; i < count; i++) {
    const base = off + i * 20
    regions.push({
      x: view.getInt32(base, true),
      y: view.getInt32(base + 4, true),
      w: view.getInt32(base + 8, true),
      h: view.getInt32(base + 12, true),
      pixels: view.getInt32(base + 16, true),
    })
  }
  return regions
}

// ── Benchmark ──
console.log(`\n🏋️ Motion Detection: JS vs WASM`)
console.log(`   ${W}×${H} = ${SIZE.toLocaleString()} px, ${ITERATIONS} iterations\n`)

// Init WASM
wasm.init(W, H)

// JS warmup + bench
for (let i = 0; i < 20; i++) jsDiff(prev, curr)
const jsT = performance.now()
let jsR = 0
for (let i = 0; i < ITERATIONS; i++) jsR = jsDiff(prev, curr)
const jsMs = (performance.now() - jsT) / ITERATIONS

// WASM warmup + bench
for (let i = 0; i < 20; i++) wasmDetect(prev, curr)
const wasmT = performance.now()
let wasmR = 0
for (let i = 0; i < ITERATIONS; i++) wasmR = wasmDetect(prev, curr)
const wasmMs = (performance.now() - wasmT) / ITERATIONS

const regions = readRegions(wasmR)

console.log(`JS diff only:          ${jsMs.toFixed(3)}ms  (${jsR} changed px)`)
console.log(`WASM full pipeline:    ${wasmMs.toFixed(3)}ms  (${wasmR} regions)`)
console.log(`  blur+diff+threshold+dilate+CCL+bbox in one call`)
console.log(`  Regions: ${JSON.stringify(regions)}`)
console.log(`Speedup: ${(jsMs / wasmMs).toFixed(1)}x faster (WASM does 5x more work!)`)

// Real camera frames
if (RTSP_URL) {
  console.log(`\n═══ Real Camera ═══`)
  const frames = await new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+nobuffer',
      '-probesize',
      '32',
      '-analyzeduration',
      '0',
      '-rtsp_transport',
      'tcp',
      '-i',
      RTSP_URL,
      '-vf',
      `scale=${W}:${H},format=gray`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-vframes',
      '30',
      'pipe:1',
    ])
    const chunks = []
    proc.stdout.on('data', (c) => chunks.push(c))
    proc.on('close', () => {
      const buf = Buffer.concat(chunks)
      const list = []
      for (let i = 0; i + SIZE <= buf.length; i += SIZE) list.push(buf.subarray(i, i + SIZE))
      resolve(list)
    })
    setTimeout(() => proc.kill(), 15000)
  })

  if (frames.length >= 2) {
    console.log(`${frames.length} frames captured`)

    // JS
    let t = performance.now()
    for (let i = 1; i < frames.length; i++) jsDiff(frames[i - 1], frames[i])
    console.log(`JS real:   ${((performance.now() - t) / (frames.length - 1)).toFixed(3)}ms/frame`)

    // WASM
    t = performance.now()
    let lastRegions = 0
    for (let i = 1; i < frames.length; i++) lastRegions = wasmDetect(frames[i - 1], frames[i])
    console.log(
      `WASM real: ${((performance.now() - t) / (frames.length - 1)).toFixed(3)}ms/frame (${lastRegions} regions)`,
    )
  }
}

console.log()
