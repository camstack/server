#!/usr/bin/env tsx
/**
 * Every SECTION of every capability's cluster settings has exactly one admin surface (#578).
 *
 * System → Settings used to draw every hub addon's cluster schema in one tab strip, one tab per
 * addon, so a new schema always had somewhere to land — and nobody decided where it belonged. The
 * settings now live on the page about their subject (Pipeline, History, Notifications, Nodes, a
 * connection page) or, as the fallback, in the addon's own settings dialog. The claim table is
 * `packages/addon-admin-ui/src/lib/cluster-settings-claims.ts`; this guard holds it to the code:
 *
 * 1. Every `clusterSettingsSchema` hook names its caps in a form this guard can read (`cap ===
 *    '<literal>'`). A hook it cannot read is a finding, never skipped.
 * 2. Every declared cap is claimed, by an addon the cap's own package ships.
 * 3. At most one WHOLE claim per cap. A cap split into section / field claims (no whole claim)
 *    needs a section source below; then every field of every section must have exactly one
 *    surface — a section added to a split cap turns this red until someone draws it.
 * 4. A field claimed apart from a whole claim (a role picker) exists in the cap's schema.
 * 5. Nothing claimed is stale: no cap, section or field that the schema no longer declares.
 *
 * That the admin pages draw what their claims say is pinned by
 * `packages/addon-admin-ui/src/lib/__tests__/cluster-settings-claims.spec.ts`.
 *
 * Usage: npx tsx scripts/check-cluster-settings-claimed.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLUSTER_SETTINGS_CLAIMS,
  type ClusterSettingsClaim,
  isWholeClaim,
} from '../packages/addon-admin-ui/src/lib/cluster-settings-claims'
import { clusterHooksIn, walk } from './check-scoped-settings-declared'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Packages whose sources describe the hooks rather than implement them. */
const NOT_ADDON_PACKAGES = new Set(['types', 'develop', 'cli'])

export interface DeclaredClusterCap {
  readonly cap: string
  readonly file: string
  /** Field keys the declaring hook reaches (textual). */
  readonly keys: readonly string[]
  /** Addon ids of the declaring package whose manifest lists this cap. */
  readonly addonIds: readonly string[]
}

export interface SchemaSection {
  readonly id: string
  readonly fields: readonly { readonly key: string }[]
}

export interface ClusterClaimInputs {
  readonly declared: readonly DeclaredClusterCap[]
  /** Files with a cluster hook whose caps could not be read. */
  readonly unreadableHooks: readonly string[]
  readonly claims: readonly ClusterSettingsClaim[]
  /** The real cluster sections of every cap that has a section source. */
  readonly sectionsByCap: ReadonlyMap<string, readonly SchemaSection[]>
}

/** Findings for the declared cluster caps against the claim table. Pure. */
export function findClusterClaimFindings(inputs: ClusterClaimInputs): readonly string[] {
  const { declared, unreadableHooks, claims, sectionsByCap } = inputs
  const findings: string[] = unreadableHooks.map(
    (file) =>
      `${file}: a clusterSettingsSchema hook whose caps cannot be read — compare the cap to a string literal (\`cap === 'x'\`)`,
  )
  const declaredByCap = new Map<string, DeclaredClusterCap[]>()
  for (const d of declared) declaredByCap.set(d.cap, [...(declaredByCap.get(d.cap) ?? []), d])
  const claimsByCap = new Map<string, ClusterSettingsClaim[]>()
  for (const c of claims) claimsByCap.set(c.cap, [...(claimsByCap.get(c.cap) ?? []), c])

  for (const [cap, decls] of declaredByCap) {
    if (!claimsByCap.has(cap)) {
      findings.push(
        `${decls[0]?.file}: cap "${cap}" declares cluster settings but no surface claims it — add it to cluster-settings-claims.ts (a feature page, or 'addon-card')`,
      )
    }
  }
  for (const [cap, capClaims] of claimsByCap) {
    const decls = declaredByCap.get(cap)
    if (decls === undefined) {
      findings.push(`claim for cap "${cap}" matches no clusterSettingsSchema hook — remove it`)
      continue
    }
    const addonIds = new Set(decls.flatMap((d) => d.addonIds))
    for (const c of capClaims) {
      if (!addonIds.has(c.addonId)) {
        findings.push(
          `claim for cap "${cap}" names addon "${c.addonId}", but the package declaring it ships it as ${[...addonIds].join(', ') || 'no addon whose manifest lists the cap'}`,
        )
      }
    }
    findings.push(...capFindings(cap, capClaims, decls, sectionsByCap.get(cap)))
  }
  return findings
}

function capFindings(
  cap: string,
  capClaims: readonly ClusterSettingsClaim[],
  decls: readonly DeclaredClusterCap[],
  sections: readonly SchemaSection[] | undefined,
): readonly string[] {
  const whole = capClaims.filter(isWholeClaim)
  const narrow = capClaims.filter((c) => !isWholeClaim(c))
  if (whole.length > 1) {
    return [
      `cap "${cap}" is claimed whole ${whole.length} times (${whole.map((c) => c.surface).join(', ')}) — one surface per value`,
    ]
  }
  if (sections === undefined) {
    if (whole.length === 0 || narrow.some((c) => c.sectionIds !== undefined)) {
      return [
        `cap "${cap}" is split into sections across surfaces, but the guard has no section source for it — add one to SECTION_SOURCES`,
      ]
    }
    // A whole claim with single fields drawn elsewhere: each field must exist.
    const keys = new Set(decls.flatMap((d) => d.keys))
    return narrow.flatMap((c) =>
      (c.fieldKeys ?? [])
        .filter((k) => !keys.has(k))
        .map(
          (k) =>
            `claim for cap "${cap}" (${c.surface}) names field "${k}", which its schema does not declare — remove it`,
        ),
    )
  }
  return sectionFindings(cap, whole[0], narrow, sections)
}

