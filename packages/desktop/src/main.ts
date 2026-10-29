/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Electron types not resolved by eslint */
/**
 * CamStack — the single Electron desktop SHELL for all three roles.
 *
 * On first launch the operator picks a ROLE:
 *   - Hub    — runs the full CamStack server + admin UI on this machine
 *              (embedded window loads https://localhost:4443).
 *   - Agent  — joins an existing hub as a worker node
 *              (embedded window loads http://localhost:4444).
 *   - Viewer — runs NO server at all: a client shell whose window loads a
 *              remote hub's viewer SPA (https://<hub>/viewer/camstack/). It
 *              spawns nothing, supervises nothing, and does not inherit the
 *              certificate bypass below. See `src/role/viewer-window.ts` and
 *              `docs/design/2026-09-08-desktop-viewer-role.md`.
 *
 * For the two SUPERVISED roles the shell spawns the SAME shared STARTER
 * (`@camstack/server/dist/starter.js`) as a child process and passes
 * `CAMSTACK_ROLE=<role>` — the server's launcher branches on it. The starter
 * boots the active server root from the user data dir, falling back to the
 * baked SEED closure on first boot / offline, so node/framework updates land in
 * the data dir and never touch the signed .app bundle. This main process is the
 * always-relaunching supervisor: it relaunches the child on crash (with
 * backoff) AND on the intentional update/rollback self-exit (no backoff), the
 * Mac equivalent of the docker restart policy.
 *
 * The agent role additionally persists a hub connection (no address yet — picked later
 * in the agent dashboard — or a manual hub address). Config is persisted via
 * `electron-store` and reused across restarts. The agent is paired from the hub
 * (D857): nothing about pairing is typed in this window.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
} from 'electron'
import type { UpdateState } from './auto-updater'
import { initAutoUpdater, notifyUpdateReady, shutdownAutoUpdater } from './auto-updater'
import { loadOrCreatePlatformKeychainKey } from './keychain-platform-key'
import { resolveLaunchArgs } from './launch-args-client'
import type { AgentConnectionInput } from './node-env'
import { buildNodeEnv } from './node-env'
import { classifyNodeExit, roleLabel, summarizeNodeRootStatus } from './node-supervisor'
import { consumeRestartIntent, readNodeRootStateView } from './node-supervisor-io'
import {
  NodeProcessManager,
  resolveBundledAddonsDir,
  resolveBundledNode,
  resolveNodeEntry,
  resolveSeedServerDir,
} from './process-manager'
import type { DesktopProduct } from './product/desktop-product'
import { PRODUCT_OVERRIDE_ENV_VAR, resolveDesktopProduct } from './product/desktop-product'
import type { RespawnState } from './renderer-diagnostics'
import { computeRespawn, formatRendererEvent, shouldToggleDevTools } from './renderer-diagnostics'
import { readBootRoleSync, shouldIgnoreCertificateErrors } from './role/boot-role'
import { isRoleRetiredByProduct, roleForProduct } from './role/effective-role'
import type { HubRecord } from './role/hub-pin-store'
import {
  EMPTY_HUB_RECORD,
  activeHub,
  normalizeHubOrigin,
  withActiveHubOrigin,
  withPinnedFingerprint,
} from './role/hub-pin-store'
import type { SupervisedRole } from './role/node-url'
import { AGENT_LOCAL_PORT, HUB_PROD_PORT, isSupervisedRole, nodeUrl } from './role/node-url'
import type { ViewerConnectionState } from './role/viewer-connection'
import { connectionLabel } from './role/viewer-connection'
import { ViewerWindowController } from './role/viewer-window'
import { parseRoleSetting } from './role-setting'
import type { HubMode } from './setup/render-setup-html'
import { defaultAgentName } from './setup/default-agent-name'
import { renderSetupHtml } from './setup/render-setup-html'
import type { NodeRole } from './types'
import { buildAgentServiceSpec, serviceResourcePaths } from './windows-service/agent-service-spec'
import { createWindowsServiceManager } from './windows-service/service-manager-node'

/** The agent's own config file in the node data dir (the service copy is seeded from it). */
const AGENT_CONFIG_FILE_NAME = 'agent.json'

