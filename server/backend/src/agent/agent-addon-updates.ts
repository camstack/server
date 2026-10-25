/**
 * Agent-local addon ALIGNMENT report — "is this node behind?", answered
 * WITHOUT the hub.
 *
 * ── Why this report installs nothing ─────────────────────────────────────
 * An addon's version on an agent is decided by the HUB: every reconnect's
 * back-fill restores the hub's installed version (`agent-addon-backfill.ts`).
 * The Update action is therefore a request to the hub to bring a package to
 * THAT version (`agent-hub-addon-update.ts`, D840) — never a local install, and
 * never npm-latest: the hub routinely ships builds via `camstack deploy` that
 * were never published, so a node that self-pulled npm-latest would run bytes
 * the hub never sent and be undone at the next reconcile.
 *
 * This module answers the read half: *which of my addons are behind the
 * published release?* The hub-version half is joined in by the routes.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { compareSemver } from '../server-root/index.js'
import { resolveAddonPackageDirs } from './addon-scan.js'

/** Default public registry, matching `AddonInstaller.downloadNpmTarball`. */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'

/** One addon package as it exists on this node's disk. */
export interface InstalledAddonPackage {
  readonly packageName: string
  readonly installedVersion: string | null
}

/** The published version of one package, or why it could not be resolved. */
export interface PublishedAddonVersion {
  readonly latestVersion: string | null
  readonly error: string | null
}

/** One row of the alignment report. */
export interface AgentAddonUpdateEntry {
  readonly packageName: string
  readonly installedVersion: string | null
  readonly latestVersion: string | null
  /** True only when a published version is strictly NEWER than the installed one. */
  readonly updateAvailable: boolean
  /** Why `latestVersion` is null for THIS package (registry 404, offline, …). */
  readonly error: string | null
}

/** The whole report, as the agent UI polls it. */
export interface AgentAddonUpdateReport {
  readonly entries: readonly AgentAddonUpdateEntry[]
  readonly checkedAtMs: number
  /**
   * A report-wide failure (registry unreachable at all). Non-null means the
   * `latestVersion` column is unknown, NOT that everything is up to date —
   * the UI must render this instead of a reassuring green list.
   */
  readonly error: string | null
  /**
   * False when this node cannot be sent an addon update right now. Purely
   * informational for the UI copy — nothing here gates on it.
   */
  readonly hubReachable: boolean
}

/** Read `<dir>/package.json`'s `name` + `version`, tolerating a broken file. */
function readPackageIdentity(dir: string): InstalledAddonPackage | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as {
      readonly name?: unknown
      readonly version?: unknown
    }
    if (typeof parsed.name !== 'string' || parsed.name.length === 0) return null
    return {
      packageName: parsed.name,
      installedVersion: typeof parsed.version === 'string' ? parsed.version : null,
    }
  } catch {
    return null
  }
}

/**
 * Every addon package installed under `addonsDir`, keyed by its npm PACKAGE
 * name (not the addon declaration id — the two differ for scoped packages and
 * only the package name can be looked up in a registry).
 *
 * `@camstack/system` is deliberately INCLUDED: on an agent the addon-root copy
 * is the only copy of the builtin infra (D87), so it is exactly the package an
 * operator needs to see the version of when a node is misaligned.
 */
export function readInstalledAddonPackages(addonsDir: string): readonly InstalledAddonPackage[] {
  const found: InstalledAddonPackage[] = []
  for (const dir of resolveAddonPackageDirs(addonsDir)) {
    const identity = readPackageIdentity(dir)
    if (identity !== null) found.push(identity)
  }
  return found.sort((a, b) => a.packageName.localeCompare(b.packageName))
}

/**
 * Pure join of the on-disk roster with the published versions.
 *
 * `updateAvailable` requires BOTH versions to be known and the published one
 * to be strictly newer. An unknown published version is never "up to date"
 * and never "behind" — it is unknown, and carries its error into the row.
 */
