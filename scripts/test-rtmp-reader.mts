#!/usr/bin/env tsx
/**
 * Live RTMP smoke-test for the new stream-broker RTMP reader.
 *
 * Reads camera coordinates from environment variables — never persisted
 * to disk by this script. Run with:
 *
 *   TCP_HOST=192.168.x.y TCP_USERNAME=admin TCP_PASSWORD=secret \
 *     npx tsx scripts/test-rtmp-reader.mts tcp
 *
 * Cameras (matching the local lab setup):
 *   - tcp     → H.264 over RTMP (TCP_HOST / TCP_USERNAME / TCP_PASSWORD)
 *   - tcp265  → H.265 over RTMP (TCP265_HOST / TCP265_USERNAME / TCP265_PASSWORD)
 *
 * Optional flags:
 *   PROFILE=main|sub          (default: main)
 *   CHANNEL=0..N               (default: 0)
 *   DURATION_SEC=15            (default: 15)
 *
 * Output: per-second progress + final summary. Never echoes the password
 * — the RTMP URL is logged with `password=***`.
 */

import { performance } from 'node:perf_hooks'
import { loadEnv } from './lib/load-env.mjs'
import { RtmpReader } from '../packages/addon-stream-broker/src/rtmp/rtmp-reader.js'

loadEnv('.env.reolink')

interface CamCreds {
  readonly host: string
  readonly username: string
  readonly password: string
  readonly label: string
}

const DEFAULT_DURATION_SEC = 15
const DEFAULT_PROFILE: 'main' | 'sub' = 'main'

function readCreds(target: string): CamCreds {
  const prefixMap: Record<string, string> = {
    tcp: 'TCP_',
    tcp265: 'TCP265_',
  }
  const prefix = prefixMap[target]
  if (!prefix) {
    throw new Error(`Unknown target '${target}'. Valid: ${Object.keys(prefixMap).join(', ')}`)
  }
  const host = process.env[`${prefix}HOST`]
  const username = process.env[`${prefix}USERNAME`]
  const password = process.env[`${prefix}PASSWORD`]
  if (!host || !username || !password) {
    throw new Error(
      `Missing env: ${prefix}HOST, ${prefix}USERNAME, ${prefix}PASSWORD must all be set`,
    )
  }
  return { host, username, password, label: target }
}

function buildReolinkRtmpUrl(
  creds: CamCreds,
  profile: 'main' | 'sub',
  channel: number,
): {
  readonly url: string
  readonly logUrl: string
} {
  const streamType = profile === 'sub' ? 1 : 0
  const path = `/bcs/channel${channel}_${profile}.bcs`
  const params = new URLSearchParams({
    channel: String(channel),
    stream: String(streamType),
    user: creds.username,
    password: creds.password,
  })
  const safeParams = new URLSearchParams({
    channel: String(channel),
    stream: String(streamType),
    user: creds.username,
    password: '***',
  })
  return {
    url: `rtmp://${creds.host}:1935${path}?${params.toString()}`,
    logUrl: `rtmp://${creds.host}:1935${path}?${safeParams.toString()}`,
  }
}

interface TestStats {
  readonly startedAt: number
  videoCodec: 'h264' | 'h265' | null
  audioCodec: string | null
  audioSampleRate: number | null
  audioChannels: number | null
  videoPackets: number
  videoKeyframes: number
  videoBytes: number
  audioPackets: number
  audioBytes: number
  errors: number
  firstPacketAt: number | null
  lastPacketAt: number | null
}

function newStats(): TestStats {
  return {
    startedAt: performance.now(),
    videoCodec: null,
    audioCodec: null,
    audioSampleRate: null,
    audioChannels: null,
    videoPackets: 0,
    videoKeyframes: 0,
    videoBytes: 0,
    audioPackets: 0,
    audioBytes: 0,
    errors: 0,
    firstPacketAt: null,
    lastPacketAt: null,
  }
}

