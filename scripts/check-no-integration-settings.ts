#!/usr/bin/env tsx
/**
 * The legacy integration settings store stays deleted (planning#416, D1007).
 *
 * Every integration's configuration is its instance record. `integration_settings`,
 * the `integration-settings` record kind, and `integrations.getSettings` /
 * `setSettings` / `clearSettings` are not a second path. The per-addon migrations
 * that copied the rows, and the history of that store, may still name it.
 *
 * Usage: npx tsx scripts/check-no-integration-settings.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const FORBIDDEN: readonly RegExp[] = [
  /integration_settings/,
  /['"]integration-settings['"]/,
  /integrations\.getSettings/,
  /integrations\.setSettings/,
  /integrations\.clearSettings/,
  /integrationSettingsSchema/,
  /\bsetIntegrationSettings\b/,
  /\bclearIntegrationSettings\b/,
  /\bsetIntegrationSetting\b/,
  /getIntegrationSettings\(integrationId/,
]

const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.git', 'coverage', 'scratchpad'])

function allowed(rel: string): boolean {
  if (rel === path.join('scripts', 'check-no-integration-settings.ts')) return true
  if (rel.includes(`${path.sep}migrations${path.sep}`)) return true
  if (rel.startsWith(`docs${path.sep}`)) return true
  if (rel.includes(`${path.sep}generated${path.sep}`)) return true
  return false
}

function filesUnder(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      out.push(...filesUnder(full))
      continue
    }
    if (/\.(ts|tsx|js|mjs|yml|yaml|md)$/.test(name)) out.push(full)
  }
  return out
}

export function integrationSettingsViolations(
  files: readonly { readonly rel: string; readonly text: string }[],
): readonly string[] {
  const out: string[] = []
  for (const file of files) {
    if (allowed(file.rel)) continue
    const lines = file.text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? ''
      if (line.includes('addonSettings.getIntegrationSettings')) continue
      for (const pattern of FORBIDDEN) {
        if (pattern.test(line)) {
          out.push(`${file.rel}:${i + 1}: ${line.trim()}`)
          break
        }
      }
    }
  }
  return out
}

function main(): void {
  const roots = ['packages', 'server', 'scripts', '.github']
  const files = roots.flatMap((root) =>
    filesUnder(path.join(ROOT, root)).map((full) => ({
      rel: path.relative(ROOT, full),
      text: readFileSync(full, 'utf8'),
    })),
  )
  const violations = integrationSettingsViolations(files)
  if (violations.length > 0) {
    console.error(
      `check-no-integration-settings: ${violations.length} reference(s) outside migrations and docs`,
    )
    for (const line of violations) console.error(`  ${line}`)
    process.exit(1)
  }
  console.log(
    'check-no-integration-settings: no legacy integration settings store outside migrations and docs',
  )
}

const isMain = process.argv[1]?.endsWith('check-no-integration-settings.ts') === true
if (isMain) main()
