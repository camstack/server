#!/usr/bin/env tsx
/**
 * Live smoke-test for nodelink's `autoDetectDeviceType` — exercises the
 * exact path Slice 15's `testCreationField` and `onCreateDevice` will
 * use. Reads creds from process.env, never persists or logs the
 * password.
 *
 * Targets (matching the local lab setup):
 *   - tcp     → H.264 over TCP   (TCP_*)
 *   - tcp265  → H.265 over TCP   (TCP265_*)
 *   - udp     → battery cam UDP  (UDP_*)
 *   - all     → run all three sequentially
 *
 * Usage:
 *   TCP_HOST=... TCP_USERNAME=... TCP_PASSWORD=... \
 *   TCP265_HOST=... TCP265_USERNAME=... TCP265_PASSWORD=... \
 *   UDP_HOST=... UDP_USERNAME=... UDP_PASSWORD=... UDP_UID=... \
 *     npx tsx scripts/test-autodetect.mts all
 */

import { autoDetectDeviceType, type AutoDetectResult } from '@apocaliss92/nodelink-js'
import { loadEnv } from './lib/load-env.mjs'

loadEnv('.env.reolink')

interface Target {
  readonly label: string
  readonly host: string
  readonly username: string
  readonly password: string
  readonly uid?: string
  readonly mode: 'auto' | 'tcp' | 'udp'
}

function readTarget(label: 'tcp' | 'tcp265' | 'udp'): Target | null {
  const prefix = label === 'tcp' ? 'TCP_' : label === 'tcp265' ? 'TCP265_' : 'UDP_'
  const host = process.env[`${prefix}HOST`]
  const username = process.env[`${prefix}USERNAME`]
  const password = process.env[`${prefix}PASSWORD`]
  const uid = process.env[`${prefix}UID`]
  if (!host || !username || !password) return null
  return {
    label,
    host,
    username,
    password,
    ...(uid ? { uid } : {}),
    mode: label === 'udp' ? 'udp' : 'auto',
  }
}

function summarise(label: string, r: AutoDetectResult): void {
  const lines = [
    `[${label}] ✅ detected`,
    `        type            : ${r.type}`,
    `        transport       : ${r.transport}`,
    `        model           : ${r.deviceInfo?.type ?? '(none)'}`,
    `        firmware        : ${r.deviceInfo?.firmwareVersion ?? '(none)'}`,
    `        channelNum      : ${r.channelNum ?? 1}`,
    `        hasBattery      : ${r.hasBattery === true}`,
    `        uid             : ${r.uid ? `${r.uid.slice(0, 4)}…${r.uid.slice(-4)}` : '(none)'}`,
    `        udp method      : ${r.udpDiscoveryMethod ?? '(n/a)'}`,
    `        host network ip : ${r.hostNetworkInfo?.ip ?? '(none)'}`,
  ]
  console.log(lines.join('\n'))
}

async function runOne(target: Target): Promise<boolean> {
  console.log(
    `\n[${target.label}] connecting (${target.host} / mode=${target.mode}${target.uid ? ' / uid set' : ''})`,
  )
  try {
    const result = await autoDetectDeviceType({
      host: target.host,
      username: target.username,
      password: target.password,
      ...(target.uid ? { uid: target.uid } : {}),
      mode: target.mode,
    })
    summarise(target.label, result)
    try {
      await result.api.close({ reason: 'smoke-test-done' })
    } catch {
      /* ignore */
    }
    return true
  } catch (err) {
    console.error(`[${target.label}] ❌ ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

const which = process.argv[2] ?? 'all'
const labels: Array<'tcp' | 'tcp265' | 'udp'> =
  which === 'all'
    ? ['tcp', 'tcp265', 'udp']
    : which === 'tcp' || which === 'tcp265' || which === 'udp'
      ? [which]
      : []

if (labels.length === 0) {
  console.error(`Unknown target '${which}'. Use one of: tcp, tcp265, udp, all.`)
  process.exit(2)
}

let okCount = 0
let skipCount = 0
for (const label of labels) {
  const target = readTarget(label)
  if (!target) {
    console.log(`[${label}] ⏭  skipped (env vars not set)`)
    skipCount++
    continue
  }
  if (await runOne(target)) okCount++
}

console.log(
  `\nDone: ${okCount} ok, ${labels.length - okCount - skipCount} failed, ${skipCount} skipped`,
)
process.exit(okCount === 0 && skipCount < labels.length ? 1 : 0)
