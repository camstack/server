#!/usr/bin/env tsx
/**
 * Runner-group guard — a DEVICE PROVIDER never shares a runner (D29).
 *
 * ## The failure this catches
 *
 * `resolveRunnerId` collapses every addon that declares the same
 * `execution.group` into ONE addon-runner subprocess. That process is the unit
 * of failure: if any co-located addon cannot be LOADED, the runner exits
 * non-zero before a single addon initialises, and after five such exits in a
 * minute the crash circuit-breaker stops respawning it. Every addon in the
 * group is then down, indefinitely, while each still reports `running`.
 *
 * This is not hypothetical. On 2026-08-09 `@camstack/addon-advanced-notifier`
 * was quarantined by renaming its directory while its manifest entry stayed in
 * `/data/addons/manifest.json`. `@camstack/addon-provider-homeassistant`
 * declared `group: 'notifiers'` — "purely a process-count optimization"
 * (9b895fb5f) — so the loader's `No package.json at …addon-advanced-notifier`
 * killed the Home Assistant provider too:
 *
 *     [notifiers] Failed to load "advanced-notifier": No package.json at …
 *     [notifiers] Process exited (code=1)   ×5
 *     [notifiers] Crash circuit-breaker tripped — 5 crashes in 60000ms.
 *
 * Cost: `broker.list` lost `ha_001` for ~2h50m, `notification-output` lost ALL
 * THREE of its providers (no notification could be delivered at all), and three
 * `restartAddon` calls returned `{success:true}` without ever spawning a
 * process. The session that followed spent hours blaming a capability pin.
 *
 * ## The rule
 *
 * D29: grouping to reclaim runner RAM is confined to non-live, frame-free,
 * low-crash addons (the `ml` group). A device provider owns live device state
 * and adoption; a co-located crash respawns the whole runner and takes that
 * state with it. Same for a data-plane runner.
 *
 * An addon is a DEVICE PROVIDER here if it declares `broker` or
 * `device-adoption`, or carries a `brokerKind` — the three signals a manifest
 * actually gives us. A data-plane runner declares `dataPlanes`.
 *
 * A builtin can also OWN devices with none of those signals: it declares them
 * through `DeclaredDevices` and registers natives on them (`composer`, D659).
 * Such a builtin may declare a group — the spec of D659 names one — but that
 * group is a group of ONE: any other addon joining it is refused here, or a
 * co-located load failure takes every composed device down.
 *
 * Usage: tsx scripts/check-runner-group-isolation.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** Groups exempted by D29 — non-live, frame-free, low-crash addons only. */
const ALLOWED_GROUPS: ReadonlySet<string> = new Set(['ml'])

/** Declaring any of these makes an addon a device provider. */
const PROVIDER_CAPS: ReadonlySet<string> = new Set(['broker', 'device-adoption'])

/**
 * Builtins that own devices without a manifest signal, with the reason. Each
 * one's `execution.group` may have no other member.
 */
const DEVICE_OWNING_BUILTINS: ReadonlyMap<string, string> = new Map([
  ['composer', 'it declares composed devices and serves their capabilities (D659)'],
])

/** One addon that declared an `execution.group`, wherever its package lives. */
interface GroupMember {
  readonly pkg: string
  readonly addonId: string
  readonly group: string
}

interface Problem {
  readonly pkg: string
  readonly addonId: string
  readonly message: string
}

function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function capabilityNames(addon: Record<string, unknown>): readonly string[] {
  const caps = addon['capabilities']
  if (!Array.isArray(caps)) return []
  const names: string[] = []
  for (const raw of caps) {
    const cap = asRecord(raw)
    const name = cap?.['name']
    if (typeof name === 'string') names.push(name)
  }
  return names
}

/**
 * Why this addon may not share a process, or null if it may.
 *
 * Returns the REASON rather than a boolean so the failure message names the
 * signal that classified it — a guard that only says "not allowed" gets an
 * exemption added to it instead of a fix.
 */
function isolationReason(addon: Record<string, unknown>): string | null {
  const caps = capabilityNames(addon)
  const providerCap = caps.find((c) => PROVIDER_CAPS.has(c))
  if (providerCap !== undefined) return `it declares the \`${providerCap}\` capability`
  if (typeof addon['brokerKind'] === 'string') {
    return `it declares \`brokerKind: '${addon['brokerKind']}'\``
  }
  if (Array.isArray(addon['dataPlanes']) && addon['dataPlanes'].length > 0) {
    return 'it serves a data plane'
  }
  return null
}

function checkPackage(pkgDir: string, problems: Problem[], members: GroupMember[]): void {
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return
  const pkg = readJson(pkgJsonPath)
  const camstack = asRecord(pkg['camstack'])
  const addons = camstack?.['addons']
  if (!Array.isArray(addons) || addons.length === 0) return

  const pkgName = typeof pkg['name'] === 'string' ? pkg['name'] : path.basename(pkgDir)

  for (const raw of addons) {
    const addon = asRecord(raw)
    if (!addon) continue
    const execution = asRecord(addon['execution'])
    const group = execution?.['group']
    if (typeof group !== 'string' || group.length === 0) continue
    members.push({
      pkg: pkgName,
      addonId: typeof addon['id'] === 'string' ? addon['id'] : '(unnamed)',
      group,
    })
    if (ALLOWED_GROUPS.has(group)) continue

    const addonId = typeof addon['id'] === 'string' ? addon['id'] : '(unnamed)'
    const reason = isolationReason(addon)
    if (reason === null) continue

    problems.push({
      pkg: pkgName,
      addonId,
      message:
        `declares \`execution.group: '${group}'\` but must run alone — ${reason}. ` +
        `A co-located addon that fails to LOAD exits the shared runner before ` +
        `any addon initialises, and five such exits trip the crash ` +
        `circuit-breaker for every addon in the group (D29). Drop the group, or ` +
        `add it to ALLOWED_GROUPS in this script with the reasoning.`,
    })
  }
}

/**
 * A device-owning builtin's group is a group of ONE. The problem is filed
 * against the JOINER: the owner's group is the spec's, the joiner's is the
 * mistake.
 */
function checkDeviceOwningGroups(members: readonly GroupMember[], problems: Problem[]): void {
  for (const owner of members) {
    const why = DEVICE_OWNING_BUILTINS.get(owner.addonId)
    if (why === undefined) continue
    for (const other of members) {
      if (other === owner || other.group !== owner.group) continue
      problems.push({
        pkg: other.pkg,
        addonId: other.addonId,
        message:
          `declares \`execution.group: '${other.group}'\`, the group of \`${owner.addonId}\`, which must run alone — ${why}. ` +
          `A device-owning builtin's group is a group of ONE (D29): drop the group from this addon.`,
      })
    }
  }
}

function main(): void {
  const problems: Problem[] = []
  const members: GroupMember[] = []
  for (const root of ['packages', 'server']) {
    const rootDir = path.join(ROOT, root)
    if (!fs.existsSync(rootDir)) continue
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (entry.isDirectory()) checkPackage(path.join(rootDir, entry.name), problems, members)
    }
  }
  checkDeviceOwningGroups(members, problems)

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} addon(s) share a runner they must not\x1b[0m:`)
    for (const p of problems) console.error(`    ${p.pkg} → ${p.addonId}: ${p.message}`)
    process.exit(1)
  }
  console.log('  ✔ no device provider, data-plane or device-owning addon shares a runner group')
}

main()
