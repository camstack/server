/**
 * `camstack deploy-server` — the dev server-deploy channel (full fidelity,
 * no npm publish).
 *
 * Flow (operator decision: every dev iteration goes through the SAME
 * stage → drain → probation → promote cycle as a release — no fast
 * dist-overlay mode):
 *   1. discover the `@camstack/server` workspace closure from the graph,
 *   2. build every closure package in dependency order,
 *   3. pack each install-closure package at ONE uniform dev version
 *      (`<serverBase>-dev.<epochSeconds>`; temp-only package.json rewrite),
 *   4. upload all tarballs multipart to `POST /api/server-upload`,
 *   5. call `serverManagement.applyServerUpdate {version}` and poll
 *      `serverManagement.getServerPackageStatus` until the dev version is
 *      promoted or rolled back.
 */
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { hubRequest } from '../http/hub-http.js'
import { type CredentialSource, withAuthHint } from '@camstack/develop'
import {
  computeDevVersion,
  discoverServerClosure,
  withDevVersionPackageJson,
  type ServerClosure,
  type WorkspacePackage,
} from './server-closure.js'

const BUILD_TIMEOUT_MS = 15 * 60_000
const PACK_TIMEOUT_MS = 2 * 60_000
const UPLOAD_TIMEOUT_MS = 10 * 60_000
const APPLY_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 3_000
const POLL_BUDGET_MS = 10 * 60_000

