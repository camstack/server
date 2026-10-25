#!/usr/bin/env tsx
/**
 * Spec-typecheck guard — every spec file a package carries is inside the tsc
 * program its `typecheck` script runs.
 *
 * ## The failure this catches
 *
 * Most packages' `tsconfig.json` excludes `**\/__tests__/**` and
 * `**\/*.test.ts` (the build must not emit specs), and that same file was the
 * one `typecheck` ran. vitest strips types without checking them. So a spec
 * could call a method that no longer exists, build a fixture missing half its
 * fields, or pass a string where a number goes, and nothing in the repository
 * would say so: on 2026-10-01 the first typecheck over the specs reported
 * 1 762 errors in 500 spec files of seven packages (addon-pipeline 656,
 * addon-post-analysis 650, server/backend 319, types 86, system 43, desktop 7,
 * addon-decoder-nodeav 1)
 * — fixtures that drifted from the types they claim to exercise, which is the
 * shape of the "green test, fake supplied what production forgot" failures
 * AGENTS.md warns about.
 *
 * ## What it checks, per workspace package that has spec files
 *
 *   1. `tsconfig.spec.json` exists;
 *   2. the `typecheck` script runs it (`-p tsconfig.spec.json`) — one tsc
 *      program over source AND specs, so CI pays for the specs once rather
 *      than checking every source file twice;
 *   3. every spec file on disk is in that program's file list, as TypeScript
 *      itself resolves the config (`include`/`exclude`/`extends`). A spec the
 *      config does not reach is a spec nobody typechecks.
 *
 * The CI side is `scripts/check-ci-baselines.ts`, which splits that one
 * pass's diagnostics into `typecheck` (production code, held at zero) and
 * `typecheck-specs` (per spec file, pinned and ratcheting down). D695.
 *
 * Usage: npx tsx scripts/check-specs-are-typechecked.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

import { findSpecFiles, workspacePackageDirs } from './check-specs-have-test-script.ts'
import { walkSources } from './lib/walk-sources.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
export const SPEC_TSCONFIG = 'tsconfig.spec.json'

/** The one shape a `typecheck` script may take: the spec program, then optionally more programs. */
const TYPECHECK_SCRIPT =
  /^tsc --noEmit -p tsconfig\.spec\.json(?: && tsc --noEmit -p [\w.-]+\.json)*$/

/**
 * The spec config's OWN compilerOptions, per package. It is the config the
 * PRODUCTION check runs under too (D695), so it may not loosen anything: no
 * `noCheck`, no `strict: false`, no `types`. An override exists only where the
 * package needs it, with its reason:
 *  - system, types: specs live in a package-root `__tests__/`, outside `./src`.
 *  - addon-pipeline: ONE spec helper mounts the real settings engine from
 *    system's source (`src/durable/__tests__/settings-store-api.ts`); the
 *    boundary for production files is held by check-src-imports-stay-in-package.
 *  - desktop: two specs import `scripts/*.mjs`, typed by inference from the JS.
 */
export const SPEC_CONFIG_OVERRIDES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  '@camstack/system': { rootDir: '.' },
  '@camstack/types': { rootDir: '.' },
  '@camstack/addon-pipeline': { rootDir: '../..' },
  '@camstack/desktop': { allowJs: true },
}

/** The base a spec config extends: the package's build config. */
const SPEC_CONFIG_BASES: Readonly<Record<string, string>> = {
  '@camstack/desktop': './tsconfig.main.json',
}

export interface SpecTypecheckFacts {
  readonly name: string
  readonly specFiles: readonly string[]
  readonly hasSpecConfig: boolean
  readonly typecheckScript: string | undefined
  /** Package-relative paths in the spec config's program; null when it could not be read. */
  readonly programFiles: ReadonlySet<string> | null
  /** The spec config file's own `extends` and `compilerOptions`, unresolved. */
  readonly specConfigExtends?: unknown
  readonly specConfigOptions?: Readonly<Record<string, unknown>>
}

function sameOptions(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every((k) => a[k] === b[k])
}

