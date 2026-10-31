import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { hubRequest } from '../http/hub-http.js'
import { type CredentialSource, withAuthHint } from '@camstack/develop'

interface DeployResult {
  readonly success: boolean
  readonly packageName?: string
  readonly version?: string
  readonly capabilities?: readonly string[]
  readonly target?: string
  readonly addonId?: string
  /**
   * Addon declaration ids the target node re-instantiated from the new dist.
   * An agent deploy that lands the bytes but reloads NOTHING keeps running the
   * previous code — the exact silent no-op this field exists to expose.
   */
  readonly reloaded?: readonly string[]
  /** sha256 the node confirmed it applied. Absent = the node could not verify. */
  readonly verifiedSha256?: string
  /**
   * The hub accepted the bundle and is pushing it to the agents AFTER
   * answering — the propagation is `void`-ed on the server, so its outcome is
   * NOT in this reply and NOT covered by the tick this command prints.
   *
   * On 2026-09-11 three deploys printed `✓ Deployed to 1 target(s)` while every
   * one of them failed on `agent-a` with a 30 s RPC timeout. The tick was
   * true — the hub is one target — and the operator had no way to know.
   */
  readonly propagatingToAgentsInBackground?: boolean
  readonly error?: string
}

interface TopologyNode {
  readonly id: string
  readonly name: string
  readonly isHub: boolean
  readonly isOnline: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * True for the transient network errors thrown when the hub is mid-bounce
 * — notably the core deploy's self-restart of the upload handler, which
 * makes the very next request fail with `fetch failed` / ECONNREFUSED /
 * socket hang up. These are safe to retry; a 4xx/5xx HTTP response is NOT
 * (that's a real rejection the server already parsed).
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = `${err.message} ${err.cause instanceof Error ? err.cause.message : ''}`.toLowerCase()
  return /fetch failed|econnrefused|econnreset|socket hang up|network|timed out|etimedout|enotfound|eai_again/.test(
    msg,
  )
}

/**
 * Run `fn`, retrying ONLY on transient network errors (hub mid-bounce).
 * Linear backoff. Surfaces the last error if every attempt fails.
 */
async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; delayMs: number; onRetry?: (attempt: number, err: unknown) => void },
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === opts.attempts || !isTransientNetworkError(err)) throw err
      opts.onRetry?.(attempt, err)
      await sleep(opts.delayMs)
    }
  }
  throw lastErr
}

/**
 * Poll `${serverUrl}/health` until it reports `ok:true` or the budget runs
 * out. Used after a deploy to confirm the hub finished its self-bounce and
 * is serving again — so a headless `deploy` exits non-zero if the node
 * never came back, instead of returning green on a half-applied install.
 */
async function verifyHubHealthy(
  serverUrl: string,
  opts: { attempts: number; delayMs: number },
): Promise<boolean> {
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      const res = await hubRequest(`${serverUrl}/health`, { timeoutMs: 5_000 })
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean }
        if (body.ok === true) return true
      }
    } catch {
      /* hub still bouncing — keep polling */
    }
    if (attempt < opts.attempts) await sleep(opts.delayMs)
  }
  return false
}

function toDeployResult(value: unknown): DeployResult {
  if (!isRecord(value)) return { success: false, error: 'Invalid response shape' }
  return {
    success: value['success'] === true,
    packageName: typeof value['packageName'] === 'string' ? value['packageName'] : undefined,
    version: typeof value['version'] === 'string' ? value['version'] : undefined,
    target: typeof value['target'] === 'string' ? value['target'] : undefined,
    addonId: typeof value['addonId'] === 'string' ? value['addonId'] : undefined,
    capabilities: Array.isArray(value['capabilities'])
      ? value['capabilities'].filter((c): c is string => typeof c === 'string')
      : undefined,
    reloaded: Array.isArray(value['reloaded'])
      ? value['reloaded'].filter((c): c is string => typeof c === 'string')
      : undefined,
    verifiedSha256:
      typeof value['verifiedSha256'] === 'string' ? value['verifiedSha256'] : undefined,
    error: typeof value['error'] === 'string' ? value['error'] : undefined,
  }
}

