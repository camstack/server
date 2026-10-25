#!/usr/bin/env tsx
/**
 * Addon validator — checks an addon's `package.json` `camstack` manifest
 * against reality, so a declared-but-missing thing is caught before it
 * reaches the hub (the class of bug behind the `export-alexa` breakages:
 * something declared that was never actually there).
 *
 * Static only — never instantiates or executes the addon:
 *   1. Manifest well-formed: `camstack.addons[]` each with id / name / entry.
 *   2. The declared `entry` and `icon` files exist on disk.
 *   3. Every declared `capabilities[].name` is a REAL capability —
 *      cross-checked against the `@camstack/types` capability set.
 *   4. Code scan: every declared capability's name appears in the addon's
 *      built `dist/` bundle. A self-contained addon bundles its cap
 *      definitions, so a used cap's name string is always present; a
 *      declared cap missing from the bundle is declared-but-not-wired.
 *   5. The self-contained-addon dependencies are declared.
 *
 * Usage:
 *   npm run validate-addon -- packages/addon-provider-reolink
 *   npm run validate-addon -- --all
 *
 * Exit code 1 if any error is found, 0 otherwise.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as camstackTypes from '@camstack/types'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Deps every self-contained addon bundles (see AGENTS.md) — looked up
 *  across both `dependencies` and `devDependencies` (vite bundles them
 *  at build time, so they are commonly dev deps). Only `@camstack/types`
 *  is universal; `zod` / `@trpc/*` are needed only by addons that ship
 *  schemas or tRPC surfaces, so they are not checked here. */
const SELF_CONTAINED_DEPS = ['@camstack/types'] as const

interface Finding {
  readonly level: 'error' | 'warn'
  readonly addon: string
  readonly message: string
}

interface ManifestAddon {
  readonly id?: unknown
  readonly name?: unknown
  readonly entry?: unknown
  readonly icon?: unknown
  readonly capabilities?: ReadonlyArray<{ readonly name?: unknown }>
}

/** Minimal shape we read off a parsed `package.json`. Fields are
 *  optional / loosely typed — the validator narrows everything it
 *  uses. `JSON.parse` is the type boundary; the cast is deliberate. */
interface PackageJson {
  readonly camstack?: { readonly addons?: readonly ManifestAddon[] }
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
}

function parsePackageJson(text: string): PackageJson {
  return JSON.parse(text) as PackageJson
}

/** Runtime-safe typed array narrowing — bare `Array.isArray` widens a
 *  typed array back to `any[]`, so the element type is re-asserted here
 *  (parsed-JSON data — the documented type boundary). */
function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : []
}

/** Collect every real capability name from `@camstack/types`. A cap
 *  definition is the only exported object carrying both a `name` and a
 *  `scope` string — schemas / enums / helpers never do. */
function collectValidCapNames(): ReadonlySet<string> {
  const names = new Set<string>()
  for (const value of Object.values(camstackTypes)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { name?: unknown }).name === 'string' &&
      typeof (value as { scope?: unknown }).scope === 'string'
    ) {
      names.add((value as { name: string }).name)
    }
  }
  return names
}

/** Concatenate the addon's built `dist/` JS — the code-scan corpus.
 *  Empty when the addon has not been built. */
function readDistText(addonDir: string): string {
  const distDir = join(addonDir, 'dist')
  if (!existsSync(distDir)) return ''
  const parts: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name))
      } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
        parts.push(readFileSync(join(dir, entry.name), 'utf8'))
      }
    }
  }
  walk(distDir)
  return parts.join('\n')
}

