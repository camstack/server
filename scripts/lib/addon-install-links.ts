/**
 * Pure parts of `check-addon-install-links.ts` — find every place a UI offers
 * "install an addon for capability X" and judge it against what published
 * addon packages declare.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export type InstallReferenceKind = 'install-capability' | 'catalog-href'

export interface InstallReference {
  readonly file: string
  readonly line: number
  readonly kind: InstallReferenceKind
  /** The capability named, or `null` when the argument is not a literal or a same-file constant. */
  readonly capability: string | null
}

export interface CatalogLiteral {
  readonly file: string
  readonly line: number
}

const INSTALL_CAPABILITY = /install:\s*\{\s*capability:\s*([^,}]+)/g
const CATALOG_HREF_CALL = /addonCatalogHref\(\s*([^)]*?)\s*\)/g
const CATALOG_LITERAL = /\/system\/addons\?capability=/
const STRING_LITERAL = /^(['"`])([^'"`$]+)\1$/
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function resolveConstant(source: string, name: string): string | null {
  const declaration = new RegExp(
    `\\bconst\\s+${name}(?::\\s*[\\w.]+)?\\s*=\\s*(['"\`])([^'"\`$]+)\\1`,
  )
  return declaration.exec(source)?.[2] ?? null
}

/** The capability an argument expression names, or null when it is computed. */
export function resolveCapabilityExpression(source: string, expression: string): string | null {
  const text = expression.trim()
  const literal = STRING_LITERAL.exec(text)
  if (literal !== null) return literal[2] ?? null
  if (IDENTIFIER.test(text)) return resolveConstant(source, text)
  return null
}

export function findInstallReferences(file: string, source: string): readonly InstallReference[] {
  const found: InstallReference[] = []
  for (const match of source.matchAll(INSTALL_CAPABILITY)) {
    found.push({
      file,
      line: lineOf(source, match.index ?? 0),
      kind: 'install-capability',
      capability: resolveCapabilityExpression(source, match[1] ?? ''),
    })
  }
  for (const match of source.matchAll(CATALOG_HREF_CALL)) {
    const argument = match[1] ?? ''
    // The declaration `addonCatalogHref(capability: string)` is not a call.
    if (/^\w+\s*:/.test(argument)) continue
    found.push({
      file,
      line: lineOf(source, match.index ?? 0),
      kind: 'catalog-href',
      capability: resolveCapabilityExpression(source, argument),
    })
  }
  return found
}

export function findCatalogLiterals(file: string, source: string): readonly CatalogLiteral[] {
  const found: CatalogLiteral[] = []
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
    if (CATALOG_LITERAL.test(text)) found.push({ file, line: index + 1 })
  })
  return found
}

interface PackageManifest {
  readonly camstack?: {
    readonly addons?: readonly {
      readonly capabilities?: readonly (string | { readonly name?: string })[]
    }[]
  }
}

/** Capability names declared by `camstack.addons[].capabilities` of one manifest. */
export function declaredCapabilitiesOf(manifest: PackageManifest): readonly string[] {
  const names: string[] = []
  for (const addon of manifest.camstack?.addons ?? []) {
    for (const cap of addon.capabilities ?? []) {
      const name = typeof cap === 'string' ? cap : cap.name
      if (name !== undefined && name.length > 0) names.push(name)
    }
  }
  return names
}

/** Every capability a non-framework `packages/addon-*` package declares. */
export function loadInstallableCapabilities(root: string): ReadonlySet<string> {
  const packagesDir = path.join(root, 'packages')
  const names = new Set<string>()
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('addon-')) continue
    const manifestPath = path.join(packagesDir, entry.name, 'package.json')
    if (!fs.existsSync(manifestPath)) continue
    const manifest: PackageManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    for (const name of declaredCapabilitiesOf(manifest)) names.add(name)
  }
  return names
}

export interface InstallLinkInputs {
  readonly references: readonly InstallReference[]
  readonly literals: readonly CatalogLiteral[]
  readonly installable: ReadonlySet<string>
  /** Files allowed to spell the catalog URL. */
  readonly allowedLiteralFiles: ReadonlySet<string>
}

export function judgeInstallLinks(inputs: InstallLinkInputs): readonly string[] {
  const problems: string[] = []
  for (const ref of inputs.references) {
    if (ref.capability === null) continue
    if (!inputs.installable.has(ref.capability)) {
      problems.push(
        `${ref.file}:${ref.line} offers to install "${ref.capability}", but no packages/addon-* package declares that capability`,
      )
    }
  }
  for (const literal of inputs.literals) {
    if (inputs.allowedLiteralFiles.has(literal.file)) continue
    problems.push(
      `${literal.file}:${literal.line} spells the addon-catalog URL — use addonCatalogHref()`,
    )
  }
  return problems
}
