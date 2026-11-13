#!/usr/bin/env tsx
/**
 * One collection, one surface (planning#505, sibling of #504; D996/D1007/D1013).
 *
 * A collection of connections is ONE `components/instances/InstancesTable`: the provider pills, Add,
 * the on switch and the lifecycle live in that table. `check-one-instances-list` sees a page that
 * edits records itself; it does not see a page that draws a SECOND list of the same providers next to
 * the table (a pill row of addons, a "tunnel control" card, a legend with its own switch). This guard
 * does, textually, over `packages/addon-admin-ui/src/{pages,components}`:
 *
 * 1. `IntegrationHub` or `AddonIntegrationBody` in code anywhere (a tag, an import, a declaration),
 *    their old folder included: the pill row of addons stacked over a collection was deleted once
 *    every page moved to the table, and it does not come back. A comment that names it is fine.
 * 2. `InstancesTable` and `useAddonsListCapabilityProviders` in one file: the providers listed twice.
 * 3. The addon-level enable switch (`AddonIntegrationBody`, `EnableToggleButton`,
 *    `useAddonsSetCapabilityProviderEnabled`) or the record switch (`InstanceSwitchCell`) outside
 *    `components/instances/`: a second switch.
 * 4. An addon id or package name hand-written as a comparison, a `startsWith`, a map key or a
 *    list line in a page or component: per-addon knowledge the manifest owns.
 * 5. A file that renders `InstancesTable` and a `SectionCard` whose body maps over providers, servers
 *    or nodes: a card re-drawing the table's rows.
 * 6. `omitSectionIds` written in a page: one surface hand-excluding what another one draws.
 * 7. `providerNamesByAddon` in a page or component outside the instances table: a per-addon name
 *    map for pill rows the table replaces.
 *
 * Every file that matches today is in `scripts/no-stacked-provider-lists-baseline.json`, with the
 * reason and the page work that deletes it. The baseline only shrinks; a listed file that no longer
 * matches is an error too. Key: the repo path. Specs, `__tests__` and generated code are skipped.
 *
 * Usage: npx tsx scripts/check-no-stacked-provider-lists.ts
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

export const BASELINE_PATH = 'scripts/no-stacked-provider-lists-baseline.json'
const ADMIN_UI_SRC = 'packages/addon-admin-ui/src/'
const SCANNED_DIRS: readonly string[] = [
  `${ADMIN_UI_SRC}pages/`,
  `${ADMIN_UI_SRC}components/`,
  `${ADMIN_UI_SRC}lib/`,
]
/** The one declared list of framework packages every surface reads. */
const DECLARATION_FILES: readonly string[] = [`${ADMIN_UI_SRC}lib/framework-packages.ts`]
/** The directory that owns the switch and the provider list. */
const OWNER_DIRS: readonly string[] = [`${ADMIN_UI_SRC}components/instances/`]

/** The deleted pill row, as code: rendered, imported, or declared. */
const HUB_CODE_RE =
  /<(?:IntegrationHub|AddonIntegrationBody)\b|\bimport\b[^;]*\b(?:IntegrationHub|AddonIntegrationBody)\b|\b(?:function|const|class|interface|type)\s+(?:IntegrationHub|AddonIntegrationBody)\b/
/** A line that only comments: a JSDoc body, a `//` or a `/*` opener. */
const COMMENT_LINE_RE = /^\s*(?:\*|\/\/|\/\*)/
const TABLE_RE = /\bInstancesTable\b/
const PROVIDER_LIST_RE = /\buseAddonsListCapabilityProviders\b/
const SWITCH_RE =
  /\b(?:AddonIntegrationBody|EnableToggleButton|useAddonsSetCapabilityProviderEnabled|InstanceSwitchCell)\b/