/**
 * Render what a node actually DID, not just that the request returned 200.
 *
 * A `camstack deploy -n <agent>` printed `✓ agent-a: @camstack/addon-pipeline@1.2.43`
 * while the node kept executing the previous dist, because the hub route
 * installed the bundle and never reloaded it. Four reproductions on 2026-08-07
 * were spent hunting a tarball cache that does not exist. A deploy line that
 * cannot distinguish "running the new code" from "holding a new tarball" is not
 * a report — so an agent target that reloaded nothing now says so out loud.
 */
/**
 * The target guard. The hub echoes the target it actually used; when that is
 * not the node we asked for, the deploy went somewhere else and the tick would
 * be a lie.
 *
 * This is not hypothetical: a `nodeId` field the hub could not see made every
 * `-n <agent>` push install on the HUB instead, answering `target: "hub"` while
 * the CLI printed the agent's name. Returns an error message, or `null` when
 * the target is the one requested.
 */
export function checkDeployTarget(
  result: DeployResult,
  requestedNodeId: string | undefined,
): string | null {
  const actual = result.target
  if (actual === undefined) return null // older hub: nothing to compare against
  const expected = requestedNodeId ?? 'hub'
  if (actual === expected) return null
  return (
    `the hub installed this on "${actual}", NOT on "${expected}" — the target was ignored. ` +
    'Nothing was deployed to the node you named.'
  )
}

export function describeDeployOutcome(
  result: DeployResult,
  isAgentTarget: boolean,
): { readonly detail: string; readonly warning: string | null } {
  const id = result.packageName ?? result.addonId ?? '?'
  const version = result.version ? `@${result.version}` : ''
  const reloaded = result.reloaded
  const suffix = reloaded === undefined ? '' : ` (reloaded: ${reloaded.join(', ') || 'none'})`
  const detail = `${id}${version}${suffix}`
  if (!isAgentTarget) return { detail, warning: null }
  if (reloaded === undefined) {
    return {
      detail,
      warning:
        'node did not report what it reloaded — its hub runtime predates deploy verification, ' +
        'so nothing confirms the new code is running',
    }
  }
  if (reloaded.length === 0) {
    return {
      detail,
      warning:
        'bundle landed but the node reloaded NOTHING — it is probably still running the ' +
        'previous code. Check the node, or restart the addon.',
    }
  }
  return { detail, warning: null }
}

function toPackFilenames(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (!isRecord(entry)) return []
      return typeof entry['filename'] === 'string' ? [entry['filename']] : []
    })
  } catch {
    return []
  }
}

/**
 * Resolve an addon source argument into an absolute directory or tarball
 * path. Accepts:
 *   - `.tgz` / `.tar.gz` file path (used as-is)
 *   - directory with `package.json` (will be npm-packed)
 *   - workspace shorthand (`tailscale` → `<cwd>/packages/addon-tailscale`
 *     or `packages/tailscale` etc.) — useful from monorepo root
 *
 * Returns `null` when nothing resolves — caller can then fall back to
 * the 5-level recursive discovery via `resolveAddonPathInteractive`.
 */
export function resolveAddonPath(arg: string): string | null {
  const absolute = path.resolve(arg)
  if (fs.existsSync(absolute)) return absolute
  // Workspace shorthand: try `packages/addon-<arg>` and `packages/<arg>`
  // relative to current working directory. Matches the camstack monorepo
  // convention (addon-<name>) plus core/agent/etc. fallbacks.
  for (const candidate of [
    path.resolve('packages', `addon-${arg}`),
    path.resolve('packages', arg),
  ]) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate
    }
  }
  return null
}

/**
 * Path resolver that integrates the 5-level filesystem discovery.
 *
 * Decision tree:
 *   1. `arg !== '.'` → exact match required (workspace shorthand / direct
 *      path / tarball). Throws on miss.
 *   2. `arg === '.'` AND cwd itself is a valid addon (has package.json
 *      that classifies) → use cwd silently (legacy behaviour).
 *   3. `arg === '.'` AND not an addon → scan up to 5 levels deep.
 *        • 0 hits  → fail with a clear "nothing found" message.
 *        • 1 hit   → silently use it (no prompt for unambiguous case).
 *        • N hits  → clack select prompt; operator picks.
 *
 * Returns the absolute path to the chosen addon directory or tarball.
 */
