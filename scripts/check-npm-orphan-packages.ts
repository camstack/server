#!/usr/bin/env tsx
/**
 * A published package whose source left the workspace must be DEPRECATED, not
 * merely forgotten.
 *
 * ## What went wrong, twice
 *
 * The registry accumulates names the workspace no longer has. Deleting
 * `packages/<x>/` is a one-line commit; the npm entry survives it forever, still
 * installable, still the first hit for anyone searching. On 2026-08-09 an audit
 * found **twelve** such names — seven of them from before the 2026-05-21 history
 * reset, so not even recoverable from git.
 *
 * Worse, the first pass at that audit compared npm PACKAGE names against
 * workspace PACKAGE names and drew conclusions about ADDONS. That is unsound in
 * both directions, because one package declares many addons:
 * `@camstack/addon-pipeline` carries six, `@camstack/addon-provider-homeassistant`
 * two, `@camstack/addon-cloudflare` two. A package can vanish while every addon
 * id it declared lives on inside a bundle (`@camstack/core` → `@camstack/system`,
 * 18 ids, all still declared) — and an addon id can vanish while its package is
 * perfectly alive. Only the first of those is safe to retire on the strength of
 * the name alone.
 *
 * ## What this checks
 *
 * 1. **Every non-deprecated `@camstack/*` package on npm has workspace source.**
 *    The registry's search endpoint OMITS deprecated packages, which is exactly
 *    the filter this guard wants: whatever it returns is a name npm still
 *    presents as current, so it must be a name this repo can still build. A
 *    deliberate retirement is recorded in {@link RETIRED} and passes.
 *
 * 2. **A retired name never comes back as a workspace package.** Offline, and the
 *    real hazard: republishing a name carrying a deprecation notice ships a
 *    package that tells its own users not to install it.
 *
 * The network half degrades to a warning — a registry outage must not block an
 * unrelated commit. The offline half always runs.
 *
 * Usage: tsx scripts/check-npm-orphan-packages.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search?text=%40camstack&size=250'
const FETCH_TIMEOUT_MS = 20_000

/**
 * Published names deliberately retired: the source is gone from the workspace on
 * purpose, and the registry entry is unpublished (preferred) or was deprecated
 * before removal. The value says where the behaviour went, because "it was
 * removed" and "it moved into a bundle" call for different answers when someone
 * asks why their install broke.
 */
const RETIRED: Readonly<Record<string, string>> = {
  '@camstack/agent': 'merged into @camstack/server — CAMSTACK_ROLE=agent (2026-07-21); unpublished',
  '@camstack/core':
    'merged into @camstack/system — all 18 addon ids still declared there; unpublished',
  '@camstack/kernel': 'merged into @camstack/system — declared no addons of its own; unpublished',
  '@camstack/addon-analytics':
    "addon id 'analytics' deleted; superseded by pipeline-analytics; unpublished",
  '@camstack/addon-decoder-ffmpeg':
    'deleted 2026-10-08 (D763) — decoder registration always resolved to nodeav; unpublished',
  '@camstack/addon-export-ha-mqtt':
    "addon id 'export-ha-mqtt' superseded by 'homeassistant-export' in @camstack/addon-provider-homeassistant; unpublished",
  '@camstack/addon-metrics-glances':
    "addon id 'metrics-glances' superseded by the metrics-native builtin; unpublished",
  '@camstack/addon-mqtt-client':
    "addon id 'mqtt-client' deleted; the broker addon owns MQTT; unpublished",
  '@camstack/addon-sample': "addon id 'sample-worker' deleted — scaffolding example; unpublished",
  '@camstack/addon-vector-store':
    "addon id 'vector-store' folded into the sqlite-settings builtin — a second provider for one singleton; unpublished",
  '@camstack/addon-vision':
    'its 13 detector ids became pipeline STEPS; only embedding-encoder survives as an addon, in @camstack/addon-post-analysis; unpublished',
  '@camstack/addon-webrtc-adaptive':
    "addon id 'webrtc-adaptive' deleted; adaptive tiering lives in the orchestrator; unpublished",
  '@camstack/lib-pipeline-analysis':
    "addon id 'pipeline-analysis' deleted; superseded by pipeline-analytics; unpublished",
  '@camstack/shm-ring':
    'deleted 2026-10-08 (D763) — no runtime importer left the closure with D184; unpublished',
}

interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly isPrivate: boolean
}

const readWorkspacePackages = (): readonly WorkspacePackage[] => {
  const roots = ['packages', 'server']
  const found: WorkspacePackage[] = []
  for (const root of roots) {
    const rootDir = path.join(ROOT, root)
    if (!fs.existsSync(rootDir)) continue
    for (const entry of fs.readdirSync(rootDir)) {
      const manifest = path.join(rootDir, entry, 'package.json')
      if (!fs.existsSync(manifest)) continue
      const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) continue
      const record: Record<string, unknown> = parsed as Record<string, unknown>
      const name = record.name
      if (typeof name !== 'string') continue
      found.push({ name, dir: `${root}/${entry}`, isPrivate: record.private === true })
    }
  }
  return found
}

interface SearchHit {
  readonly package: { readonly name: string }
}

const fetchPublishedNames = async (): Promise<readonly string[] | null> => {
  try {
    const response = await fetch(SEARCH_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return null
    const objects = (body as Record<string, unknown>).objects
    if (!Array.isArray(objects)) return null
    return objects
      .map((hit: unknown): string | null => {
        const pkg = (hit as SearchHit | undefined)?.package
        return typeof pkg?.name === 'string' ? pkg.name : null
      })
      .filter((name: string | null): name is string => name !== null)
      .filter((name: string): boolean => name === 'camstack' || name.startsWith('@camstack/'))
  } catch {
    return null
  }
}

const main = async (): Promise<void> => {
  const workspace = readWorkspacePackages()
  const workspaceNames = new Set(workspace.map((p: WorkspacePackage): string => p.name))
  const failures: string[] = []

  // 2 — offline: a retired name must not reappear as workspace source.
  for (const [name, reason] of Object.entries(RETIRED)) {
    const resurrected = workspace.find((p: WorkspacePackage): boolean => p.name === name)
    if (resurrected !== undefined) {
      failures.push(
        `${name} is listed as RETIRED but ${resurrected.dir}/package.json declares it again.\n` +
          `    Retired because: ${reason}\n` +
          `    Publishing it again ships a package whose npm page tells users not to install it.\n` +
          `    Either rename the package, or un-deprecate on npm and drop it from RETIRED here.`,
      )
    }
  }

  // 1 — network: every current npm name must be buildable from this workspace.
  const published = await fetchPublishedNames()
  if (published === null) {
    console.warn(
      'check-npm-orphan-packages: registry search unavailable — skipped the published-name half.',
    )
  } else {
    for (const name of published) {
      if (workspaceNames.has(name)) continue
      if (name in RETIRED) continue
      failures.push(
        `${name} is published on npm and NOT deprecated, but no package in this workspace declares that name.\n` +
          `    Anyone can still install it, and nobody can rebuild it.\n` +
          `    Fix: 'npm deprecate ${name} "<where the behaviour went>"' and add it to RETIRED in this file.\n` +
          `    Before you do — check whether the ADDON IDS it declared moved into a bundle rather than\n` +
          `    vanishing (npm view ${name} camstack.addons), and say which in the note.`,
      )
    }
  }

  if (failures.length > 0) {
    console.error('\n✗ check-npm-orphan-packages\n')
    for (const failure of failures) console.error(`  - ${failure}\n`)
    process.exit(1)
  }
  const scope = published === null ? 'offline half only' : `${published.length} published names`
  console.log(`✓ check-npm-orphan-packages (${scope}, ${Object.keys(RETIRED).length} retired)`)
}

void main().catch((error: unknown): void => {
  console.error('check-npm-orphan-packages: unexpected failure', error)
  process.exit(1)
})
