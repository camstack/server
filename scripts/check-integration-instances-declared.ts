#!/usr/bin/env tsx
/**
 * Every integration that brings devices keeps its configuration as a typed instance record
 * (planning#416, "one store"). Two rules, one list.
 *
 * 1. An addon entry that declares `device-provider` or `device-adoption` AND `integration-instances`
 *    (it has migrated) must also carry what an instance needs in its own source: a record kind
 *    (`defineEntryKind` / `defineRecordKinds`) and the `role` its `describe()` answers
 *    (`devices` or `services`). Without a role the Integrations page cannot tell what the
 *    instances are for, and without a kind there is no record to read.
 * 2. An entry that declares a device marker and NOT `integration-instances` is still on the legacy
 *    leftover rows. Those entries are the committed list
 *    `scripts/integration-instances-baseline.json` (`onRows`), and it only SHRINKS: a new device
 *    addon starts on records (declare the cap), and an addon that migrated, or went away, leaves
 *    the list in the same change.
 *
 * 3. An addon entry that declares `device-export` (D1009: an export target is an integration
 *    instance, every exporter is multi-instance) must declare `integration-instances` and carry
 *    `instanceMode: 'multiple'` in its own source, never `'single'`.
 *
 * 4. An addon entry that declares a device marker, `broker` AND `integration-instances` (D1013
 *    rule 5: the link lives on the consumer, the broker owns nothing of its users) must declare
 *    its integration kind through the one link primitive `declareLinkKind`, with a `links` entry
 *    naming the broker. The kind never carries a password or any secret field
 *    (credentials belong to the broker).
 *
 * Textual: the source is read, not run. Specs, `__tests__`, `dist` and generated code are skipped.
 *
 * Usage: npx tsx scripts/check-integration-instances-declared.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEVICE_MARKERS: ReadonlySet<string> = new Set(['device-provider', 'device-adoption'])
const INSTANCES_CAP = 'integration-instances'
const EXPORT_CAP = 'device-export'
const MULTIPLE_RE = /\binstanceMode:\s*['"]multiple['"]/
const SINGLE_RE = /\binstanceMode:\s*['"]single['"]/

export interface DeviceAddonEntry {
  readonly id: string
  /** Package directory under `packages/`. */
  readonly pkg: string
  readonly capabilities: readonly string[]
}

export interface Violation {
  readonly addon: string
  readonly message: string
}

const KIND_RE = /\b(?:defineEntryKind|defineRecordKinds|declareLinkKind)\s*[(<]/
const ROLE_RE = /\brole:\s*['"](?:devices|services)['"]/

export function findViolations(
  entries: readonly DeviceAddonEntry[],
  onRows: readonly string[],
  sourceOf: (pkg: string) => string,
): Violation[] {
  const out: Violation[] = []
  const listed = new Set(onRows)
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.capabilities.some((c) => DEVICE_MARKERS.has(c))) continue
    seen.add(entry.id)
    const migrated = entry.capabilities.includes(INSTANCES_CAP)
    if (migrated) {
      const source = sourceOf(entry.pkg)
      if (!KIND_RE.test(source)) {
        out.push({
          addon: entry.id,
          message: `declares ${INSTANCES_CAP} but its source defines no record kind (defineEntryKind / defineRecordKinds)`,
        })
      }
      if (!ROLE_RE.test(source)) {
        out.push({
          addon: entry.id,
          message: `declares ${INSTANCES_CAP} but no describe() answers a role ('devices' | 'services')`,
        })
      }
      if (listed.has(entry.id)) {
        out.push({
          addon: entry.id,
          message: `migrated to ${INSTANCES_CAP} but still in the onRows baseline: remove it from scripts/integration-instances-baseline.json`,
        })
      }
    } else if (!listed.has(entry.id)) {
      out.push({
        addon: entry.id,
        message: `brings devices and does not declare ${INSTANCES_CAP}: a new device addon keeps its configuration as an instance record (the onRows baseline only shrinks)`,
      })
    }
  }
  for (const id of listed) {
    if (!seen.has(id)) {
      out.push({
        addon: id,
        message:
          'listed in the onRows baseline but no addon entry with a device marker has this id: remove the line',
      })
    }
  }
  return out
}

/** D1009: every `device-export` provider is a multi-instance integration. */
export function findExporterViolations(
  entries: readonly DeviceAddonEntry[],
  sourceOf: (pkg: string) => string,
): Violation[] {
  const out: Violation[] = []
  for (const entry of entries) {
    if (!entry.capabilities.includes(EXPORT_CAP)) continue
    if (!entry.capabilities.includes(INSTANCES_CAP)) {
      out.push({
        addon: entry.id,
        message: `provides ${EXPORT_CAP} and does not declare ${INSTANCES_CAP}: an export target is an integration instance (D1009)`,
      })
      continue
    }
    const source = sourceOf(entry.pkg)
    if (SINGLE_RE.test(source) || !MULTIPLE_RE.test(source)) {
      out.push({
        addon: entry.id,
        message: `provides ${EXPORT_CAP} but does not declare instanceMode: 'multiple': every exporter is multi-instance (D1009)`,
      })
    }
  }
  return out
}

