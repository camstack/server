/**
 * Stage the @camstack/server runtime closure for electron-builder — sourced
 * PRE-BUILT from public npm. NO source build, NO nx: the @camstack/* packages
 * are public (registry.npmjs.org, --access public) and published WITH their
 * dist (and addon-pipeline ships python/wasm/swift/assets too), so a single
 * `npm install @camstack/server@latest` brings the ENTIRE runtime closure:
 * server + system/types/sdk/ui-library + all addon-* transitively +
 * every third-party dep (fastify/moleculer/zod/winston/…) + native prebuilds.
 * electron-builder then copies `.deps/node_modules` into
 * `Contents/Resources/node_modules`.
 *
 * ONE closure serves BOTH roles: `@camstack/server` is the single root package
 * and the desktop shell selects hub vs agent at runtime via `CAMSTACK_ROLE`.
 *
 * ROLE CHANGE (runtime-updatable node packages, phase 3): this baked closure is
 * the immutable first-boot/offline SEED, not "the thing we run". The app spawns
 * the shared STARTER (`@camstack/server/dist/starter.js`), which boots the
 * ACTIVE server root from the user data dir (`<userData>/data/server-root`) and
 * only falls back to this seed when no version is installed there. Nothing
 * writes into Contents/Resources at runtime — all mutable state lives under
 * userData — so node/framework updates never touch the signed .app bundle.
 *
 * The closure is `@camstack/server@latest` at build time — the same install
 * the image uses. The desktop app's own version is the product release
 * (`product-version.json`, D943), not this closure's version.
 *
 * better-sqlite3 is the one traditional (non-N-API) native: npm fetched THIS
 * Node's ABI prebuild, but the packaged app runs under the BUNDLED real Node
 * (see below), so re-fetch that Node's ABI prebuild. (node-av /
 * sharp are N-API → ABI-stable across Node & Electron.)
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeExecFailure, runWithRetry, sleepSync } from './exec-retry.mjs'
import {
  extractArgs,
  nodeArchiveSpec,
  nodeAvSiblingName,
  tarCommand,
  verifyNodeArchive,
} from './node-bundle.mjs'
import { verifyWinsw, WINSW_STAGED_NAME, WINSW_URL } from './winsw-bundle.mjs'
import {
  addonMissingNatives,
  bundledAddonSourceDirs,
  referencedNativePackages,
  stageNativeIntoAddon,
} from './native-staging.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, '..') // packages/desktop
const stageDir = join(desktopDir, '.deps')
const stageModules = join(stageDir, 'node_modules')

// @camstack/server already depends on the addons, but listing it alone pulls
// the entire closure (server + system/types/sdk/ui-library + all
// addon-* + third-party deps) transitively. `@latest` is deliberate:
// the product version is not an npm version (D943).
const SPECS = ['@camstack/server@latest']

// The closure install is the one long (~90 s), network-heavy, externally
// killable step of the desktop build. On the self-hosted linux runner an
// EXTERNAL SIGTERM landed on npm mid-reify (release v1.2.104): npm's arborist
// signal handler rolled the reify back and exited 1, the leg failed, and
// `publish-release` was skipped — leaving the release a draft with the mac +
// docker artifacts already built. Bound the blast radius with ONE retry. A
// genuine failure (an unpublished version, a 404) still fails, one attempt
// later; a transient kill no longer costs a release.
const CLOSURE_INSTALL_ATTEMPTS = 2
const CLOSURE_INSTALL_RETRY_MS = 15_000

rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageModules, { recursive: true })
writeFileSync(
  join(stageDir, 'package.json'),
  `${JSON.stringify({ name: 'camstack-desktop-deps-stage', private: true, version: '0.0.0' }, null, 2)}\n`,
)

console.log(`[stage-deps] installing PRE-BUILT closure from npm: ${SPECS.join(' ')}`)
const closureInstall = `npm install --omit=dev --no-audit --no-fund ${SPECS.join(' ')}`
try {
  runWithRetry(() => execSync(closureInstall, { cwd: stageDir, stdio: 'inherit' }), {
    attempts: CLOSURE_INSTALL_ATTEMPTS,
    delayMs: CLOSURE_INSTALL_RETRY_MS,
    sleep: sleepSync,
    onRetry: ({ attempt, attempts, error }) => {
      console.error(
        `[stage-deps] closure install attempt ${attempt}/${attempts} failed: ` +
          `${describeExecFailure(error, closureInstall)} — retrying in ${CLOSURE_INSTALL_RETRY_MS / 1000}s`,
      )
    },
  })
} catch (err) {
  // `stdio: 'inherit'` leaves the thrown error's `stderr` null, so nothing but
  // a bare node stack trace reaches the operator unless the cause is named
  // here. A step that aborts a release says WHAT failed.
  console.error(`[stage-deps] closure install FAILED: ${describeExecFailure(err, closureInstall)}`)
  process.exit(1)
}

// The shell spawns the STARTER out of the FULL baked closure at
// Resources/node_modules/@camstack/server (so the starter's __dirname anchors
// the seed package dir + its npm-sibling framework resolution). Assert both the
// starter and the seed launcher are present — mirrors the Dockerfile `test -e`.
const serverSeedDist = join(stageModules, '@camstack', 'server', 'dist')
for (const f of ['starter.js', 'launcher.js']) {
  if (!existsSync(join(serverSeedDist, f))) {
    console.error(
      `[stage-deps] baked seed is missing @camstack/server/dist/${f} — the shell cannot spawn the starter`,
    )
    process.exit(1)
  }
}
console.log('[stage-deps] verified baked seed exposes dist/starter.js + dist/launcher.js')

// --- Ensure node-av's prebuild for the TARGET arch is staged ---
// node-av (runtime dep of @camstack/addon-pipeline, kept external by vite) loads
// its native binary from a per-platform sibling package installed via its
// optionalDependencies (e.g. @seydx/node-av-darwin-arm64). The install above
// fetched the BUILD HOST's sibling; a cross-arch build (e.g. --x64 on an arm64
// mac, signalled via CS_NODE_ARCH) needs the TARGET arch's sibling, which npm
// only fetches when told the intended platform via --os/--cpu. The target
// PLATFORM is the build host's (electron-builder never cross-builds platforms).
// CS_NODE_ARCH is AUTHORITATIVE when set: the GH runner binary may run under
// Rosetta on Apple Silicon, making process.arch report 'x64' on an arm64 host
// (this shipped an x64 Node inside the arm64 DMG — 2026-07-21).
const envArch = process.env.CS_NODE_ARCH
const targetArch =
  envArch === 'x64' || envArch === 'arm64' ? envArch : process.arch === 'x64' ? 'x64' : 'arm64'
const nodeAvDir = join(stageModules, 'node-av')
if (!existsSync(nodeAvDir)) {
  console.error(
    '[stage-deps] node-av missing from staged closure (expected via @camstack/addon-pipeline)',
  )
  process.exit(1)
}
const nodeAvSibling = nodeAvSiblingName(process.platform, targetArch)
const nodeAvPkg = JSON.parse(readFileSync(join(nodeAvDir, 'package.json'), 'utf8'))
const nodeAvSiblingRange = (nodeAvPkg.optionalDependencies ?? {})[nodeAvSibling]
if (!nodeAvSiblingRange) {
  console.error(
    `[stage-deps] node-av@${nodeAvPkg.version} declares no optionalDependency ${nodeAvSibling}`,
  )
  process.exit(1)
}
if (!existsSync(join(stageModules, nodeAvSibling))) {
  console.log(`[stage-deps] fetching node-av prebuild ${nodeAvSibling}@${nodeAvSiblingRange} …`)
  execSync(
    `npm install --no-save --no-audit --no-fund --force --os=${process.platform} --cpu=${targetArch} "${nodeAvSibling}@${nodeAvSiblingRange}"`,
    { cwd: stageDir, stdio: 'inherit' },
  )
}
if (!existsSync(join(stageModules, nodeAvSibling, 'package.json'))) {
  console.error(
    `[stage-deps] ${nodeAvSibling} missing after staging — node-av would fail to load at runtime`,
  )
  process.exit(1)
}

// --- Bundle a REAL Node runtime + align native ABI to it ---
// The packaged app runs the node under THIS bundled Node (not Electron-as-Node)
// so Electron's V8 pointer-compression sandbox does not reject native external
// mmap `Napi::Buffer` ("External buffers are not allowed"), which would break
// the native frame plane on macOS. `process-manager.ts` prefers
// `Contents/Resources/node/bin/node` (staged here via `extraResources`).
//
// ABI: the initial `npm install` fetched the BUILD machine's Node-ABI prebuild
// for the one traditional (non-N-API) native (better-sqlite3); we re-fetch the
// BUNDLED Node version's ABI. (node-av / sharp are N-API →
// ABI-stable across Node & Electron, so they need no re-fetch.)
const NODE_BUNDLE_MAJOR = '24' // matches Electron 42's Node line; server targets Node 22+
const nodeArch = targetArch
// electron-builder never cross-BUILDS platforms (a `--linux` build runs on a
// linux runner, `--mac` on a mac), only cross-ARCH — so the build host's
// `process.platform` IS the target platform. (Node's dist dir names and the
// per-platform archive shape — tar.gz vs zip, bin/node vs node.exe — are in
// `node-bundle.mjs`.)
const runtimeNodeDir = join(stageDir, 'runtime-node')

// The x64 mac build runs on an Apple Silicon runner. Executing the x64 binary
// there needs Rosetta, which a runner may not have ("Bad CPU type in
// executable" — the v1.2.489 release, 2026-10-09). A cross-arch binary is
// never run by the build, so when it cannot execute, check its header instead.
const FILE_ARCH_MARKERS = { x64: /x86[-_]64/, arm64: /arm64|aarch64/ }

function verifyBundledNode(binary, arch) {
  try {
    execFileSync(binary, ['-v'], { stdio: 'inherit' })
    return
  } catch (err) {
    // `file` does not exist on Windows, and a Windows build never cross-runs a
    // foreign arch: there the failure to execute IS the failure.
    if (process.platform === 'win32') throw err
    const header = execSync(`file -b "${binary}"`).toString()
    if (!FILE_ARCH_MARKERS[arch]?.test(header)) {
      throw new Error(
        `bundled node is not a runnable ${arch} binary (${header.trim()}): ${err.message}`,
      )
    }
    console.warn(
      `[stage-deps] bundled node cannot run on this host; header is ${arch}: ${header.trim()}`,
    )
  }
}

function latestNodeVersion(major) {
  const idx = JSON.parse(execSync('curl -fsSL https://nodejs.org/dist/index.json').toString())
  const hit = idx.find((e) => e.version.startsWith(`v${major}.`))
  if (!hit) throw new Error(`no Node v${major}.x release found in nodejs.org/dist/index.json`)
  return hit.version // e.g. "v24.16.0"
}

try {
  const nodeVersion = latestNodeVersion(NODE_BUNDLE_MAJOR)
  const spec = nodeArchiveSpec({ platform: process.platform, arch: nodeArch, version: nodeVersion })
  console.log(
    `[stage-deps] downloading bundled Node ${nodeVersion} (${process.platform}-${nodeArch}, ${spec.format}) …`,
  )
  mkdirSync(runtimeNodeDir, { recursive: true })
  const archivePath = join(stageDir, spec.fileName)
  execFileSync('curl', ['-fsSL', '-o', archivePath, spec.url], { stdio: 'inherit' })
  // Verified BEFORE a byte is extracted: nodejs.org lists every archive's
  // sha256 in SHASUMS256.txt beside it.
  verifyNodeArchive(
    archivePath,
    spec.fileName,
    execFileSync('curl', ['-fsSL', spec.shasumsUrl]).toString(),
  )
  // Extract only the executable — the official tarballs/zips are self-contained.
  execFileSync(
    tarCommand(process.platform, process.env.SystemRoot),
    extractArgs(spec, archivePath, runtimeNodeDir),
    { stdio: 'inherit' },
  )
  rmSync(archivePath, { force: true })
  const bundledNode = join(runtimeNodeDir, spec.stagedRelPath)
  if (!existsSync(bundledNode)) {
    throw new Error(`bundled node binary missing after extraction at ${bundledNode}`)
  }
  verifyBundledNode(bundledNode, nodeArch)

  const nodeTarget = nodeVersion.replace(/^v/, '')
  for (const mod of ['better-sqlite3']) {
    const modDir = join(stageModules, mod)
    if (!existsSync(modDir)) continue
    console.log(`[stage-deps] fetching Node ${nodeTarget} prebuild for ${mod} …`)
    execSync(
      `npx --yes prebuild-install --runtime node --target ${nodeTarget} --arch ${nodeArch}`,
      {
        cwd: modDir,
        stdio: 'inherit',
      },
    )
  }
} catch (err) {
  console.error(`[stage-deps] bundling Node runtime FAILED: ${err.message}`)
  process.exit(1)
}

// --- Windows only: the pinned service wrapper (D846) ---
// Shipped inside the installer as `resources/service/winsw.exe`; the opt-in
// "run as a Windows service" copies it into an admin-only directory. Fetched
// HERE, verified against its pinned sha256, never on the user's machine.
if (process.platform === 'win32') {
  try {
    const serviceDir = join(stageDir, 'service')
    mkdirSync(serviceDir, { recursive: true })
    const winsw = join(serviceDir, WINSW_STAGED_NAME)
    console.log(`[stage-deps] downloading pinned WinSW → ${winsw}`)
    execFileSync('curl', ['-fsSL', '-o', winsw, WINSW_URL], { stdio: 'inherit' })
    verifyWinsw(winsw)
  } catch (err) {
    console.error(`[stage-deps] staging WinSW FAILED: ${err.message}`)
    process.exit(1)
  }
}

// --- Self-contain each bundled addon copy's native prebuilds ---
// npm HOISTS the natives to the closure's top-level `node_modules`, so an
// addon's own subtree carries none. At runtime the addon-installer seeds
// `data/addons/@camstack/<addon>` from that subtree and `npm install`s the
// addon's deps; on a toolchain-less Mac that leaves `better-sqlite3`
// source-only, so the runner cannot load its `.node` (fresh CamStack.app
// first-boot FATAL, 2026-07-21). Plant each referenced native (WITH the
// bundled-Node `.node` fetched above) into the addon copy's own `node_modules`
// so the subtree is self-contained, then VERIFY — the build must fail loudly if
// any addon copy is still missing a native binary.
//
// The targets are the closure's OWN `@camstack/*` dirs, which is what
// `CAMSTACK_BUNDLED_ADDONS_DIR` points at (`Resources/node_modules/@camstack`).
// Until 2026-08-25 this list was derived from the per-addon `extraResources`
// entries instead, and it was verifying a tree electron-builder shipped WITHOUT
// its `node_modules` — see `native-staging.mjs` for the measurement.
const bundledAddonDirs = bundledAddonSourceDirs(stageModules)

const stagingFailures = []
for (const addonDir of bundledAddonDirs) {
  const addonPkg = JSON.parse(readFileSync(join(addonDir, 'package.json'), 'utf8'))
  const natives = referencedNativePackages(addonPkg)
  if (natives.length === 0) continue
  for (const native of natives) {
    const copied = stageNativeIntoAddon(stageModules, addonDir, native)
    if (copied.length > 0) {
      console.log(
        `[stage-deps] ${addonPkg.name}: staged ${native} (+${copied.length} module dir(s))`,
      )
    }
  }
  const missing = addonMissingNatives(addonDir, natives)
  if (missing.length > 0) {
    stagingFailures.push(`${addonPkg.name}: missing .node for ${missing.join(', ')}`)
  }
}

if (stagingFailures.length > 0) {
  console.error(
    '[stage-deps] POST-STAGE VERIFICATION FAILED — bundled addon copies missing native prebuilds:',
  )
  for (const f of stagingFailures) console.error(`  - ${f}`)
  console.error(
    '[stage-deps] refusing to ship: these addons would crash at runtime ' +
      '("Could not locate the bindings file"). Fix the closure/prebuild step.',
  )
  process.exit(1)
}
console.log(
  `[stage-deps] verified ${bundledAddonDirs.length} bundled addon copies carry their native prebuilds`,
)

console.log(`[stage-deps] staged pre-built closure + bundled Node → ${stageModules}`)
