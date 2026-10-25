/**
 * `camstack dev <addon>` — watch + auto rebuild + push.
 *
 * The development loop runs `camstack push` once up-front, then watches
 * source files for changes and re-pushes on every meaningful edit. The
 * server-side `AddonInstaller` already overwrites the existing install
 * + calls `reloadPackages()`, so a successful push is effectively a
 * hot-reload for the operator's addon code.
 *
 * Trade-offs vs a true "edit-and-reload" stack:
 *   • Each cycle is build + npm pack + HTTPS upload + server reload —
 *     2-5 seconds end-to-end. Fast enough for the dev loop, not for
 *     keystroke-level feedback.
 *   • We watch `src/**` (configurable) — NOT the addon's own dist —
 *     to avoid bouncing on artifacts that the build script writes.
 *   • Debounced at the file-change level (default 500ms): bursts of
 *     file writes from a build tool (e.g. Vite touching ten files in
 *     parallel) collapse into a single rebuild.
 *   • Sequential, never overlapping: if a change arrives mid-push, the
 *     next push is queued. Concurrency would corrupt the tarball + the
 *     server-side install path.
 *
 * Zero-dep: uses `node:fs.watch` with `{ recursive: true }`. On Linux
 * the recursive flag requires Node 20+; on macOS/Windows it's been
 * available longer. We target Node 18.3+ for `parseArgs` but recursive
 * watch is gated runtime — if it throws we fall back to top-level only
 * and log a hint.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import * as clack from '@clack/prompts'
import { loadSession, resolveFreshCredentials, touchSession } from '@camstack/develop'
import { cliHubTransport } from '../http/hub-transport.js'
import { deployAddon, type DeployOptions } from './deploy.js'

const DEFAULT_DEBOUNCE_MS = 500
const DEFAULT_WATCH_SUBDIR = 'src'

/**
 * Resolve the addon source argument the same way `deploy` does, but
 * without consuming the resolution helper (kept private in deploy.ts).
 * Three valid shapes: tarball (rejected — can't watch), absolute/relative
 * dir, workspace shorthand `<name>` → `packages/addon-<name>` /
 * `packages/<name>`.
 */
function resolveAddonDir(arg: string): string {
  if (arg.endsWith('.tgz') || arg.endsWith('.tar.gz')) {
    throw new Error('`dev` requires a source directory, not a tarball (nothing to watch).')
  }
  const absolute = path.resolve(arg)
  if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
    return absolute
  }
  for (const candidate of [
    path.resolve('packages', `addon-${arg}`),
    path.resolve('packages', arg),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate
    }
  }
  throw new Error(
    `Path not resolved: ${arg} (tried as-is + packages/addon-${arg} + packages/${arg})`,
  )
}

/**
 * fs.watch wrapper that recovers from the Linux pre-20 "recursive: true
 * unsupported" throw by retrying without the flag. Returns the watcher
 * + a flag for the caller's status line.
 */
function watchRecursive(
  target: string,
  onEvent: () => void,
): { close: () => void; recursive: boolean } {
  try {
    const w = fs.watch(target, { recursive: true }, onEvent)
    return { close: () => w.close(), recursive: true }
  } catch {
    const w = fs.watch(target, onEvent)
    return { close: () => w.close(), recursive: false }
  }
}

/**
 * Push-once helper. We treat each push as atomic: build script (if any)
 * + npm pack + HTTPS upload + server reload. Errors don't crash the
 * watcher — they get printed and the next change triggers a retry.
 */