export async function resolveAddonPathInteractive(arg: string): Promise<string> {
  // Non-`.` args take the legacy fast path.
  if (arg !== '.') {
    const resolved = resolveAddonPath(arg)
    if (!resolved) {
      throw new Error(
        `Path not resolved: ${arg} (tried as-is + packages/addon-${arg} + packages/${arg})`,
      )
    }
    return resolved
  }
  // cwd itself is an addon?
  const cwdAbs = path.resolve('.')
  if (fs.existsSync(path.join(cwdAbs, 'package.json'))) {
    // Run the classifier to confirm it's actually an addon, not just any package.
    const { discoverAddonsInCwd } = await import('./discover-addons.js')
    const direct = discoverAddonsInCwd(cwdAbs, 0)
    if (direct.length > 0 && direct[0]!.path === cwdAbs) {
      return cwdAbs
    }
  }
  // Recursive scan + interactive picker.
  const { discoverAddonsInCwd } = await import('./discover-addons.js')
  const candidates = discoverAddonsInCwd(cwdAbs, 5)
  if (candidates.length === 0) {
    throw new Error(
      `No addon found in the current directory tree (5 levels deep). Run inside an addon source dir, pass a path, or use the workspace shorthand.`,
    )
  }
  if (candidates.length === 1) {
    const only = candidates[0]!
    console.log(
      `[camstack] Auto-selected ${only.name} (${path.relative(cwdAbs, only.path) || '.'}, matched by ${only.matchedBy})`,
    )
    return only.path
  }
  // Multiple — prompt.
  const clack = await import('@clack/prompts')
  const choice = await clack.select({
    message: `Found ${candidates.length} addons — pick one to deploy`,
    options: candidates.map((c) => ({
      value: c.path,
      label: `${c.name}${c.displayName && c.displayName !== c.name ? ` (${c.displayName})` : ''}`,
      hint: `${path.relative(cwdAbs, c.path) || '.'}  matched by ${c.matchedBy}`,
    })),
  })
  if (clack.isCancel(choice)) {
    clack.cancel('Cancelled.')
    process.exit(130)
  }
  return choice as string
}

/**
 * Resolve the package.json of an addon dir and check for a build script.
 * Returns the script name when present; null when no `scripts.<scriptName>`
 * is declared (caller treats as "nothing to do, skip build").
 */
function readBuildScript(addonDir: string, scriptName: string): string | null {
  const pkgJsonPath = path.join(addonDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return null
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const scripts = (parsed as { scripts?: Record<string, unknown> }).scripts
    if (!scripts || typeof scripts !== 'object') return null
    const val = (scripts as Record<string, unknown>)[scriptName]
    return typeof val === 'string' && val.length > 0 ? scriptName : null
  } catch {
    return null
  }
}

/**
 * Run `npm run <script>` inside the addon directory. We use the same npm
 * already on PATH (the one that loaded this CLI), so workspace setups
 * like nvm/volta/asdf and corepack-shimmed package managers resolve
 * naturally. Stdio is inherited so the operator sees real-time output
 * — the alternative (capturing + replaying on failure) hides progress
 * and makes long builds feel frozen.
 */
