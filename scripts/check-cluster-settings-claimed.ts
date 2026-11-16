#!/usr/bin/env tsx
/**
 * Every capability that declares CLUSTER settings is drawn by exactly one admin surface (#578).
 *
 * System → Settings used to draw every hub addon's cluster schema in one tab strip, one tab per
 * addon, so a new schema always had somewhere to land — and nobody decided where it belonged. The
 * settings now live on the page about their subject (Pipeline, History, Notifications, Nodes, a
 * connection page) or, as the fallback, in the addon's own settings dialog. The claim table is
 * `packages/addon-admin-ui/src/lib/cluster-settings-claims.ts`; this guard holds it to the code:
 *
 * 1. A capability with a `clusterSettingsSchema` hook is claimed. Unclaimed, a new schema would be
 *    drawn only by the addon dialog without anyone having chosen that.
 * 2. A capability is claimed once. Two claims are two controls for one value.
 * 3. A claim names a capability that still declares a cluster schema — a stale claim keeps a card
 *    that renders nothing.
 *
 * The declared caps are found textually, by the same reader as `check-scoped-settings-declared`.
 *
 * Usage: npx tsx scripts/check-cluster-settings-claimed.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLUSTER_SETTINGS_CLAIMS,
  type ClusterSettingsClaim,
} from '../packages/addon-admin-ui/src/lib/cluster-settings-claims'
import { clusterSchemaCapsIn, walk } from './check-scoped-settings-declared'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Packages whose sources describe the hooks rather than implement them. */
const NOT_ADDON_PACKAGES = new Set(['types', 'develop', 'mcp-dev'])

export interface DeclaredClusterCap {
  readonly cap: string
  readonly file: string
}

/** Findings for a set of declared cluster caps against the claim table. Pure. */
export function findClusterClaimFindings(
  declared: readonly DeclaredClusterCap[],
  claims: readonly ClusterSettingsClaim[],
): readonly string[] {
  const findings: string[] = []
  const byCap = new Map<string, ClusterSettingsClaim[]>()
  for (const claim of claims) byCap.set(claim.cap, [...(byCap.get(claim.cap) ?? []), claim])
  for (const [cap, list] of byCap) {
    if (list.length > 1) {
      findings.push(
        `cap "${cap}" is claimed ${list.length} times (${list.map((c) => c.surface).join(', ')}) — one surface per cap`,
      )
    }
  }
  const declaredCaps = new Set(declared.map((d) => d.cap))
  for (const d of declared) {
    if (!byCap.has(d.cap)) {
      findings.push(
        `${d.file}: cap "${d.cap}" declares cluster settings but no surface claims it — add it to cluster-settings-claims.ts (a feature page, or 'addon-card')`,
      )
    }
  }
  for (const claim of claims) {
    if (!declaredCaps.has(claim.cap)) {
      findings.push(
        `claim for cap "${claim.cap}" (${claim.surface}) matches no clusterSettingsSchema hook — remove it`,
      )
    }
  }
  return findings
}

function main(): void {
  const declared: DeclaredClusterCap[] = []
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    if (NOT_ADDON_PACKAGES.has(pkg)) continue
    const files: string[] = []
    walk(path.join(ROOT, 'packages', pkg, 'src'), files)
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      if (!content.includes('clusterSettingsSchema')) continue
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      for (const cap of clusterSchemaCapsIn(content)) declared.push({ cap, file: rel })
    }
  }
  const findings = findClusterClaimFindings(declared, CLUSTER_SETTINGS_CLAIMS)
  if (findings.length === 0) {
    console.log(
      `check-cluster-settings-claimed: ${declared.length} cluster schemas, each claimed by one surface`,
    )
    return
  }
  console.error('check-cluster-settings-claimed: cluster settings without exactly one home (#578):')
  for (const f of findings) console.error(`  ${f}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
