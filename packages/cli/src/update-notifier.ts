/**
 * Zero-dep update notifier.
 *
 * Hits npm's registry once per 24h (cached at `~/.camstack/update-check.json`)
 * and prints a one-line banner the next time the CLI runs if a newer version
 * is published. The check is fire-and-forget — we never block the command;
 * a missed check just delays the next reminder by 24h.
 *
 * Why custom instead of `update-notifier`: the upstream library pulls
 * boxen + configstore + latest-version (~30 transitive deps). We're a
 * zero-dep CLI; a 60-line probe fits the budget.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const CACHE_DIR = path.join(os.homedir(), '.camstack')
const CACHE_FILE = path.join(CACHE_DIR, 'update-check.json')
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24h
const REGISTRY_BASE = 'https://registry.npmjs.org'
const FETCH_TIMEOUT_MS = 2_500

interface CacheShape {
  /** Last time we hit the registry (ms epoch). */
  readonly lastCheckAt: number
  /** The version we observed on last successful check. */
  readonly latestVersion: string | null
  /** Last version we surfaced to the user — suppresses duplicate banners. */
  readonly lastNotifiedVersion: string | null
}

function readCache(): CacheShape | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null
    const parsed: unknown = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const c = parsed as Partial<CacheShape>
    if (typeof c.lastCheckAt !== 'number') return null
    return {
      lastCheckAt: c.lastCheckAt,
      latestVersion: typeof c.latestVersion === 'string' ? c.latestVersion : null,
      lastNotifiedVersion: typeof c.lastNotifiedVersion === 'string' ? c.lastNotifiedVersion : null,
    }
  } catch {
    return null
  }
}

function writeCache(c: CacheShape): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2))
  } catch {
    /* best-effort */
  }
}

/**
 * Compare semver-ish `latest` against `current`. We accept the published
 * version as-is from the registry (already valid semver) and split on dots.
 * Returns true when `latest` is strictly newer; false on equal, older, or
 * malformed input (caller treats as "no update").
 */
function isNewer(current: string, latest: string): boolean {
  const a = parseSemver(current)
  const b = parseSemver(latest)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return true
    if ((b[i] ?? 0) < (a[i] ?? 0)) return false
  }
  return false
}

function parseSemver(v: string): readonly [number, number, number] | null {
  // Strip pre-release / build metadata — we compare main numerics only.
  const m = v.replace(/^v/, '').split(/[-+]/)[0]?.split('.')
  if (!m || m.length < 3) return null
  const parts = m.map((s) => parseInt(s, 10))
  if (parts.some(Number.isNaN)) return null
  return [parts[0]!, parts[1]!, parts[2]!] as const
}

export async function fetchLatestVersion(pkg: string): Promise<string | null> {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(`${REGISTRY_BASE}/${pkg}/latest`, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

/**
 * Kick off an async update check.
 *
 *   • If cache is fresh (<24h) and stored `latestVersion > current` → print banner.
 *   • If cache is stale → fire-and-forget the network fetch, update cache.
 *     The banner appears on the NEXT invocation (we never delay the current one).
 *
 * Suppresses repeated banners for the same version: once you've been told
 * `0.5.0` is out, we don't tell you again until `0.5.1` ships.
 *
 * Disabled via env: `CAMSTACK_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1`
 * (compat with the conventional flag).
 */
export function maybeNotifyUpdate(pkgName: string, currentVersion: string): void {
  if (process.env.CAMSTACK_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER) return
  // Skip in non-TTY contexts (CI/scripted runs) — keeps logs clean.
  if (!process.stdout.isTTY) return

  const cache = readCache()
  const now = Date.now()

  // Show banner immediately if we already know about a newer version
  // and haven't notified about THIS specific version yet.
  if (
    cache?.latestVersion &&
    cache.latestVersion !== cache.lastNotifiedVersion &&
    isNewer(currentVersion, cache.latestVersion)
  ) {
    printBanner(pkgName, currentVersion, cache.latestVersion)
    writeCache({ ...cache, lastNotifiedVersion: cache.latestVersion })
  }

  // Refresh in background when cache is missing or stale.
  const isStale = !cache || now - cache.lastCheckAt > CHECK_INTERVAL_MS
  if (isStale) {
    fetchLatestVersion(pkgName)
      .then((latest) => {
        if (!latest) return
        writeCache({
          lastCheckAt: Date.now(),
          latestVersion: latest,
          lastNotifiedVersion: cache?.lastNotifiedVersion ?? null,
        })
      })
      .catch(() => {
        /* swallow */
      })
  }
}

function printBanner(pkgName: string, current: string, latest: string): void {
  const lines = [
    '',
    `  ┌──────────────────────────────────────────────────────────┐`,
    `  │  Update available: ${current} → ${latest}`.padEnd(60) + '│',
    `  │  Run: npx ${pkgName}@latest`.padEnd(60) + '│',
    `  └──────────────────────────────────────────────────────────┘`,
    '',
  ]
  // stderr so it doesn't pollute scripted stdout consumers.
  process.stderr.write(lines.join('\n'))
}
