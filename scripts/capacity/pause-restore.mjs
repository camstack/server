#!/usr/bin/env node
/**
 * pause-restore.mjs — pause / restore the detection pipeline for the capacity test.
 *
 * Design: (planning repo: superpowers/specs/2026-08-02-capacity-test-design.md) (§3, §5).
 *
 * SAFE BY DEFAULT: every command is a DRY RUN unless `--apply` is passed.
 * Nothing here touches the server without it.
 *
 * What "pause" means: per camera, `detectionMode: 'disabled'` written through
 * `pipelineOrchestrator.applyDeviceSettingsPatch` (the cap path — the ONLY
 * store the forked orchestrator reads). The runner then registers the camera
 * in phase 'idle': no stream subscribe, no inference. Motion detection,
 * recording and audio keep running. Detections/notifications STOP — the
 * fleet is blind for the pause window.
 *
 * Why the ceremony: the settings write is durable but the restart rides a
 * DROPPABLE event (D8). A dropped restore event = a camera whose config says
 * live while its runner stays idle — blind, silently. So:
 *   1. the restore manifest is written to disk BEFORE the first patch;
 *   2. every patch is verified for CONVERGENCE (runner-reported phase), and
 *      re-applied until converged or loudly failed;
 *   3. restore is idempotent and re-runnable from the manifest alone;
 *   4. `pause` refuses to run while an unfinished manifest exists;
 *   5. a hard wall-clock bound (--max-minutes, default 45) is stamped into
 *      the manifest so ANY later invocation of `verify` past the deadline
 *      demands a restore.
 *
 * Usage:
 *   node scripts/capacity/pause-restore.mjs pause   --scope fleet            [--apply]
 *   node scripts/capacity/pause-restore.mjs pause   --scope node:<nodeId>    [--apply]
 *   node scripts/capacity/pause-restore.mjs restore                          [--apply]
 *   node scripts/capacity/pause-restore.mjs verify
 *
 * Options:
 *   --server <url>       hub base URL   (default https://camstack.<local-user>.top)
 *   --token-file <path>  explicit token override (default: the `camstack login` session)
 *   --manifest <path>    manifest file  (default scripts/capacity/.pause-manifest.json)
 *   --max-minutes <n>    hard pause bound stamped into the manifest (default 45)
 *   --apply              actually mutate; otherwise print what WOULD happen
 */
import { resolveHubAuth } from '../hub/credentials.mjs'
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const command = argv[0]
function opt(name, dflt) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const APPLY = argv.includes('--apply')
const TOKEN_FILE = opt('token-file', undefined)
const MANIFEST = opt('manifest', join(HERE, '.pause-manifest.json'))
const MAX_MINUTES = Number(opt('max-minutes', '45'))
const SCOPE = opt('scope', '')

const VERIFY_TIMEOUT_MS = 60_000 // per-camera convergence wait
const VERIFY_POLL_MS = 3_000
const REAPPLY_AFTER_POLLS = 5 // re-send the patch if not converged by then (dropped event)

if (!['pause', 'restore', 'verify'].includes(command ?? '')) {
  console.error(
    'usage: pause-restore.mjs <pause|restore|verify> [--scope fleet|node:<id>] [--apply] [--server url] [--token-file path]',
  )
  process.exit(2)
}