// The hub role serves its admin UI over HTTPS with a self-signed cert it
// generates under {dataDir}/tls/ on first boot; Electron's renderer blocks
// `https://localhost:4443` otherwise. The switch MUST be set before
// app.whenReady fires, hence at module top. Harmless for the agent role (plain
// HTTP on :4444).
//
// It is NOT harmless for the viewer role: that one talks to a hub across the
// LAN, where a process-wide "accept any certificate" means any host on the path
// can impersonate the hub — and the switch also pre-empts the per-session
// verify proc the viewer relies on. The store is only opened inside
// `whenReady` (electron-store v11 is ESM-only), so the role is read
// SYNCHRONOUSLY from the store's file here; a corrupt/absent file reads as
// 'hub' and the switch is appended exactly as before. See ADR-0402.
//
// The PRODUCT is read first and is the outer gate: the reduced `camstack-viewer`
// build is a viewer by construction, so `readBootRoleSync` answers 'viewer'
// without consulting the store at all — a leftover hub store, a corrupt one and
// an absent one can no longer put the switch back in a viewer's process.
const PRODUCT: DesktopProduct = resolveDesktopProduct({
  appName: app.getName(),
  isPackaged: app.isPackaged,
  override: process.env[PRODUCT_OVERRIDE_ENV_VAR],
})
const BOOT_ROLE: NodeRole = readBootRoleSync(app.getPath('userData'), PRODUCT)
if (shouldIgnoreCertificateErrors(BOOT_ROLE)) {
  app.commandLine.appendSwitch('ignore-certificate-errors')
}

// ---------------------------------------------------------------------------
// Persistent config
// ---------------------------------------------------------------------------

interface AppConfig {
  role: NodeRole
  hubMode: HubMode
  hubAddress: string | null
  hubPort: number
  agentName: string | null
  setupComplete: boolean
  windowBounds: { width: number; height: number; x?: number; y?: number } | null
  /** Launch automatically at user login. Defaults to `true` so the node comes
   *  back online after a reboot without manual intervention. */
  openAtLogin: boolean
  /**
   * Windows agent only: the node runs as the `CamStackAgent` Windows service
   * (D846) instead of as a child of this app, so it survives logout and starts
   * at boot. Opt-in; the login item stays the default.
   */
  runAsService: boolean
  /** Viewer role only: the hubs this client knows, and their CA pins. */
  viewerHubs: HubRecord
}

/** Prompt relaunch delay after an intentional update/rollback exit (no backoff). */
const UPDATE_RESTART_DELAY_MS = 500

/**
 * Effective role: the persisted setting, validated, then narrowed to what this
 * PRODUCT can run. The same `roleForProduct` the boot path used, so the tray,
 * the window and the certificate posture can never disagree about the role.
 */
function currentRole(): NodeRole {
  return roleForProduct(PRODUCT, parseRoleSetting(store.get('role')))
}

/** The node's data dir — the starter roots `server-root/` here (both roles). */
function nodeDataDir(): string {
  return path.join(app.getPath('userData'), 'data')
}

// electron-store v11 is ESM-only — a static CJS `require('electron-store')`
// compiled from `import Store from 'electron-store'` (module:commonjs tsconfig)
// would throw ERR_REQUIRE_ESM at runtime (tsc does not catch this). Use a
// dynamic import() instead, resolved once before app.whenReady so every
// downstream store.get/set call already has the initialized instance.
interface TypedStore<T> {
  get<K extends keyof T>(key: K): T[K]
  set<K extends keyof T>(key: K, value: T[K]): void
}

let store: TypedStore<AppConfig>

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null
let setupWindow: BrowserWindow | null = null
let tray: Tray | null = null
const nodeManager = new NodeProcessManager()

/** Viewer role only — created lazily, never for a supervised role. */
let viewerWindow: ViewerWindowController | null = null
let viewerState: ViewerConnectionState = 'connecting'

// Auto-update handle + latest known state (surfaced to the tray + node UI).
let updater: ReturnType<typeof initAutoUpdater> | null = null
let updateState: UpdateState = {
  available: false,
  downloaded: false,
  version: null,
  checking: false,
  // No check has run yet, so there is no failure to report — distinct from
  // the empty string a "checked and it went fine" state would carry.
  error: null,
}

nodeManager.onLog((line, stream) => {
  const writer = stream === 'stderr' ? console.error : console.log
  writer(`[node] ${line}`)
})

