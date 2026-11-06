#!/usr/bin/env tsx
/**
 * No addon-level settings (planning#440 step 8 / M5, D986).
 *
 * An addon has no settings of its own. Every value lives in its owner's scope: a cluster, node, device
 * or integration-instance row (`clusterSettingsSchema`, `nodeSettingsSchema`, an instance kind's
 * body). The hooks that gave an addon one global form are retired:
 *
 * - `globalSettingsSchema` (the addon's single settings form),
 * - `integrationSettingSections` (the sections of the addon's integration form),
 * - `getGlobalSettings` / `updateGlobalSettings` (read and write that one blob),
 * - `getIntegrationSettings` (the integration-wide settings read).
 *
 * Any of them in non-test source is refused, unless the file is in
 * `scripts/no-addon-level-settings-baseline.json` under its family with the reason it cannot move yet.
 * The baseline only shrinks; P8 (M5) empties it. A listed file that no longer names any of them is an
 * error too. Key: `<repo path>:addon-level-settings`.
 *
 * Textual: the source is read, comments are ignored, not run. Specs, `__tests__`, `dist`, `.d.ts` and
 * generated code are skipped.
 *
 * Usage: npx tsx scripts/check-no-addon-level-settings.ts
 */
import path from 'node:path'
import {
  compareToBaseline,
  type FamilyBaseline,
  type Finding,
  isMain,
  isProductSource,
  loadBaseline,
  ROOT,
  readSources,
  report,
  type SourceFile,
  type Violation,
  walk,
} from './lib/family-baseline.js'

export const BASELINE_PATH = 'scripts/no-addon-level-settings-baseline.json'

const RETIRED_RE =
  /\b(globalSettingsSchema|integrationSettingSections|getGlobalSettings|updateGlobalSettings|getIntegrationSettings)\b/g

/** Source with block and line comments blanked, so prose that names a retired hook is not a use. */
export function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

/** The retired hooks one file names, de-duplicated. */
export function retiredHooksOf(text: string): string[] {
  return [
    ...new Set([...withoutComments(text).matchAll(RETIRED_RE)].map((m) => m[1] ?? '')),
  ].filter(Boolean)
}

export function findViolations(
  sources: readonly SourceFile[],
  baseline: FamilyBaseline,
): Violation[] {
  const findings: Finding[] = []
  for (const source of sources) {
    const hooks = retiredHooksOf(source.text)
    if (hooks.length === 0) continue
    findings.push({
      key: `${source.path}:addon-level-settings`,
      where: source.path,
      message: `names ${hooks.join(', ')}: an addon has no settings of its own (D986). Put the value in its owner's scope (clusterSettingsSchema, nodeSettingsSchema, an instance kind body); a site that cannot move yet is listed, with its reason, in ${BASELINE_PATH}`,
    })
  }
  return compareToBaseline(findings, baseline, BASELINE_PATH)
}

function main(): number {
  const files = [
    ...walk(path.join(ROOT, 'packages'), isProductSource),
    ...walk(path.join(ROOT, 'server'), isProductSource),
  ]
  const violations = findViolations(readSources(files), loadBaseline(BASELINE_PATH))
  return report('check-no-addon-level-settings', violations)
}

if (isMain(import.meta.url)) process.exit(main())