function validateAddon(addonDir: string, validCaps: ReadonlySet<string>): Finding[] {
  const findings: Finding[] = []
  const label = basename(addonDir)
  const err = (addon: string, message: string): void => {
    findings.push({ level: 'error', addon, message })
  }
  const warn = (addon: string, message: string): void => {
    findings.push({ level: 'warn', addon, message })
  }

  const pkgPath = join(addonDir, 'package.json')
  if (!existsSync(pkgPath)) {
    err(label, `no package.json at ${pkgPath}`)
    return findings
  }

  let pkg: PackageJson
  try {
    pkg = parsePackageJson(readFileSync(pkgPath, 'utf8'))
  } catch (e) {
    err(label, `package.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
    return findings
  }

  const camstack = pkg.camstack
  if (!camstack || typeof camstack !== 'object') {
    err(label, 'package.json has no `camstack` block')
    return findings
  }
  const addons = asArray<ManifestAddon>(camstack.addons)
  if (addons.length === 0) {
    err(label, '`camstack.addons` is missing or empty')
    return findings
  }

  // The built bundle is the code-scan corpus, shared across this
  // package's addon entries.
  const dist = readDistText(addonDir)

  for (const raw of addons) {
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null
    const addonName = id ?? label
    if (!id) err(addonName, 'addon entry has no string `id`')
    if (typeof raw.name !== 'string' || raw.name.length === 0) {
      err(addonName, 'addon entry has no `name`')
    }

    // `entry` file must exist.
    let entryExists = false
    if (typeof raw.entry !== 'string' || raw.entry.length === 0) {
      err(addonName, 'addon entry has no `entry` path')
    } else if (!existsSync(join(addonDir, raw.entry))) {
      err(addonName, `declared entry '${raw.entry}' does not exist (build the addon first?)`)
    } else {
      entryExists = true
    }

    // `icon` asset, when declared, must exist.
    if (
      typeof raw.icon === 'string' &&
      raw.icon.length > 0 &&
      !existsSync(join(addonDir, raw.icon))
    ) {
      err(addonName, `declared icon '${raw.icon}' does not exist`)
    }

    // Declared capabilities. A wrong/typo'd/removed cap name is a hard
    // error (the declared thing genuinely does not exist). The bundle
    // presence check is advisory — a self-contained addon usually
    // bundles the cap definitions it registers, so a used cap's `name`
    // string is normally in `dist/`; but some caps are wired
    // structurally (no cap-object import), so absence is a heads-up to
    // verify wiring, not a guaranteed defect.
    const caps = asArray<{ readonly name?: unknown }>(raw.capabilities)
    for (const cap of caps) {
      const capName = typeof cap?.name === 'string' ? cap.name : null
      if (!capName) {
        err(addonName, 'a capabilities[] entry has no `name`')
        continue
      }
      if (!validCaps.has(capName)) {
        err(addonName, `declares capability '${capName}' — no such capability in @camstack/types`)
        continue
      }
      if (dist.length > 0 && !dist.includes(`"${capName}"`) && !dist.includes(`'${capName}'`)) {
        warn(
          addonName,
          `declared capability '${capName}' is absent from the built bundle — verify it is registered`,
        )
      }
    }
    if (caps.length > 0 && dist.length === 0 && entryExists) {
      warn(addonName, 'capability code-scan skipped — no dist/ directory (run a build)')
    }
  }

  // Self-contained-addon dependencies (dependencies OR devDependencies).
  const declaredDeps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ])
  for (const dep of SELF_CONTAINED_DEPS) {
    if (!declaredDeps.has(dep)) {
      warn(label, `self-contained-addon dependency '${dep}' is not declared in package.json`)
    }
  }

  return findings
}

/** Addon package directories — `packages/addon-*` that actually carry a
 *  `camstack` manifest (skips non-addon scaffolding dirs). */
function discoverAddonDirs(): string[] {
  const pkgDir = join(REPO_ROOT, 'packages')
  const dirs: string[] = []
  for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('addon-')) continue
    const pkgJson = join(pkgDir, entry.name, 'package.json')
    if (!existsSync(pkgJson)) continue
    try {
      const pkg = parsePackageJson(readFileSync(pkgJson, 'utf8'))
      if (pkg.camstack) dirs.push(join(pkgDir, entry.name))
    } catch {
      /* skip unreadable package.json */
    }
  }
  return dirs
}

function main(): void {
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const targets = all
    ? discoverAddonDirs()
    : args.filter((a) => !a.startsWith('--')).map((a) => resolve(a))

  if (targets.length === 0) {
    console.error('Usage: validate-addon <addon-dir> | --all')
    process.exit(2)
  }

  const validCaps = collectValidCapNames()
  if (validCaps.size === 0) {
    console.error('validate-addon: could not collect capability names from @camstack/types')
    process.exit(2)
  }

  const findings: Finding[] = []
  for (const dir of targets) findings.push(...validateAddon(dir, validCaps))

  const errors = findings.filter((f) => f.level === 'error')
  const warnings = findings.filter((f) => f.level === 'warn')

  for (const f of findings) {
    console.log(`  [${f.level === 'error' ? 'ERROR' : 'WARN '}] ${f.addon}: ${f.message}`)
  }
  console.log(
    `\nvalidate-addon: ${targets.length} addon package(s) — ` +
      `${errors.length} error(s), ${warnings.length} warning(s)`,
  )
  process.exit(errors.length > 0 ? 1 : 0)
}

main()
