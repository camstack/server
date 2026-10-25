#!/usr/bin/env tsx
/**
 * Capability activation has ONE authority: the addon manifest's `autoActivate`.
 *
 * ## The failure this catches
 *
 * The kernel used to carry a second one. `{dataPath}/runtime-state.json` held
 * two maps — `systemActivation` and `deviceActivation`, both keyed
 * `{capability}/{addonId}` → boolean — and `CapabilityRegistry` consulted them
 * on the live resolution path: `resolveForDevice` and
 * `resolveCollectionForDevice` filtered every provider through them. A single
 * `false` under a deviceId made a registered provider vanish for that one
 * camera, and nothing logged it.
 *
 * It was never wired to anything. `setDeviceActivation` existed from the first
 * commit and never gained a caller, so the file was never written and did not
 * exist on either node of the reference cluster. What it WAS, was a generic
 * per-device switch sitting above every function in the system — which is
 * precisely what D62 forbids: a per-camera switch stores nothing, it reads and
 * writes the authority that already owns the function (`setDisabled`,
 * `setWrapperActive`, `RecordingConfig.enabled`, the notification mute). A
 * second switch that disagrees with the first is worse than no switch, and this
 * repo has already shipped two knobs that wrote a store nobody read.
 *
 * It was also invisible to every census: `docs/reference/storage.md` derives
 * from SQLite `@durable` annotations, and this was a JSON file outside them.
 * Removed in D334.
 *
 * ## What it checks
 *
 * 1. No source file names `runtime-state.json`.
 * 2. No source file declares or calls one of {@link REMOVED_NAMES} — the
 *    accessors that made the maps reachable.
 * 3. `CapabilityRegistry` does not hold a `ConfigManager`. That wiring existed
 *    for exactly this state; re-adding it is how a persisted authority would
 *    get back onto the resolution path.
 *
 * Every check is a literal or an import — present or absent, never a judgement
 * call. This cannot see a hand-rolled activation map that never names itself;
 * nothing conservative can. What it guarantees is that the removed surface
 * cannot come back by accident, and that the door it came through stays shut.
 *
 * Usage: tsx scripts/check-capability-activation-single-authority.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The file that used to hold the second authority. */
const REMOVED_FILE = 'runtime-state.json'

/**
 * The accessors that reached it, on both the registry and the config manager.
 *
 * `DeviceRuntimeState` — the per-cap runtime-state slices backed by the SQLite
 * `device-runtime-state` collection — is a DIFFERENT and legitimate mechanism
 * and shares no name with anything here. That is why these are exact
 * identifiers and not a `runtime.?state` pattern: the loose version would fire
 * on 26 correct references in `config-manager.ts` alone.
 */
const REMOVED_NAMES: readonly string[] = [
  'systemActivation',
  'deviceActivation',
  'isActiveForDevice',
  'setSystemActivation',
  'setDeviceActivation',
  'getSystemActivation',
  'getDeviceActivation',
  'getAllDeviceActivation',
  'clearDeviceActivation',
  'getDeviceActivations',
]

/** The registry file, and the wiring that must not return to it. */
const REGISTRY_FILE = 'packages/system/src/kernel/capability-registry.ts'

/** This guard names every removed identifier; it must not fail on itself. */
const SELF = 'scripts/check-capability-activation-single-authority.ts'

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      sourceFiles(full, out)
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
}

function allSources(): readonly string[] {
  const files: string[] = []
  for (const root of ['packages', 'server', 'scripts']) {
    sourceFiles(path.join(ROOT, root), files)
  }
  return files.filter((f) => !f.includes(`${path.sep}generated${path.sep}`))
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

function checkRemovedSurface(files: readonly string[], problems: Problem[]): void {
  for (const file of files) {
    const relative = rel(file)
    if (relative === SELF) continue
    const source = fs.readFileSync(file, 'utf-8')

    if (source.includes(REMOVED_FILE)) {
      problems.push({
        where: relative,
        what: `names \`${REMOVED_FILE}\` — the kernel activation file removed in D334`,
        fix: 'a per-camera switch reads and writes the authority that already owns the function (D62). If you need a new durable kernel fact, give it its own file and its own name — do not revive this one.',
      })
    }

    for (const name of REMOVED_NAMES) {
      if (!new RegExp(`\\b${name}\\b`).test(source)) continue
      problems.push({
        where: relative,
        what: `references \`${name}\` — part of the removed activation-override surface`,
        fix: 'capability activation resolves from the manifest `autoActivate` flag and nothing else. To turn a function off for one camera, write the authority that owns it and name it in `CameraSwitch.authority` (D62).',
      })
    }
  }
}

function checkRegistryHasNoConfigManager(problems: Problem[]): void {
  const full = path.join(ROOT, REGISTRY_FILE)
  if (!fs.existsSync(full)) {
    problems.push({
      where: REGISTRY_FILE,
      what: 'the capability registry is not where this guard expects it',
      fix: 'update REGISTRY_FILE in this guard, or retire the guard deliberately rather than by moving the file',
    })
    return
  }
  const source = fs.readFileSync(full, 'utf-8')
  if (!/\bConfigManager\b/.test(source)) return
  problems.push({
    where: REGISTRY_FILE,
    what: 'holds a `ConfigManager` again',
    fix: 'that wiring existed only to read persisted activation overrides. The registry resolves providers from what addons registered plus the manifest `autoActivate`; a durable store on this path is a second authority over every capability at once.',
  })
}

function main(): void {
  const files = allSources()
  if (files.length === 0) {
    console.error('\x1b[31m✘ no source files found — check the repo layout\x1b[0m')
    process.exit(1)
  }

  const problems: Problem[] = []
  checkRemovedSurface(files, problems)
  checkRegistryHasNoConfigManager(problems)

  if (problems.length > 0) {
    console.error(
      `\x1b[31m✘ ${problems.length} capability-activation authority violation(s)\x1b[0m:`,
    )
    for (const p of problems) {
      console.error(`    ${p.where}: ${p.what}`)
      console.error(`      → ${p.fix}`)
    }
    console.error(
      '    Why this matters: a generic per-device activation map is a second switch over a function some addon already owns (D62), and it is invisible to the storage census.',
    )
    process.exit(1)
  }
  console.log('  ✔ capability activation has one authority (the manifest autoActivate)')
}

main()