export function buildAddonUpdateEntries(
  installed: readonly InstalledAddonPackage[],
  published: ReadonlyMap<string, PublishedAddonVersion>,
): readonly AgentAddonUpdateEntry[] {
  return installed.map((pkg) => {
    const latest = published.get(pkg.packageName)
    const latestVersion = latest?.latestVersion ?? null
    const updateAvailable =
      latestVersion !== null &&
      pkg.installedVersion !== null &&
      compareSemver(latestVersion, pkg.installedVersion) > 0
    return {
      packageName: pkg.packageName,
      installedVersion: pkg.installedVersion,
      latestVersion,
      updateAvailable,
      error: latest?.error ?? null,
    }
  })
}

/** Injected fetch seam so the resolver is testable without the network. */
export type RegistryFetchFn = (url: string) => Promise<{
  readonly ok: boolean
  readonly status: number
  json: () => Promise<unknown>
}>

/**
 * Resolve `dist-tags.latest` for one package over the registry's HTTPS API —
 * the same door `AddonInstaller.downloadNpmTarball` uses, so a host with no
 * `npm` on PATH (a packaged desktop agent) still gets an answer.
 *
 * Never throws: a failure becomes `{ latestVersion: null, error }` so one
 * unreachable package cannot blank the whole report.
 */
export async function resolvePublishedVersion(
  packageName: string,
  registryUrl: string,
  fetchFn: RegistryFetchFn,
): Promise<PublishedAddonVersion> {
  const base = registryUrl.replace(/\/+$/, '')
  const url = `${base}/${encodeURIComponent(packageName).replace(/^%40/, '@')}`
  try {
    const res = await fetchFn(url)
    if (!res.ok) return { latestVersion: null, error: `registry GET → ${res.status}` }
    const body = (await res.json()) as { readonly 'dist-tags'?: Record<string, string> }
    const latest = body['dist-tags']?.['latest']
    if (typeof latest !== 'string' || latest.length === 0) {
      return { latestVersion: null, error: 'registry returned no dist-tags.latest' }
    }
    return { latestVersion: latest, error: null }
  } catch (err) {
    return { latestVersion: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Everything {@link buildAgentAddonUpdateReport} needs, all injectable. */
export interface AgentAddonUpdateReportInput {
  readonly addonsDir: string
  readonly registryUrl?: string
  readonly fetchFn: RegistryFetchFn
  readonly isHubReachable: () => boolean
  readonly now?: () => number
}

/**
 * Build the full report. The report-wide `error` is set only when EVERY
 * package failed to resolve — that is the "registry unreachable" signal, and
 * distinguishing it from a single 404 is what stops the UI claiming a node is
 * aligned when it simply could not ask.
 */
export async function buildAgentAddonUpdateReport(
  input: AgentAddonUpdateReportInput,
): Promise<AgentAddonUpdateReport> {
  const now = input.now ?? Date.now
  const registryUrl = input.registryUrl ?? DEFAULT_NPM_REGISTRY
  const installed = readInstalledAddonPackages(input.addonsDir)
  const published = new Map<string, PublishedAddonVersion>()
  const resolved = await Promise.all(
    installed.map(async (pkg) => ({
      packageName: pkg.packageName,
      result: await resolvePublishedVersion(pkg.packageName, registryUrl, input.fetchFn),
    })),
  )
  for (const r of resolved) published.set(r.packageName, r.result)

  const entries = buildAddonUpdateEntries(installed, published)
  const allFailed = entries.length > 0 && entries.every((e) => e.latestVersion === null)
  const firstError = entries.find((e) => e.error !== null)?.error ?? 'registry unreachable'
  return {
    entries,
    checkedAtMs: now(),
    error: allFailed ? `Could not reach ${registryUrl}: ${firstError}` : null,
    hubReachable: input.isHubReachable(),
  }
}