export function judgeSpecTypecheck(facts: SpecTypecheckFacts): readonly string[] {
  const { name, specFiles, hasSpecConfig, typecheckScript, programFiles } = facts
  if (specFiles.length === 0) return []
  if (!hasSpecConfig) {
    return [`${name}: ${specFiles.length} spec file(s) and no \`${SPEC_TSCONFIG}\``]
  }
  const failures: string[] = []
  if (typecheckScript === undefined || !TYPECHECK_SCRIPT.test(typecheckScript)) {
    failures.push(
      `${name}: \`typecheck\` does not run \`${SPEC_TSCONFIG}\` as \`tsc --noEmit -p ${SPEC_TSCONFIG}\` (${typecheckScript ?? 'no script'}) — the specs are not reliably typechecked`,
    )
  }
  const expectedBase = SPEC_CONFIG_BASES[name] ?? './tsconfig.json'
  if (facts.specConfigExtends !== undefined && facts.specConfigExtends !== expectedBase) {
    failures.push(`${name}: \`${SPEC_TSCONFIG}\` must extend \`${expectedBase}\``)
  }
  const allowed = SPEC_CONFIG_OVERRIDES[name] ?? {}
  if (facts.specConfigOptions !== undefined && !sameOptions(facts.specConfigOptions, allowed)) {
    failures.push(
      `${name}: \`${SPEC_TSCONFIG}\` sets compilerOptions ${JSON.stringify(facts.specConfigOptions)} — it is the production check's config too, so it may set only ${JSON.stringify(allowed)}`,
    )
  }
  if (programFiles === null) {
    failures.push(`${name}: \`${SPEC_TSCONFIG}\` could not be parsed`)
    return failures
  }
  const missed = specFiles.filter((f) => !programFiles.has(f))
  if (missed.length > 0) {
    failures.push(
      `${name}: ${missed.length} spec file(s) outside \`${SPEC_TSCONFIG}\` — e.g. ${missed.slice(0, 3).join(', ')}`,
    )
  }
  return failures
}

/**
 * Ambient declarations a TEST file may make. Test files join the production
 * program (D695), and an ambient `declare module 'x'` OVERRIDES the real
 * resolution of `x` for every file in it — verified: a shorthand
 * `declare module '@camstack/types'` in a backend test silently typed the
 * whole program's `@camstack/types` imports as `any`. So: matcher type
 * augmentation only, plus the backend's untyped-addon shim, which is allowed
 * only while no production file of that package imports those modules.
 */
const ALLOWED_TEST_REFERENCE_TYPES: ReadonlySet<string> = new Set(['@testing-library/jest-dom'])
const ALLOWED_TEST_MODULE_AUGMENTATIONS: ReadonlySet<string> = new Set(['vitest'])
const ALLOWED_TEST_SHORTHAND_MODULES: Readonly<Record<string, ReadonlySet<string>>> = {
  '@camstack/server': new Set([
    '@camstack/addon-admin-ui/server/addon',
    '@camstack/addon-auth/oidc',
    '@camstack/addon-benchmark',
    '@camstack/addon-mqtt-broker',
    '@camstack/addon-pipeline/stream-broker',
  ]),
}

export interface AmbientDeclaration {
  readonly file: string
  readonly kind: 'reference-types' | 'module' | 'global'
  /** The module name; `''` for `declare global`. */
  readonly target: string
}

const REFERENCE_TYPES = /\/\/\/\s*<reference\s+types="([^"]+)"/g
const DECLARE_MODULE = /^\s*declare\s+module\s+['"]([^'"]+)['"]/gm
const DECLARE_GLOBAL = /^\s*declare\s+global\b/gm

/** Every ambient declaration in a test file's source. */
export function ambientDeclarationsIn(file: string, source: string): readonly AmbientDeclaration[] {
  const out: AmbientDeclaration[] = []
  for (const m of source.matchAll(REFERENCE_TYPES)) {
    out.push({ file, kind: 'reference-types', target: m[1] ?? '' })
  }
  for (const m of source.matchAll(DECLARE_MODULE)) {
    out.push({ file, kind: 'module', target: m[1] ?? '' })
  }
  for (const _ of source.matchAll(DECLARE_GLOBAL)) out.push({ file, kind: 'global', target: '' })
  return out
}

