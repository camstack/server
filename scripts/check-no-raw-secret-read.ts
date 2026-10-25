#!/usr/bin/env tsx
/**
 * Addon code never reads its settings through a MARKER-bearing view (D798).
 *
 * ## The failure this catches
 *
 * After the keychain migration a settings blob holds `{ "$secret": "secret://…" }`
 * where a secret used to be. Three addons read their config raw in one evening
 * and got the marker instead of the value: Wyze (no schema), ONVIF
 * (`_getAddonConfig()`), Reolink (`resolveGlobalStore()` → "absent" → a new
 * password minted and saved ~233 times a minute).
 *
 * The root fix makes every addon-facing read resolve markers: `this.ctx.settings`
 * (all reads), `resolveGlobalStore()`, `readStoredGlobalKey()`, `state()`,
 * `this.config`. The marker-bearing view still exists — `BaseAddon` needs it
 * for the form hydrate and config resolution — but only as PRIVATE members of
 * `BaseAddon`. This guard keeps it that way. In every non-test `.ts` under
 * `packages/addon-*\/src` and `packages/system/src/builtins` it fails on:
 *
 *  - `context-bypass` — an `initialize(context)` override that reads
 *    `context.settings`. That parameter is the kernel's context BEFORE
 *    `BaseAddon` wraps it: its reads answer markers. Use `this.ctx.settings`
 *    (after `super.initialize(context)`) or the `BaseAddon` helpers.
 *  - `private-raw-surface` — any reference to `BaseAddon`'s private raw
 *    members (`_secretSettings`, `rawSettings`, `readRawProjectedStore`) or
 *    to the raw half of a secret-aware handle (`.raw.readAddonStore`,
 *    `.raw.readDeviceStore`), and any use of `createSecretAwareContext`.
 *
 * Exceptions are pinned in {@link ALLOWLIST} with a reason; a stale entry
 * fails too.
 *
 * Usage: npx tsx scripts/check-no-raw-secret-read.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

export type RuleId = 'context-bypass' | 'private-raw-surface'

export interface Finding {
  readonly file: string
  readonly line: number
  readonly rule: RuleId
  readonly text: string
}

export function findingId(f: Finding): string {
  return `${f.file}#${f.rule}#${f.text}`
}

export const ALLOWLIST: ReadonlyMap<string, string> = new Map<string, string>()

/** `BaseAddon`'s private raw members and the secret-aware wrapper factory. */
const PRIVATE_RAW_NAMES: ReadonlySet<string> = new Set([
  '_secretSettings',
  'rawSettings',
  'readRawProjectedStore',
  'createSecretAwareContext',
])

const RAW_HANDLE_READS: ReadonlySet<string> = new Set(['readAddonStore', 'readDeviceStore'])

function nameOf(node: ts.Expression | ts.MemberName): string | null {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text
  if (ts.isStringLiteralLike(node)) return node.text
  return null
}

/** `x.settings` / `x['settings']` where `x` is the identifier `param`. */
function readsSettingsOf(node: ts.Node, param: string): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return (
      ts.isIdentifier(node.expression) &&
      node.expression.text === param &&
      node.name.text === 'settings'
    )
  }
  if (ts.isElementAccessExpression(node)) {
    return (
      ts.isIdentifier(node.expression) &&
      node.expression.text === param &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'settings'
    )
  }
  return false
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function contextBypasses(sf: ts.SourceFile, file: string, out: Finding[]): void {
  const visit = (n: ts.Node): void => {
    if (
      ts.isMethodDeclaration(n) &&
      nameOf(n.name as ts.MemberName) === 'initialize' &&
      n.body !== undefined
    ) {
      const first = n.parameters[0]
      if (first !== undefined && ts.isIdentifier(first.name)) {
        const param = first.name.text
        const inBody = (m: ts.Node): void => {
          if (readsSettingsOf(m, param)) {
            out.push({ file, line: lineOf(sf, m), rule: 'context-bypass', text: m.getText(sf) })
          }
          ts.forEachChild(m, inBody)
        }
        inBody(n.body)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

function privateRawSurface(sf: ts.SourceFile, file: string, out: Finding[]): void {
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text
      const viaRawHandle =
        RAW_HANDLE_READS.has(name) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'raw'
      if (PRIVATE_RAW_NAMES.has(name) || viaRawHandle) {
        out.push({ file, line: lineOf(sf, n), rule: 'private-raw-surface', text: n.getText(sf) })
      }
    } else if (ts.isIdentifier(n) && n.text === 'createSecretAwareContext') {
      const parent = n.parent
      if (!(parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === n)) {
        out.push({ file, line: lineOf(sf, n), rule: 'private-raw-surface', text: n.text })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

export function findRawSecretReads(file: string, text: string): readonly Finding[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out: Finding[] = []
  contextBypasses(sf, file, out)
  privateRawSurface(sf, file, out)
  return out
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !/\.(spec|test)\.ts$/.test(name)) {
      out.push(abs)
    }
  }
}

function sourceRoots(root: string): string[] {
  const pkgs = join(root, 'packages')
  const roots: string[] = []
  for (const name of readdirSync(pkgs)) {
    if (!name.startsWith('addon-')) continue
    const src = join(pkgs, name, 'src')
    if (existsSync(src)) roots.push(src)
  }
  const builtins = join(pkgs, 'system', 'src', 'builtins')
  if (existsSync(builtins)) roots.push(builtins)
  return roots
}

const NEEDLES = ['initialize', ...PRIVATE_RAW_NAMES, '.raw.']

export function scanRepo(root: string): readonly Finding[] {
  const files: string[] = []
  for (const dir of sourceRoots(root)) walk(dir, files)
  const out: Finding[] = []
  for (const abs of files) {
    const text = readFileSync(abs, 'utf8')
    if (!NEEDLES.some((needle) => text.includes(needle))) continue
    out.push(...findRawSecretReads(relative(root, abs), text))
  }
  return out
}

export interface GuardResult {
  readonly violations: readonly Finding[]
  readonly stale: readonly string[]
}

export function evaluate(
  findings: readonly Finding[],
  allowlist: ReadonlyMap<string, string> = ALLOWLIST,
): GuardResult {
  const ids = new Set(findings.map(findingId))
  return {
    violations: findings.filter((f) => !allowlist.has(findingId(f))),
    stale: [...allowlist.keys()].filter((id) => !ids.has(id)),
  }
}

const ADVICE: Record<RuleId, string> = {
  'context-bypass':
    "reads the kernel's UNWRAPPED context — its settings reads answer keychain markers. Call super.initialize(context) and use this.ctx.settings / this.resolveGlobalStore()",
  'private-raw-surface':
    "reaches BaseAddon's private marker-bearing view. Addon code reads resolved values: this.ctx.settings, this.resolveGlobalStore(), this.state(), this.config",
}

function main(): void {
  const { violations, stale } = evaluate(scanRepo(process.cwd()))
  if (violations.length === 0 && stale.length === 0) {
    console.log('✔ no addon code reads its settings through a marker-bearing view')
    return
  }
  for (const f of violations) {
    console.error(`✘ ${f.file}:${f.line} [${f.rule}] \`${f.text}\` ${ADVICE[f.rule]}`)
  }
  for (const id of stale) console.error(`✘ stale allowlist entry (fixed — remove it): ${id}`)
  console.error('\nKeychain values reach addon code resolved, never as { $secret } markers (D798).')
  process.exit(1)
}

if (process.argv[1]?.endsWith('check-no-raw-secret-read.ts')) main()
