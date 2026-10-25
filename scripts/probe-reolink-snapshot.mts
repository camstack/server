#!/usr/bin/env tsx
/**
 * Live diagnostic for the Reolink Baichuan `getSnapshot` cmd_id 109,
 * targeted at battery doorbells (BCUDP). Mirrors what the
 * `addon-provider-reolink` snapshot native does, with extra
 * instrumentation so we can see WHERE getSnapshot fails after the
 * camera wakes up:
 *
 *   1. Open a fresh ReolinkBaichuanApi instance (same options the
 *      addon uses) and call `login()` so the socket is up.
 *   2. Poll `isSleeping()` until the lib reports `true` (the user runs
 *      the script when the camera is genuinely sleeping — the addon's
 *      sleep poll will have just fired).
 *   3. Reach into `getSnapshot()` with a sequence of variants:
 *        - main / sub stream
 *        - explicit waker first vs. no waker
 *        - longer timeout
 *      …timing each one, capturing the exact error if it fails.
 *   4. Bail with a structured summary so we can compare success vs.
 *      failure cases.
 *
 * Usage:
 *   UDP_HOST=… UDP_USERNAME=… UDP_PASSWORD=… UDP_UID=… \
 *     npx tsx scripts/probe-reolink-snapshot.mts
 */

import { ReolinkBaichuanApi } from '@apocaliss92/nodelink-js'
import { loadEnv } from './lib/load-env.mjs'

loadEnv('.env.reolink')

const HOST = process.env['UDP_HOST']
const USERNAME = process.env['UDP_USERNAME']
const PASSWORD = process.env['UDP_PASSWORD']
const UID = process.env['UDP_UID']

if (!HOST || !USERNAME || !PASSWORD) {
  console.error('Missing UDP_HOST / UDP_USERNAME / UDP_PASSWORD env vars')
  process.exit(1)
}

interface Attempt {
  readonly label: string
  readonly fn: (api: ReolinkBaichuanApi) => Promise<Buffer>
}

const attempts: ReadonlyArray<Attempt> = [
  {
    label: 'main stream, default timeout (15s)',
    fn: (api) => api.getSnapshot(0, { streamType: 'main' }),
  },
  {
    label: 'sub stream, default timeout (15s)',
    fn: (api) => api.getSnapshot(0, { streamType: 'sub' }),
  },
  {
    label: 'main stream, 30s timeout',
    fn: (api) => api.getSnapshot(0, { streamType: 'main', timeoutMs: 30_000 }),
  },
  {
    label: 'wakeUp(0) then main stream, default timeout',
    fn: async (api) => {
      const t0 = Date.now()
      await api.wakeUp(0)
      console.log(`        wakeUp() resolved in ${Date.now() - t0}ms`)
      return api.getSnapshot(0, { streamType: 'main' })
    },
  },
  {
    // Mirrors the addon's new fetchSnapshotWithSingleFlight flow
    // (commit 00769bc8): pre-wake when getSleepStatus !== 'awake',
    // 25 s timeout on the first attempt, second wakeUp + retry on
    // failure. Validates the same code path against the live cam.
    label: 'addon flow: getSleepStatus → maybe wakeUp → main 25s → retry on fail',
    fn: async (api) => {
      const t0 = Date.now()
      let preWakeMs = 0
      try {
        const status = api.getSleepStatus({ channel: 0 })
        console.log(
          `        getSleepStatus → state=${status.state} idleMs=${status.idleMs ?? 'n/a'}`,
        )
        if (status.state !== 'awake') {
          const w0 = Date.now()
          await api.wakeUp(0, { waitAfterWakeMs: 1500, attempts: 2 })
          preWakeMs = Date.now() - w0
          console.log(`        pre-wakeUp resolved in ${preWakeMs}ms`)
        }
      } catch (err) {
        console.log(
          `        pre-wake skipped (${err instanceof Error ? err.message : String(err)})`,
        )
      }
      try {
        const buf = await api.getSnapshot(0, { streamType: 'main', timeoutMs: 25_000 })
        console.log(`        attempt 1 ok (total ${Date.now() - t0}ms, pre-wake ${preWakeMs}ms)`)
        return buf
      } catch (err) {
        console.log(
          `        attempt 1 failed (${Date.now() - t0}ms): ${err instanceof Error ? err.message : String(err)}`,
        )
        const w0 = Date.now()
        await api.wakeUp(0, { waitAfterWakeMs: 3000, attempts: 3, reconnect: true })
        console.log(`        recovery wakeUp resolved in ${Date.now() - w0}ms`)
        const buf = await api.getSnapshot(0, { streamType: 'main', timeoutMs: 25_000 })
        console.log(`        attempt 2 ok (total ${Date.now() - t0}ms)`)
        return buf
      }
    },
  },
]

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function isoNow(): string {
  return new Date().toISOString().slice(11, 23)
}

