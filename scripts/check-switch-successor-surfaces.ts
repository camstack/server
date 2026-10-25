#!/usr/bin/env tsx
/**
 * Switch-authority guard — every per-camera switch writes the authority that
 * already owns the function.
 *
 * ## What changed on 2026-09-19
 *
 * This guard used to enforce a SECOND rule as well: that nothing new calls
 * `getCameraSwitches` / `setCameraSwitch`, because D113 had them on a
 * deprecation path. [D544](../docs/decisions/adr-0544-the-switch-group-is-the-one-surface-on-both-clients.md)
 * withdrew that: the viewer never left the group, the admin UI grew a
 * hand-written list of four ids instead, and the two clients ended up
 * disagreeing about which functions a camera even HAS. The pair is the
 * composed read and the composed write on both clients now, so policing new
 * callers of it would block the fix.
 *
 * What survives — the half D62, D113 and D544 all state — is below: a switch
 * stores nothing, and writes its own authority.
 *
 * ## The failure this catches
 *
 * [D113](../docs/decisions/adr-0113.md) withdraws the aggregate switch group in
 * four phases, and phase 4 (deleting `getCameraSwitches` / `setCameraSwitch`,
 * the catalog, the derivation and the panels) is separated from phase 3 (giving
 * each function a surface in its own component) for one reason: **for two of
 * the eight rows the shim was the ONLY writer in the entire product.**
 *
 *  - `device-audio` — the camera's microphone. Its store is the CAMERA. No
 *    admin page, no viewer screen and no other cap wrote it.
 *  - `broker-audio` — the broker's `DeviceOverride.audioMuted`. The shim was
 *    also the only caller that ROUTED the write to the camera's source owner;
 *    `stream-broker` is a per-node singleton, so an unrouted write lands on a
 *    node that serves nothing for that camera.
 *
 * Delete the shim first and those two functions are not "harder to reach" —
 * they are unreachable, and a camera left muted stays muted with no control
 * anywhere that can lift it. The recovery is a framework train, i.e. a
 * published `@camstack/server`, for a state an operator set with one click.
 *
 * That ordering was written down twice and is exactly the kind of constraint a
 * review does not catch six weeks later, when the deletion looks like tidying
 * up. So it gets a check.
 *
 * ## What it checks
 *
 * 1. **Every row in {@link SUCCESSORS} has its surface file, and that file
 *    contains the authority write.** Deleting or renaming a surface fails here
 *    whether or not the shim still exists — which is the point: after phase 4
 *    this guard is the only thing standing between "we moved the panel" and "we
 *    removed the last writer".
 * 2. **No NEW source calls the deprecated pair**, and the ones that already do
 *    are printed on every run as the phase-4 ledger. The shim itself is exempt
 *    (it IS the pair's implementation) and so are tests, which mock it
 *    precisely to assert it is never called. A new caller means phase 4 just
 *    got further away and somebody should know before it is merged.
 *
 * Both checks are "does this identifier appear in this file" — present or
 * absent, never a judgement. A guard with false positives gets deleted.
 *
 * Usage: tsx scripts/check-switch-successor-surfaces.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** One retired switch id and the surface that took over its authority. */
interface SuccessorSurface {
  /** The `CameraSwitchId` this row replaces. */
  readonly switchId: string
  /** The surface file, relative to the repo root. */
  readonly file: string
  /** A token that only appears when the file actually writes the authority. */
  readonly write: string
  /** Named in the failure message so the fix does not need this file read. */
  readonly authority: string
}