async function pushOnce(
  addonPath: string,
  getOpts: () => Promise<DeployOptions>,
  label: string,
): Promise<void> {
  const start = Date.now()
  console.log(`\n[camstack dev] → ${label}…`)
  try {
    await deployAddon(addonPath, await getOpts())
    const took = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`[camstack dev] ✓ Synced in ${took}s`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[camstack dev] ✗ Push failed: ${msg}`)
    console.error(`[camstack dev]   Waiting for next change…`)
  }
}

export async function runDev(args: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      server: { type: 'string', short: 's' },
      token: { type: 'string', short: 't' },
      'token-file': { type: 'string' },
      node: { type: 'string', short: 'n' },
      cluster: { type: 'boolean', short: 'c' },
      'watch-path': { type: 'string', short: 'w' },
      debounce: { type: 'string' },
      'no-build': { type: 'boolean' },
      'build-script': { type: 'string' },
      'no-initial-push': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: true,
  })

  const addonArg = positionals[0] ?? '.'
  const addonDir = resolveAddonDir(addonArg)

  // Resolve auth same way as the push command (`credentials.ts`).
  const credentialInputs = {
    ...(typeof values.server === 'string' ? { server: values.server } : {}),
    ...(typeof values.token === 'string' ? { token: values.token } : {}),
    ...(typeof values['token-file'] === 'string' ? { tokenFile: values['token-file'] } : {}),
    loadSession,
    transport: cliHubTransport,
  }
  const creds = await resolveFreshCredentials(credentialInputs)
  if (creds.warning) console.error(`[camstack dev] Warning: ${creds.warning}`)
  if (creds.source === 'session' && creds.server) touchSession(creds.server)
  const serverUrl = creds.server
  const token = creds.token
  if (!serverUrl) {
    throw new Error('No hub server known. Pass --server, or run `camstack login` first.')
  }
  const nodeId = typeof values.node === 'string' ? values.node : undefined
  const cluster = values.cluster === true

  const deployOpts: DeployOptions = {
    serverUrl,
    token,
    authSource: creds.source,
    ...(nodeId ? { nodeId } : {}),
    ...(cluster ? { cluster: true } : {}),
    buildMode: values['no-build'] === true ? 'skip' : 'auto',
    ...(typeof values['build-script'] === 'string' ? { buildScript: values['build-script'] } : {}),
  }

  // A long `dev` session outlives an access token: every push re-resolves the
  // credential, which renews an expiring session.
  const freshOpts = async (): Promise<DeployOptions> => ({
    ...deployOpts,
    token: (await resolveFreshCredentials(credentialInputs)).token,
  })

  // What to watch. Default: <addonDir>/src if it exists, else addonDir.
  // The watcher path is operator-overridable so monorepo addons with
  // unusual layouts (e.g. `lib/`, `app/`) work without code changes.
  const watchOverride = typeof values['watch-path'] === 'string' ? values['watch-path'] : undefined
  const watchTarget = watchOverride
    ? path.resolve(addonDir, watchOverride)
    : fs.existsSync(path.join(addonDir, DEFAULT_WATCH_SUBDIR))
      ? path.join(addonDir, DEFAULT_WATCH_SUBDIR)
      : addonDir
  if (!fs.existsSync(watchTarget)) {
    throw new Error(`Watch path does not exist: ${watchTarget}`)
  }
  const debounceMs =
    typeof values.debounce === 'string' ? parseInt(values.debounce, 10) : DEFAULT_DEBOUNCE_MS

  clack.intro(`camstack dev — ${path.basename(addonDir)}`)
  clack.log.info(`Watch:  ${watchTarget}`)
  clack.log.info(
    `Target: ${serverUrl}${cluster ? ' (cluster)' : nodeId ? ` (node: ${nodeId})` : ' (hub)'}`,
  )
  clack.log.info(`Debounce: ${debounceMs}ms`)

  // Initial sync unless the operator opted out (useful when the server
  // already has a working copy and they only want incremental updates).
  if (values['no-initial-push'] !== true) {
    await pushOnce(addonDir, freshOpts, 'Initial sync')
  } else {
    console.log('[camstack dev] Skipping initial push (--no-initial-push). Waiting for changes…')
  }

  // The watch loop: debounced single-flight push. `pending` is the
  // "next push queued" flag — collapses multiple concurrent changes into
  // a single follow-up cycle, matching the operator's intuition that
  // "anything that arrived during the build is part of the same edit".
  let timer: NodeJS.Timeout | null = null
  let pushing = false
  let pending = false

  const runDebouncedPush = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      if (pushing) {
        pending = true
        return
      }
      pushing = true
      try {
        await pushOnce(addonDir, freshOpts, 'File change detected — rebuilding')
      } finally {
        pushing = false
        if (pending) {
          pending = false
          runDebouncedPush()
        }
      }
    }, debounceMs)
  }

  const { close, recursive } = watchRecursive(watchTarget, () => runDebouncedPush())
  if (!recursive) {
    clack.log.warn(
      'Recursive watch not supported on this platform — only top-level changes will trigger a push. Upgrade Node 20+ for recursive support.',
    )
  }

  // Shutdown hooks.
  const shutdown = (): void => {
    console.log('\n[camstack dev] Stopping watcher…')
    if (timer) clearTimeout(timer)
    close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.log('\n[camstack dev] Watching for changes. Ctrl-C to stop.')
  // Keep the process alive forever — fs.watch alone doesn't pin the
  // event loop reliably across platforms, and `await new Promise(() => {})`
  // is the canonical idiom for an intentional indefinite block.
  await new Promise<void>(() => {})
}
