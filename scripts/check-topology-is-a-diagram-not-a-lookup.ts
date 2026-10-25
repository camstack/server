#!/usr/bin/env tsx
/**
 * Disproportionate-endpoint guard — `nodes.topology` draws the cluster
 * DIAGRAM; it is not a lookup table.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * `nodes.topology` answers "what does this cluster consist of": every node,
 * every addon, every runner subprocess with its live cpu/rss, plus the durable
 * offline rows. Its handler walks the fleet, so its cost scales with
 * nodes x processes. Measured on the production hub on 2026-08-31, with every
 * leg isolated against its own endpoint rather than attributed by subtraction:
 *
 *   nodes.getNodeAddons({nodeId:'hub'})   14–39 ms   HTTP + auth + local registry
 *   metricsProvider.listAddonInstances    92 ms      hub `$process.list` + forked `ps`
 *   metricsProvider.getCached             95 ms      buildHubEntry's metrics leg
 *   ONE settings-store round trip         14 846–18 349 ms
 *   nodes.topology                        30 483 ms  = 2 x a 15 557 ms store tick
 *
 * Fourteen UI call sites made that call on mount, and almost none of them
 * wanted the diagram. They wanted a node's NAME, or whether a node was UP, or
 * one node's addon ids — one fact, priced at the whole fleet. D315 removed one
 * such caller (a presence gate that asked the cluster a one-bit question) and
 * D317 removed the rest.
 *
 * ── What is checked ───────────────────────────────────────────────────────
 *  1. **`nodes.topology` is reached only through the two hooks.** In a UI
 *     package, `useNodesTopology` / `trpc.nodes.topology` may appear only in
 *     `hooks/use-cluster-nodes.ts` (which owns both `useClusterTopology` and
 *     `useClusterNodes`) or behind an allowlist entry that says why that call
 *     site needs the whole diagram. Everything else asks the roster hook, or
 *     asks a per-node endpoint (`nodes.getNodeAddons`) that does not fan out.
 *
 *  2. **Neither hook may poll.** A diagram reader bootstraps ONCE and then
 *     lives off the pushed `cluster.topology-snapshot`, so the owner
 *     `use-cluster-nodes.ts` must configure `staleTime: Infinity` and must not
 *     carry `refetchInterval`. A poll here is the fan-out on a timer.
 *
 *  3. **No call site re-declares fetch policy for it.** `refetchOnMount`,
 *     `refetchInterval` or a `staleTime` next to a topology read is the same
 *     defect one layer out — `DeviceStepOverrideTab` forced
 *     `refetchOnMount: 'always'`, i.e. a full cluster fan-out every time an
 *     operator opened a camera tab.
 *
 * The allowlist is the intended friction: an entry is a claim, in writing,
 * that this surface renders the diagram.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PACKAGES = path.join(ROOT, 'packages')

/** The single module allowed to hold the two cluster-reading hooks. */
const HOOK_OWNER = 'packages/ui-library/src/hooks/use-cluster-nodes.ts'

/** How a UI reaches `nodes.topology`, in either of its two spellings. */
const TOPOLOGY_READ_PATTERNS: readonly RegExp[] = [
  /\buseNodesTopology\b/,
  /\btrpc\.nodes\.topology\b/,
  /\bnodes\.topology\.useQuery\b/,
]

/**
 * Surfaces that genuinely render the cluster diagram and may therefore reach
 * for it directly. Each entry states what it draws — if that stops being true,
 * the entry goes, and so does the direct call.
 *
 * NOTE: the sanctioned diagram READERS (Cluster page, ProcessResources,
 * NodeList, NodeDetailHeader, ClusterBalancerTab) are deliberately NOT here:
 * they read through `useClusterTopology`, which is the point. This allowlist
 * exists for a surface that cannot use the hook at all.
 */
// Empty since D646: the one entry was the benchmark's Sustained Throughput
// tab, which was merged into the capacity ramp and deleted.
const ALLOWED_DIRECT_TOPOLOGY_READS: ReadonlyMap<string, string> = new Map<string, string>([])

/** A UI package: one that ships React sources reading the hub through tRPC. */
function isUiPackage(pkg: string): boolean {
  return pkg === 'ui-library' || pkg.startsWith('addon-') || pkg === 'admin-ui'
}

function collectUiSources(): readonly string[] {
  const out: string[] = []
  for (const pkg of fs.readdirSync(PACKAGES)) {
    if (!isUiPackage(pkg)) continue
    const src = path.join(PACKAGES, pkg, 'src')
    if (!fs.existsSync(src)) continue
    walk(src, out)
  }
  return out
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
        continue
      }
      walk(full, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
}