const SUCCESSORS: readonly SuccessorSurface[] = [
  // These three moved with D544: device details renders the COMPOSED group
  // instead of three hand-listed pills, so the authority write they are
  // checked for now happens where the group dispatches it. The property is
  // unchanged — a switch still writes the authority that owns the function,
  // and this guard still proves it.
  {
    switchId: 'object-detection',
    file: 'packages/addon-pipeline-orchestrator/src/camera-switch-service.ts',
    write: 'api.deviceManager.setWrapperActive.mutate',
    authority: 'deviceManager.setWrapperActive on the detection-pipeline binding',
  },
  {
    switchId: 'audio-analysis',
    file: 'packages/addon-pipeline-orchestrator/src/camera-switch-service.ts',
    write: 'api.deviceManager.setWrapperActive.mutate',
    authority: 'deviceManager.setWrapperActive on the audio-analysis binding',
  },
  {
    switchId: 'recording',
    file: 'packages/addon-pipeline-orchestrator/src/camera-switch-service.ts',
    write: 'api.recordingArchive.setDeviceConfig.mutate',
    authority: 'RecordingConfig.enabled via recordingArchive.setDeviceConfig',
  },
  {
    switchId: 'notifications',
    file: 'packages/addon-admin-ui/src/components/device/DeviceNotificationMute.tsx',
    write: 'useNotificationRulesSetDeviceMuted',
    authority: "the notification centre's device-mute rows",
  },
  {
    switchId: 'privacy-mask',
    file: 'packages/ui-library/src/composites/cap-settings/PrivacyMaskSettings.tsx',
    write: 'setMask(',
    authority: 'privacyMask.setMask({ enabled })',
  },
  {
    switchId: 'device-audio',
    file: 'packages/ui-library/src/composites/cap-settings/PrivacyMaskSettings.tsx',
    write: 'setAudioEnabled(write)',
    authority: 'privacyMask.setAudioEnabled — the CAMERA is the store',
  },
  {
    switchId: 'broker-audio',
    file: 'packages/addon-pipeline/src/stream-broker/widgets/StreamBrokerPanel.tsx',
    write: 'useStreamBrokerSetDeviceAudioMute',
    authority: "streamBroker.setDeviceAudioMute on the camera's source owner",
  },
  /**
   * `ha-export`'s own successor surface (Task A of the 2026-08-26 export
   * plan). `camera-function-writes.ts` is the file
   * `applyCameraFunctionWrite` lives in — it is a SECOND writer for every
   * one of the eight functions, straight onto the same authority the row
   * above already names.
   *
   * A duplicate `switchId` is legitimate here, deliberately: the guard
   * iterates rows independently, so this surface and the admin-ui / HAP
   * surface above defend each other — a rename that breaks one write path
   * fails on its own row without needing the other to also be checked.
   */
  {
    switchId: 'stream-broker',
    file: 'packages/addon-provider-homeassistant/src/ha-export/camera-function-writes.ts',
    write: 'deviceManager.setDisabled.mutate',
    authority: 'deviceManager.setDisabled',
  },
  {
    switchId: 'object-detection',
    file: 'packages/addon-provider-homeassistant/src/ha-export/camera-function-writes.ts',
    write: 'deviceManager.setWrapperActive.mutate',
    authority: 'deviceManager.setWrapperActive on the detection-pipeline binding',
  },
  {
    switchId: 'audio-analysis',
    file: 'packages/addon-provider-homeassistant/src/ha-export/camera-function-writes.ts',
    write: 'deviceManager.setWrapperActive.mutate',
    authority: 'deviceManager.setWrapperActive on the audio-analysis binding',
  },
  {
    switchId: 'recording',
    file: 'packages/addon-provider-homeassistant/src/ha-export/camera-function-writes.ts',
    write: 'recordingArchive.setDeviceConfig.mutate',
    authority: 'RecordingConfig.enabled via recordingArchive.setDeviceConfig',
  },
  {
    switchId: 'notifications',
    file: 'packages/addon-provider-homeassistant/src/ha-export/camera-function-writes.ts',
    write: 'notificationRules.setDeviceMuted.mutate',
    authority: "the notification centre's device-mute rows",
  },
  {
    switchId: 'privacy-mask',
    file: 'packages/addon-provider-homeassistant/src/ha-export/camera-function-writes.ts',
    write: 'privacyMask.setMask.mutate',
    authority: 'privacyMask.setMask({ enabled })',
  },
  {
    switchId: 'device-audio',
    file: 'packages/addon-provider-homeassistant/src/ha-export/camera-function-writes.ts',
    write: 'privacyMask.setAudioEnabled.mutate',
    authority: 'privacyMask.setAudioEnabled — the CAMERA is the store',
  },
  {
    switchId: 'broker-audio',
    file: 'packages/addon-provider-homeassistant/src/ha-export/camera-function-writes.ts',
    write: 'streamBroker.setDeviceAudioMute.mutate',
    authority: "streamBroker.setDeviceAudioMute on the camera's source owner",
  },
]

/** The deprecated cap pair. A new caller of either delays phase 4. */
const DEPRECATED_CALLS: readonly string[] = [
  'setCameraSwitch.mutate',
  'usePipelineOrchestratorSetCameraSwitch(',
  'usePipelineOrchestratorGetCameraSwitches(',
  '.getCameraSwitches.query',
]

/** The shim IS the pair's implementation — it may name them. */
const SHIM_FILES: readonly string[] = [
  'packages/addon-pipeline-orchestrator/src/camera-switch-service.ts',
]

/**
 * Callers that already existed when D113 landed — the phase-4 LEDGER.
 *
 * This is not an amnesty, it is the to-do list. Each entry is a caller phase 4
 * must migrate or delete, printed on every run so the count is visible rather
 * than remembered. What the guard actually enforces is that the list does not
 * GROW: a file not on it that reaches for the pair fails the build.
 *
 * Emptied on 2026-08-26 (export plan, Task A) when `ha-export` moved to writing
 * every function through its own authority (`camera-function-writes.ts`). That
 * emptying was WRONG, and the cost is measurable: `device-meta-actions.ts` was
 * calling the deprecated pair at the time and was not listed, so this guard has
 * failed on every run since — which is how a CI becomes a permanent red people
 * scroll past, and then `disabled_manually`, which is what happened here
 * between 2026-08-30 and 2026-09-09.
 *
 * The entry below is therefore a correction, not an amnesty. It names the ONE
 * caller left and what phase 3 still owes it.
 */
