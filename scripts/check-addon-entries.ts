#!/usr/bin/env tsx
/**
 * Addon-entry guard — every `camstack.addons[].entry` must actually be BUILT.
 *
 * ## The failure this catches
 *
 * A manifest entry is a string. Nothing type-checks it, nothing resolves it at
 * build time, and the build happily succeeds without emitting it. The addon then
 * fails at RUNTIME, on a node, with `Cannot find module` — or worse, it is simply
 * absent from `listAddons()` and the capability it provides silently does not
 * exist. `AddonLoader` is the first thing that finds out, in production.
 *
 * This was written immediately after doing it: a new `loki-logging` builtin got
 * its source, its `package.json` manifest entry and its `src/index.ts` barrel, and
 * was missing one line in `packages/system/vite.config.ts`. Everything compiled,
 * every test passed, `docs/reference/addons.md` listed it — and
 * `dist/builtins/loki-logging/index.js` did not exist.
 *
 * ## What it checks
 *
 * For every addon manifest in every workspace package, given
 * `entry: './dist/<path>/index.js'`:
 *
 *   1. A plausible SOURCE file exists (`src/<path>/index.ts` or `.tsx`). Catches a
 *      typo'd or renamed directory.
 *   2. If the package builds with a vite config that declares an explicit `entries`
 *      map, the entry's key is present in it. This is the check that would have
 *      caught the real bug.
 * It does NOT check for a default export — see the note at the bottom of
 * `checkPackage`. `resolveAddonClass` accepts named-only modules, and asserting
 * otherwise flagged 28 healthy addons on the first run.
 *
 * It deliberately does NOT require `dist/` to exist — that would make the guard
 * depend on build order and fail on a clean checkout.
 *
 * Usage: tsx scripts/check-addon-entries.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

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

/**
 * The `entries` keys of a vite config, read textually.
 *
 * Textual on purpose: importing the config would execute it, which pulls in
 * plugins and a whole build environment for a check that has to stay fast enough
 * to run in a hook. The shape it looks for is the house convention —
 * `'builtins/x/index': 'src/builtins/x/index.ts',`.
 *
 * Returns null when the package has no vite config or no literal `entries` map,
 * in which case check 2 is skipped rather than guessed at.
 */
function viteEntryKeys(pkgDir: string): ReadonlySet<string> | null {
  const configPath = path.join(pkgDir, 'vite.config.ts')
  if (!fs.existsSync(configPath)) return null
  const source = fs.readFileSync(configPath, 'utf-8')
  const block = /entries\s*[:=]\s*\{([\s\S]*?)\n\s*\}/.exec(source)
  if (!block) return null
  const keys = new Set<string>()
  // Both quoted and BARE keys. `index: 'src/index.ts'` is as common as
  // `'builtins/x/index': …`, and matching only quoted keys reported two healthy
  // packages as broken — a guard that cries wolf is a guard someone deletes.
  for (const match of block[1].matchAll(/(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*:/g)) {
    const key = match[1] ?? match[2]
    if (key !== undefined) keys.add(key)
  }
  return keys.size > 0 ? keys : null
}

/** `./dist/builtins/x/index.js` → `builtins/x/index` */
function entryToStem(entry: string): string | null {
  const match = /^\.?\/?dist\/(.+)\.(?:js|mjs|cjs)$/.exec(entry)
  return match ? match[1] : null
}

function checkPackage(pkgDir: string, problems: Problem[]): void {
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return
  const pkg = readJson(pkgJsonPath)
  const camstack = asRecord(pkg['camstack'])
  const addons = camstack?.['addons']
  if (!Array.isArray(addons) || addons.length === 0) return

  const pkgName = typeof pkg['name'] === 'string' ? pkg['name'] : path.basename(pkgDir)
  const entryKeys = viteEntryKeys(pkgDir)

  for (const raw of addons) {
    const addon = asRecord(raw)
    if (!addon) continue
    const addonId = typeof addon['id'] === 'string' ? addon['id'] : '(unnamed)'
    const entry = addon['entry']
    if (typeof entry !== 'string' || entry.length === 0) {
      problems.push({ pkg: pkgName, addonId, message: 'manifest has no `entry`' })
      continue
    }

    const stem = entryToStem(entry)
    if (stem === null) {
      problems.push({
        pkg: pkgName,
        addonId,
        message: `entry \`${entry}\` is not of the form ./dist/<path>.js`,
      })
      continue
    }

    // 1 — a source file must exist.
    const candidates = [`src/${stem}.ts`, `src/${stem}.tsx`, `src/${stem}/index.ts`]
    const sourceRel = candidates.find((c) => fs.existsSync(path.join(pkgDir, c)))
    if (sourceRel === undefined) {
      problems.push({
        pkg: pkgName,
        addonId,
        message: `entry \`${entry}\` has no source — expected one of ${candidates.join(', ')}`,
      })
      continue
    }

    // 2 — the build must be configured to emit it. THE check that matters.
    if (entryKeys !== null && !entryKeys.has(stem)) {
      problems.push({
        pkg: pkgName,
        addonId,
        message:
          `entry \`${entry}\` is never built — add \`'${stem}': '${sourceRel}',\` to ` +
          `${path.relative(ROOT, path.join(pkgDir, 'vite.config.ts'))}. ` +
          `Without it the addon loads only until someone tries to load it.`,
      })
    }

    // There is deliberately no "must have a default export" check. It looks
    // obvious and it is wrong: `resolveAddonClass`
    // (packages/system/src/kernel/addon-class-resolver.ts) falls back to scanning
    // NAMED exports for a class whose prototype has `initialize`, precisely
    // because tsup-built CJS bundles have no default slot. Most addons here rely
    // on that. Asserting the default export flagged 28 healthy addons.
  }
}

function main(): void {
  const problems: Problem[] = []
  for (const root of ['packages', 'server']) {
    const rootDir = path.join(ROOT, root)
    if (!fs.existsSync(rootDir)) continue
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (entry.isDirectory()) checkPackage(path.join(rootDir, entry.name), problems)
    }
  }

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} addon entry problem(s)\x1b[0m:`)
    for (const p of problems) console.error(`    ${p.pkg} → ${p.addonId}: ${p.message}`)
    process.exit(1)
  }
  console.log('  ✔ every addon entry has a source and a configured build entry')
}

main()