export function judgeAmbientDeclarations(
  name: string,
  declarations: readonly AmbientDeclaration[],
  productionImports: ReadonlySet<string>,
): readonly string[] {
  const failures: string[] = []
  const shorthand = ALLOWED_TEST_SHORTHAND_MODULES[name] ?? new Set<string>()
  for (const d of declarations) {
    if (d.kind === 'reference-types' && ALLOWED_TEST_REFERENCE_TYPES.has(d.target)) continue
    if (d.kind === 'module' && ALLOWED_TEST_MODULE_AUGMENTATIONS.has(d.target)) continue
    if (d.kind === 'module' && shorthand.has(d.target)) {
      if (productionImports.has(d.target)) {
        failures.push(
          `${name}: ${d.file} declares '${d.target}' ambient while production code imports it — the declaration would type those imports for the whole program`,
        )
      }
      continue
    }
    const what = d.kind === 'global' ? 'declare global' : `${d.kind} '${d.target}'`
    failures.push(
      `${name}: ${d.file} makes an ambient declaration (${what}) — a test file joins the production program and would change its types`,
    )
  }
  return failures
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

/** Bare module specifiers production files of `dir` import. */
function productionImportsOf(dir: string): ReadonlySet<string> {
  const out = new Set<string>()
  for (const f of walkSources(ROOT, [dir])) {
    for (const m of f.code.matchAll(IMPORT_SPECIFIER)) if (m[1]) out.add(m[1])
  }
  return out
}

function testFilesOf(dir: string): readonly { rel: string; source: string }[] {
  return walkSources(ROOT, [dir], { includeTests: true, includeDeclarations: true }).filter((f) =>
    /(^|\/)__tests__\/|\.(spec|test)\.[cm]?[jt]sx?$/.test(f.rel),
  )
}

/** The program's root files, package-relative, as TypeScript resolves the config. */
function programFilesOf(packageDir: string): ReadonlySet<string> | null {
  const configPath = path.join(packageDir, SPEC_TSCONFIG)
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  )
  if (parsed === undefined) return null
  return new Set(
    parsed.fileNames.map((f) => path.relative(packageDir, f).split(path.sep).join('/')),
  )
}

interface PackageManifest {
  readonly name?: unknown
  readonly scripts?: unknown
}

function isPackageManifest(value: unknown): value is PackageManifest {
  return typeof value === 'object' && value !== null
}

function scriptOf(manifest: PackageManifest, script: string): string | undefined {
  const scripts = manifest.scripts
  if (typeof scripts !== 'object' || scripts === null) return undefined
  const body = Reflect.get(scripts, script)
  return typeof body === 'string' ? body : undefined
}

function main(): void {
  const failures: string[] = []
  let checked = 0
  for (const dir of workspacePackageDirs(ROOT)) {
    const abs = path.join(ROOT, dir)
    const specFiles = findSpecFiles(abs)
    if (specFiles.length === 0) continue
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf-8'))
    if (!isPackageManifest(manifest)) continue
    const hasSpecConfig = fs.existsSync(path.join(abs, SPEC_TSCONFIG))
    const name = typeof manifest.name === 'string' ? manifest.name : dir
    const raw: unknown = hasSpecConfig
      ? JSON.parse(fs.readFileSync(path.join(abs, SPEC_TSCONFIG), 'utf-8'))
      : null
    const specConfigExtends = isPackageManifest(raw) ? Reflect.get(raw, 'extends') : undefined
    const rawOptions = isPackageManifest(raw) ? Reflect.get(raw, 'compilerOptions') : undefined
    const specConfigOptions: Record<string, unknown> = {}
    if (typeof rawOptions === 'object' && rawOptions !== null) {
      for (const [k, v] of Object.entries(rawOptions)) specConfigOptions[k] = v
    }
    checked++
    failures.push(
      ...judgeSpecTypecheck({
        name,
        specFiles,
        hasSpecConfig,
        typecheckScript: scriptOf(manifest, 'typecheck'),
        programFiles: hasSpecConfig ? programFilesOf(abs) : null,
        ...(hasSpecConfig ? { specConfigExtends, specConfigOptions } : {}),
      }),
    )
    const declarations = testFilesOf(dir).flatMap((f) => ambientDeclarationsIn(f.rel, f.source))
    if (declarations.length > 0) {
      failures.push(...judgeAmbientDeclarations(name, declarations, productionImportsOf(dir)))
    }
  }
  if (failures.length > 0) {
    console.error('✘ spec files nothing typechecks:')
    for (const f of failures) console.error(`    ${f}`)
    console.error(
      `  Give the package a \`${SPEC_TSCONFIG}\` that extends its tsconfig.json and includes\n` +
        `  the specs, and make \`typecheck\` run \`tsc --noEmit -p ${SPEC_TSCONFIG}\`.`,
    )
    process.exit(1)
  }
  console.log(
    `✔ ${checked} packages with specs, every spec file inside the program \`typecheck\` runs`,
  )
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main()
}