/** Generated cap hooks are a mechanical mirror of the router, not a call site. */
function isGenerated(rel: string): boolean {
  return rel.includes('/generated/')
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

interface Violation {
  readonly file: string
  readonly rule: string
  readonly detail: string
}

/** Rule 1 — only the hook owner (or an allowlisted surface) reads it directly. */
function checkTopologyReachedThroughTheHook(rel: string, code: string): Violation | null {
  const matched = TOPOLOGY_READ_PATTERNS.find((pattern) => pattern.test(code))
  if (!matched) return null
  if (rel === HOOK_OWNER) return null
  if (ALLOWED_DIRECT_TOPOLOGY_READS.has(rel)) return null
  return {
    file: rel,
    rule: 'topology-is-not-a-lookup',
    detail:
      `reads \`nodes.topology\` directly (${matched.source}). That call walks the whole ` +
      'fleet — 30.5 s on the reference hub. If this surface renders the cluster DIAGRAM, ' +
      `read it through \`useClusterTopology\` from ${HOOK_OWNER}. If it needs a node list, ` +
      "a node name or a node's addons, use `useClusterNodes`. If it needs ONE node's " +
      'addons, ask `nodes.getNodeAddons` — one node, no fan-out. Otherwise add an ' +
      'ALLOWED_DIRECT_TOPOLOGY_READS entry saying what diagram it draws.',
  }
}

/** Rule 3 — a call site may not re-declare fetch policy around a topology read. */
function checkNoPollingAtCallSite(rel: string, code: string): Violation | null {
  if (rel === HOOK_OWNER) return null
  if (!TOPOLOGY_READ_PATTERNS.some((pattern) => pattern.test(code))) return null
  const offender = /\brefetchInterval\b|\brefetchOnMount\b|\bstaleTime\b/.exec(code)
  if (!offender) return null
  return {
    file: rel,
    rule: 'topology-fetch-policy-at-call-site',
    detail:
      `declares \`${offender[0]}\` beside a \`nodes.topology\` read. Fetch policy for the ` +
      'cluster diagram belongs to the hook and nowhere else — the owner bootstraps once and ' +
      "then lives off the pushed `cluster.topology-snapshot`. A `refetchOnMount: 'always'` " +
      'here is a full cluster fan-out every time the surface mounts.',
  }
}

/** Rule 2 — the hook owner itself must bootstrap-and-push, never poll. */
function checkHookOwnerDoesNotPoll(): readonly Violation[] {
  const full = path.join(ROOT, HOOK_OWNER)
  if (!fs.existsSync(full)) {
    return [
      {
        file: HOOK_OWNER,
        rule: 'hook-owner-missing',
        detail: 'the module that owns `useClusterTopology` / `useClusterNodes` no longer exists',
      },
    ]
  }
  const code = stripComments(fs.readFileSync(full, 'utf8'))
  const out: Violation[] = []
  if (!/staleTime:\s*(Number\.POSITIVE_INFINITY|Infinity)/.test(code)) {
    out.push({
      file: HOOK_OWNER,
      rule: 'hook-owner-must-not-poll',
      detail:
        'the topology bootstrap query must be `staleTime: Number.POSITIVE_INFINITY` — the ' +
        'hub pushes `cluster.topology-snapshot` every 30 s and 200 ms after any lifecycle ' +
        'edge, so a finite window is a fleet fan-out on a timer.',
    })
  }
  if (/\brefetchInterval\b/.test(code)) {
    out.push({
      file: HOOK_OWNER,
      rule: 'hook-owner-must-not-poll',
      detail: '`refetchInterval` polls the cluster diagram — the snapshot is pushed, not polled.',
    })
  }
  if (!code.includes('cluster.topology-snapshot')) {
    out.push({
      file: HOOK_OWNER,
      rule: 'hook-owner-must-subscribe',
      detail:
        'the hook does not subscribe to `cluster.topology-snapshot`. Without the push, ' +
        '`staleTime: Infinity` means the diagram never updates after the first render.',
    })
  }
  return out
}

// ── Main ───────────────────────────────────────────────────────────────────

const violations: Violation[] = [...checkHookOwnerDoesNotPoll()]

for (const file of collectUiSources()) {
  const rel = path.relative(ROOT, file)
  if (isGenerated(rel)) continue
  const code = stripComments(fs.readFileSync(file, 'utf8'))
  for (const check of [checkTopologyReachedThroughTheHook, checkNoPollingAtCallSite]) {
    const violation = check(rel, code)
    if (violation) violations.push(violation)
  }
}

// A stale allowlist entry is a rule nobody is enforcing — fail on it too.
for (const [rel, reason] of ALLOWED_DIRECT_TOPOLOGY_READS) {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) {
    violations.push({
      file: rel,
      rule: 'stale-allowlist-entry',
      detail: `ALLOWED_DIRECT_TOPOLOGY_READS names a file that no longer exists (reason: ${reason})`,
    })
    continue
  }
  const code = stripComments(fs.readFileSync(full, 'utf8'))
  if (!TOPOLOGY_READ_PATTERNS.some((pattern) => pattern.test(code))) {
    violations.push({
      file: rel,
      rule: 'stale-allowlist-entry',
      detail: 'ALLOWED_DIRECT_TOPOLOGY_READS entry no longer reads `nodes.topology` — remove it',
    })
  }
}

if (violations.length > 0) {
  console.error('✗ topology guard: `nodes.topology` is the cluster diagram, not a lookup\n')
  for (const violation of violations) {
    console.error(`  ${violation.file}`)
    console.error(`    [${violation.rule}] ${violation.detail}\n`)
  }
  process.exit(1)
}

console.log('✓ topology guard: every cluster read is proportional to the fact it needs')