const BROKER_CAP = 'broker'
const LINK_CALL_RE = /\bdeclareLinkKind\s*[(<]/
const LINKS_RE = /\blinks:\s*\{/
const SECRET_FIELD_RE = /\b(?:password|secret|token|apiKey)\b|\.meta\(/i

/** The text of the first `declareLinkKind(...)` call, parentheses balanced. */
function linkCallText(source: string): string {
  const at = source.search(LINK_CALL_RE)
  if (at < 0) return ''
  const open = source.indexOf('(', at)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

/** D1013 rule 5: a broker-backed integration names its broker by id, through the one link primitive. */
export function findBrokerLinkViolations(
  entries: readonly DeviceAddonEntry[],
  sourceOf: (pkg: string) => string,
): Violation[] {
  const out: Violation[] = []
  for (const entry of entries) {
    const backed =
      entry.capabilities.some((c) => DEVICE_MARKERS.has(c)) &&
      entry.capabilities.includes(BROKER_CAP) &&
      entry.capabilities.includes(INSTANCES_CAP)
    if (!backed) continue
    const source = sourceOf(entry.pkg)
    if (!LINK_CALL_RE.test(source)) {
      out.push({
        addon: entry.id,
        message: `brings devices through a broker and does not declare its integration kind with declareLinkKind: an integration names its broker by id and owns none of its settings (D1013)`,
      })
      continue
    }
    const call = linkCallText(source)
    if (!LINKS_RE.test(call)) {
      out.push({
        addon: entry.id,
        message: `its declareLinkKind kind names no links entry (links: { brokerId: <the broker target> }): the integration must name its broker by id (D1013)`,
      })
    }
    if (SECRET_FIELD_RE.test(call)) {
      out.push({
        addon: entry.id,
        message: `its declareLinkKind kind carries a password or secret field: credentials belong to the broker, never to its users (D1013)`,
      })
    }
  }
  return out
}

const SKIP_DIRS = new Set([
  'dist',
  'node_modules',
  '__tests__',
  '__mocks__',
  'generated',
  'coverage',
])
const SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/
const NON_RUNTIME_RE = /\.(?:spec|test|d)\.(?:ts|tsx|mts|cts)$/

export function walk(dir: string, out: string[]): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

export function readEntries(): DeviceAddonEntry[] {
  const entries: DeviceAddonEntry[] = []
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    let manifest: unknown
    try {
      manifest = JSON.parse(readFileSync(path.join(ROOT, 'packages', pkg, 'package.json'), 'utf-8'))
    } catch {
      continue
    }
    const camstack: unknown =
      typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'camstack') : null
    const addons: unknown =
      typeof camstack === 'object' && camstack !== null ? Reflect.get(camstack, 'addons') : null
    if (!Array.isArray(addons)) continue
    for (const addon of addons) {
      if (typeof addon !== 'object' || addon === null) continue
      const id: unknown = Reflect.get(addon, 'id')
      const caps: unknown = Reflect.get(addon, 'capabilities')
      if (typeof id !== 'string' || !Array.isArray(caps)) continue
      const names = caps
        .map((c: unknown) =>
          typeof c === 'string'
            ? c
            : typeof c === 'object' && c !== null
              ? Reflect.get(c, 'name')
              : undefined,
        )
        .filter((n: unknown): n is string => typeof n === 'string')
      entries.push({ id, pkg, capabilities: names })
    }
  }
  return entries
}

function readBaseline(): readonly string[] {
  const raw: unknown = JSON.parse(
    readFileSync(path.join(ROOT, 'scripts/integration-instances-baseline.json'), 'utf-8'),
  )
  const list: unknown = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'onRows') : null
  if (!Array.isArray(list))
    throw new Error('integration-instances-baseline.json has no onRows list')
  return list.filter((x: unknown): x is string => typeof x === 'string')
}

function main(): void {
  const entries = readEntries()
  const cache = new Map<string, string>()
  const sourceOf = (pkg: string): string => {
    const cached = cache.get(pkg)
    if (cached !== undefined) return cached
    const files: string[] = []
    walk(path.join(ROOT, 'packages', pkg, 'src'), files)
    const text = files.map((f) => readFileSync(f, 'utf-8')).join('\n')
    cache.set(pkg, text)
    return text
  }
  const violations = [
    ...findViolations(entries, readBaseline(), sourceOf),
    ...findExporterViolations(entries, sourceOf),
    ...findBrokerLinkViolations(entries, sourceOf),
  ]
  if (violations.length === 0) {
    const devices = entries.filter((e) => e.capabilities.some((c) => DEVICE_MARKERS.has(c)))
    console.log(
      `check-integration-instances-declared: ${devices.length} device addons, all accounted for`,
    )
    return
  }
  console.error('check-integration-instances-declared (planning#416):')
  for (const v of violations) console.error(`  ${v.addon}: ${v.message}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
