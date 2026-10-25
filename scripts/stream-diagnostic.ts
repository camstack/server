/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- TECH-DEBT(test-2026-03-31): test file, mock typing */
// Diagnostic script — run with: cd camstack-server && npx tsx /tmp/stream-diagnostic.ts
import { StreamBrokerManager } from './server/backend/src/core/stream-broker/stream-broker-manager.service'
import { DecoderRegistry } from './server/backend/src/core/stream-broker/decoder-registry'
import { FfmpegDecoderProvider } from './server/backend/src/core/decoder/ffmpeg-decoder-provider'
import type { DecodedFrame, EncodedPacket } from './server/backend/src/interfaces/stream-broker'

const RTSP_RELAY = process.env.RTSP_RELAY_HOST || '192.168.x.x'
const STREAMS = [
  { id: 'front_door_main', url: `rtsp://${RTSP_RELAY}:8554/front_door_main`, codec: 'h264' },
  { id: 'hall_main', url: `rtsp://${RTSP_RELAY}:8554/hall_main`, codec: 'h264' },
]

const registry = new DecoderRegistry()
registry.register(new FfmpegDecoderProvider(), 50)

const mockLogger: any = {
  debug: () => {},
  info: console.log,
  warn: console.warn,
  error: console.error,
  child: () => mockLogger,
}
const manager = new StreamBrokerManager(registry, mockLogger as any)

async function runDiagnostic() {
  console.log('=== StreamBroker Diagnostic ===\n')

  // --- Test 1: Latency (time from broker start to first frame) ---
  console.log('--- Test 1: First-frame latency ---')
  for (const s of STREAMS) {
    const broker = await manager.createBroker(s.id, {
      type: 'rtsp',
      url: s.url,
      videoCodec: s.codec,
    })
    const startMs = Date.now()
    await (broker as any).start({ type: 'rtsp', url: s.url, videoCodec: s.codec })

    const firstFrame = await new Promise<{ latencyMs: number; size: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout 15s')), 15000)
      const unsub = broker.onDecodedFrame(
        (frame: DecodedFrame) => {
          clearTimeout(timeout)
          unsub()
          resolve({ latencyMs: Date.now() - startMs, size: frame.data.length })
        },
        { maxFps: 5, format: 'jpeg' },
      )
    })

    console.log(
      `  ${s.id}: first frame in ${firstFrame.latencyMs}ms, size=${(firstFrame.size / 1024).toFixed(1)}KB`,
    )
    await broker.stop()
  }

  // --- Test 2: Frame quality (JPEG sizes over time) ---
  console.log('\n--- Test 2: Frame quality (5s sample @ 5fps) ---')
  const broker1 = await manager.createBroker('quality-test', {
    type: 'rtsp',
    url: STREAMS[0].url,
    videoCodec: 'h264',
  })
  await (broker1 as any).start({ type: 'rtsp', url: STREAMS[0].url, videoCodec: 'h264' })

  const qualityFrames: { size: number; ts: number }[] = []
  const unsub1 = broker1.onDecodedFrame(
    (frame: DecodedFrame) => {
      qualityFrames.push({ size: frame.data.length, ts: frame.timestamp })
    },
    { maxFps: 5, format: 'jpeg' },
  )

  await new Promise((r) => setTimeout(r, 5000))
  unsub1()

  const sizes = qualityFrames.map((f) => f.size)
  const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length
  const minSize = Math.min(...sizes)
  const maxSize = Math.max(...sizes)

  // Check timestamp gaps
  const gaps: number[] = []
  for (let i = 1; i < qualityFrames.length; i++) {
    gaps.push(qualityFrames[i].ts - qualityFrames[i - 1].ts)
  }
  const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0

  console.log(`  Frames collected: ${qualityFrames.length}`)
  console.log(
    `  JPEG size: avg=${(avgSize / 1024).toFixed(1)}KB, min=${(minSize / 1024).toFixed(1)}KB, max=${(maxSize / 1024).toFixed(1)}KB`,
  )
  console.log(`  Frame gap: avg=${avgGap.toFixed(0)}ms (expected ~200ms @ 5fps)`)
  console.log(
    `  All valid JPEG: ${qualityFrames.every((f) => f.size > 1000 && f.ts > 0) ? 'YES' : 'NO'}`,
  )
  await broker1.stop()

  // --- Test 3: Fanout (encoded + decoded + multiple subscribers) ---
  console.log('\n--- Test 3: Fanout (3s, encoded + 2 decoded subscribers) ---')
  const broker2 = await manager.createBroker('fanout-test', {
    type: 'rtsp',
    url: STREAMS[0].url,
    videoCodec: 'h264',
  })
  await (broker2 as any).start({ type: 'rtsp', url: STREAMS[0].url, videoCodec: 'h264' })

  let encodedCount = 0
  let decoded1Count = 0
  let decoded2Count = 0
  let encodedBytes = 0

  const unsubE = broker2.onEncodedData((pkt: EncodedPacket) => {
    encodedCount++
    encodedBytes += pkt.data.length
  })
  const unsubD1 = broker2.onDecodedFrame(
    () => {
      decoded1Count++
    },
    { maxFps: 5, format: 'jpeg' },
  )
  const unsubD2 = broker2.onDecodedFrame(
    () => {
      decoded2Count++
    },
    { maxFps: 2, format: 'jpeg' },
  )

  await new Promise((r) => setTimeout(r, 3000))
  unsubE()
  unsubD1()
  unsubD2()

  console.log(`  Encoded packets: ${encodedCount} (${(encodedBytes / 1024).toFixed(0)}KB total)`)
  console.log(`  Decoded sub 1 (5fps): ${decoded1Count} frames`)
  console.log(`  Decoded sub 2 (2fps): ${decoded2Count} frames`)
  console.log(
    `  Fanout working: ${encodedCount > 0 && decoded1Count > 0 && decoded2Count > 0 ? 'YES' : 'NO'}`,
  )
  console.log(`  FPS isolation: ${decoded1Count > decoded2Count ? 'YES' : 'NO'} (sub1 > sub2)`)

  await broker2.stop()

  // --- Test 4: Concurrent brokers isolation ---
  console.log('\n--- Test 4: Concurrent brokers (2 cameras, 3s) ---')
  const counts: Record<string, number> = {}
  const brokers = []

  for (const s of STREAMS) {
    const b = await manager.createBroker(`concurrent-${s.id}`, {
      type: 'rtsp',
      url: s.url,
      videoCodec: s.codec,
    })
    await (b as any).start({ type: 'rtsp', url: s.url, videoCodec: s.codec })
    counts[s.id] = 0
    b.onDecodedFrame(
      () => {
        counts[s.id]++
      },
      { maxFps: 3, format: 'jpeg' },
    )
    brokers.push(b)
  }

  await new Promise((r) => setTimeout(r, 3000))

  for (const s of STREAMS) {
    console.log(`  ${s.id}: ${counts[s.id]} frames`)
  }
  console.log(`  Both producing: ${Object.values(counts).every((c) => c > 0) ? 'YES' : 'NO'}`)

  for (const b of brokers) await b.stop()

  // --- Summary ---
  console.log('\n=== Diagnostic Complete ===')
  await manager.destroyAll()
  process.exit(0)
}

runDiagnostic().catch((e) => {
  console.error(e)
  process.exit(1)
})
