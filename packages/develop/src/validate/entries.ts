import * as fs from 'node:fs'
import * as path from 'node:path'
import { asRecord, readJsonFile } from '../workspace.js'
import type { ValidationFinding, ValidationResult } from '../types.js'

/**
 * Port of `scripts/check-addon-entries.ts` as a library API (no process.exit).
 * Every `camstack.addons[].entry` must have a source file and, when the
 * package uses an explicit vite `entries` map, a matching key.
 */
export function checkAddonEntries(workspaceRoot: string, packageDir?: string): ValidationResult {
  const findings: ValidationFinding[] = []
  const targets =
    packageDir !== undefined ? [path.resolve(packageDir)] : collectPackageDirs(workspaceRoot)

  for (const pkgDir of targets) {
    checkPackage(pkgDir, findings)
  }

  return {
    ok: findings.every((f) => f.level !== 'error'),
    findings,
  }
}

function collectPackageDirs(workspaceRoot: string): readonly string[] {
  const out: string[] = []
  for (const root of ['packages', 'server']) {
    const rootDir = path.join(workspaceRoot, root)
    if (!fs.existsSync(rootDir)) continue
    for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(path.join(rootDir, entry.name))
    }
  }
  return out
}

function viteEntryKeys(pkgDir: string): ReadonlySet<string> | null {
  const configPath = path.join(pkgDir, 'vite.config.ts')
  if (!fs.existsSync(configPath)) return null
  const source = fs.readFileSync(configPath, 'utf-8')
  const block = /entries\s*[:=]\s*\{([\s\S]*?)\n\s*\}/.exec(source)
  if (!block?.[1]) return null
  const keys = new Set<string>()
  for (const match of block[1].matchAll(/(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*:/g)) {
    const key = match[1] ?? match[2]
    if (key !== undefined) keys.add(key)
  }
  return keys.size > 0 ? keys : null
}

function entryToStem(entry: string): string | null {
  const match = /^\.?\/?dist\/(.+)\.(?:js|mjs|cjs)$/.exec(entry)
  return match?.[1] ?? null
}

function checkPackage(pkgDir: string, findings: ValidationFinding[]): void {
  const pkg = readJsonFile(path.join(pkgDir, 'package.json'))
  if (!pkg) return
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
      findings.push({
        level: 'error',
        code: 'missing-entry',
        message: `${pkgName} → ${addonId}: manifest has no \`entry\``,
        path: pkgDir,
      })
      continue
    }

    const stem = entryToStem(entry)
    if (stem === null) {
      findings.push({
        level: 'error',
        code: 'bad-entry-shape',
        message: `${pkgName} → ${addonId}: entry \`${entry}\` is not ./dist/<path>.js`,
        path: pkgDir,
      })
      continue
    }

    const candidates = [`src/${stem}.ts`, `src/${stem}.tsx`, `src/${stem}/index.ts`]
    const sourceRel = candidates.find((c) => fs.existsSync(path.join(pkgDir, c)))
    if (sourceRel === undefined) {
      findings.push({
        level: 'error',
        code: 'missing-source',
        message:
          `${pkgName} → ${addonId}: entry \`${entry}\` has no source — expected one of ` +
          candidates.join(', '),
        path: pkgDir,
      })
      continue
    }

    if (entryKeys !== null && !entryKeys.has(stem)) {
      findings.push({
        level: 'error',
        code: 'missing-vite-entry',
        message:
          `${pkgName} → ${addonId}: entry \`${entry}\` is never built — add ` +
          `'${stem}': '${sourceRel}' to vite.config.ts entries map`,
        path: path.join(pkgDir, 'vite.config.ts'),
      })
    }
  }
}