// ── tRPC plumbing (mirrors scripts/hub/hub.mjs conventions) ──────────────────
// The `camstack login` session through the shared resolver (renewed when it is about to expire).
const { server: SERVER, token } = await resolveHubAuth({
  server: opt('server', undefined),
  ...(TOKEN_FILE ? { tokenFile: TOKEN_FILE } : {}),
})
async function trpc(method, path, input) {
  const url =
    method === 'GET'
      ? `${SERVER}/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
      : `${SERVER}/trpc/${path}`
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify({ json: input }) : undefined,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.error) {
    const msg = body?.error?.json?.message ?? body?.error?.message ?? `HTTP ${res.status}`
    throw new Error(`${method} ${path}: ${msg}`)
  }
  return body?.result?.data?.json
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── camera inventory ────────────────────────────────────────────────────────
/**
 * All cameras with their current assignment + detection state, from the
 * orchestrator's own status surface (assignment is authoritative there).
 */
async function fetchCameraStatuses() {
  const statuses = await trpc('GET', 'pipelineOrchestrator.getCameraStatuses', {})
  if (!Array.isArray(statuses)) throw new Error('getCameraStatuses: unexpected shape')
  return statuses
}

/** Current hydrated detectionMode + whether the raw key was explicitly set. */
async function fetchDetectionMode(deviceId) {
  const contrib = await trpc('GET', 'pipelineOrchestrator.getDeviceSettingsContribution', {
    deviceId,
  })
  // Walk the hydrated sections for the detectionMode field value.
  for (const section of contrib?.sections ?? []) {
    for (const field of section.fields ?? []) {
      if (field?.key === 'detectionMode') {
        return { mode: field.value ?? null, raw: field }
      }
    }
  }
  return { mode: null, raw: null }
}

/** Runner-reported phase for one device (the CONVERGENCE truth, not the store). */
async function fetchRunnerPhase(deviceId, nodeId) {
  try {
    const metrics = await trpc('GET', 'pipelineRunner.getCameraMetrics', {
      deviceId,
      ...(nodeId ? { nodeId } : {}),
    })
    return metrics?.phase ?? null
  } catch {
    return null // node unreachable or camera not attached there
  }
}

/** Detection placement node for a camera (CameraAssignmentStatusSchema). */
function detectionNodeOf(status) {
  return status.assignment?.detectionNodeId ?? null
}

function scopeFilter(statuses) {
  if (SCOPE === 'fleet') return statuses
  if (SCOPE.startsWith('node:')) {
    const nodeId = SCOPE.slice('node:'.length)
    return statuses.filter((s) => detectionNodeOf(s) === nodeId)
  }
  throw new Error(`--scope must be 'fleet' or 'node:<nodeId>' (got '${SCOPE || '<missing>'}')`)
}

// ── convergence ─────────────────────────────────────────────────────────────
/**
 * Wait until the runner reports the expected phase for a device, re-applying
 * the patch on the way (a dropped OrchestrationSettingsUpdated event means the
 * store is right but the runner never restarted — re-writing re-emits it).
 */
async function converge(deviceId, nodeId, wantIdle, patch) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS
  let polls = 0
  while (Date.now() < deadline) {
    const phase = await fetchRunnerPhase(deviceId, nodeId)
    const idle = phase === 'idle' || phase === null // detached entirely also counts as quiet
    if (wantIdle ? idle : !idle) return { ok: true, phase }
    polls += 1
    if (polls === REAPPLY_AFTER_POLLS) {
      console.log(
        `  device ${deviceId}: not converged after ${polls} polls — re-applying patch (droppable-event guard)`,
      )
      await trpc('POST', 'pipelineOrchestrator.applyDeviceSettingsPatch', { deviceId, patch })
    }
    await sleep(VERIFY_POLL_MS)
  }
  const phase = await fetchRunnerPhase(deviceId, nodeId)
  return { ok: false, phase }
}

// ── commands ────────────────────────────────────────────────────────────────
async function cmdPause() {
  if (existsSync(MANIFEST)) {
    console.error(
      `REFUSING to pause: unfinished manifest exists at ${MANIFEST}.\n` +
        `A previous pause was never restored. Run 'restore --apply' first (or move the file if you are CERTAIN it is stale).`,
    )
    process.exit(1)
  }
  const statuses = scopeFilter(await fetchCameraStatuses())
  if (statuses.length === 0) {
    console.error('No cameras matched the scope — nothing to pause.')
    process.exit(1)
  }

  console.log(`${APPLY ? '' : '[DRY RUN] '}Pausing ${statuses.length} camera(s), scope=${SCOPE}`)
  const entries = []
  for (const s of statuses) {
    const { mode } = await fetchDetectionMode(s.deviceId)
    entries.push({
      deviceId: s.deviceId,
      nodeId: detectionNodeOf(s),
      previousMode: mode, // hydrated value; restored explicitly (see design §3.3)
      alreadyDisabled: mode === 'disabled',
    })
    console.log(
      `  device ${s.deviceId}: detectionMode '${mode}' -> 'disabled'${mode === 'disabled' ? ' (already disabled — will be left untouched on restore)' : ''}`,
    )
  }

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to execute.')
    return
  }

  // 1. Manifest FIRST — restore must be possible even if we crash mid-loop.
  mkdirSync(dirname(MANIFEST), { recursive: true })
  const manifest = {
    createdAt: new Date().toISOString(),
    scope: SCOPE,
    server: SERVER,
    hardDeadline: new Date(Date.now() + MAX_MINUTES * 60_000).toISOString(),
    entries,
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2))
  console.log(`Manifest written: ${MANIFEST} (hard deadline ${manifest.hardDeadline})`)

  // 2. Patch + verify each camera.
  const failures = []
  for (const e of entries) {
    if (e.alreadyDisabled) continue
    const patch = { detectionMode: 'disabled' }
    await trpc('POST', 'pipelineOrchestrator.applyDeviceSettingsPatch', {
      deviceId: e.deviceId,
      patch,
    })
    const v = await converge(e.deviceId, e.nodeId, true, patch)
    console.log(
      `  device ${e.deviceId}: ${v.ok ? `converged (phase=${v.phase ?? 'detached'})` : `NOT CONVERGED (phase=${v.phase})`}`,
    )
    if (!v.ok) failures.push(e.deviceId)
  }

  if (failures.length > 0) {
    console.error(
      `\nPAUSE INCOMPLETE — devices not converged: ${failures.join(', ')}.\n` +
        `Do NOT start the capacity run. Either retry 'pause --apply' (idempotent) or 'restore --apply' and investigate.`,
    )
    process.exit(1)
  }
  console.log(`\nPause complete and VERIFIED. Restore no later than ${manifest.hardDeadline}.`)
  console.log(`Restore with: node scripts/capacity/pause-restore.mjs restore --apply`)
}

async function cmdRestore() {
  if (!existsSync(MANIFEST)) {
    console.error(`No manifest at ${MANIFEST} — nothing to restore (or it was already completed).`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const targets = manifest.entries.filter((e) => !e.alreadyDisabled)
  console.log(
    `${APPLY ? '' : '[DRY RUN] '}Restoring ${targets.length} camera(s) from manifest of ${manifest.createdAt}`,
  )
  for (const e of targets) {
    console.log(`  device ${e.deviceId}: detectionMode 'disabled' -> '${e.previousMode}'`)
  }
  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to execute.')
    return
  }

  const failures = []
  for (const e of targets) {
    if (!e.previousMode || e.previousMode === 'disabled') continue
    const patch = { detectionMode: e.previousMode }
    await trpc('POST', 'pipelineOrchestrator.applyDeviceSettingsPatch', {
      deviceId: e.deviceId,
      patch,
    })
    const v = await converge(e.deviceId, e.nodeId, false, patch)
    console.log(
      `  device ${e.deviceId}: ${v.ok ? `LIVE (phase=${v.phase})` : `STILL IDLE — BLIND (phase=${v.phase})`}`,
    )
    if (!v.ok) failures.push(e.deviceId)
  }

  if (failures.length > 0) {
    console.error(
      `\nRESTORE INCOMPLETE — devices still idle (BLIND): ${failures.join(', ')}.\n` +
        `Manifest KEPT at ${MANIFEST}. Re-run 'restore --apply' (idempotent); if it will not converge, ` +
        `restart the orchestrator/runner for those nodes and re-verify. Do not walk away from this state.`,
    )
    process.exit(1)
  }

  // Only after full verification does the manifest go away (archived, not deleted).
  const archived = `${MANIFEST}.${Date.now()}.done`
  renameSync(MANIFEST, archived)
  console.log(`\nRestore complete and VERIFIED. Manifest archived: ${archived}`)
  console.log(
    'Final check: trigger one real motion event and confirm a detection lands end-to-end.',
  )
}

async function cmdVerify() {
  const hasManifest = existsSync(MANIFEST)
  if (hasManifest) {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    const overdue = Date.now() > Date.parse(manifest.hardDeadline)
    console.log(
      `ACTIVE pause manifest (created ${manifest.createdAt}, deadline ${manifest.hardDeadline})${overdue ? ' — OVERDUE, RESTORE NOW' : ''}`,
    )
    for (const e of manifest.entries) {
      const phase = await fetchRunnerPhase(e.deviceId, e.nodeId)
      console.log(
        `  device ${e.deviceId}: phase=${phase ?? 'detached'} (will restore to '${e.previousMode}')`,
      )
    }
    if (overdue) process.exit(1)
    return
  }
  // No manifest: report fleet detection state so a silent half-restore is visible.
  const statuses = await fetchCameraStatuses()
  let idle = 0
  for (const s of statuses) {
    const phase = await fetchRunnerPhase(s.deviceId, detectionNodeOf(s))
    const { mode } = await fetchDetectionMode(s.deviceId)
    const blind = mode !== 'disabled' && (phase === 'idle' || phase === null)
    if (phase === 'idle') idle += 1
    console.log(
      `  device ${s.deviceId}: mode=${mode} phase=${phase ?? 'detached'}${blind ? '  <-- config says live but runner is quiet: INVESTIGATE' : ''}`,
    )
  }
  console.log(`\nNo active manifest. ${statuses.length} cameras, ${idle} idle.`)
}

// ── main ────────────────────────────────────────────────────────────────────
try {
  if (command === 'pause') await cmdPause()
  else if (command === 'restore') await cmdRestore()
  else await cmdVerify()
} catch (err) {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`)
  if (command !== 'verify' && APPLY && existsSync(MANIFEST)) {
    console.error(
      `A manifest exists at ${MANIFEST} — the fleet may be partially paused. Run 'verify', then 'restore --apply'.`,
    )
  }
  process.exit(1)
}