// Auto-respawn on UNINTENDED exit (crash) and on the intended
// `addons.restartServer` path (process.exit(0) inside the server). Skip respawn
// only when the parent app is on its way out (`appQuitting`) or when stop() was
// called explicitly with no follow-up (e.g. config change).
//
// Respawn uses exponential backoff (1s → 30s cap, reset after 60s of stable
// uptime): a child that dies during boot must not tight-loop with the local
// HTTP UI flapping up and down.
let appQuitting = false
let respawnState: RespawnState = { consecutiveCrashes: 0 }
let nodeStartedAt = 0
nodeManager.onExit((code, signal, wasIntentional) => {
  console.log(
    `[node] exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}, intentional=${wasIntentional})`,
  )
  refreshTrayMenu()
  if (appQuitting) return

  // Classify WHY the child exited. An update/rollback apply makes the node
  // gracefully self-exit AFTER dropping a restart-intent marker in its data
  // dir; that is an intentional restart, not a crash, so it must relaunch
  // promptly WITHOUT counting against the crash backoff. The marker is consumed
  // (read + deleted) here so a later crash is never mis-classified.
  const restartIntent = consumeRestartIntent(nodeDataDir())
  const exitClass = classifyNodeExit({
    wasParentIntentional: wasIntentional,
    restartIntent,
    nowMs: Date.now(),
  })

  if (exitClass.kind === 'parent-intentional') return

  if (exitClass.kind === 'update-restart') {
    // Reset backoff: the staged version boots on probation; the starter's own
    // auto-rollback (crash-loop counter in state.json) is the safety net.
    respawnState = { consecutiveCrashes: 0 }
    console.log(
      `[main] node exited to apply an update/rollback (${restartIntent?.reason ?? 'server-update'}) — relaunching to boot the staged version`,
    )
    setTimeout(() => {
      if (appQuitting) return
      startNodeProcess()
    }, UPDATE_RESTART_DELAY_MS)
    return
  }

  // Real crash → exponential backoff.
  const uptimeMs = nodeStartedAt > 0 ? Date.now() - nodeStartedAt : 0
  const decision = computeRespawn(respawnState, uptimeMs)
  respawnState = decision.state
  console.log(
    `[main] Respawning node in ${decision.delayMs}ms (consecutive crashes: ${decision.state.consecutiveCrashes})`,
  )
  setTimeout(() => {
    if (appQuitting) return
    startNodeProcess()
  }, decision.delayMs)
})

// ---------------------------------------------------------------------------
// Node process lifecycle
// ---------------------------------------------------------------------------

/**
 * Derive the agent-role hub connection address from the persisted config.
 * Combines the address + port into the `host:port` form the broker expects when
 * the port is non-default and the address doesn't already carry one. Returns
 * `undefined` when manual mode is selected but no address is configured (caller
 * shows the setup window); a `string | null` otherwise (null = auto discovery).
 */
function resolveAgentHubAddress(): string | null | undefined {
  const hubMode = store.get('hubMode')
  const hubAddressRaw = store.get('hubAddress')
  const hubPort = store.get('hubPort')

  if (hubMode === 'manual' && !hubAddressRaw) return undefined // not configured

  let hubAddress: string | null = hubAddressRaw
  if (hubMode === 'manual' && hubAddress && hubPort && hubPort !== HUB_PROD_PORT) {
    const looksLikeIpv6Bracketed = hubAddress.startsWith('[') && hubAddress.includes(']')
    const hasPort = looksLikeIpv6Bracketed
      ? /\]:\d+$/.test(hubAddress)
      : hubAddress.includes(':') && !hubAddress.startsWith('[')
    if (!hasPort) hubAddress = `${hubAddress}:${hubPort}`
  }
  return hubAddress
}

/** True when the Windows service owns the agent node and this app must not start a second one. */
function serviceOwnsTheNode(): boolean {
  return process.platform === 'win32' && currentRole() === 'agent' && store.get('runAsService')
}

/**
 * The environment the node starts with — the one place both launch paths
 * (a child of this app, the Windows service) take it from. `undefined` means
 * manual hub mode with no address yet (the caller shows the setup window).
 */
function currentNodeEnv(
  role: 'hub' | 'agent',
  dataDir: string = nodeDataDir(),
): Readonly<Record<string, string>> | undefined {
  let agent: AgentConnectionInput | undefined
  if (role === 'agent') {
    const hubAddress = resolveAgentHubAddress()
    if (hubAddress === undefined) return undefined
    // Server default is 4444; set it explicitly so the embedded window URL and
    // the served port always agree.
    agent = { hubAddress, agentName: store.get('agentName'), statusPort: AGENT_LOCAL_PORT }
  }
  // Bundled-addons resolution — ONE copy: the packaged closure's own
  // `<resourcesPath>/node_modules/@camstack` scope dir; the seed dir lets the
  // first-boot/offline fallback work. Dev (unpackaged) leaves both unset.
  return buildNodeEnv({
    role,
    dataDir,
    appVersion: app.getVersion(),
    ...(agent === undefined ? {} : { agent }),
    bundledAddonsDir: app.isPackaged ? resolveBundledAddonsDir(process.resourcesPath) : null,
    seedServerDir: app.isPackaged ? resolveSeedServerDir(process.resourcesPath) : null,
  })
}