export interface DeployServerOptions {
  readonly serverUrl: string
  readonly token: string
  /** Where `token` came from — picks the advice printed on a 401/403. */
  readonly authSource?: CredentialSource
  /**
   * Skip the post-apply promotion poll (fire-and-forget after
   * `applyServerUpdate` is accepted). Default: verify.
   */
  readonly verify?: boolean
  /** Workspace root — defaults to the current working directory. */
  readonly workspaceRoot?: string
  /**
   * After the hub upload+apply, also propagate `dev-uploads` and apply on
   * these agent node ids. Mutually exclusive with `allAgents` at the CLI.
   */
  readonly nodeIds?: readonly string[]
  /**
   * Propagate+apply on every online agent from `nodes.topology` (hub already
   * handled). Mutually exclusive with `nodeIds` at the CLI.
   * CLI surface: `--cluster` (preferred) or legacy `--all` on `deploy-server`.
   */
  readonly allAgents?: boolean
  /**
   * Reuse an already-uploaded hub `dev-uploads/<version>/` — skip build, pack
   * and upload. Still applies the hub (no-op if already running) then fans out
   * when `allAgents` / `nodeIds` are set.
   */
  readonly existingVersion?: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ── Build + pack ─────────────────────────────────────────────────────────

function hasBuildScript(pkgDir: string): boolean {
  const manifest = readJson(path.join(pkgDir, 'package.json'))
  if (!isRecord(manifest)) return false
  const scripts = manifest['scripts']
  return isRecord(scripts) && typeof scripts['build'] === 'string' && scripts['build'].length > 0
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * `npm run build` in the package dir — same mechanism as the addon deploy
 * path (npm from PATH, inherited stdio for real-time output), with a wider
 * timeout because the server backend + admin UI builds run minutes.
 */
function buildPackage(pkg: WorkspacePackage): void {
  if (!hasBuildScript(pkg.dir)) {
    console.log(`[camstack]   ${pkg.name}: no build script — skipping`)
    return
  }
  console.log(`[camstack]   ${pkg.name}: npm run build`)
  try {
    execSync('npm run build', { cwd: pkg.dir, stdio: 'inherit', timeout: BUILD_TIMEOUT_MS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Build failed for ${pkg.name} (${pkg.dir}): ${msg}`, { cause: err })
  }
}

function toPackFilename(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const first: unknown = parsed[0]
    if (!isRecord(first)) return null
    return typeof first['filename'] === 'string' ? first['filename'] : null
  } catch {
    // Non-JSON npm pack output — last non-empty line is the filename.
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    const last = lines[lines.length - 1]?.trim()
    return last !== undefined && last.length > 0 ? last : null
  }
}

interface PackedTarball {
  readonly name: string
  readonly tgzPath: string
}

/**
 * Pack one package at the uniform dev version into `outDir`. The
 * package.json rewrite lives only for the duration of `npm pack` —
 * the workspace file is restored afterwards (see server-closure.ts).
 */
function packPackage(
  pkg: WorkspacePackage,
  devVersion: string,
  intraSetNames: ReadonlySet<string>,
  outDir: string,
): PackedTarball {
  const output = withDevVersionPackageJson(pkg.dir, devVersion, intraSetNames, () =>
    execSync(`npm pack --json --pack-destination ${JSON.stringify(outDir)}`, {
      cwd: pkg.dir,
      encoding: 'utf8',
      timeout: PACK_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
  )
  const filename = toPackFilename(output)
  if (filename === null) {
    throw new Error(`npm pack produced no tarball for ${pkg.name}`)
  }
  const tgzPath = path.join(outDir, path.basename(filename))
  if (!fs.existsSync(tgzPath)) {
    throw new Error(`Expected tarball not found after pack: ${tgzPath}`)
  }
  return { name: pkg.name, tgzPath }
}

// ── Upload ───────────────────────────────────────────────────────────────

/**
 * POST every tarball + the version field in ONE multipart request to
 * `/api/server-upload`. Hand-rolled multipart (same approach as the addon
 * deploy) because `hubRequest` (node:https + pinned-CA agent)
 * has no FormData convenience.
 */
async function uploadClosure(args: {
  readonly serverUrl: string
  readonly token: string
  readonly version: string
  readonly tarballs: readonly PackedTarball[]
  readonly authSource?: CredentialSource
}): Promise<void> {
  const boundary = `----camstackdeployserver${randomBytes(16).toString('hex')}`
  const CRLF = '\r\n'
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="version"${CRLF}${CRLF}${args.version}${CRLF}`,
    ),
  ]
  for (const tarball of args.tarballs) {
    parts.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="file"; filename="${path.basename(tarball.tgzPath)}"${CRLF}` +
          `Content-Type: application/gzip${CRLF}${CRLF}`,
      ),
      fs.readFileSync(tarball.tgzPath),
      Buffer.from(CRLF),
    )
  }
  parts.push(Buffer.from(`--${boundary}--${CRLF}`))
  const body = Buffer.concat(parts)
  const response = await hubRequest(`${args.serverUrl}/api/server-upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  })
  const payload = await response.json().catch((): unknown => ({}))
  if (!response.ok || !isRecord(payload) || payload['success'] !== true) {
    const detail =
      isRecord(payload) && typeof payload['error'] === 'string'
        ? payload['error']
        : `${response.status} ${response.statusText}`
    throw new Error(
      withAuthHint(`Server upload rejected: ${detail}`, response.status, args.authSource),
    )
  }
}

// ── Apply + poll ─────────────────────────────────────────────────────────

interface ApplyResult {
  readonly accepted: boolean
  readonly restarting: boolean
  readonly message: string
}

function toApplyResult(value: unknown): ApplyResult | null {
  if (!isRecord(value)) return null
  if (typeof value['accepted'] !== 'boolean' || typeof value['message'] !== 'string') return null
  return {
    accepted: value['accepted'],
    restarting: value['restarting'] === true,
    message: value['message'],
  }
}

/** Unwrap a tRPC batched envelope: `[{result:{data:{json: <payload>}}}]`. */
function unwrapTrpcJson(body: unknown): unknown {
  const first: unknown = Array.isArray(body) ? body[0] : body
  if (!isRecord(first)) return null
  const result = first['result']
  if (!isRecord(result)) return null
  const data = result['data']
  if (!isRecord(data)) return null
  return data['json']
}

async function applyServerUpdate(args: {
  readonly serverUrl: string
  readonly token: string
  readonly version: string
  readonly nodeId?: string
  readonly authSource?: CredentialSource
}): Promise<ApplyResult> {
  const payload: { version: string; nodeId?: string } = { version: args.version }
  if (args.nodeId !== undefined) payload.nodeId = args.nodeId
  const res = await hubRequest(
    `${args.serverUrl}/trpc/serverManagement.applyServerUpdate?batch=1`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ '0': { json: payload } }),
      timeoutMs: APPLY_TIMEOUT_MS,
    },
  )
  const body = await res.json().catch((): unknown => null)
  if (!res.ok) {
    throw new Error(
      withAuthHint(
        `applyServerUpdate returned ${res.status} ${res.statusText}`,
        res.status,
        args.authSource,
      ),
    )
  }
  const result = toApplyResult(unwrapTrpcJson(body))
  if (result === null) {
    throw new Error('applyServerUpdate returned an unexpected payload shape')
  }
  return result
}

