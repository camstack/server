/**
 * Launcher -- entry point that ensures required addons are installed
 * before main.ts loads. This solves the chicken-and-egg problem:
 * main.ts has static imports from @camstack/system, but core lives in
 * data/addons/ and may not exist on first boot.
 *
 * 1. Run AddonInstaller.ensureRequiredPackages (zero core dependencies)
 * 2. Create symlinks so @camstack/system resolves from data/addons/
 * 3. Dynamically import main.ts (which has static @camstack/system imports)
 *
 * Load-order invariant: @camstack/system is imported DYNAMICALLY inside
 * launch() AFTER the active framework dir is resolved (the single-copy
 * collapse points CAMSTACK_FRAMEWORK_DIR at CAMSTACK_SERVER_ACTIVE_ROOT in
 * data-root mode, or the baked seed otherwise). NEVER add a top-level static
 * import of @camstack/system here — that would pin the resolver before the
 * framework dir + NODE_PATH are set up. Framework/cap updates ship via the
 * node-root `applyServerUpdate` flow, not an in-launcher package swap.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
// Type-only import — erased at runtime, does NOT load @camstack/system module.
import type { bootstrapSchema as BootstrapSchemaType } from '@camstack/system'
import * as yaml from 'js-yaml'
import { formatAddonRootReport, inventoryAddonRoots } from './addon-root-inventory.js'
import type { ServerBootstrapManifest } from './bootstrap-packages.js'
import { selectHubBootstrapPackages } from './bootstrap-packages.js'
import { formatFirstBootPlan, planFirstBootAddons } from './first-boot-addon-plan.js'
import { planAddonRealignment } from './core/addon/addon-realign-plan.js'
import { resolveClosureNodeModules } from './closure-node-modules.js'
import { frameworkNodePaths } from './framework-nodepath.js'
import {
  formatInventoryReport,
  formatShadowingNotes,
  hostProvidedSearchRoots,
  inventoryHostProvided,
  seedNodeModulesRoots,
} from './package-inventory.js'
import { applyPendingRestore } from './pending-restore.js'

/** Resolve the data directory from env or default */
const DATA_DIR = process.env['CAMSTACK_DATA'] ?? 'camstack-data'

/** Narrow `CAMSTACK_INSTALL_SOURCE` env into the typed union. */
function parseInstallSource(value: string | undefined): 'npm' | 'local' | 'symlink' | undefined {
  if (value === 'npm' || value === 'local' || value === 'symlink') return value
  return undefined
}

/**
 * Locate + parse `config.yaml` relative to the data dir. Returns the
 * raw object on success, `null` when missing or unparseable. The
 * launcher uses this BEFORE @camstack/system is imported so it must stay
 * free of core deps — just js-yaml + the kernel's bootstrapSchema for
 * shape validation by the call site.
 */
