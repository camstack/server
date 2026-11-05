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
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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

function allowed(rel: string): boolean {
  if (rel === path.join('scripts', 'check-no-integration-settings.ts')) return true
  if (rel.includes(`${path.sep}migrations${path.sep}`)) return true
  if (rel.startsWith(path.join('docs', 'decisions') + path.sep)) return true
  if (rel.startsWith(path.join('docs', 'architecture') + path.sep)) return true
  if (rel.startsWith(path.join('docs', 'design') + path.sep)) return true
  // The drop's own spec has to name the store it proves is gone.
  if (rel.endsWith('migration-drop-integration-settings.spec.ts')) return true
  // The developer kit teaches that the store is retired, and its specs prove the
  // scaffolds and the knowledge index say so.
  if (rel === path.join('packages', 'develop', 'skills', 'camstack-addon.md')) return true
  if (rel === path.join('packages', 'develop', 'src', 'scaffold', 'addon.ts')) return true
  if (rel === path.join('packages', 'develop', 'src', '__tests__', 'integration-scaffold.spec.ts'))
    return true
  if (rel === path.join('packages', 'mcp-dev', 'src', '__tests__', 'knowledge.spec.ts')) return true
  return false
}

/** Tracked sources only: build output and local data dirs are not the repo. */
function trackedFiles(roots: readonly string[]): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...roots], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return out
    .split('\0')
    .filter((rel) => rel !== '' && /\.(ts|tsx|js|mjs|yml|yaml|md)$/.test(rel))
    .filter((rel) => !rel.split('/').some((part) => part === 'generated'))
    .filter((rel) => existsSync(path.join(ROOT, rel)))
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
  const files = trackedFiles(roots).map((rel) => ({
    rel: path.normalize(rel),
    text: readFileSync(path.join(ROOT, rel), 'utf8'),
  }))
  const violations = integrationSettingsViolations(files)
  if (violations.length > 0) {
    console.error(
      `check-no-integration-settings: ${violations.length} reference(s) outside migrations, the drop spec, and history docs`,
    )
    for (const line of violations) console.error(`  ${line}`)
    process.exit(1)
  }
  console.log(
    'check-no-integration-settings: no legacy integration settings store outside migrations, the drop spec, and history docs',
  )
}

const isMain = process.argv[1]?.endsWith('check-no-integration-settings.ts') === true
if (isMain) main()