async function runTest(
  target: string,
  profile: 'main' | 'sub',
  channel: number,
  durationSec: number,
): Promise<TestStats> {
  const creds = readCreds(target)
  const { url, logUrl } = buildReolinkRtmpUrl(creds, profile, channel)
  const stats = newStats()

  console.log(`\n[${creds.label}] connecting`)
  console.log(`        url: ${logUrl}`)
  console.log(`        duration: ${durationSec}s\n`)

  await new Promise<void>((resolve) => {
    const reader = new RtmpReader(url, undefined, {
      onVideoCodec: (codec) => {
        stats.videoCodec = codec
        console.log(`[${creds.label}] video codec: ${codec}`)
      },
      onAudioInfo: (info) => {
        stats.audioCodec = info.codec
        stats.audioSampleRate = info.sampleRate
        stats.audioChannels = info.channels
        console.log(
          `[${creds.label}] audio: ${info.codec} ${info.sampleRate}Hz ch=${info.channels}`,
        )
      },
      onPlaying: () => {
        console.log(`[${creds.label}] streaming`)
      },
      onEncodedPacket: (packet) => {
        const now = performance.now()
        if (stats.firstPacketAt === null) stats.firstPacketAt = now
        stats.lastPacketAt = now
        if (packet.type === 'video') {
          stats.videoPackets++
          stats.videoBytes += packet.data.length
          if (packet.keyframe) stats.videoKeyframes++
        } else {
          stats.audioPackets++
          stats.audioBytes += packet.data.length
        }
      },
      onError: (err) => {
        stats.errors++
        console.error(`[${creds.label}] ERROR: ${err.message}`)
        resolve()
      },
      onTeardown: () => {
        // teardown after destroy() — expected when we stop the test
      },
    })

    let lastReport = performance.now()
    let lastVideoPackets = 0
    let lastVideoBytes = 0
    const reportTimer = setInterval(() => {
      const now = performance.now()
      const dtSec = (now - lastReport) / 1000
      const fps = (stats.videoPackets - lastVideoPackets) / dtSec
      const kbps = ((stats.videoBytes - lastVideoBytes) * 8) / 1000 / dtSec
      lastReport = now
      lastVideoPackets = stats.videoPackets
      lastVideoBytes = stats.videoBytes
      console.log(
        `[${creds.label}] +${((now - stats.startedAt) / 1000).toFixed(1)}s ` +
          `v=${fps.toFixed(1)}fps ${kbps.toFixed(0)}kbps key=${stats.videoKeyframes} a=${stats.audioPackets}pkt`,
      )
    }, 1000)

    const stopTimer = setTimeout(() => {
      clearInterval(reportTimer)
      reader.destroy()
      resolve()
    }, durationSec * 1000)

    void reader.connect().catch((err: unknown) => {
      clearInterval(reportTimer)
      clearTimeout(stopTimer)
      console.error(`[${creds.label}] connect failed: ${(err as Error).message}`)
      stats.errors++
      resolve()
    })
  })

  return stats
}

function summarise(label: string, stats: TestStats, durationSec: number): void {
  const elapsed = (performance.now() - stats.startedAt) / 1000
  const fps = stats.videoPackets / elapsed
  const kbps = (stats.videoBytes * 8) / 1000 / elapsed
  console.log(`\n[${label}] summary (${elapsed.toFixed(1)}s elapsed, requested ${durationSec}s)`)
  console.log(`        video codec        : ${stats.videoCodec ?? '(none)'}`)
  console.log(`        video packets      : ${stats.videoPackets}`)
  console.log(`        video keyframes    : ${stats.videoKeyframes}`)
  console.log(`        video avg fps      : ${fps.toFixed(2)}`)
  console.log(`        video avg bitrate  : ${kbps.toFixed(0)} kbps`)
  console.log(`        audio codec        : ${stats.audioCodec ?? '(none)'}`)
  if (stats.audioCodec) {
    console.log(`        audio sample-rate  : ${stats.audioSampleRate} Hz`)
    console.log(`        audio channels     : ${stats.audioChannels}`)
  }
  console.log(`        audio packets      : ${stats.audioPackets}`)
  console.log(`        errors             : ${stats.errors}`)
}

const target = process.argv[2] ?? 'tcp'
const profile = (process.env.PROFILE === 'sub' ? 'sub' : DEFAULT_PROFILE) as 'main' | 'sub'
const channel = Number.parseInt(process.env.CHANNEL ?? '0', 10) || 0
const durationSec = Number.parseInt(process.env.DURATION_SEC ?? `${DEFAULT_DURATION_SEC}`, 10)

try {
  const stats = await runTest(target, profile, channel, durationSec)
  summarise(target, stats, durationSec)
  process.exit(stats.errors > 0 || stats.videoPackets === 0 ? 1 : 0)
} catch (err) {
  console.error(`fatal: ${(err as Error).message}`)
  process.exit(1)
}