function readConfigYaml(dataDir: string): unknown {
  // CONFIG_PATH (when set) is the authoritative location and must win — it
  // is what main.ts reads/writes. Without this the launcher would miss the
  // `bootstrap.*` section of a relocated config.yaml (e.g. a separate
  // /config mount) and silently fall back to defaults.
  const candidates = [
    ...(process.env.CONFIG_PATH ? [path.resolve(process.env.CONFIG_PATH)] : []),
    path.resolve(dataDir, '..', 'config.yaml'),
    path.resolve(dataDir, 'config.yaml'),
    path.resolve(process.cwd(), 'config.yaml'),
  ]
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) return null
  try {
    return yaml.load(fs.readFileSync(found, 'utf-8')) ?? {}
  } catch (err) {
    console.warn(
      `[launcher] Could not parse ${found}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/**
 * Read `bootstrap.installSource` from `<dataDir>/config.yaml` if present.
 * Returns the configured value or `null` when absent.
 *
 * Production deployments should leave this unset (defaults to 'npm');
 * `symlink` is a dev-time convenience that points data/addons/<pkg>
 * directly at the workspace source dir — never set in shipped
 * containers or Electron bundles.
 *
 * `bootstrapSchema` is passed in (not imported at module top) so this
 * helper can be called after the dynamic @camstack/system import in launch().
 */
function readBootstrapInstallSource(
  dataDir: string,
  bootstrapSchema: typeof BootstrapSchemaType,
): 'npm' | 'local' | 'symlink' | undefined {
  const raw = readConfigYaml(dataDir)
  if (raw === null) return undefined
  const validation = bootstrapSchema.safeParse(raw)
  if (!validation.success) return undefined
  return parseInstallSource(validation.data.bootstrap.installSource)
}

/**
 * Derive the bootstrap package list from THIS server's own package.json — the
 * `@camstack/addon-*` deps plus `@camstack/system` (which ships the required
 * infrastructure builtins), MINUS `camstack.agentOnlyBootstrapAddons`. Read by
 * absolute path (the package.json sits one level up from this launcher's dist
 * dir), so it works in the slim image where the `@camstack/*` node_modules
 * symlinks are stripped. Mirrors `AddonInstaller.deriveBootstrapList`, but
 * without `require.resolve` — the selection itself lives in
 * `bootstrap-packages.ts` so it is unit-testable (this module self-executes
 * `launch()` on import, so nothing declared here can be imported by a spec).
 */
function deriveBootstrapFromSelf(): readonly string[] {
  const pkg = readOwnManifest()
  return pkg === null ? [] : selectHubBootstrapPackages(pkg)
}

/**
 * THIS server closure's own `package.json` — the roster's source and, when
 * `pin-root-deps` ran for the release, the exact version of every bootstrap
 * addon. Read by absolute path for the same reason `deriveBootstrapFromSelf`
 * is: the slim image strips the `@camstack/*` symlinks, so `require.resolve`
 * would answer nothing here.
 */
function readOwnManifest(): ServerBootstrapManifest | null {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json')
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as ServerBootstrapManifest
  } catch (err) {
    console.warn(
      `[launcher] could not read the server manifest: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/** The version each required package currently has under the addon root. */
/**
 * When a package directory was last written, ms, or `null` when unreadable.
 *
 * `null` is not zero: an unreadable time is an unknown, and the re-alignment
 * treats an unknown as "cannot be shown to be stale" rather than as "old"
 * (D393). Folding it into a number is how a deliberate deploy gets destroyed.
 */
function readDirTimeMs(dir: string): number | null {
  try {
    return fs.statSync(dir).mtimeMs
  } catch {
    return null
  }
}

function readInstalledAddonVersions(
  addonRoot: string,
  packages: readonly string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const name of packages) {
    const pkgJson = path.join(addonRoot, name, 'package.json')
    if (!fs.existsSync(pkgJson)) continue
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'))
      const version =
        typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined
      out[name] = typeof version === 'string' ? version : null
    } catch {
      // Present but unreadable is NOT absent — the plan says so in its own words.
      out[name] = null
    }
  }
  return out
}

/**
 * Read `bootstrap.requiredAddons` from `<dataDir>/config.yaml` if present.
 * Returns the parsed array, an empty array when explicitly set to `[]`,
 * or `null` when the field is absent (caller should fall back to the
 * kernel's REQUIRED_PACKAGES constant).
 *
 * Inline YAML parse rather than going through ConfigManager: the
 * launcher runs before @camstack/system is imported and must stay free of
 * core dependencies. Just yaml.load + bootstrapSchema (kernel) for
 * shape validation.
 *
 * `bootstrapSchema` is passed in (not imported at module top) so this
 * helper can be called after the dynamic @camstack/system import in launch().
 */
function readBootstrapRequiredAddons(
  dataDir: string,
  bootstrapSchema: typeof BootstrapSchemaType,
): readonly string[] | null {
  const raw = readConfigYaml(dataDir)
  if (raw === null) return null

  const validation = bootstrapSchema.safeParse(raw)
  if (!validation.success) {
    console.warn(
      `[launcher] config.yaml failed bootstrapSchema validation: ${validation.error.message}`,
    )
    return null
  }

  return validation.data.bootstrap.requiredAddons ?? null
}

async function launch(): Promise<void> {
  const dataDir = DATA_DIR

  // Node role (hub | agent) — resolved ONCE here. Dynamic import keeps the
  // launcher's zero-static-@camstack/*-import invariant intact even though
  // `node-role.ts` imports no @camstack/* itself. The role selects both the
  // bootstrap package set (hub → all addons; agent → AGENT_PACKAGES) and,
  // at the very end of launch(), which runtime entry is loaded.
  const { resolveNodeRole } = await import('./node-role.js')
  const role = resolveNodeRole(process.env)
  console.log(`[launcher] Node role: ${role}`)
  // Addons live in a real `node_modules`-shaped dir so ESM `import` resolves
  // every @camstack/* (system + addon-*) from there via the standard
  // walk-up — NODE_PATH only covers CJS, which is why forked ESM addon
  // runners couldn't resolve `@camstack/types` from a plain `addons/` dir.
  // `CAMSTACK_ADDONS_DIR` lets the Docker/Electron images point at their
  // node_modules path (e.g. /data/node_modules); dev keeps `<dataDir>/addons`.
  const addonsDir = process.env['CAMSTACK_ADDONS_DIR'] ?? path.resolve(dataDir, 'addons')

  // ── Single-copy framework dir (2026-07-18 collapse) ────────────────────────
  // In data-root mode the ACTIVE single copy (set by the starter as
  // CAMSTACK_SERVER_ACTIVE_ROOT) IS the framework — point the forked
  // addon-runners' resolver + NODE_PATH at it instead of the (now-inert)
  // static /data/framework copy. Forked children inherit this via process.env,
  // and the NODE_PATH extension below reads CAMSTACK_FRAMEWORK_DIR. No-op in
  // baked mode (activeRoot unset → keep the image's /data/framework).
  const activeRoot = process.env['CAMSTACK_SERVER_ACTIVE_ROOT']
  if (activeRoot && fs.existsSync(path.join(activeRoot, 'node_modules', '@camstack', 'system'))) {
    process.env['CAMSTACK_FRAMEWORK_DIR'] = activeRoot
    console.log(`[launcher] Single-copy framework dir → ${activeRoot}`)
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Restore must happen first so the snapshot's `addons/` is what the
  // installer + symlink step pick up — otherwise we'd install a stale
  // set and overwrite it a step later.
  await applyPendingRestore(dataDir, (line) => console.log(line))

  // @camstack/system is imported DYNAMICALLY here — AFTER the active framework
  // dir + NODE_PATH are resolved above — so the correct framework copy is what
  // gets loaded. Never import it at module top.
  const { AddonInstaller, bootstrapSchema, detectWorkspacePackagesDir, quarantineAddonResidue } =
    await import('@camstack/system')

  // Residue quarantine — FIRST thing that touches the addon root, before the
  // bootstrap seed writes into it and long before any loader scans it.
  //
  // A directory under `addons/@camstack` whose name is not the package it
  // declares is not an archive: the loader, the agent's boot scan and the
  // install manifest all key on the `package.json` inside, so a rename
  // INSTALLS. On 2026-08-07/08 that shipped `@camstack/system 1.2.3` as the
  // reported version on a node running a 1.2.61 closure, and kept a 17-day-old
  // `better_sqlite3.node` mapped into the live process. Moved, never deleted —
  // the cleanup that deleted one of these gutted an agent the same evening.
  //
  // Guarded with a typeof check for the same reason `reconcileManifest` is: a
  // system-only framework update can swap in a build that predates this.
  if (typeof quarantineAddonResidue === 'function') {
    const residue = quarantineAddonResidue(addonsDir, (msg) => console.log(msg))
    if (residue.quarantined.length > 0 || residue.failed.length > 0) {
      console.log(
        `[launcher] Addon residue — quarantined ${residue.quarantined.length}, ` +
          `failed ${residue.failed.length}`,
      )
    }
  } else {
    console.warn('[launcher] quarantineAddonResidue unavailable — skipping residue quarantine')
  }

  // Install source resolution:
  //   1. CAMSTACK_BUNDLED_ADDONS_DIR — set by Electron-packaged builds to
  //      the closure's own scope dir, <resourcesPath>/node_modules/@camstack.
  //      Pre-built addons ship inside that closure and are copied out of it at
  //      first launch (`'local'` mode). ONE copy in the bundle: the app used to
  //      ship a second, hand-copied <resourcesPath>/addons tree as well (D45).
  //   2. CAMSTACK_INSTALL_SOURCE=local — explicit opt-in to copy from
  //      the monorepo workspace (used by e2e + dev bootstrap). Hub
  //      auto-detects `packages/` via detectWorkspacePackagesDir.
  //   3. Otherwise: 'npm' from the registry. Local development pushes
  //      via `camstack deploy` (CLI tarball upload), bypassing this
  //      bootstrap entirely.
  console.log('[launcher] Checking required packages...')
  // Install source resolution:
  //   CAMSTACK_INSTALL_SOURCE env: 'npm' | 'local' | 'symlink' | undefined.
  //   CAMSTACK_BUNDLED_ADDONS_DIR: Electron path, forces 'local'.
  //   bootstrap.installSource (config.yaml): same set as env. Env wins.
  const rawEnvSource = process.env['CAMSTACK_INSTALL_SOURCE']
  const yamlSource = readBootstrapInstallSource(dataDir, bootstrapSchema)
  const explicitSource = parseInstallSource(rawEnvSource) ?? yamlSource
  const bundledDir = process.env['CAMSTACK_BUNDLED_ADDONS_DIR']
  let workspaceDir: string | null = null
  let resolvedSource: 'npm' | 'local' | 'symlink' | undefined = explicitSource
  if (bundledDir && fs.existsSync(bundledDir)) {
    workspaceDir = bundledDir
    resolvedSource = 'local'
    console.log(`[launcher] Using bundled addons from ${bundledDir}`)
  } else if (explicitSource === 'local' || explicitSource === 'symlink') {
    workspaceDir = detectWorkspacePackagesDir(__dirname)
    if (workspaceDir === null) {
      console.warn(
        `[launcher] installSource=${explicitSource} requested but no workspace ` +
          `packages/ dir found from ${__dirname} — falling back to 'npm'`,
      )
      resolvedSource = 'npm'
    }
  }
  const installer = new AddonInstaller({
    addonsDir,
    workspacePackagesDir: workspaceDir ?? undefined,
    installSource: resolvedSource,
  })

  // bootstrap.requiredAddons from config.yaml — if set, REPLACES the
  // kernel's hard-coded REQUIRED_PACKAGES. The kernel never reaches into
  // SQL before this list is installed; everything here must be a known
  // package name that can be resolved from the workspace, the bundle, or
  // npm. Default (undefined) → derive from THIS server's own package.json.
  //
  // We derive the list here rather than relying on
  // `AddonInstaller.REQUIRED_PACKAGES` (which uses
  // `require.resolve('@camstack/server/package.json')`): in the slim image the
  // `@camstack/*` workspace symlinks are stripped and NODE_PATH is only
  // extended to include `/repo/node_modules` LATER in this launcher, so that
  // static resolves to an EMPTY list at import time — and `@camstack/system`
  // (which provides the storage-provider / settings / logging infra builtins)
  // would never get installed into data/addons, aborting boot with
  // "No addon provides required infrastructure capability storage-provider".
  // The server's own package.json is always readable next to this launcher.
  // Role-aware default bootstrap set: the hub installs every addon-* dep of
  // its own package.json; the agent installs ONLY the agent bootstrap subset
  // (AGENT_PACKAGES, derived from `camstack.agentBootstrapAddons`). A
  // config.yaml `bootstrap.requiredAddons` override still wins for both roles.
  const roleDefaultBootstrap =
    role === 'agent' ? AddonInstaller.AGENT_PACKAGES : deriveBootstrapFromSelf()
  const bootstrapRequired =
    readBootstrapRequiredAddons(dataDir, bootstrapSchema) ?? roleDefaultBootstrap
  console.log(`[launcher] bootstrap (${role}): ${bootstrapRequired.length} required package(s)`)

  // THE FIRST-BOOT ADDON PLAN — reported every boot (D45 task 32).
  //
  // The image no longer bakes a NON-system addon tree, so this roster comes
  // from the registry on a fresh node: "tutti gli altri addons devono rimanere
  // copia unica, sempre, installati durante l'avvio iniziale" [all the other addons must remain a single copy, always, installed during the initial boot] (2026-08-12), at
  // `latest`, because "il sistema e' designato per essere addons-agnostic" [the system is designed to be addons-agnostic]
  // (2026-08-13). The plan below is what `ensureRequiredPackages` is about to
  // do, said out loud BEFORE it happens: how many packages this node must fetch
  // (i.e. whether this boot needs the registry at all), and where an installed
  // copy differs from the one inside this very closure — one node, two truthful
  // versions, which is the condition task 32 exists to end.
  //
  // Diagnostics, so it can never end a boot: same policy as the inventories.
  try {
    const closureNodeModules = resolveClosureNodeModules(__dirname)
    const plan = planFirstBootAddons({
      required: bootstrapRequired,
      installed: readInstalledAddonVersions(addonsDir, bootstrapRequired),
      closureVersions: readInstalledAddonVersions(closureNodeModules, bootstrapRequired),
      // Mirrors `shouldSkipClosureProvidedSeed`: only `@camstack/system`, and
      // only while it actually resolves.
      closureProvided: (() => {
        try {
          require.resolve('@camstack/system/package.json')
          return ['@camstack/system']
        } catch {
          return []
        }
      })(),
    })
    for (const line of formatFirstBootPlan(plan, 'observe')) {
      console.log(`[launcher] ${line}`)
    }
  } catch (err) {
    console.warn(
      `[launcher] first-boot addon plan failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  await installer.ensureRequiredPackages(bootstrapRequired)

  // THE ARM THE PLAN ABOVE NEVER HAD (D518).
  //
  // The closure carries a copy of every addon it declares, and nothing ever
  // loads one from there — the addon root is the only load path on every role.
  // So `applyServerUpdate` advanced the closure and changed nothing that runs:
  // six addons on this hub were behind by up to nineteen versions, each frozen
  // at whenever somebody last ran `camstack deploy`. `planFirstBootAddons` has
  // printed that drift at INFO on every boot for a month, and its `PlanMode`
  // has an `'enforce'` arm that was never built. This is it.
  //
  // Diagnostics-grade failure policy, like the plan and the inventories: a
  // re-alignment that throws must never end a boot. An addon that stays behind
  // is the status quo; a node that will not start is not.
  try {
    const closureNodeModules = resolveClosureNodeModules(__dirname)
    const decisions = planAddonRealignment(
      bootstrapRequired.flatMap((pkg) => {
        const installedVersion = readInstalledAddonVersions(addonsDir, [pkg])[pkg]
        if (typeof installedVersion !== 'string') return []
        return [
          {
            pkg,
            installedVersion,
            installedUpdatedAtMs: readDirTimeMs(path.join(addonsDir, pkg)),
            closureVersion: readInstalledAddonVersions(closureNodeModules, [pkg])[pkg] ?? null,
            closureLandedAtMs: readDirTimeMs(path.join(closureNodeModules, pkg)),
          },
        ]
      }),
    )
    for (const d of decisions) {
      if (d.action !== 'realign') continue
      try {
        const done = await installer.realignFromClosure(d.pkg, path.join(closureNodeModules, d.pkg))
        console.log(`[launcher] re-aligned ${d.pkg} → ${done.version} — ${d.reason}`)
      } catch (err) {
        // Named per addon. A batch that reports only a count cannot say which
        // one is still behind, which is the whole question afterwards.
        console.warn(
          `[launcher] re-align FAILED for ${d.pkg}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    const kept = decisions.filter((d) => d.action === 'keep').length
    console.log(
      `[launcher] addon re-alignment: ${decisions.length - kept} re-aligned, ${kept} kept as they are`,
    )
  } catch (err) {
    console.warn(
      `[launcher] addon re-alignment failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Make every installed addon's runtime deps resolvable — the restore
  // repair (D338: a restored addons/ tree carries no node_modules, and only
  // bootstrap addons were reinstalled here, leaving every other addon
  // silently broken until a manual redeploy). Reinstalls ONLY what is
  // neither present nor resolvable from the server closure; an addon whose
  // deps are satisfied is not touched. typeof-guarded like reconcileManifest:
  // a system-only framework update can swap in a build that predates it.
  if (typeof installer.ensureAddonRuntimeDeps === 'function') {
    try {
      const depsResult = await installer.ensureAddonRuntimeDeps()
      if (
        depsResult.linked.length > 0 ||
        depsResult.reinstalled.length > 0 ||
        depsResult.failed.length > 0
      ) {
        console.log(
          `[launcher] Addon runtime deps ensured — linked: [${depsResult.linked.join(', ')}], ` +
            `reinstalled: [${depsResult.reinstalled.join(', ')}], ` +
            `failed: [${depsResult.failed.join(', ')}] (${depsResult.checked} checked)`,
        )
      }
    } catch (err) {
      console.warn(
        `[launcher] ensureAddonRuntimeDeps failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    console.warn('[launcher] ensureAddonRuntimeDeps unavailable — skipping addon dep repair')
  }

  // Reconcile the install manifest against what is on disk — the directory is
  // the truth, because it is what the loader runs. Registers image-seeded
  // addons (copied straight into addonsDir by the container entrypoint, never
  // through an install codepath, so runtime "Update" rejected them as "not
  // currently tracked"), corrects a recorded version that disagrees with the
  // installed package.json, and drops entries naming a directory that does not
  // exist. Idempotent; safe every boot. Runs BEFORE any update can be in
  // flight, and never touches an entry holding a rollback pointer.
  //
  // Guarded with a typeof check: the backend and @camstack/system normally
  // ship together in one image, but a system-only framework update can
  // swap in a build that predates `reconcileManifest`. A missing method
  // must not crash boot — the manifest is already persisted from a prior
  // boot, so skipping reconcile is harmless.
  if (typeof installer.reconcileManifest === 'function') {
    const reconciled = installer.reconcileManifest()
    if (reconciled > 0) {
      console.log(`[launcher] Manifest reconciled — ${reconciled} correction(s)`)
    }
  } else {
    console.warn('[launcher] installer.reconcileManifest unavailable — skipping manifest reconcile')
  }

  // Reclaim orphaned pre-update rollback copies under `addons/.backups/`.
  // Nothing used to delete them: a second update overwrote `lastBackupDir`
  // and the previous backup lost its only pointer — 814 MiB of them on the
  // live hub, 796 MiB of it two copies of one addon. The sweep keeps at most
  // the manifest's rollback target per addon (and never the last surviving
  // copy of an addon whose install dir is missing). Runs here, before any
  // update can be in flight. Same typeof guard as reconcileManifest: an
  // older @camstack/system must not crash boot.
  if (typeof installer.sweepBackups === 'function') {
    const swept = await installer.sweepBackups()
    if (swept.removed.length > 0) {
      console.log(
        `[launcher] Backup sweep — reclaimed ${swept.removed.length}, retained ${swept.kept.length}`,
      )
    }
  }

  // Self-contained addon bundles (build preset `self-contained`) inline
  // @camstack/types + zod + @camstack/sdk into each addon's dist. The
  // hub no longer plants peer-dep symlinks under
  // addonsDir/node_modules/@camstack/ — addons resolve everything from
  // their own bundle. Kept the serverDir derivation in case future
  // tooling needs it (NODE_PATH extension below still uses it).
  const serverDir = path.resolve(__dirname, '..')
  const nodeModulesDir = path.join(serverDir, 'node_modules')

  // Extend Node's module resolution so addons in `data/addons/`
  // (which sit outside the server tree on packaged builds — e.g.
  // `~/Library/Application Support/.../data/addons/`) can resolve
  // third-party peer deps from the hub's own `node_modules`.
  //
  // Why: an addon's runtime file `data/addons/@scope/<x>/dist/x.js`
  // walks UP looking for `node_modules/<pkg>`. With user-data
  // outside the workspace, the walk dead-ends well before hitting
  // the hub's tree. NODE_PATH instructs Node to ALSO check the
  // listed dirs after the regular walk fails.
  //
  // The workspace-root node_modules holds hoisted deps (zod, werift,
  // etc); the server-local node_modules has direct deps. Listing
  // both covers every realistic resolution.
  const workspaceRootNodeModules = path.resolve(serverDir, '..', '..', 'node_modules')
  const frameworkPaths = frameworkNodePaths(process.env['CAMSTACK_FRAMEWORK_DIR'], fs.existsSync)
  const extraNodePaths = [...frameworkPaths, nodeModulesDir, workspaceRootNodeModules].filter((p) =>
    fs.existsSync(p),
  )
  if (frameworkPaths.length > 0) {
    console.log(`[launcher] Framework dir on NODE_PATH: ${frameworkPaths[0]}`)
  }
  if (extraNodePaths.length > 0) {
    const sep = process.platform === 'win32' ? ';' : ':'
    process.env['NODE_PATH'] = process.env['NODE_PATH']
      ? `${process.env['NODE_PATH']}${sep}${extraNodePaths.join(sep)}`
      : extraNodePaths.join(sep)
    // Re-init Node's module path cache so the change takes effect for
    // subsequent require()/import() calls. Without this the resolver
    // already cached the empty list at startup.
    const Module = require('node:module') as { _initPaths: () => void }
    Module._initPaths()
    console.log(`[launcher] NODE_PATH extended with: ${extraNodePaths.join(sep)}`)
  }

  // WHICH COPY did this node just commit to? ([D45](../../../docs/decisions/adr-0045.md))
  //
  // A node can hold several copies of a host-provided package — the image seed
  // under /opt, a legacy /data/framework on NODE_PATH, the active closure, an
  // installed copy under /data/addons. Which one wins is a resolution outcome,
  // and on 2026-08-03 three consecutive deductions about it were each disproved
  // by the next measurement, while every status surface reported the version of
  // a copy nobody was running. Resolution happens HERE, right after NODE_PATH
  // is final and before the runtime imports anything — so this is the one place
  // that can answer it, and it costs a stat call per package.
  //
  // A version number without a path is not evidence. Log both.
  for (const pkg of ['@camstack/system', '@camstack/types']) {
    try {
      const resolved = require.resolve(`${pkg}/package.json`)
      const version: unknown = (
        JSON.parse(fs.readFileSync(resolved, 'utf-8')) as { version?: unknown }
      ).version
      console.log(`[launcher] resolved ${pkg}@${String(version)} from ${resolved}`)
    } catch (err) {
      console.warn(
        `[launcher] could NOT resolve ${pkg}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // WHAT ELSE could have run? (D45 enforcement step 2)
  //
  // The line above says which copy this boot resolved. It cannot say what else
  // is lying around, and that is the half that produced three wrong diagnoses:
  // one agent held FOUR copies of @camstack/system (1.2.28 / 1.2.28 / 1.2.0 /
  // 1.2.30), so every version the node reported was true of a copy nobody was
  // running.
  //
  // Only the copies nobody deposits on purpose are reported. The /opt seeds
  // are baked into the image and shadowed by the /data/server-root/current
  // deposit on every applyServerUpdate — calling those a violation printed the
  // banner at every boot on every node, which is how it stopped being read.
  // They get one compact line instead; an unexpected location (the legacy
  // /data/framework, a bootstrap install under /data/addons) and two copies
  // that could both run still scream.
  //
  // NEVER fatal — operator directive, 2026-08-12: "non dovremmo mai prevenire
  // il boot" [we should never prevent the boot]. There is no flag that turns this into a refusal. A node that
  // cannot start is a camera system that is not recording, and the inventory is
  // the thing that was supposed to EXPLAIN a bad layout, not enact a verdict on
  // it. Removing a copy stays an operator decision.
  //
  // [inventory-diagnostics-begin] enforced by scripts/check-inventory-never-fatal.ts
  try {
    const inventory = inventoryHostProvided(
      hostProvidedSearchRoots({
        nodePath: process.env['NODE_PATH'],
        pathSeparator: process.platform === 'win32' ? ';' : ':',
        dataDir: DATA_DIR,
        serverNodeModules: nodeModulesDir,
        frameworkRoots: frameworkPaths,
        seedRoots: seedNodeModulesRoots(fs),
      }),
      {
        exists: (dir) => fs.existsSync(path.join(dir, 'package.json')),
        readVersion: (dir) => {
          try {
            const raw: unknown = JSON.parse(
              fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'),
            )
            const version =
              typeof raw === 'object' && raw !== null
                ? (raw as { version?: unknown }).version
                : undefined
            return typeof version === 'string' ? version : null
          } catch {
            return null
          }
        },
        realPath: (dir) => {
          try {
            return fs.realpathSync(dir)
          } catch {
            return dir
          }
        },
      },
    )
    for (const note of formatShadowingNotes(inventory)) {
      console.log(`[launcher] ${note}`)
    }
    const report = formatInventoryReport(inventory)
    if (report !== '') {
      console.error(`[launcher] ${report}`)
    }
  } catch (err) {
    // The inventory is diagnostics. It must never be the reason a node fails
    // to boot when it is the thing that was supposed to explain failures.
    console.warn(
      `[launcher] package inventory failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // A SECOND ADDON ROOT on this machine.
  //
  // The inventory above scans roots derived from the ACTIVE data dir, so an
  // entire rival data root — a retired Electron app id, the pre-Electron
  // `~/camstack-agent-data` — is structurally invisible to it. Those trees hold
  // complete `addons/@camstack/` installs with plausible package.json files,
  // and reading a version out of one answers a question about a node that has
  // not run since June. Measured on the Mac agent: four addon roots, four
  // truthful `addon-pipeline` versions, one of them the running node's.
  //
  // Reported, never fatal, never deleted here — same policy as D45 above, and
  // no flag changes it. Making the second location LOUD is the whole job;
  // removing it stays an operator decision.
  try {
    const addonRoots = inventoryAddonRoots(
      {
        dataDir: DATA_DIR,
        activeAddonsDir: addonsDir,
        homeDir: os.homedir(),
        platform: process.platform,
      },
      {
        exists: (dir) => fs.existsSync(dir),
        listPackages: (scopeDir) => {
          try {
            return fs
              .readdirSync(scopeDir, { withFileTypes: true })
              .filter((e) => e.isDirectory() || e.isSymbolicLink())
              .map((e) => e.name)
          } catch {
            return []
          }
        },
        readVersion: (packageDir) => {
          try {
            const raw: unknown = JSON.parse(
              fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8'),
            )
            const version =
              typeof raw === 'object' && raw !== null
                ? (raw as { version?: unknown }).version
                : undefined
            return typeof version === 'string' ? version : null
          } catch {
            return null
          }
        },
        realPath: (dir) => {
          try {
            return fs.realpathSync(dir)
          } catch {
            return dir
          }
        },
      },
    )
    const addonRootReport = formatAddonRootReport(addonRoots)
    if (addonRootReport !== '') {
      console.error(`[launcher] ${addonRootReport}`)
    }
  } catch (err) {
    console.warn(
      `[launcher] addon-root inventory failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  // [inventory-diagnostics-end]

  // Now safe to load the role's runtime entry (both have static imports from
  // @camstack/system, resolved only after the framework dir + NODE_PATH setup
  // above). The agent boots from THIS same @camstack/server closure — there is
  // no separate agent root package.
  if (role === 'agent') {
    console.log('[launcher] Starting agent runtime...')
    const { startAgent } = await import('./agent/main.js')
    await startAgent()
  } else {
    console.log('[launcher] Starting server...')
    await import('./main')
  }

  // The role runtime has installed its own SIGTERM/SIGINT handlers now. Stop
  // intercepting those signals here: calling process.exit() first prevented the
  // hub/agent's asynchronous broker shutdown from running at all. Keep SIGHUP
  // launcher-owned as before.
  process.off('SIGTERM', handleSignal)
  process.off('SIGINT', handleSignal)
}

// Bootstrap-window signal handlers. Once the selected role has installed its
// own graceful handlers, launch() removes these for SIGTERM/SIGINT. Before that
// point an immediate exit is intentional; the process-group exit backstop kills
// any runner group that managed to start during the interrupted boot.
let shuttingDown = false
const handleSignal = (signal: NodeJS.Signals) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[launcher] Received ${signal} — shutting down`)
  process.exit(0)
}
process.on('SIGHUP', handleSignal)
process.on('SIGTERM', handleSignal)
process.on('SIGINT', handleSignal)

// Parent-death watchdog (macOS: no PR_SET_PDEATHSIG). If tsx watch / npm
// get orphaned to init, self-destruct so NestJS shutdown hooks fire before
// the process tree turns into a zombie.
const initialPpid = process.ppid
setInterval(() => {
  if (process.ppid === 1 && initialPpid !== 1) {
    console.error('[launcher] Parent died (reparented to init) — exiting')
    process.exit(0)
  }
}, 2000).unref()

launch().catch((err) => {
  console.error('[launcher] FATAL:', err)
  process.exit(1)
})