interface ServerStatusView {
  readonly runningVersion: string | null
  readonly updateState: string
  readonly pendingVersion: string | null
  readonly rolledBackFrom: string | null
  readonly rolledBackReason: string | null
}

function toStatusView(value: unknown): ServerStatusView | null {
  if (!isRecord(value)) return null
  if (typeof value['updateState'] !== 'string') return null
  const rolledBack = value['rolledBack']
  return {
    runningVersion: typeof value['runningVersion'] === 'string' ? value['runningVersion'] : null,
    updateState: value['updateState'],
    pendingVersion: typeof value['pendingVersion'] === 'string' ? value['pendingVersion'] : null,
    rolledBackFrom:
      isRecord(rolledBack) && typeof rolledBack['fromVersion'] === 'string'
        ? rolledBack['fromVersion']
        : null,
    rolledBackReason:
      isRecord(rolledBack) && typeof rolledBack['reason'] === 'string'
        ? rolledBack['reason']
        : null,
  }
}

async function fetchServerStatus(
  serverUrl: string,
  token: string,
  nodeId?: string,
): Promise<ServerStatusView | null> {
  const url = serverPackageStatusUrl(serverUrl, nodeId)
  const res = await hubRequest(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 10_000,
  })
  if (!res.ok) return null
  const body = await res.json().catch((): unknown => null)
  return toStatusView(unwrapTrpcJson(body))
}

export function serverPackageStatusUrl(serverUrl: string, nodeId?: string): string {
  const input = nodeId === undefined ? '{"json":{}}' : JSON.stringify({ json: { nodeId } })
  return `${serverUrl}/trpc/serverManagement.getServerPackageStatus?input=${encodeURIComponent(input)}`
}

interface TopologyNode {
  readonly id: string
  readonly isHub: boolean
  readonly isOnline: boolean
}

/**
 * Online agents only — hub is always updated by the main deploy-server path.
 * Same contract as addon `--cluster`: refuse if topology is unreadable.
 */
export async function fetchOnlineAgentIds(
  serverUrl: string,
  token: string,
): Promise<readonly string[]> {
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
  if (body.error) {
    throw new Error(`nodes.topology failed: ${body.error.json?.message ?? 'unknown error'}`)
  }
  const nodes = body.result?.data?.json
  if (!Array.isArray(nodes)) {
    throw new Error(
      'nodes.topology returned no node list — refusing to assume the cluster is empty',
    )
  }
  return nodes.filter((n) => n.isOnline && !n.isHub).map((n) => n.id)
}