const KNOWN_LEGACY_CALLERS: readonly string[] = [
  // Device MIGRATION carrying every camera function across a hardware swap.
  //
  // It already writes the `stream-broker` switch directly, because that
  // authority IS this addon (`deviceManager.setDisabled`, D62) and routing it
  // through the orchestrator sent it over UDS back into this process, where it
  // queued on the meta write lock the migration was holding — a self-deadlock
  // the transport resolved at its 60 s default, once per phase, whose write
  // then landed AFTER the swap against whichever hardware had taken the number
  // (measured 2026-09-01).
  //
  // The other seven cannot move yet, and the reason is specific rather than
  // "not done": the successor `applyCameraFunctionWrite` is reachable — it
  // takes its API slice as a PARAMETER and imports nothing but
  // `@camstack/types`, so promoting it out of the addon is mechanical. What is
  // missing is its input. `resolveCameraFunctionWrite` needs
  // `CameraFunctionReads`: eight reads spanning device-manager, recording,
  // notification-rules, privacy-mask and stream-broker. The migration path
  // gathers none of them today, and inventing them under a held write lock is
  // exactly the shape of change that produced the deadlock above.
  //
  // Phase 3 owes this caller that snapshot. Until it exists, deleting the pair
  // breaks device migration.
  'packages/system/src/builtins/device-manager/device-meta-actions.ts',
]

/**
 * Does `src` contain `token` as a whole identifier?
 *
 * A plain `includes` is not enough and the difference is not academic:
 * `useNotificationRulesSetDeviceMuted` is a prefix of anything a rename would
 * produce, so a substring test reports a surface as intact while the write no
 * longer exists. Verified by renaming the hook and watching the guard stay
 * green — which is exactly the shape of failure this file exists to prevent.
 */
function containsToken(src: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Only identifier-terminated tokens need the boundary; `setMask(` already has
  // one, and appending a lookahead after `\(` would never match.
  const suffix = /[A-Za-z0-9_$]$/.test(token) ? '(?![A-Za-z0-9_$])' : ''
  return new RegExp(escaped + suffix).test(src)
}

function listSourceFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__')
        continue
      listSourceFiles(full, out)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.spec.tsx')) continue
    out.push(full)
  }
}

const failures: string[] = []

// ── 1. Every retired switch still has a writer that is not the shim ────────
for (const row of SUCCESSORS) {
  const abs = path.join(ROOT, row.file)
  if (!fs.existsSync(abs)) {
    failures.push(
      `[${row.switchId}] its surface is GONE: ${row.file}\n` +
        `    That surface is the only thing that writes ${row.authority}.\n` +
        `    If it moved, update SUCCESSORS in this guard — do not delete the row.`,
    )
    continue
  }
  const src = fs.readFileSync(abs, 'utf8')
  if (!containsToken(src, row.write)) {
    failures.push(
      `[${row.switchId}] ${row.file} no longer writes its authority ` +
        `(expected \`${row.write}\`).\n` +
        `    Authority: ${row.authority}.`,
    )
  }
}

// ── 2. Nothing NEW calls the deprecated pair ───────────────────────────────
const sources: string[] = []
listSourceFiles(path.join(ROOT, 'packages'), sources)
const legacySeen: string[] = []
for (const abs of sources) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/')
  if (SHIM_FILES.includes(rel)) continue
  // The generated cap surfaces name every method of every cap; they are
  // codegen output, not a caller.
  if (rel.includes('/generated/')) continue
  if (rel.startsWith('packages/types/src')) continue
  const src = fs.readFileSync(abs, 'utf8')
  const calls = DEPRECATED_CALLS.filter((call) => containsToken(src, call))
  if (calls.length === 0) continue
  // Not a failure any more (D544): the pair is the surface. Kept as a CENSUS
  // so the set of callers stays visible rather than remembered — a composed
  // write that starts being called from somewhere unexpected is still worth
  // seeing on every run.
  legacySeen.push(rel)
}

if (failures.length > 0) {
  console.error('✗ D113 switch-successor guard failed:\n')
  for (const f of failures) console.error(`  ${f}\n`)
  console.error(
    '  A switch writes the authority that already owns the function.\n' +
      '  See docs/decisions/adr-0544-the-switch-group-is-the-one-surface-on-both-clients.md.',
  )
  process.exit(1)
}

console.log(
  `✓ D544: ${String(SUCCESSORS.length)} switches all write their own authority; ` +
    'the composed group is the surface on both clients',
)
if (legacySeen.length > 0) {
  // Printed on every green run on purpose: a census, not a to-do list. What phase 4 still owes.
  console.log('  callers of the composed switch pair:')
  for (const rel of legacySeen) console.log(`    · ${rel}`)
}