function sectionFindings(
  cap: string,
  whole: ClusterSettingsClaim | undefined,
  narrow: readonly ClusterSettingsClaim[],
  sections: readonly SchemaSection[],
): readonly string[] {
  const findings: string[] = []
  const sectionIds = new Set(sections.map((s) => s.id))
  const fieldKeys = new Set(sections.flatMap((s) => s.fields.map((f) => f.key)))
  for (const c of narrow) {
    for (const id of c.sectionIds ?? []) {
      if (!sectionIds.has(id)) {
        findings.push(
          `claim for cap "${cap}" (${c.surface}) names section "${id}", which its schema does not declare — remove it`,
        )
      }
    }
    for (const k of c.fieldKeys ?? []) {
      if (!fieldKeys.has(k)) {
        findings.push(
          `claim for cap "${cap}" (${c.surface}) names field "${k}", which its schema does not declare — remove it`,
        )
      }
    }
  }
  for (const section of sections) {
    const unclaimed: string[] = []
    for (const field of section.fields) {
      const narrowOwners = narrow.filter(
        (c) =>
          c.sectionIds?.includes(section.id) === true || c.fieldKeys?.includes(field.key) === true,
      )
      const owners = narrowOwners.length > 0 ? narrowOwners : whole !== undefined ? [whole] : []
      if (owners.length === 0) unclaimed.push(field.key)
      else if (owners.length > 1) {
        findings.push(
          `cap "${cap}" section "${section.id}" field "${field.key}" is drawn by ${owners.length} surfaces (${owners.map((c) => c.surface).join(', ')}) — one surface per value`,
        )
      }
    }
    if (unclaimed.length === section.fields.length && unclaimed.length > 0) {
      findings.push(
        `cap "${cap}" section "${section.id}" is drawn by no surface — claim it in cluster-settings-claims.ts and draw it there`,
      )
    } else if (unclaimed.length > 0) {
      findings.push(
        `cap "${cap}" section "${section.id}" fields ${unclaimed.join(', ')} are drawn by no surface`,
      )
    }
  }
  return findings
}

/**
 * The real cluster sections of a cap split across surfaces, built by the addon's own schema
 * builder. A cap claimed in sections without a source here is a finding.
 */
const SECTION_SOURCES: Readonly<Record<string, () => Promise<readonly SchemaSection[]>>> = {
  'pipeline-orchestrator': async () => {
    const { buildGlobalSettingsSections } = await import(
      '../packages/addon-pipeline-orchestrator/src/settings-ui-schemas'
    )
    return buildGlobalSettingsSections({ fpsMinThresholdDefault: 1 }).map((s) => ({
      id: s.id,
      fields: s.fields.flatMap((f) =>
        'key' in f && typeof f.key === 'string' ? [{ key: f.key }] : [],
      ),
    }))
  },
  // The analytics form is drawn whole by its dialog; `postProcessingNodeId` is a role picker.
  'pipeline-analytics': async () => {
    const { buildAnalyticsClusterSchema } = await import(
      '../packages/addon-post-analysis/src/pipeline-analytics/settings-schema'
    )
    return buildAnalyticsClusterSchema().sections.map((s) => ({
      id: s.id,
      fields: s.fields.flatMap((f) =>
        'key' in f && typeof f.key === 'string' ? [{ key: f.key }] : [],
      ),
    }))
  },
}

/** Addon ids of a package whose manifest entry lists `cap` among its capabilities. */
function addonIdsDeclaring(pkgDir: string, cap: string): readonly string[] {
  const raw: unknown = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'))
  const camstack = isRecord(raw) ? raw['camstack'] : undefined
  const addons = isRecord(camstack) ? camstack['addons'] : undefined
  if (!Array.isArray(addons)) return []
  return addons.flatMap((addon) => {
    if (!isRecord(addon) || typeof addon['id'] !== 'string') return []
    const caps = Array.isArray(addon['capabilities']) ? addon['capabilities'] : []
    const names = caps.map((c) => (typeof c === 'string' ? c : isRecord(c) ? c['name'] : undefined))
    return names.includes(cap) ? [addon['id']] : []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function main(): Promise<void> {
  const declared: DeclaredClusterCap[] = []
  const unreadableHooks: string[] = []
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    if (NOT_ADDON_PACKAGES.has(pkg)) continue
    const pkgDir = path.join(ROOT, 'packages', pkg)
    const files: string[] = []
    walk(path.join(pkgDir, 'src'), files)
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      if (!content.includes('clusterSettingsSchema')) continue
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      for (const hook of clusterHooksIn(content)) {
        if (hook.caps.length === 0) unreadableHooks.push(rel)
        for (const cap of hook.caps) {
          declared.push({
            cap,
            file: rel,
            keys: hook.keys,
            addonIds: addonIdsDeclaring(pkgDir, cap),
          })
        }
      }
    }
  }
  const sectionsByCap = new Map<string, readonly SchemaSection[]>()
  for (const [cap, source] of Object.entries(SECTION_SOURCES))
    sectionsByCap.set(cap, await source())
  const findings = findClusterClaimFindings({
    declared,
    unreadableHooks,
    claims: CLUSTER_SETTINGS_CLAIMS,
    sectionsByCap,
  })
  if (findings.length === 0) {
    console.log(
      `check-cluster-settings-claimed: ${declared.length} cluster schemas, every section drawn by one surface`,
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
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
