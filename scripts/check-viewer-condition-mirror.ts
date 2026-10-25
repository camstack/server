#!/usr/bin/env tsx
/**
 * Viewer condition-mirror guard — the app must be able to render every
 * condition the hub serves.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * The viewer mirrors the notification-rules cap's schemas LOCALLY (it is a
 * separate app with its own Zod copies), so every condition added to the cap is
 * an unknown member to the app until someone updates the mirror. That boundary
 * has failed twice:
 *
 *   - `occupancy` shipped, and the rule editor lost ALL of its conditions;
 *   - `crossingSelect` shipped, and it lost them again — live on 2026-08-04,
 *     with the hub serving 21 descriptors and the app rendering none.
 *
 * The parse is no longer all-or-nothing (an undecodable descriptor is dropped
 * and warned about, not fatal), so the failure is now partial rather than
 * total: the condition simply does not appear. That is better and still wrong —
 * an operator who authors a rule in the admin UI and opens it on the phone sees
 * a rule that is missing a condition it has.
 *
 * ── What it checks ─────────────────────────────────────────────────────────
 * Every `valueType` in the cap's `NcConditionValueTypeSchema` appears in the
 * viewer's mirrored enum, and every `group` likewise. Both files are read as
 * TEXT: the viewer is a separate package with its own toolchain, and importing
 * across that boundary at guard time is not worth the coupling.
 *
 * A missing MIRROR entry fails. The viewer having EXTRA entries does not — the
 * app may legitimately be ahead of the hub it is built against.
 *
 * A check MAY carry an explicit, SELF-EXPIRING `aheadOfViewer` allowance for a
 * member the hub ships before the viewer OTA learns it (the precedent is
 * `check-nc-mirrors-in-sync.ts`). Each allowed member must be IN the cap and
 * NOT in the viewer: the day the viewer gains it, this guard fails until the
 * allowance line is deleted, so an allowance cannot outlive the gap it covers.
 * An old viewer DROPS an undecodable descriptor (warned, never fatal), so the
 * gap costs the phone a widget, not the rule's other conditions.
 *
 * Usage: npx tsx scripts/check-viewer-condition-mirror.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CAP = path.join(ROOT, 'packages/types/src/capabilities/notification-rules.cap.ts')
const MIRROR = path.join(ROOT, 'camstack/src/data/notification-center.ts')

/**
 * The `NcConditionDescriptorSchema = z.object({ … })` block.
 *
 * Both sides declare `group` and `valueType` as INLINE property enums, and both
 * files contain other `z.enum` properties by those names — so the enums are
 * read from inside this block rather than from the file, or the guard compares
 * the wrong two lists and passes.
 */
function descriptorBlock(source: string): string {
  const start = source.indexOf('NcConditionDescriptorSchema = z.object({')
  if (start < 0) return ''
  // Everything AFTER the declaration, not a bounded block. Bounding it on the
  // first `\n})` silently truncated the enum mid-list — the guard then compared
  // two short lists and reported a member as missing that was right there.
  // Reading forward is enough: the properties are matched by name.
  return stripComments(source.slice(start))
}

/**
 * Strip comments before matching.
 *
 * Not cosmetic: the enum's own JSDoc contains `MaskPolygonShape[])`, and the
 * non-greedy `\]\)` terminator matched THAT — so the member list silently
 * stopped at `packagePhase` and the guard reported `crossingSelect` missing
 * from a file that declares it three lines later. A guard that reads source as
 * text has to read it as code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Members of a top-level `export const NAME = z.enum([...])`. */
