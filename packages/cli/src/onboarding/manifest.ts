/**
 * Which onboarding manifest this process answers from (D1077).
 *
 * The bundled snapshot always exists, so the flow works offline and on a
 * network that cannot reach the docs site. A live read from the docs site wins
 * only when it parses AND carries a higher `revision`: a docs fix reaches a
 * CLI that was published before it, and a stale CDN copy never rolls a newer
 * CLI back. Every answer says which one it used.
 *
 * A failed live read is not an error to the caller — it is the reason the
 * bundled copy was used, kept short and free of anything but the cause.
 */
import type { FetchFn } from '../mcp/context.js'
import { OnboardingManifestSchema, type OnboardingManifest } from './manifest-schema.js'
import snapshot from './manifest.snapshot.json' with { type: 'json' }

export const ONBOARDING_MANIFEST_URL =
  'https://camstack-docs.zentik.app/onboarding/v1/manifest.json'
export const LIVE_TIMEOUT_MS = 3_000
export const LIVE_TTL_MS = 60 * 60_000
/** How long a failed live read is remembered, so a dead network costs one timeout, not one per call. */
export const LIVE_FAILURE_TTL_MS = 5 * 60_000

export type ManifestSource = 'live' | 'bundled'

export interface ResolvedManifest {
  readonly manifest: OnboardingManifest
  readonly source: ManifestSource
  /** Why the bundled copy answered, when a live read was attempted or turned off. */
  readonly note: string | null
}

export interface ManifestResolverOptions {
  readonly fetch: FetchFn
  /** `false` (`--no-docs-fetch`): never leave the machine. */
  readonly live: boolean
  readonly now?: () => number
  readonly url?: string
  readonly timeoutMs?: number
}

export type ManifestProvider = () => Promise<ResolvedManifest>

let bundledCache: OnboardingManifest | null = null

/** The snapshot shipped inside this CLI. A snapshot that does not parse is a build defect, and throws. */
export function bundledManifest(): OnboardingManifest {
  bundledCache ??= OnboardingManifestSchema.parse(snapshot)
  return bundledCache
}

export const bundledOnly: ManifestProvider = async () => ({
  manifest: bundledManifest(),
  source: 'bundled',
  note: null,
})

interface LiveAttempt {
  readonly atMs: number
  readonly manifest: OnboardingManifest | null
  readonly failure: string | null
}

async function readLive(options: ManifestResolverOptions): Promise<OnboardingManifest | string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LIVE_TIMEOUT_MS)
  try {
    const response = await options.fetch(options.url ?? ONBOARDING_MANIFEST_URL, {
      signal: controller.signal,
    })
    if (!response.ok) return `the docs site answered ${String(response.status)}`
    const parsed = OnboardingManifestSchema.safeParse(await response.json())
    if (!parsed.success) return 'the docs site answered a document this CLI cannot read'
    return parsed.data
  } catch (err) {
    return controller.signal.aborted
      ? 'the docs site did not answer in time'
      : `the docs site could not be reached (${err instanceof Error ? err.name : 'error'})`
  } finally {
    clearTimeout(timer)
  }
}

/** A provider that reads the docs site at most once per TTL and falls back to the snapshot. */
export function createManifestProvider(options: ManifestResolverOptions): ManifestProvider {
  if (!options.live) {
    return async () => ({
      manifest: bundledManifest(),
      source: 'bundled',
      note: 'live docs read is turned off (--no-docs-fetch)',
    })
  }
  const now = options.now ?? Date.now
  let last: LiveAttempt | null = null
  return async () => {
    const bundled = bundledManifest()
    const ttl = last?.manifest ? LIVE_TTL_MS : LIVE_FAILURE_TTL_MS
    if (last === null || now() - last.atMs >= ttl) {
      const live = await readLive(options)
      last =
        typeof live === 'string'
          ? { atMs: now(), manifest: null, failure: live }
          : { atMs: now(), manifest: live, failure: null }
    }
    if (last.manifest === null) {
      return { manifest: bundled, source: 'bundled', note: last.failure }
    }
    if (last.manifest.revision > bundled.revision) {
      return { manifest: last.manifest, source: 'live', note: null }
    }
    return {
      manifest: bundled,
      source: 'bundled',
      note:
        last.manifest.revision === bundled.revision
          ? null
          : `the docs site holds an older revision (${String(last.manifest.revision)}) than this CLI (${String(bundled.revision)})`,
    }
  }
}