const SECTION_CARD_RE = /<SectionCard\b/
const PROVIDER_MAP_RE = /\b\w*(?:[Pp]rovider|[Ss]erver|[Nn]ode|[Ss]ource)s?\w*\.map\(/
const OMIT_RE = /\bomitSectionIds\b/
const DISPLAY_NAME_MAP_RE = /\bproviderNamesByAddon\b/
/** An addon id or a package name as a literal in a comparison, a startsWith or a map key. */
const ADDON_ID = String.raw`(?:@camstack/[a-z0-9-]+|(?:auth|addon|provider)-[a-z0-9-]+)`
const ADDON_ID_RES: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:addonId|packageName|pkgName|pkg|addon\.id|providerId)\s*[!=]==\s*'${ADDON_ID}'`,
  ),
  new RegExp(String.raw`\.startsWith\(\s*'${ADDON_ID}'`),
  // A map key or a list line: 'auth-oidc': ..., '@camstack/types',
  new RegExp(String.raw`^\s*'${ADDON_ID}'\s*:`, 'm'),
  new RegExp(String.raw`^\s*'@camstack/[a-z0-9-]+',?\s*$`, 'm'),
]

function inScope(file: SourceFile): boolean {
  return SCANNED_DIRS.some((dir) => file.path.startsWith(dir))
}

function inOwnerDir(file: SourceFile): boolean {
  return OWNER_DIRS.some((dir) => file.path.startsWith(dir))
}

function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => !COMMENT_LINE_RE.test(line))
    .join('\n')
}

/** The rules a file breaks, as short sentences. Empty when it is clean. */
export function stackedListBreaches(file: SourceFile): string[] {
  if (!inScope(file)) return []
  const owner = inOwnerDir(file) || DECLARATION_FILES.includes(file.path)
  const text = file.text
  const hasTable = TABLE_RE.test(text)
  const out: string[] = []
  if (HUB_CODE_RE.test(codeOnly(text))) {
    out.push('the deleted IntegrationHub / AddonIntegrationBody pill row')
  }
  if (!owner && hasTable && PROVIDER_LIST_RE.test(text)) {
    out.push('an InstancesTable and a second list of providers (useAddonsListCapabilityProviders)')
  }
  if (!owner && SWITCH_RE.test(text)) {
    out.push('a switch or addon-level enable control outside components/instances')
  }
  if (!owner && ADDON_ID_RES.some((re) => re.test(text))) {
    out.push('a hand-written addon id or package name')
  }
  if (!owner && hasTable && SECTION_CARD_RE.test(text) && PROVIDER_MAP_RE.test(text)) {
    out.push('a SectionCard mapping providers, servers or nodes next to an InstancesTable')
  }
  if (file.path.startsWith(`${ADMIN_UI_SRC}pages/`) && OMIT_RE.test(text)) {
    out.push('a page excluding settings sections by hand (omitSectionIds)')
  }
  if (!owner && DISPLAY_NAME_MAP_RE.test(text)) {
    out.push('a page-level per-addon display-name map (providerNamesByAddon) for pill rows')
  }
  return out
}

export function findViolations(
  sources: readonly SourceFile[],
  baseline: FamilyBaseline,
): Violation[] {
  const findings: Finding[] = []
  for (const file of sources) {
    const breaches = stackedListBreaches(file)
    if (breaches.length === 0) continue
    findings.push({
      key: file.path,
      where: file.path,
      message: `stacks a second list or control of a collection next to its InstancesTable: ${breaches.join('; ')}. Declare the kind in pages/system/Integrations.tsx and use components/instances/InstancesTable; a page that cannot move yet is listed, with its reason, in ${BASELINE_PATH}`,
    })
  }
  return compareToBaseline(findings, baseline, BASELINE_PATH)
}

function main(): number {
  const files = walk(path.join(ROOT, ADMIN_UI_SRC), isProductSource)
  const violations = findViolations(readSources(files), loadBaseline(BASELINE_PATH))
  return report('check-no-stacked-provider-lists', violations)
}

if (isMain(import.meta.url)) process.exit(main())
