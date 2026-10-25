#!/usr/bin/env tsx
/**
 * Registration guard — a capability an addon REGISTERS at runtime must also be
 * DECLARED in a manifest of the same package.
 *
 * ## The failure this catches
 *
 * `onInitialize` returns `ProviderRegistration[]`, and the registry accepts
 * whatever it is handed. The manifest's `capabilities[]` is a separate, plain
 * JSON list. Nothing connects the two, so a provider can be live in the registry
 * while every derived surface — `docs/reference/capabilities.md`, the addon
 * catalog, anything that reasons about a package before it boots — believes the
 * capability does not exist there.
 *
 * Written immediately after paying for it. `vector-store` was folded into the
 * `sqlite-settings` builtin; the code returned the registration, the manifest was
 * never updated, and the retired standalone addon was never uninstalled from the
 * nodes. Two providers then served the same SINGLETON capability from two
 * different tables of the same database: the active one was empty and threw
 * "index was never declared" on every direct call, while every write landed in
 * the other. It read as a routing mystery for a full session. The manifest miss
 * is the half a guard can see.
 *
 * ## What it checks
 *
 * Per package (not per addon — see below), it compares:
 *
 *   REGISTERED — every `<x>Capability` identifier that appears inside an object
 *                literal that also has a `provider:` key. That is the
 *                `ProviderRegistration` shape and nothing else uses it.
 *   DECLARED   — every name in every `camstack.addons[].capabilities[]` of that
 *                package's `package.json`.
 *
 * A REGISTERED capability declared by NO manifest in the package is a violation.
 *
 * ## Deliberately per-package, not per-addon
 *
 * Mapping a registration back to the specific addon that performs it would mean
 * resolving each manifest `entry` to its source and following re-exports — an
 * addon class rarely lives in the file the entry names. The per-package form is
 * strictly weaker (it cannot catch a cap declared on the WRONG addon inside one
 * package) and has no false positives, which is the property that decides
 * whether a guard survives. It catches the real bug: the miss above is invisible
 * to every manifest in `@camstack/system`.
 *
 * Usage: tsx scripts/check-registered-caps-declared.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CAP_DIR = path.join(ROOT, 'packages/types/src/capabilities')

interface Problem {
  readonly pkg: string
  readonly capName: string
  readonly identifier: string
  readonly where: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
  return asRecord(parsed) ?? {}
}

/**
 * `vectorStoreCapability` → `vector-store`, read from the cap definitions.
 *
 * Textual rather than by import: these files are the authoritative source and
 * importing the barrel would drag the whole type package into a check that has
 * to stay fast enough for a hook.
 */
function capabilityNamesByIdentifier(): ReadonlyMap<string, string> {
  const map = new Map<string, string>()
  if (!fs.existsSync(CAP_DIR)) return map
  for (const file of fs.readdirSync(CAP_DIR)) {
    if (!file.endsWith('.cap.ts')) continue
    const source = fs.readFileSync(path.join(CAP_DIR, file), 'utf-8')
    for (const match of source.matchAll(
      /export\s+const\s+([A-Za-z_$][\w$]*Capability)\s*=\s*\{[\s\S]*?name:\s*['"]([^'"]+)['"]/g,
    )) {
      const identifier = match[1]
      const name = match[2]
      if (identifier !== undefined && name !== undefined) map.set(identifier, name)
    }
  }
  return map
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') {
        continue
      }
      sourceFiles(full, out)
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
}

/**
 * Capability identifiers used in a `ProviderRegistration` literal.
 *
 * Anchored on `provider:` because that key is what makes the literal a
 * registration. A bare mention of `fooCapability` — a type import, a comparison,
 * a `ctx.capabilities.get(fooCapability)` lookup — is NOT a registration and
 * must not be flagged; requiring the sibling key is what keeps this quiet.
 */
function registeredIdentifiers(source: string): ReadonlySet<string> {
  const found = new Set<string>()
  // Object literals shallow enough to hold `capability:` and `provider:` as
  // siblings. Non-greedy to the first closing brace at the same nesting the
  // house style produces: `{ capability: xCapability, provider: y }`.
  for (const match of source.matchAll(/\{[^{}]*?\bprovider\s*:[^{}]*?\}/g)) {
    const literal = match[0]
    for (const ident of literal.matchAll(/\b([A-Za-z_$][\w$]*Capability)\b/g)) {
      const name = ident[1]
      if (name !== undefined) found.add(name)
    }
  }
  return found
}

function declaredCapabilities(pkg: Record<string, unknown>): ReadonlySet<string> {
  const declared = new Set<string>()
  const addons = asRecord(pkg['camstack'])?.['addons']
  if (!Array.isArray(addons)) return declared
  for (const rawAddon of addons) {
    const addon = asRecord(rawAddon)
    const caps = addon?.['capabilities']
    if (!Array.isArray(caps)) continue
    for (const rawCap of caps) {
      const cap = asRecord(rawCap)
      const name = cap?.['name']
      if (typeof name === 'string') declared.add(name)
    }
  }
  return declared
}

function checkPackage(
  pkgDir: string,
  capNames: ReadonlyMap<string, string>,
  problems: Problem[],
): void {
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return
  const pkg = readJson(pkgJsonPath)
  const addons = asRecord(pkg['camstack'])?.['addons']
  if (!Array.isArray(addons) || addons.length === 0) return

  const pkgName = typeof pkg['name'] === 'string' ? pkg['name'] : path.basename(pkgDir)
  const declared = declaredCapabilities(pkg)

  const files: string[] = []
  sourceFiles(path.join(pkgDir, 'src'), files)

  const seen = new Set<string>()
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8')
    for (const identifier of registeredIdentifiers(source)) {
      const capName = capNames.get(identifier)
      // An identifier this script cannot resolve to a cap definition is not a
      // finding — it is a gap in THIS script, and reporting it would train
      // people to ignore the output.
      if (capName === undefined) continue
      if (declared.has(capName)) continue
      const key = `${pkgName}:${capName}`
      if (seen.has(key)) continue
      seen.add(key)
      problems.push({
        pkg: pkgName,
        capName,
        identifier,
        where: path.relative(ROOT, file),
      })
    }
  }
}

function main(): void {
  const capNames = capabilityNamesByIdentifier()
  if (capNames.size === 0) {
    console.error('\x1b[31m✘ no capability definitions found — check CAP_DIR\x1b[0m')
    process.exit(1)
  }

  const problems: Problem[] = []
  for (const root of ['packages', 'server']) {
    const rootDir = path.join(ROOT, root)
    if (!fs.existsSync(rootDir)) continue
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (entry.isDirectory()) checkPackage(path.join(rootDir, entry.name), capNames, problems)
    }
  }

  if (problems.length > 0) {
    console.error(`\x1b[31m✘ ${problems.length} capability registered but never declared\x1b[0m:`)
    for (const p of problems) {
      console.error(
        `    ${p.pkg}: registers \`${p.capName}\` (${p.identifier}) in ${p.where}, ` +
          `but no manifest in this package declares it. Add ` +
          `{ "name": "${p.capName}" } to the owning addon's \`capabilities[]\`.`,
      )
    }
    process.exit(1)
  }
  console.log('  ✔ every registered capability is declared in a manifest')
}

main()