function startNodeProcess(): void {
  const role = currentRole()
  if (serviceOwnsTheNode()) {
    console.log('[main] the CamStackAgent Windows service runs the node — not starting a child')
    refreshTrayMenu()
    return
  }

  const entryPath = resolveNodeEntry({
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    devWorkspaceRoot: app.isPackaged ? null : path.resolve(__dirname, '..', '..', '..'),
  })
  if (!entryPath) {
    console.error('[main] cannot find server starter — bundle is malformed')
    return
  }

  const dataDir = nodeDataDir()
  if (role !== 'hub' && role !== 'agent') return
  const env = currentNodeEnv(role)
  if (env === undefined) {
    console.warn('[main] agent manual mode but no hub address — showing setup window')
    showSetupWindow()
    return
  }

  // Run the node (and its forked addon runners) under the bundled real-Node
  // binary when packaged — Electron's V8 sandbox otherwise breaks native
  // external-buffer addons. Dev / no staged node → null → Electron-as-Node.
  const nodeExecPath = app.isPackaged ? resolveBundledNode(process.resourcesPath) : null

  // A desktop HUB keeps its keychain master key in the OS keychain (D788).
  // Handed over a pipe, never the environment. Unavailable → the hub falls
  // back to its default key file and the Secrets page says so.
  let keychainKey: Buffer | null = null
  if (role === 'hub') {
    const platformKey = loadOrCreatePlatformKeychainKey(app.getPath('userData'), safeStorage)
    if (platformKey.kind === 'key') {
      keychainKey = platformKey.key
      if (platformKey.created)
        console.log('[main] created the hub keychain master key in the OS keychain')
    } else {
      console.warn(`[main] no OS-keychain master key for the hub: ${platformKey.reason}`)
    }
  }

  // The node's launch args (heap ceiling) are decided by the server closure's
  // launch-args module, never by this app (ADR 0970). Set on argv, not
  // NODE_OPTIONS: runners are sized separately. Fails open.
  const bundledNode = nodeExecPath !== null && fs.existsSync(nodeExecPath)
  const launch = resolveLaunchArgs({
    role,
    dataDir,
    starterPath: entryPath,
    nodeExecPath: bundledNode ? nodeExecPath : process.execPath,
    runAsElectron: !bundledNode,
    env: process.env,
  })
  for (const note of launch.notes) console.warn(`[main] ${note}`)

  try {
    nodeManager.start({
      entryPath,
      cwd: path.dirname(entryPath),
      env: { ...env, ...launch.env },
      nodeExecPath,
      keychainKey,
      nodeArgs: launch.args,
    })
    nodeStartedAt = Date.now()
    console.log(`[main] node started (role=${role}, data=${dataDir})`)
    // The tray menu is first built BEFORE the node starts on the boot path, so
    // its "Status" line would otherwise stay stuck on "Stopped".
    refreshTrayMenu()
  } catch (err) {
    console.error('[main] node start failed', err)
    void dialog.showMessageBox({
      type: 'error',
      title: 'CamStack — start failed',
      message: 'Could not start the CamStack node process.',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Move the agent node between "a child of this app" (default) and the
 * `CamStackAgent` Windows service (D846). The two never run together: they
 * share one status port and one node id, so the child is stopped first and
 * started again if the service could not be installed.
 */
async function toggleRunAsService(enable: boolean): Promise<void> {
  const manager = createWindowsServiceManager()
  const fail = (detail: string): void => {
    void dialog.showMessageBox({
      type: 'error',
      title: 'CamStack — Windows service',
      message: enable
        ? 'Could not set the agent up as a Windows service.'
        : 'Could not remove the Windows service.',
      detail,
    })
  }
  if (!manager.supported || !app.isPackaged) {
    fail('The Windows service is available in the installed Windows app only.')
    refreshTrayMenu()
    return
  }
  const confirm = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Continue', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'CamStack — Windows service',
    message: enable
      ? 'Run the CamStack agent as a Windows service?'
      : 'Stop running the CamStack agent as a Windows service?',
    detail: enable
      ? 'The agent will start at boot and keep running after you log out. Windows will ask for administrator permission once.'
      : 'The service is removed and the agent runs inside this app again. Windows will ask for administrator permission once.',
  })
  if (confirm.response !== 0) {
    refreshTrayMenu()
    return
  }

  const resourcesPath = process.resourcesPath
  // One node at a time: free the port and the node id before the service takes them.
  await nodeManager.stop()
  let outcome: { readonly ok: true } | { readonly ok: false; readonly reason: string }
  if (enable) {
    const entryPath = resolveNodeEntry({ resourcesPath, devWorkspaceRoot: null })
    // The service has its OWN data dir (admin-only, under ProgramData): it runs
    // addons as SYSTEM, so it may not share the user's writable one.
    const serviceDataDir = manager.dataDir
    const env = serviceDataDir === null ? undefined : currentNodeEnv('agent', serviceDataDir)
    if (entryPath === null || env === undefined) {
      outcome = {
        ok: false,
        reason:
          entryPath === null
            ? 'The server starter is missing from this install.'
            : 'The hub address is not configured yet — finish the agent setup first.',
      }
    } else {
      outcome = await manager.install({
        winswSource: serviceResourcePaths(resourcesPath).winsw,
        spec: buildAgentServiceSpec({ resourcesPath, starterJs: entryPath, env }),
        // Hub address, mesh certificate and node id carry over; the user's own
        // data dir (addons, server-root) does not.
        agentConfigSource: path.join(nodeDataDir(), AGENT_CONFIG_FILE_NAME),
      })
    }
  } else {
    outcome = await manager.remove()
  }
  if (outcome.ok) store.set('runAsService', enable)
  else fail(outcome.reason)
  if (!serviceOwnsTheNode()) startNodeProcess()
  refreshTrayMenu()
}

async function restartNode(): Promise<void> {
  await nodeManager.stop()
  startNodeProcess()
  refreshTrayMenu()
}

// ---------------------------------------------------------------------------
// IPC handlers — bridge from setup window's preload
// ---------------------------------------------------------------------------

/**
 * What the setup window sends. Every field but `role` is OPTIONAL because the
 * two products send different forms: the viewer product's window has one input
 * and posts `{ role, viewerHubUrl }`, the node product's posts the agent block.
 */
interface SetupPayload {
  role: NodeRole
  hubMode?: HubMode
  hubAddress?: string
  agentName?: string
  hubPort?: number
  /** Viewer product only: the full hub URL the window will load. */
  viewerHubUrl?: string
}

ipcMain.handle('camstack:setup:save', async (_evt, raw: SetupPayload) => {
  // The product has the last word: the viewer build saves a viewer whatever the
  // payload claims, and the node build never persists the role it no longer
  // offers.
  const role = roleForProduct(PRODUCT, parseRoleSetting(raw.role))
  const hubMode: HubMode = raw.hubMode === 'manual' ? 'manual' : 'auto'
  const hubAddress = (raw.hubAddress || '').trim() || null
  const agentName = (raw.agentName || '').trim() || null
  const rawPort = raw.hubPort
  const hubPort =
    typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0 ? rawPort : HUB_PROD_PORT

  if (role === 'agent' && hubMode === 'manual' && !hubAddress) {
    throw new Error('Manual mode requires a hub address')
  }

  if (role === 'viewer') {
    const origin = normalizeHubOrigin(raw.viewerHubUrl || '')
    if (origin === null) {
      throw new Error('Enter the hub address, e.g. https://192.168.10.9:4443')
    }
    // Re-selecting a known hub keeps its partition AND its certificate pin — a
    // re-typed address must not silently drop a trust decision or a login.
    store.set('viewerHubs', withActiveHubOrigin(store.get('viewerHubs'), origin))
  }

  store.set('role', role)
  store.set('hubMode', hubMode)
  store.set('hubAddress', hubAddress)
  store.set('hubPort', hubPort)
  store.set('agentName', agentName)
  store.set('setupComplete', true)

  if (setupWindow) {
    setupWindow.close()
    setupWindow = null
  }
  // A role/config change means the embedded window must reload the (possibly
  // different) role URL — drop the current window so it re-creates on demand.
  if (mainWindow) {
    mainWindow.destroy()
    mainWindow = null
  }
  // Boot call site #2: a viewer starts NOTHING. The supervised branch is the
  // one that already existed. A node left over from a previous role is stopped.
  if (isSupervisedRole(role)) {
    await restartNode()
  } else {
    await nodeManager.stop()
    if (viewerWindow !== null) {
      viewerWindow.switchHub()
      refreshTrayMenu()
      return
    }
  }
  showMainWindow()
})

ipcMain.handle('camstack:setup:cancel', async () => {
  if (setupWindow) {
    setupWindow.close()
    setupWindow = null
  }
})

// -- App version + auto-update bridge (main window preload-ui) --------------

ipcMain.on('camstack:app:get-version-sync', (evt) => {
  evt.returnValue = app.getVersion()
})
ipcMain.handle('camstack:app:get-update-state', () => updateState)
ipcMain.handle('camstack:app:check-updates', async () => {
  await updater?.checkForUpdates()
})
ipcMain.on('camstack:app:install-update', () => {
  updater?.installAndRestart()
})

// ---------------------------------------------------------------------------
// Setup window — first-launch / change-config (role selector + agent config)
// ---------------------------------------------------------------------------

function showSetupWindow(): void {
  if (setupWindow) {
    setupWindow.focus()
    return
  }
  setupWindow = new BrowserWindow({
    width: 520,
    height: 600,
    title: 'CamStack — Setup',
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  attachRendererDiagnostics(setupWindow)

  const html = renderSetupHtml({
    product: PRODUCT,
    role: currentRole(),
    hubMode: store.get('hubMode'),
    hubAddress: store.get('hubAddress') ?? '',
    hubPort: store.get('hubPort'),
    agentName: store.get('agentName') ?? '',
    defaultAgentName: defaultAgentName(os.hostname(), os.arch()),
    viewerHubUrl: activeHub(store.get('viewerHubs'))?.origin ?? '',
  })
  void setupWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  setupWindow.on('closed', () => {
    setupWindow = null
  })
}

// ---------------------------------------------------------------------------
// Renderer diagnostics — forward renderer failures to the main-process log
// ---------------------------------------------------------------------------

/**
 * Renderer events are logged to stdout AND appended to
 * `<userData>/renderer.log` so a blank window is diagnosable after the fact
 * even when the app was launched from Finder (no visible stdout).
 */
function logRendererEvent(kind: string, fields: Readonly<Record<string, unknown>>): void {
  const line = formatRendererEvent(kind, fields)
  console.error(line)
  try {
    const logPath = path.join(app.getPath('userData'), 'renderer.log')
    try {
      if (fs.statSync(logPath).size > 5 * 1024 * 1024) fs.rmSync(logPath, { force: true })
    } catch {
      /* stat failed — file absent */
    }
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* file logging is best-effort */
  }
}

/**
 * Reveal the folder holding `renderer.log` (and the main-process log the OS
 * captures). The viewer role has no node stdout to read, so this is the only
 * on-disk trace of a failed load — the tray offers it directly.
 */
async function openLogsFolder(): Promise<void> {
  const userData = app.getPath('userData')
  const logPath = path.join(userData, 'renderer.log')
  try {
    if (fs.existsSync(logPath)) {
      shell.showItemInFolder(logPath)
      return
    }
  } catch {
    /* fall through to the folder */
  }
  const error = await shell.openPath(userData)
  if (error !== '') console.error(`[main] could not open the logs folder: ${error}`)
}

/**
 * Wire load-failure / crash / console forwarding + the DevTools shortcut
 * (Cmd/Ctrl+Alt+I, F12) onto a window. Without this a renderer error in the
 * packaged app was a silent blank page with no way to inspect it.
 */
function attachRendererDiagnostics(win: BrowserWindow): void {
  const wc = win.webContents
  wc.on('did-fail-load', (_evt, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logRendererEvent('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame })
  })
  wc.on('render-process-gone', (_evt, details) => {
    logRendererEvent('render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })
  wc.on('preload-error', (_evt, preloadPath, error) => {
    logRendererEvent('preload-error', { preloadPath, error: error.message })
  })
  wc.on('console-message', (details) => {
    if (details.level !== 'error' && details.level !== 'warning') return
    logRendererEvent(`console:${details.level}`, {
      message: details.message,
      source: `${details.sourceId}:${details.lineNumber}`,
    })
  })
  wc.on('before-input-event', (_evt, input) => {
    if (shouldToggleDevTools(input)) wc.toggleDevTools()
  })
}

// ---------------------------------------------------------------------------
// Main window — embeds the node's local UI (role-dependent URL)
// ---------------------------------------------------------------------------

/**
 * The viewer role's window controller. Created on first use so a hub/agent run
 * never constructs one (and never opens a session partition).
 */
function ensureViewerWindow(): ViewerWindowController {
  if (viewerWindow !== null) return viewerWindow
  viewerWindow = new ViewerWindowController({
    hub: () => activeHub(store.get('viewerHubs')),
    // Writes the operator's trust decision through the SAME store the verify
    // proc reads its pin from, so the next verification sees it. Refuses when
    // no hub is active — a pin belongs to a hub, never to the app.
    pinActiveHub: (fingerprint) => {
      const record = store.get('viewerHubs')
      const hub = activeHub(record)
      if (hub === null) return false
      store.set('viewerHubs', withPinnedFingerprint(record, hub.id, fingerprint))
      return true
    },
    bounds: () => store.get('windowBounds') ?? { width: 1200, height: 800 },
    onBoundsChanged: (bounds) => store.set('windowBounds', { ...bounds }),
    onStateChanged: (state) => {
      viewerState = state
      refreshTrayMenu()
    },
    log: (message) => console.log(message),
    preloadPath: path.join(__dirname, 'preload-ui.js'),
    iconPath: path.join(__dirname, '..', 'assets', 'icon.png'),
    isQuitting: () => appQuitting,
    hasTray: () => tray !== null,
  })
  return viewerWindow
}

function showMainWindow(): void {
  if (currentRole() === 'viewer') {
    if (activeHub(store.get('viewerHubs')) === null) {
      console.warn('[viewer] no hub configured — showing setup')
      showSetupWindow()
      return
    }
    ensureViewerWindow().show()
    return
  }
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
    return
  }
  const bounds = store.get('windowBounds') ?? { width: 1200, height: 800 }
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    title: 'CamStack',
    backgroundColor: '#0c0a09', // matches admin-ui --color-background
    icon: nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Explicit: DevTools stay available in the packaged build — they are the
      // only way to diagnose a blank UI in the field.
      devTools: true,
      preload: path.join(__dirname, 'preload-ui.js'),
    },
  })

  attachRendererDiagnostics(mainWindow)

  // Push the current update state as soon as the UI finishes loading, so a
  // download that completed before the window opened is reflected immediately.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.send('camstack:update-state', updateState)
  })

  loadNodeUI(0)

  mainWindow.on('close', (e) => {
    if (tray && !(app as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.on('resize', () => {
    if (!mainWindow) return
    const b = mainWindow.getBounds()
    store.set('windowBounds', { width: b.width, height: b.height, x: b.x, y: b.y })
  })
}

function loadNodeUI(attempt: number): void {
  if (!mainWindow) return
  const role = currentRole()
  // The viewer has no local node; its window is owned by ViewerWindowController.
  if (!isSupervisedRole(role)) return
  const url = nodeUrl(role, app.isPackaged)
  mainWindow.loadURL(url).catch(() => {
    // The spawned node takes 5-30s to bind its port (sqlite migrations, addon
    // load, cert gen). ERR_CONNECTION_REFUSED during this window would pin the
    // renderer at Chromium's error page — retry until it comes up.
    if (attempt < 60) {
      setTimeout(() => loadNodeUI(attempt + 1), 1_000)
    } else {
      mainWindow
        ?.loadURL(
          `data:text/html,${encodeURIComponent(renderUnreachableHtml(role, app.isPackaged))}`,
        )
        .catch(() => {
          /* ignore */
        })
    }
  })
}

function renderUnreachableHtml(role: SupervisedRole, isPackaged: boolean): string {
  // Derive the port from the SAME source the window actually loads (nodeUrl),
  // so the hub-dev case shows :3001 rather than the packaged :4443.
  const port = new URL(nodeUrl(role, isPackaged)).port
  const label = roleLabel(role)
  return `<!doctype html>
<html><body style="font-family:-apple-system,sans-serif;padding:40px;color:#444;">
<h2>${label} UI not reachable yet</h2>
<p>The CamStack node may still be starting, or it failed to bind port ${port}.</p>
<p>Use the tray icon → Restart node, then reopen the window.</p>
</body></html>`
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/**
 * Register/unregister the app as an OS login item (best-effort — a login-item
 * write failure must never block boot).
 */
function applyOpenAtLogin(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled })
  } catch {
    /* non-fatal */
  }
}

function ensureTray(): void {
  if (tray) return
  const trayIcon = nativeImage.createFromPath(
    path.join(__dirname, '..', 'assets', 'tray-icon-template.png'),
  )
  trayIcon.setTemplateImage(true)
  tray = new Tray(trayIcon)
  if (trayIcon.isEmpty()) {
    tray.setTitle('CamStack')
  }
  tray.setToolTip('CamStack')
  refreshTrayMenu()
  tray.on('click', () => {
    if (process.platform !== 'darwin') tray?.popUpContextMenu()
  })
}

function refreshTrayMenu(): void {
  if (!tray) return
  const role = currentRole()
  const running = nodeManager.isRunning

  // Agent role surfaces its hub connection; hub role does not.
  const roleLine: Electron.MenuItemConstructorOptions[] =
    role === 'agent'
      ? [
          {
            label:
              store.get('hubMode') === 'auto'
                ? 'Hub: not configured (choose it in the dashboard)'
                : store.get('hubAddress')
                  ? `Hub: ${store.get('hubAddress')}`
                  : 'Hub: not configured',
            enabled: false,
          },
        ]
      : []

  // The viewer runs no node, so a "Status: Running" / server-root line would be
  // a lie and "Restart node" would have nothing to restart. It surfaces the hub
  // it is pointed at and how the connection to it is going instead.
  const statusLines: Electron.MenuItemConstructorOptions[] =
    role === 'viewer'
      ? [
          { label: `Hub: ${activeHub(store.get('viewerHubs'))?.origin ?? 'not configured'}` },
          { label: connectionLabel(viewerState) },
        ].map((item) => ({ ...item, enabled: false }))
      : [
          {
            label: serviceOwnsTheNode()
              ? 'Status: running as the CamStackAgent Windows service'
              : running
                ? 'Status: Running'
                : 'Status: Stopped',
            enabled: false,
          },
          {
            label: summarizeNodeRootStatus(readNodeRootStateView(nodeDataDir()), role),
            enabled: false,
          },
        ]

  const items: Electron.MenuItemConstructorOptions[] = [
    { label: `CamStack ${roleLabel(role)} v${app.getVersion()}`, enabled: false },
    ...roleLine,
    ...statusLines,
    ...(updateState.downloaded
      ? [
          { type: 'separator' as const },
          {
            label: `Install update${updateState.version ? ` (v${updateState.version})` : ''} & restart`,
            click: () => updater?.installAndRestart(),
          },
        ]
      : updateState.available
        ? [{ label: 'Downloading update…', enabled: false }]
        : []),
    { type: 'separator' },
    { label: 'Open Window…', click: () => showMainWindow() },
    ...(role === 'viewer'
      ? [
          { label: 'Reload UI', click: () => viewerWindow?.reload() },
          { label: 'Change hub…', click: () => showSetupWindow() },
          { label: 'Open logs', click: () => void openLogsFolder() },
        ]
      : [
          { label: 'Restart node', click: () => void restartNode() },
          // The viewer product has no role to change — `Change hub…` above IS
          // its setup window, and it is the whole of it.
          { label: 'Setup / change role…', click: () => showSetupWindow() },
        ]),
    {
      label: 'Toggle DevTools',
      click: () => {
        showMainWindow()
        mainWindow?.webContents.toggleDevTools()
      },
    },
    ...(process.platform === 'win32' && role === 'agent' && app.isPackaged
      ? [
          {
            label: 'Run as Windows service (starts at boot)',
            type: 'checkbox' as const,
            checked: store.get('runAsService'),
            click: (menuItem: Electron.MenuItem) => void toggleRunAsService(menuItem.checked),
          },
        ]
      : []),
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: store.get('openAtLogin'),
      click: (menuItem) => {
        store.set('openAtLogin', menuItem.checked)
        applyOpenAtLogin(menuItem.checked)
        refreshTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        ;(app as { isQuitting?: boolean }).isQuitting = true
        app.quit()
      },
    },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

void app.whenReady().then(async () => {
  // electron-store v11 is ESM-only — see the note on the dynamic import above.
  // eslint-disable-next-line no-new-func
  const { default: Store } = await (Function('return import("electron-store")')() as Promise<
    typeof import('electron-store')
  >)
  store = new Store<AppConfig>({
    defaults: {
      role: 'hub',
      hubMode: 'auto',
      hubAddress: null,
      hubPort: HUB_PROD_PORT,
      agentName: null,
      setupComplete: false,
      windowBounds: null,
      openAtLogin: true,
      runAsService: false,
      viewerHubs: EMPTY_HUB_RECORD,
    },
  }) as TypedStore<AppConfig>

  // The switch at module top was decided from the store FILE. If the store the
  // library actually opened disagrees, the certificate posture and the role
  // would be inconsistent — say so rather than run in that state silently.
  const storedRole = currentRole()
  if (storedRole !== BOOT_ROLE) {
    console.warn(
      `[main] boot role read as '${BOOT_ROLE}' but the store says '${storedRole}' — restart the app to re-apply the certificate policy`,
    )
  }

  applyOpenAtLogin(store.get('openAtLogin'))
  ensureTray()

  // A node install whose store still holds the retired `viewer` role is asked
  // again rather than booted into a hub it never chose — and nothing loads a
  // remote origin in the meantime, which is what makes coercing that role to
  // `hub` (and re-arming the certificate switch) safe. See ADR-0402.
  const roleRetired = isRoleRetiredByProduct(PRODUCT, parseRoleSetting(store.get('role')))
  if (!store.get('setupComplete') || roleRetired) {
    showSetupWindow()
  } else {
    // Boot call site #1. The viewer supervises nothing: it starts no child, so
    // `nodeManager.onExit` never fires for it and `will-quit` /
    // `window-all-closed` already take their existing no-child path.
    if (isSupervisedRole(storedRole)) startNodeProcess()
    showMainWindow()
  }

  updater = initAutoUpdater(PRODUCT, {
    onStateChange: (state) => {
      updateState = state
      refreshTrayMenu()
      mainWindow?.webContents.send('camstack:update-state', state)
    },
    onUpdateDownloaded: (version) => {
      notifyUpdateReady(version)
    },
  })

  // macOS: closing the window hides it (tray keeps the app alive), so
  // getAllWindows() is never empty — Dock click must still show/focus.
  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void nodeManager.stop().finally(() => app.quit())
  }
})

function markQuitting(): void {
  appQuitting = true
  ;(app as { isQuitting?: boolean }).isQuitting = true
}

app.on('before-quit', () => {
  markQuitting()
  viewerWindow?.dispose()
})

// "Install update & restart" closes every window BEFORE `before-quit` fires.
// Without this, the tray's close handlers still see "not quitting", hide the
// window and cancel the close — the quit aborts, the app lingers windowless
// and the update never installs. electron-updater emits this event on every
// platform right before it starts closing windows.
nativeAutoUpdater.on('before-quit-for-update', markQuitting)

app.on('will-quit', async (event) => {
  if (nodeManager.isRunning) {
    event.preventDefault()
    await nodeManager.stop()
    shutdownAutoUpdater()
    app.exit(0)
  }
})