function namedEnumMembers(source: string, name: string): string[] {
  const re = new RegExp(`${name}\\s*=\\s*z\\.enum\\(\\[([\\s\\S]*?)\\]\\)`)
  const block = re.exec(source)
  if (block === null) return []
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** Members of the object-property `name: z.enum([...])`. */
function propertyEnumMembers(source: string, name: string): string[] {
  const re = new RegExp(`\\b${name}:\\s*z\\.enum\\(\\[([\\s\\S]*?)\\]\\)`)
  const block = re.exec(source)
  if (block === null) return []
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/**
 * Property NAMES of a top-level `export const NAME = z.object({ … })`.
 *
 * Bounded on the first line that closes the object at column 0 (`\n})`), which
 * is safe here because these schemas are flat — and the input is comment-
 * stripped first, for the same reason the enum reader is: a guard that reads
 * source as text has to read it as code.
 */
function objectKeys(source: string, name: string): string[] {
  const start = source.indexOf(`${name} = z.object({`)
  if (start < 0) return []
  const body = source.slice(start)
  const end = body.indexOf('\n})')
  if (end < 0) return []
  return [...body.slice(0, end).matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])
}

function main(): void {
  if (!fs.existsSync(MIRROR)) {
    // The viewer is a submodule; a checkout without it is not a failure. It is
    // not a PASS either — a tick here says the mirror was compared, and it was
    // not. Same distinction the sibling guards draw.
    console.log(
      '⊘ viewer condition mirror NOT checked: the camstack/ submodule is not checked out here',
    )
    return
  }
  const cap = descriptorBlock(fs.readFileSync(CAP, 'utf-8'))
  const mirror = descriptorBlock(fs.readFileSync(MIRROR, 'utf-8'))

  // `delivery` is NOT on the descriptor — it is its own schema on both sides,
  // and it reaches the app twice: on every RULE and inside the descriptor's
  // `appliesTo`. A delivery kind the app does not know would therefore cost an
  // operator their rules, not just a condition, which is why it is checked here
  // rather than left to be discovered.
  const capSource = stripComments(fs.readFileSync(CAP, 'utf-8'))
  const mirrorSource = stripComments(fs.readFileSync(MIRROR, 'utf-8'))

  const checks: ReadonlyArray<{
    what: string
    cap: string[]
    mirrored: string[]
    aheadOfViewer?: readonly string[]
  }> = [
    {
      what: 'valueType',
      cap: propertyEnumMembers(cap, 'valueType'),
      mirrored: propertyEnumMembers(mirror, 'valueType'),
    },
    {
      what: 'group',
      cap: propertyEnumMembers(cap, 'group'),
      mirrored: propertyEnumMembers(mirror, 'group'),
    },
    {
      what: 'delivery',
      cap: namedEnumMembers(capSource, 'NcDeliverySchema'),
      mirrored: namedEnumMembers(mirrorSource, 'NcDeliverySchema'),
    },
    // SNOOZE. A scope the app cannot decode is a silence it cannot SHOW — and a
    // snooze the operator cannot see is indistinguishable from the outage this
    // whole feature is one misstep away from being.
    {
      what: 'snooze scope',
      cap: namedEnumMembers(capSource, 'NcSnoozeScopeSchema'),
      mirrored: namedEnumMembers(mirrorSource, 'NcSnoozeScopeSchema'),
    },
    {
      what: 'snooze field',
      cap: objectKeys(capSource, 'NcSnoozeSchema'),
      mirrored: objectKeys(mirrorSource, 'NcSnoozeSchema'),
    },
    {
      what: 'snooze input field',
      cap: objectKeys(capSource, 'NcSnoozeInputSchema'),
      mirrored: objectKeys(mirrorSource, 'NcSnoozeInputSchema'),
    },
  ]

  const problems: string[] = []
  const notes: string[] = []
  for (const check of checks) {
    if (check.cap.length === 0) {
      // A rename in the cap would otherwise turn this guard into a no-op that
      // reports success — the exact "green means nothing" failure the repo
      // keeps paying for.
      problems.push(
        `could not read the cap's ${check.what} enum — the guard cannot check what it cannot find`,
      )
      continue
    }
    if (check.mirrored.length === 0) {
      problems.push(`could not read the viewer's mirrored ${check.what} enum`)
      continue
    }
    const ahead = check.aheadOfViewer ?? []
    for (const a of ahead) {
      if (!check.cap.includes(a)) {
        problems.push(
          `the ${check.what} allowance names "${a}", which the cap does not serve — delete it from aheadOfViewer`,
        )
      } else if (check.mirrored.includes(a)) {
        problems.push(
          `the viewer now mirrors ${check.what} "${a}" — the gap is closed: delete it from aheadOfViewer`,
        )
      } else {
        notes.push(`${check.what} "${a}": the viewer is allowed to lack it (aheadOfViewer)`)
      }
    }
    const missing = check.cap.filter((v) => !check.mirrored.includes(v) && !ahead.includes(v))
    for (const m of missing)
      problems.push(`${check.what} "${m}" is served by the hub, and the viewer cannot render it`)
  }

  if (problems.length > 0) {
    console.error('')
    console.error('✘ viewer condition mirror is behind the notification-rules cap:')
    for (const p of problems) console.error(`    ${p}`)
    console.error('')
    console.error('  The viewer mirrors the cap locally. Add the member to the enums in')
    console.error('  camstack/src/data/notification-center.ts AND give it a widget in')
    console.error('  camstack/src/components/notifications/ConditionField.tsx — a mirrored')
    console.error('  type with no widget parses and then renders nothing.')
    console.error('')
    console.error('  If the condition also carries a NEW FIELD on the rule, mirror that in')
    console.error('  NcConditionsSchema too, or saving a rule from the phone STRIPS it.')
    process.exit(1)
  }

  const total = checks.reduce((n, c) => n + c.cap.length, 0)
  console.log(`✔ viewer condition mirror: ${total} cap member(s) all renderable by the viewer`)
  for (const note of notes) console.log(`  ⊘ ${note}`)
}

main()
