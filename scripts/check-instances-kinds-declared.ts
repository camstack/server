#!/usr/bin/env tsx
/**
 * An addon that configures more than one thing declares which function each kind serves (D1013).
 *
 * An addon registers ONE `integration-instances` provider; a page section (Brokers, SMTP relays,
 * Integrations) is the kinds of that provider whose `functionCap` it names. So, for every addon
 * entry that declares `integration-instances`:
 *
 * 0. Every holder declares `kinds` (even one kind): `describe().kinds` is required (D1013 rule 1) and
 *    the type says so; this is the textual twin that names the addon.
 * 1. S = the configurable functions its package declares (`broker`, `device-provider` (also
 *    `device-adoption`, the same section), `smtp-provider`, `device-export`, `calendar-source`,
 *    `notification-output`). With |S| >= 2 its source must declare `kinds`
 *    (a `kinds:` array or `composeInstanceKinds(`) and every `functionCap:` literal it writes
 *    must be one of S, with at least one written.
 * 2. Every entry of a `kinds:` array that names an `id:` also names a `functionCap:`.
 * 3. The integration role `both` is gone: `role: 'both'` and `integrationRole: 'both'` are refused.
 *
 * Textual: the source is read, not run. Specs, `__tests__`, `dist` and generated code are skipped.
 *
 * Usage: npx tsx scripts/check-instances-kinds-declared.ts
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type DeviceAddonEntry,
  ROOT,
  readEntries,
  type Violation,
  walk,
} from './check-integration-instances-declared.ts'

const INSTANCES_CAP = 'integration-instances'
export const SECTION_CAPS: ReadonlySet<string> = new Set([
  'broker',
  'device-provider',
  'device-adoption',
  'smtp-provider',
  'device-export',
  'calendar-source',
  'notification-output',
])

const FUNCTION_CAP_RE = /\bfunctionCap:\s*['"]([^'"]+)['"]/g
/** `buildNotificationTargetInstances` and `notificationTargetParts` declare the kinds themselves. */
const KINDS_DECL_RE =
  /\bkinds:\s*[[A-Za-z_$]|\bcomposeInstanceKinds\s*\(|\bbuildNotificationTargetInstances\s*\(|\bnotificationTargetParts\s*\(/
const RECORD_SITE_RE = /\bnew\s+RecordIntegrationInstances\b/g
const KINDS_ARRAY_RE = /\bkinds:\s*\[/g
const BOTH_RE = /\b(?:role|integrationRole):\s*['"]both['"]/

/** The text of the bracketed array that opens at `open` (a `[`), brackets balanced. */
function arrayText(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1
    else if (source[i] === ']') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

/** The text of the parenthesised call whose `(` is the first one at or after `from`. */
function callText(source: string, from: number): string {
  const open = source.indexOf('(', from)
  if (open < 0) return ''
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

/** The text of the braced object that opens at the first `{` at or after `from`. */
function braceText(source: string, from: number): string {
  const open = source.indexOf('{', from)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

/**
 * The call text, plus the initialiser of a `description: NAME` constant it passes by name (the
 * description is often a module constant shared with `describe()`).
 */
function siteText(source: string, call: string): string {
  const named = /\bdescription:\s*([A-Za-z_$][\w$]*)\s*[,}\n]/.exec(call)
  if (named === null) return call
  const def = new RegExp(`\\b(?:const|let)\\s+${named[1] ?? ''}\\b[^=]*=`).exec(source)
  return def === null ? call : `${call}\n${braceText(source, def.index + def[0].length)}`
}

/** The top-level `{ ... }` entries of an array text. */
function entriesOf(array: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  for (let i = 1; i < array.length; i += 1) {
    const ch = array[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) out.push(array.slice(start, i + 1))
    }
  }
  return out
}

/**
 * A package's holders: its entries that declare `integration-instances`, with the section
 * capabilities of every entry of the package (one provider source serves them all).
 * `device-adoption` is the same section as `device-provider` (the devices of an integration).
 */
function holdersByPackage(
  entries: readonly DeviceAddonEntry[],
): ReadonlyArray<{ addon: string; pkg: string; sections: ReadonlySet<string> }> {
  const byPkg = new Map<string, { addons: string[]; caps: Set<string>; holds: boolean }>()
  for (const entry of entries) {
    const row = byPkg.get(entry.pkg) ?? { addons: [], caps: new Set<string>(), holds: false }
    row.addons.push(entry.id)
    for (const cap of entry.capabilities) {
      if (SECTION_CAPS.has(cap)) row.caps.add(cap === 'device-adoption' ? 'device-provider' : cap)
    }
    if (entry.capabilities.includes(INSTANCES_CAP)) row.holds = true
    byPkg.set(entry.pkg, row)
  }
  return [...byPkg.entries()]
    .filter(([, row]) => row.holds)
    .map(([pkg, row]) => ({ addon: row.addons.join('+'), pkg, sections: row.caps }))
}

export function findKindsViolations(
  entries: readonly DeviceAddonEntry[],
  sourceOf: (pkg: string) => string,
): Violation[] {
  const out: Violation[] = []
  for (const entry of holdersByPackage(entries)) {
    const source = sourceOf(entry.pkg)
    const sections = entry.sections
    if (!KINDS_DECL_RE.test(source)) {
      out.push({
        addon: entry.addon,
        message: `declares no instance kinds: describe() needs kinds[] with a functionCap each, even for one kind (D1013 rule 1)`,
      })
    } else {
      const literals = [...source.matchAll(FUNCTION_CAP_RE)].map((m) => m[1] ?? '')
      if (sections.size >= 2) {
        if (literals.length === 0) {
          out.push({
            addon: entry.addon,
            message: 'declares instance kinds without a functionCap literal on any of them (D1013)',
          })
        }
        for (const cap of new Set(literals)) {
          if (!sections.has(cap)) {
            out.push({
              addon: entry.addon,
              message: `a kind names functionCap '${cap}' that the entry does not declare (declared: ${[...sections].join(', ')})`,
            })
          }
        }
      }
    }
    // Every `new RecordIntegrationInstances` declares its own kinds: one provider that does
    // must not cover a sibling that does not (D1013 rule 1).
    for (const site of source.matchAll(RECORD_SITE_RE)) {
      const call = callText(source, (site.index ?? 0) + site[0].length)
      if (!KINDS_DECL_RE.test(siteText(source, call))) {
        const line = source.slice(0, site.index ?? 0).split('\n').length
        out.push({
          addon: entry.addon,
          message: `a RecordIntegrationInstances construction (source line ${line} of the package) declares no kinds in its description (D1013 rule 1)`,
        })
      }
    }
    for (const match of source.matchAll(KINDS_ARRAY_RE)) {
      const array = arrayText(source, (match.index ?? 0) + match[0].length - 1)
      for (const item of entriesOf(array)) {
        if (/\bid:\s*/.test(item) && !/\bfunctionCap:/.test(item)) {
          out.push({
            addon: entry.addon,
            message: `a kinds[] entry has an id and no functionCap: ${item.replace(/\s+/g, ' ').slice(0, 80)}`,
          })
        }
      }
    }
  }
  return out
}

/** D1013 / the role `both` is gone: a mixed addon declares each kind's role instead. */
export function findBothRoleViolations(
  entries: readonly DeviceAddonEntry[],
  sourceOf: (pkg: string) => string,
): Violation[] {
  const out: Violation[] = []
  for (const entry of entries) {
    if (BOTH_RE.test(sourceOf(entry.pkg))) {
      out.push({
        addon: entry.id,
        message:
          "uses the integration role 'both', which no longer exists: declare each kind's role",
      })
    }
  }
  return out
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
    ...findKindsViolations(entries, sourceOf),
    ...findBothRoleViolations(entries, sourceOf),
  ]
  if (violations.length === 0) {
    const holders = entries.filter((e) => e.capabilities.includes(INSTANCES_CAP))
    console.log(
      `check-instances-kinds-declared: ${holders.length} instance holders, kinds accounted for`,
    )
    return
  }
  console.error('check-instances-kinds-declared (D1013):')
  for (const v of violations) console.error(`  ${v.addon}: ${v.message}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