async function waitForSleep(api: ReolinkBaichuanApi, maxMs: number): Promise<boolean> {
  console.log(`[${isoNow()}] waiting for camera to enter sleep state (max ${maxMs / 1000}s)…`)
  // Battery cams sleep when idle. Polling `isSleeping` (even with the
  // NONE_WAKING getBatteryInfo) keeps the UDP socket warm enough that
  // the camera never enters its low-power mode in our window. So we sit
  // silent for a stretch, then do a single probe — and if still awake,
  // sit silent again. No app-level traffic between probes.
  const deadline = Date.now() + maxMs
  const SILENT_INTERVAL_MS = 60_000
  while (Date.now() < deadline) {
    const remaining = Math.round((deadline - Date.now()) / 1000)
    const wait = Math.min(SILENT_INTERVAL_MS, deadline - Date.now())
    if (wait <= 0) break
    console.log(
      `[${isoNow()}] sitting silent for ${Math.round(wait / 1000)}s (${remaining}s deadline)…`,
    )
    await new Promise((r) => setTimeout(r, wait))
    let sleeping = false
    try {
      sleeping = await api.isSleeping(0)
    } catch (err) {
      console.log(
        `[${isoNow()}] isSleeping threw: ${err instanceof Error ? err.message : String(err)} — treating as awake`,
      )
    }
    console.log(`[${isoNow()}] probe: sleeping=${sleeping}`)
    if (sleeping) {
      console.log(`[${isoNow()}] ✅ sleep detected — entering test phase immediately`)
      return true
    }
  }
  console.log(`[${isoNow()}] ⏱  sleep wait timed out`)
  return false
}

async function main(): Promise<void> {
  console.log(`[${isoNow()}] connecting to ${HOST} (uid=${UID ? 'set' : 'absent'})…`)
  const api = new ReolinkBaichuanApi({
    host: HOST!,
    port: 9000,
    username: USERNAME!,
    password: PASSWORD!,
    transport: 'udp',
    ...(UID ? { uid: UID } : {}),
  })

  const t0 = Date.now()
  await api.login()
  console.log(`[${isoNow()}] login ok in ${Date.now() - t0}ms`)

  // Force idle disconnect — the addon does this for battery cams. Lets
  // the camera return to sleep between attempts so we can probe the
  // wake-up path repeatedly.
  api.setIdleDisconnect(true)

  // Best-effort sleep wait (60s window). The running addon keeps its
  // own session warm so the camera typically stays awake throughout —
  // the variants below still produce useful data on the lib's behaviour
  // from awake state. Sleep-state validation is done via the UI flow
  // after the hub restart.
  const waitMs = Number(process.env['SLEEP_WAIT_MS'] ?? 60_000)
  const slept = waitMs > 0 ? await waitForSleep(api, waitMs) : false
  if (!slept) {
    console.log(
      `[${isoNow()}] ⚠  camera never reported sleeping — running attempts from awake state`,
    )
  }

  for (const attempt of attempts) {
    const isSleepingNow = await api.isSleeping(0).catch(() => false)
    console.log(`\n[${isoNow()}] ── ${attempt.label} (sleeping=${isSleepingNow}) ──`)
    const start = Date.now()
    try {
      const buf = await attempt.fn(api)
      const elapsed = Date.now() - start
      console.log(`[${isoNow()}] ✅ got ${formatBytes(buf.length)} in ${elapsed}ms`)
    } catch (err) {
      const elapsed = Date.now() - start
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[${isoNow()}] ❌ failed after ${elapsed}ms — ${msg}`)
      if (err instanceof Error && err.stack) {
        console.log(err.stack.split('\n').slice(0, 4).join('\n'))
      }
    }
    // Short cooldown so each attempt sees a similar pre-state.
    await new Promise((r) => setTimeout(r, 3_000))
  }

  console.log(`\n[${isoNow()}] done — closing socket`)
  await api.close({ reason: 'probe done' }).catch(() => undefined)
  process.exit(0)
}

main().catch((err) => {
  console.error('probe failed:', err)
  process.exit(1)
})