async function propagateDevUploads(args: {
  readonly serverUrl: string
  readonly token: string
  readonly version: string
  readonly nodeId: string
  readonly authSource?: CredentialSource
}): Promise<void> {
  const response = await hubRequest(`${args.serverUrl}/api/server-upload/propagate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ version: args.version, nodeId: args.nodeId }),
    timeoutMs: UPLOAD_TIMEOUT_MS,
  })
  const payload = await response.json().catch((): unknown => ({}))
  if (!response.ok || !isRecord(payload) || payload['success'] !== true) {
    const detail =
      isRecord(payload) && typeof payload['error'] === 'string'
        ? payload['error']
        : `${response.status} ${response.statusText}`
    throw new Error(
      withAuthHint(
        `propagate to ${args.nodeId} rejected: ${detail}`,
        response.status,
        args.authSource,
      ),
    )
  }
}

/**
 * Poll the update state until the dev version is promoted (running + idle)
 * or rolled back. Network errors are expected mid-poll — the hub restarts
 * onto the staged closure — and are swallowed until the budget runs out.
 */
async function pollUntilPromoted(args: {
  readonly serverUrl: string
  readonly token: string
  readonly version: string
  readonly nodeId?: string
  readonly label?: string
}): Promise<void> {
  const label = args.label ?? args.nodeId ?? 'hub'
  const deadline = Date.now() + POLL_BUDGET_MS
  let lastState = ''
  while (Date.now() < deadline) {
    let status: ServerStatusView | null = null
    try {
      status = await fetchServerStatus(args.serverUrl, args.token, args.nodeId)
    } catch {
      // node bouncing between drain and probation boot — keep polling
    }
    if (status !== null) {
      const stateLine = `${status.updateState} (running ${status.runningVersion ?? '?'})`
      if (stateLine !== lastState) {
        console.log(`[camstack]   ${label}: ${stateLine}`)
        lastState = stateLine
      }
      if (status.rolledBackFrom === args.version) {
        throw new Error(
          `${label}: dev version ${args.version} was ROLLED BACK: ${status.rolledBackReason ?? 'probation boot failed'}`,
        )
      }
      if (status.runningVersion === args.version && status.updateState === 'idle') {
        return // promoted
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(
    `Timed out after ${POLL_BUDGET_MS / 60_000} minutes waiting for ${args.version} to promote on ${label} — ` +
      'check `serverManagement.getServerPackageStatus`.',
  )
}

// ── Orchestration ────────────────────────────────────────────────────────

function printClosure(closure: ServerClosure): void {
  console.log(
    `[camstack] Closure from server/backend: ${closure.packSet.length} packages to pack ` +
      `(+${closure.buildSet.length - closure.packSet.length} build-only)`,
  )
  for (const pkg of closure.packSet) console.log(`[camstack]   • ${pkg.name}`)
}

async function applyAndMaybeVerify(args: {
  readonly opts: DeployServerOptions
  readonly version: string
  readonly nodeId?: string
  readonly label: string
}): Promise<'ok' | 'failed'> {
  const { opts, version, nodeId, label } = args
  const apply = await applyServerUpdate({
    serverUrl: opts.serverUrl,
    token: opts.token,
    version,
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(opts.authSource ? { authSource: opts.authSource } : {}),
  })
  if (!apply.accepted) {
    if (apply.message.includes('already running')) {
      console.log(`[camstack] ✓ ${label}: already on ${version}`)
      return 'ok'
    }
    console.error(`[camstack] ✗ ${label}: ${apply.message}`)
    return 'failed'
  }
  console.log(`[camstack] ✓ ${label}: ${apply.message}`)
  if (opts.verify === false) return 'ok'
  await pollUntilPromoted({
    serverUrl: opts.serverUrl,
    token: opts.token,
    version,
    ...(nodeId !== undefined ? { nodeId } : {}),
    label,
  })
  console.log(`[camstack] ✓ ${label}: ${version} promoted`)
  return 'ok'
}

async function fanOutToAgents(opts: DeployServerOptions, version: string): Promise<void> {
  let agentTargets: readonly string[] = opts.nodeIds ?? []
  if (opts.allAgents === true) {
    console.log('[camstack] Enumerating online agents via nodes.topology...')
    agentTargets = await fetchOnlineAgentIds(opts.serverUrl, opts.token)
    if (agentTargets.length === 0) {
      console.log('[camstack] No online agents — hub-only deploy complete')
      return
    }
    console.log(`[camstack] Agents: ${agentTargets.join(', ')}`)
  }
  if (agentTargets.length === 0) return

  const failures: string[] = []
  for (const nodeId of agentTargets) {
    try {
      console.log(`[camstack] Propagating dev-uploads → ${nodeId}...`)
      await propagateDevUploads({
        serverUrl: opts.serverUrl,
        token: opts.token,
        version,
        nodeId,
        ...(opts.authSource ? { authSource: opts.authSource } : {}),
      })
      console.log(`[camstack] ✓ ${nodeId}: uploads staged`)
      console.log(`[camstack] Applying server update on ${nodeId}...`)
      const outcome = await applyAndMaybeVerify({
        opts,
        version,
        nodeId,
        label: nodeId,
      })
      if (outcome === 'failed') failures.push(`${nodeId}: apply refused`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push(`${nodeId}: ${message}`)
      console.error(`[camstack] ✗ ${nodeId}: ${message}`)
    }
  }
  if (failures.length > 0) {
    console.error(
      `[camstack] ✗ Agent fan-out incomplete (${failures.length}/${agentTargets.length} failed):`,
    )
    for (const line of failures) console.error(`[camstack]   • ${line}`)
    process.exit(1)
  }
  console.log(`[camstack] ✓ Dev closure ${version} on hub + ${agentTargets.length} agent(s)`)
}

export async function deployServer(opts: DeployServerOptions): Promise<void> {
  const existing = opts.existingVersion?.trim()
  if (existing !== undefined && existing.length > 0) {
    if (!/-dev\.\d+$/.test(existing)) {
      console.error(
        `[camstack] ✗ --version must be a dev-channel version (<base>-dev.<epoch>), got: ${existing}`,
      )
      process.exit(1)
    }
    console.log(
      `[camstack] Reusing hub upload ${existing} (skip build/pack/upload) — ` +
        'POST /api/server-upload/propagate + apply',
    )
    console.log(`[camstack] Applying server update to hub (${existing})...`)
    const hubOutcome = await applyAndMaybeVerify({
      opts,
      version: existing,
      label: 'hub',
    })
    if (hubOutcome === 'failed') process.exit(1)
    await fanOutToAgents(opts, existing)
    return
  }

  const workspaceRoot = path.resolve(opts.workspaceRoot ?? '.')
  const closure = discoverServerClosure(workspaceRoot)
  printClosure(closure)

  const devVersion = computeDevVersion(closure.serverVersion, Math.floor(Date.now() / 1000))
  console.log(`[camstack] Dev version: ${devVersion}`)

  console.log(`[camstack] Building ${closure.buildSet.length} packages (dependency order)...`)
  for (const pkg of closure.buildSet) buildPackage(pkg)

  const intraSetNames: ReadonlySet<string> = new Set(closure.packSet.map((p) => p.name))
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-deploy-server-'))
  try {
    console.log(`[camstack] Packing ${closure.packSet.length} packages at ${devVersion}...`)
    const tarballs: PackedTarball[] = []
    for (const pkg of closure.packSet) {
      const packed = packPackage(pkg, devVersion, intraSetNames, outDir)
      console.log(`[camstack]   ✓ ${pkg.name} → ${path.basename(packed.tgzPath)}`)
      tarballs.push(packed)
    }

    console.log(`[camstack] Uploading ${tarballs.length} tarballs to ${opts.serverUrl}...`)
    await uploadClosure({
      serverUrl: opts.serverUrl,
      token: opts.token,
      version: devVersion,
      tarballs,
      ...(opts.authSource ? { authSource: opts.authSource } : {}),
    })
    console.log('[camstack] ✓ Upload accepted')

    console.log(`[camstack] Applying server update to ${devVersion}...`)
    const hubOutcome = await applyAndMaybeVerify({
      opts,
      version: devVersion,
      label: 'hub',
    })
    if (hubOutcome === 'failed') process.exit(1)

    await fanOutToAgents(opts, devVersion)
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
}
