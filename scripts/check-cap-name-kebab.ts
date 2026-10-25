#!/usr/bin/env tsx
/**
 * Cap-name guard — **a capability name is kebab-case, because the transport
 * recovers it from the router key with a string transform.**
 *
 * ## The failure this catches
 *
 * A forked addon calls `ctx.api.<routerKey>.<method>()`. The router key is
 * `kebabToCamel(cap.name)` (`addon-context-factory.ts`). The value that has to
 * come back out the other end — the name a provider actually registered under —
 * is recovered in `parsePath()` (`packages/system/src/kernel/moleculer/
 * trpc-links.ts`) by `toKebab(namespace)`. `toKebab` is the inverse of
 * `kebabToCamel` **only for kebab-case input**, and it cannot be replaced by a
 * real name↔key map: `trpc-links.ts` is in the addon-runner's transitive
 * closure, where a value import of the `@camstack/types` barrel is forbidden
 * (D28, `check-runner-barrel-free.ts`) — it costs ~66MB RSS per runner.
 *
 * `recordingExport` shipped camelCase. `kebabToCamel` left it alone, so the
 * `ctx.api` property was right and everything type-checked; `toKebab` turned it
 * into `recording-export`, which no provider registers. EVERY forked-addon call
 * to that cap failed with `no provider registered for cap "recording-export"`,
 * for its whole life, while the hub's own tRPC router — which mounts by key and
 * never re-derives a name — served the admin UI perfectly. The bug was invisible
 * until the first addon-to-addon caller (the timelapse renderer) appeared.
 *
 * Nothing else fails on a camel cap name. There is no type error, no codegen
 * error, no failing test, and no log line at the registering end. Hence a guard.
 *
 * ## What it checks
 *
 * Every `name: '<x>'` inside an `export const <x>Capability = { … }` under
 * `packages/types/src/capabilities` must satisfy `^[a-z0-9]+(-[a-z0-9]+)*$` —
 * lowercase, digits, single hyphens, no leading/trailing hyphen. Equivalently:
 * `toKebab(kebabToCamel(name)) === name`, checked directly too, so a name that
 * is somehow kebab-shaped yet does not round-trip is still reported.
 *
 * Textual rather than by import, like the sibling cap guards: the `*.cap.ts`
 * files are authoritative, and importing the barrel would drag the whole schema
 * graph into a check that has to stay fast enough for a pre-commit hook.
 *
 * The transport-level twin of this guard, over the REAL cap set and through the
 * REAL link, is `packages/system/src/kernel/__tests__/moleculer/
 * cap-name-router-key-roundtrip.spec.ts`.
 *
 * Usage: tsx scripts/check-cap-name-kebab.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CAP_DIR = path.join(ROOT, 'packages/types/src/capabilities')

/** The shape every cap name must have. */
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface CapName {
  readonly capName: string
  readonly identifier: string
  readonly file: string
}

interface Problem {
  readonly capName: string
  readonly file: string
  readonly detail: string
}

/** `kebab-case → camelCase` — the router-key derivation (`cap-router-predicates.ts`). */
function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** `camelCase → kebab-case` — the transport's inverse (`trpc-links.ts` `parsePath`). */
function toKebab(name: string): string {
  return name.replace(/[A-Z]/g, (m, i: number) => (i > 0 ? '-' : '') + m.toLowerCase())
}

/**
 * Every `export const <x>Capability = { … name: '<capName>' … }` in the cap
 * directory. The `name:` taken is the FIRST one after the declaration, which is
 * the cap's own name — method schemas and nested option objects come later and
 * are scoped by the next `export const`.
 */
function collectCapNames(): CapName[] {
  const out: CapName[] = []
  for (const file of fs
    .readdirSync(CAP_DIR)
    .filter((f) => f.endsWith('.cap.ts'))
    .toSorted()) {
    const src = fs.readFileSync(path.join(CAP_DIR, file), 'utf8')
    const decl = /export const (\w+Capability)\s*=\s*\{/g
    let m: RegExpExecArray | null
    while ((m = decl.exec(src)) !== null) {
      const identifier = m[1]
      if (identifier === undefined) continue
      const rest = src.slice(m.index + m[0].length)
      const end = rest.search(/\nexport const \w+Capability\s*=/)
      const body = end < 0 ? rest : rest.slice(0, end)
      const nameMatch = /^\s*(?:\/\/.*\n\s*)*name:\s*'([^']+)'/m.exec(body)
      if (nameMatch?.[1] === undefined) continue
      out.push({ capName: nameMatch[1], identifier, file })
    }
  }
  return out
}

function main(): void {
  const names = collectCapNames()
  if (names.length === 0) {
    console.error(
      '\x1b[31m✘ cap-name guard found no capability definitions — parser broken?\x1b[0m',
    )
    process.exit(1)
  }

  const problems: Problem[] = []
  for (const { capName, identifier, file } of names) {
    if (!KEBAB.test(capName)) {
      problems.push({
        capName,
        file,
        detail:
          `\`${identifier}\` is named '${capName}' — cap names are kebab-case ` +
          `(lowercase, digits, single hyphens). Rename it to ` +
          `'${toKebab(capName)}'. The generated tRPC router key stays ` +
          `'${kebabToCamel(toKebab(capName))}', so no client path changes; the ` +
          `manifest \`capabilities[].name\` in the declaring package.json must ` +
          `be renamed with it, then \`npm run codegen\`.`,
      })
      continue
    }
    const roundTripped = toKebab(kebabToCamel(capName))
    if (roundTripped !== capName) {
      problems.push({
        capName,
        file,
        detail:
          `\`${identifier}\` is named '${capName}', which does not survive the ` +
          `ctx.api round trip: kebabToCamel → '${kebabToCamel(capName)}' → ` +
          `toKebab → '${roundTripped}'. Every forked-addon call to it would ` +
          `resolve to a cap nothing registers.`,
      })
    }
  }

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} non-kebab capability name(s)\x1b[0m:`)
    for (const p of problems) console.error(`    ${p.file}: ${p.detail}`)
    process.exit(1)
  }
  console.log(`  ✔ all ${names.length} capability names are kebab-case and round-trip via ctx.api`)
}

main()