function buildAddon(addonDir: string, scriptName: string): void {
  console.log(`[camstack] Building (npm run ${scriptName}) in ${addonDir}...`)
  try {
    execSync(`npm run ${scriptName}`, {
      cwd: addonDir,
      stdio: 'inherit',
      timeout: 5 * 60_000,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Build script "${scriptName}" failed in ${addonDir}: ${msg}`, { cause: err })
  }
}

/**
 * Run `npm pack` in a directory and return the resulting .tgz path.
 * Cleans up the tgz when `cleanup()` is invoked.
 */
function packAddon(addonDir: string): { readonly tgzPath: string; readonly cleanup: () => void } {
  const pkgJsonPath = path.join(addonDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`No package.json found in: ${addonDir}`)
  }
  console.log(`[camstack] Packing addon from ${addonDir}...`)
  const packOutput = execSync('npm pack --json 2>/dev/null || npm pack', {
    cwd: addonDir,
    encoding: 'utf8',
    timeout: 60_000,
  }).trim()
  const parsedFilenames = toPackFilenames(packOutput)
  let tgzFilename: string
  if (parsedFilenames.length > 0) {
    tgzFilename = parsedFilenames[0] ?? ''
  } else {
    const lines = packOutput.split('\n')
    tgzFilename = lines[lines.length - 1]?.trim() ?? ''
  }
  if (!tgzFilename) throw new Error('npm pack did not produce a .tgz file')
  const tgzPath = path.join(addonDir, tgzFilename)
  if (!fs.existsSync(tgzPath)) {
    throw new Error(`Expected tgz file not found: ${tgzPath}`)
  }
  console.log(`[camstack] Packed: ${tgzFilename}`)
  return {
    tgzPath,
    cleanup: () => {
      try {
        if (fs.existsSync(tgzPath)) fs.unlinkSync(tgzPath)
      } catch {
        /* noop */
      }
    },
  }
}

/**
 * Query the hub's `nodes.topology` cap and return the list of online
 * agents (hub excluded — every cluster push always includes the hub).
 * Auth: the supplied token must have `admin` or `super_admin` role.
 */
async function fetchOnlineAgents(
  serverUrl: string,
  token: string,
): Promise<readonly TopologyNode[]> {
  // An OBJECT input, never a null one. The procedure's input parses as an
  // object, and a null fails validation — but tRPC answers a validation
  // failure with HTTP **200** and an `error` in the BODY. The old call sent
  // null, so
  // `body.result?.data?.json ?? []` turned that error into an empty list and
  // `--cluster` reported "no online agents found" while pushing to the hub
  // alone. Verified 2026-08-02 against the live hub: null → `expected object`,
  // `{}` → three nodes, all online. A silent partial cluster update is worse
  // than a failed one, because the operator is told it worked.
  const url = `${serverUrl}/trpc/nodes.topology?input=${encodeURIComponent('{"json":{}}')}`
  const res = await hubRequest(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    throw new Error(
      `nodes.topology returned ${res.status}: ${await res.text().catch(() => res.statusText)}`,
    )
  }
  const body = (await res.json()) as {
    result?: { data?: { json?: readonly TopologyNode[] } }
    error?: { json?: { message?: string } }
  }
  // A 200 carrying an `error` is a FAILURE, not an empty cluster. Throwing puts
  // it on the caller's error path, which says so out loud.
  if (body.error) {
    throw new Error(`nodes.topology failed: ${body.error.json?.message ?? 'unknown error'}`)
  }
  const nodes = body.result?.data?.json
  if (!Array.isArray(nodes)) {
    throw new Error(
      'nodes.topology returned no node list — refusing to assume the cluster is empty',
    )
  }
  return nodes.filter((n) => n.isOnline && !n.isHub)
}

/**
 * POST the tarball to /api/addons/upload with an optional nodeId field.
 * Returns the parsed DeployResult (caller decides how to render).
 */
async function uploadToTarget(args: {
  readonly serverUrl: string
  readonly token: string
  readonly tgzPath: string
  readonly nodeId?: string
  readonly addonId?: string
  readonly authSource?: CredentialSource
}): Promise<DeployResult> {
  const { serverUrl, token, tgzPath, nodeId, addonId } = args
  const fileBuffer = fs.readFileSync(tgzPath)
  // Hand-rolled multipart/form-data — the tarball goes through hubRequest
  // (node:https + pinned-CA agent), which has no FormData/Blob
  // convenience, so we assemble the body + boundary ourselves.
  //
  // **The text fields come FIRST, before the file.** They used to trail it, and
  // the hub reads them off a busboy body that is only populated as parsing
  // proceeds: with a 4.9 MB tarball the hub saw `nodeId = undefined`, took the
  // hub-install branch, and never addressed the agent the operator named — while
  // this CLI printed a tick against that agent's label. Small tarballs arrived in
  // one chunk and worked, which is why it looked intermittent. Leading fields are
  // parsed before the file part exists, on any server version.
  const boundary = `----camstackcli${randomBytes(16).toString('hex')}`
  const CRLF = '\r\n'
  const parts: Buffer[] = []
  const appendField = (name: string, value: string): void => {
    parts.push(
      Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
      ),
    )
  }
  if (nodeId) appendField('nodeId', nodeId)
  if (addonId) appendField('addonId', addonId)
  parts.push(
    Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="${path.basename(tgzPath)}"${CRLF}` +
        `Content-Type: application/gzip${CRLF}${CRLF}`,
    ),
    fileBuffer,
    Buffer.from(CRLF),
  )
  parts.push(Buffer.from(`--${boundary}--${CRLF}`))
  const body = Buffer.concat(parts)
  const response = await hubRequest(`${serverUrl}/api/addons/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
    // Large tarballs + a hub that may be mid-bounce — give it room.
    timeoutMs: 120_000,
  })
  const result = toDeployResult(await response.json().catch(() => ({})))
  if (!response.ok) {
    return {
      success: false,
      error: withAuthHint(
        result.error ?? `Server returned ${response.status} ${response.statusText}`,
        response.status,
        args.authSource,
      ),
    }
  }
  return result
}

export interface DeployOptions {
  readonly serverUrl: string
  readonly token: string
  /** Where `token` came from — picks the advice printed on a 401/403. */
  readonly authSource?: CredentialSource
  /** Explicit target node id (e.g. "dev-agent-0"). Pushes ONLY to that node. */
  readonly nodeId?: string
  /**
   * When true, query `nodes.topology` and push to hub + every online
   * agent. Falls back to hub-only push if the topology query fails
   * (e.g. user token lacks admin scope).
   */
  readonly cluster?: boolean
  /**
   * Build behaviour when the addon source is a directory:
   *   • `'auto'` (default) — runs the `build` script if declared in
   *     package.json. Skips silently otherwise (the addon may ship
   *     compiled artifacts checked in).
   *   • `'force'` — runs the build script; errors if missing.
   *   • `'skip'` — pack only, never invoke npm run build.
   * Tarball inputs (.tgz) always skip — they're already built.
   */
  readonly buildMode?: 'auto' | 'force' | 'skip'
  /** Override the npm script name. Default: `build`. */
  readonly buildScript?: string
  /**
   * After a successful upload, poll the hub's `/health` until it reports
   * ready (it self-bounces on a core/system deploy). Default `true` so a
   * headless `deploy` fails loudly if the node never comes back. Set
   * `false` for fire-and-forget.
   */
  readonly verify?: boolean
}

/**
 * Build (if needed) and deploy an addon to one or more CamStack nodes.
 */
export async function deployAddon(addonPath: string, opts: DeployOptions): Promise<void> {
  // Path can be passed pre-resolved (e.g. dev command did its own
  // interactive prompt). When it's not (raw `.`), run the same
  // resolver the CLI dispatcher would have used.
  const resolvedPath =
    path.isAbsolute(addonPath) && fs.existsSync(addonPath)
      ? addonPath
      : await resolveAddonPathInteractive(addonPath)

  let tgzPath: string
  let cleanup: (() => void) | null = null
  if (resolvedPath.endsWith('.tgz') || resolvedPath.endsWith('.tar.gz')) {
    if (!fs.existsSync(resolvedPath)) throw new Error(`File not found: ${resolvedPath}`)
    tgzPath = resolvedPath
  } else {
    // Optional build before pack. Tarball inputs always skip — pre-built.
    const buildMode = opts.buildMode ?? 'auto'
    const scriptName = opts.buildScript ?? 'build'
    if (buildMode !== 'skip') {
      const declared = readBuildScript(resolvedPath, scriptName)
      if (declared) {
        buildAddon(resolvedPath, declared)
      } else if (buildMode === 'force') {
        throw new Error(
          `Build mode "force" but no "${scriptName}" script declared in ${path.join(resolvedPath, 'package.json')}`,
        )
      } else {
        console.log(
          `[camstack] No "${scriptName}" script — skipping build (use --build force to require one).`,
        )
      }
    }
    const packed = packAddon(resolvedPath)
    tgzPath = packed.tgzPath
    cleanup = packed.cleanup
  }

  try {
    // Build the target list:
    //   - `--node X`            → single named target
    //   - `--cluster`           → hub + every online agent
    //   - default               → hub only
    const targets: { nodeId?: string; label: string }[] = []
    if (opts.nodeId) {
      targets.push({ nodeId: opts.nodeId, label: opts.nodeId })
    } else if (opts.cluster) {
      targets.push({ label: 'hub' }) // hub always — undefined nodeId == hub install path
      try {
        const agents = await fetchOnlineAgents(opts.serverUrl, opts.token)
        for (const a of agents) {
          targets.push({ nodeId: a.id, label: `${a.name} (${a.id})` })
        }
        if (agents.length === 0) {
          console.log('[camstack] --cluster: no online agents found, pushing to hub only')
        } else {
          console.log(`[camstack] --cluster: pushing to hub + ${agents.length} online agent(s)`)
        }
      } catch (err) {
        // `--cluster` means "every node". If we cannot even ASK which nodes
        // exist, quietly deploying to the hub alone leaves the fleet on mixed
        // versions while reporting success — the exact failure that let an
        // agent sit on stale code for a day. Refuse instead: the operator can
        // still run `-n <node>` deliberately.
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(
          `--cluster: cannot enumerate agents, refusing a partial cluster deploy (${msg}). ` +
            'Deploy per node with -n <nodeId> if this is intentional.',
        )
      }
    } else {
      targets.push({ label: 'hub' })
    }

    // Push sequentially so failures don't get tangled. Per-target outcomes
    // print as we go; final summary at the end.
    const outcomes: { target: string; ok: boolean; detail: string }[] = []
    let propagating = false
    for (const t of targets) {
      console.log(`[camstack] → Deploying ${path.basename(tgzPath)} to ${t.label}...`)
      // Retry the upload itself through transient network errors — a core/
      // system deploy self-bounces the upload handler, so the request can
      // fail with `fetch failed` while the hub is mid-restart.
      const result = await withNetworkRetry(
        () =>
          uploadToTarget({
            serverUrl: opts.serverUrl,
            token: opts.token,
            tgzPath,
            ...(t.nodeId ? { nodeId: t.nodeId } : {}),
            ...(opts.authSource ? { authSource: opts.authSource } : {}),
          }),
        {
          attempts: 5,
          delayMs: 3_000,
          onRetry: (attempt, err) =>
            console.log(
              `[camstack]   … ${t.label} unreachable (hub bouncing?), retry ${attempt}/4: ${err instanceof Error ? err.message : String(err)}`,
            ),
        },
      )
      const misrouted = result.success ? checkDeployTarget(result, t.nodeId) : null
      if (misrouted) {
        // A deploy that landed on a node nobody asked for is a FAILURE, not a
        // tick with a footnote.
        console.error(`[camstack]   ✗ ${t.label}: ${misrouted}`)
        outcomes.push({ target: t.label, ok: false, detail: misrouted })
      } else if (result.success) {
        if (result.propagatingToAgentsInBackground === true) propagating = true
        const { detail, warning } = describeDeployOutcome(result, t.nodeId !== undefined)
        console.log(`[camstack]   ✓ ${t.label}: ${detail}`)
        if (warning) console.warn(`[camstack]   ⚠ ${t.label}: ${warning}`)
        outcomes.push({ target: t.label, ok: true, detail })
      } else {
        const detail = result.error ?? 'unknown'
        console.error(`[camstack]   ✗ ${t.label}: ${detail}`)
        outcomes.push({ target: t.label, ok: false, detail })
      }
    }

    const failed = outcomes.filter((o) => !o.ok)
    if (failed.length > 0) {
      console.error(`[camstack] ${failed.length}/${outcomes.length} target(s) failed`)
      process.exit(1)
    }
    console.log(`[camstack] ✓ Deployed to ${outcomes.length} target(s)`)
    if (propagating) {
      // Never let the tick above stand for the agents: it does not cover them.
      console.log(
        '[camstack]   … agents are updated in the BACKGROUND and are NOT covered by the ✓ above.',
      )
      console.log(
        '[camstack]     Confirm with: hub log line `propagation done` (per-agent success/error).',
      )
    }

    // Post-deploy health gate: confirm the hub finished its self-bounce and
    // is serving again. Makes `deploy` safe to chain in a headless pipeline
    // (deploy → reload → verify) — a node that never recovers fails the run.
    if (opts.verify !== false) {
      process.stdout.write('[camstack] Verifying hub health')
      const healthy = await verifyHubHealthy(opts.serverUrl, { attempts: 20, delayMs: 1_500 })
      process.stdout.write('\n')
      if (!healthy) {
        console.error(
          '[camstack] ✗ Hub did not report healthy after deploy (still bouncing or failed to restart)',
        )
        process.exit(1)
      }
      console.log('[camstack] ✓ Hub healthy')
    }
  } finally {
    if (cleanup) cleanup()
  }
}
