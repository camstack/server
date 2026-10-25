#!/usr/bin/env tsx
/**
 * Union guard — every capability DEFINED in `packages/types/src/capabilities`
 * must be a member of the `AnyCapability` union and a VALUE export of the
 * barrel.
 *
 * ## The failure this catches
 *
 * `CapabilityName = AnyCapability['name']` is the closed set of capability
 * names the compiler will accept. Everything keyed on it — the readiness
 * registry (`IReadinessRegistry<CapabilityName>`), per-cap maps, the
 * cap-name arguments all over the kernel — silently loses a capability that
 * is defined and re-exported but never added to the union. Nothing breaks:
 * the cap file compiles, `codegen` still emits its router (codegen walks the
 * DIRECTORY, not the union), the addon registers it at runtime. Only the
 * TYPE-LEVEL surface has a hole, and a hole in a union is invisible — the
 * union has no arity anyone counts.
 *
 * Written after finding 15 of 147 caps outside the union, `intercom` and
 * `doorbell` among them. Same rust that kept Alexa dark for weeks: a
 * hand-maintained mirror of a generated-shaped thing, with no check that the
 * two agree.
 *
 * ## What it checks
 *
 * For every `*.cap.ts` under `packages/types/src/capabilities`, for every
 * `export const <x>Capability = {...} satisfies CapabilityDefinition`:
 *
 *   1. `| typeof <x>Capability` appears in the `AnyCapability` union in
 *      `index.ts`, and
 *   2. `<x>Capability` is a VALUE re-export of `index.ts` (a `type`-only
 *      re-export does not make the cap def reachable to a consumer that
 *      needs the object).
 *
 * And in the other direction: a union member with no matching definition is
 * a dangling entry (a renamed or deleted cap), reported too.
 *
 * Textual rather than by import, like the sibling guards: these files are the
 * authoritative source, and importing the barrel would drag the whole type
 * package into a check that has to stay fast enough for a hook.
 *
 * Usage: tsx scripts/check-capability-union-complete.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CAP_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const BARREL = path.join(CAP_DIR, 'index.ts')

interface CapDefinition {
  /** `intercomCapability` */
  readonly identifier: string
  /** `intercom` — the cap's wire name, for the error message. */
  readonly capName: string
  /** `intercom.cap.ts` */
  readonly file: string
}

interface Problem {
  readonly kind: 'missing-from-union' | 'not-value-exported' | 'dangling-union-member'
  readonly identifier: string
  readonly detail: string
}

/**
 * Every `export const <x>Capability = {...} satisfies CapabilityDefinition`
 * across the cap files.
 *
 * The `satisfies CapabilityDefinition` anchor is what makes this precise: a
 * cap file may export helper consts and schemas, and only the definition
 * itself belongs in the union.
 */
function capDefinitions(): readonly CapDefinition[] {
  const defs: CapDefinition[] = []
  for (const file of fs.readdirSync(CAP_DIR).toSorted()) {
    if (!file.endsWith('.cap.ts')) continue
    const source = fs.readFileSync(path.join(CAP_DIR, file), 'utf-8')
    for (const match of source.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*Capability)\s*=/g)) {
      const identifier = match[1]
      if (identifier === undefined || match.index === undefined) continue
      // The declaration body runs to the next top-level `export` (house style
      // puts each on its own line at column 0) or to end of file.
      const rest = source.slice(match.index)
      const next = rest.indexOf('\nexport ', 1)
      const body = next > 0 ? rest.slice(0, next) : rest
      if (!/satisfies\s+CapabilityDefinition/.test(body)) continue
      const name = body.match(/name:\s*['"]([^'"]+)['"]/)?.[1]
      defs.push({ identifier, capName: name ?? '<unknown>', file })
    }
  }
  return defs
}

/** The `| typeof xCapability` members of the `AnyCapability` union. */
function unionMembers(barrel: string): ReadonlySet<string> {
  const start = barrel.indexOf('type AnyCapability =')
  const end = barrel.indexOf('export type CapabilityName', start)
  if (start < 0 || end < 0) {
    console.error('\x1b[31m✘ could not locate the AnyCapability union in the barrel\x1b[0m')
    process.exit(1)
  }
  const block = barrel.slice(start, end)
  return new Set(
    [...block.matchAll(/\|\s*typeof\s+([A-Za-z_$][\w$]*)/g)]
      .map((m) => m[1])
      .filter((m): m is string => m !== undefined),
  )
}

/**
 * Identifiers the barrel re-exports as VALUES.
 *
 * `export type { x } from …` and the per-specifier `type` modifier
 * (`export { type IFooProvider, fooCapability } from …`) are both excluded:
 * a type-only export does not carry the definition object.
 */
function valueExports(barrel: string): ReadonlySet<string> {
  const exported = new Set<string>()
  for (const match of barrel.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*from\s*'[^']+'/g)) {
    if (match[1] !== undefined) continue // `export type { … }` — whole clause is type-only
    const specifiers = match[2]
    if (specifiers === undefined) continue
    for (const raw of specifiers.split(',')) {
      const spec = raw.trim()
      if (spec.length === 0 || spec.startsWith('type ')) continue
      // `foo as bar` — the local name is what a consumer imports.
      const local = spec.split(/\s+as\s+/)[1] ?? spec
      exported.add(local.trim())
    }
  }
  return exported
}

function main(): void {
  const defs = capDefinitions()
  if (defs.length === 0) {
    console.error('\x1b[31m✘ no capability definitions found — check CAP_DIR\x1b[0m')
    process.exit(1)
  }
  const barrel = fs.readFileSync(BARREL, 'utf-8')
  const members = unionMembers(barrel)
  const exported = valueExports(barrel)

  const problems: Problem[] = []
  for (const def of defs) {
    if (!members.has(def.identifier)) {
      problems.push({
        kind: 'missing-from-union',
        identifier: def.identifier,
        detail:
          `\`${def.capName}\` (${def.file}) is defined but is NOT a member of \`AnyCapability\`. ` +
          `Add \`import type { ${def.identifier} } from './${def.file.replace(/\.ts$/, '.js')}'\` ` +
          `and \`| typeof ${def.identifier}\` to the union in packages/types/src/capabilities/index.ts. ` +
          `Until then \`CapabilityName\` does not contain '${def.capName}' and every consumer keyed on it is blind to the cap.`,
      })
    }
    if (!exported.has(def.identifier)) {
      problems.push({
        kind: 'not-value-exported',
        identifier: def.identifier,
        detail:
          `\`${def.capName}\` (${def.file}) is not a VALUE re-export of the barrel. ` +
          `Add \`${def.identifier}\` to the \`export { … } from './${def.file.replace(/\.ts$/, '.js')}'\` clause ` +
          `(a \`type\`-only export does not carry the definition object).`,
      })
    }
  }

  const known = new Set(defs.map((d) => d.identifier))
  for (const member of [...members].toSorted()) {
    if (known.has(member)) continue
    problems.push({
      kind: 'dangling-union-member',
      identifier: member,
      detail:
        `\`AnyCapability\` includes \`typeof ${member}\` but no \`*.cap.ts\` defines it. ` +
        `Remove the member, or restore the definition it was renamed away from.`,
    })
  }

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} capability-union problem(s)\x1b[0m:`)
    for (const p of problems) console.error(`    [${p.kind}] ${p.detail}`)
    process.exit(1)
  }
  console.log(
    `  ✔ all ${defs.length} capability definitions are in the AnyCapability union and value-exported`,
  )
}

main()
