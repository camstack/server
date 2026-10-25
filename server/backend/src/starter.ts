/**
 * STARTER — the tiny, immutable, dependency-free entry baked into the hub
 * image. Everything above it (launcher, main, framework, addons) is runtime-
 * updatable; the starter itself can NEVER self-update — a new image is the
 * only way to change it, which is why it must stay deliberately dumb.
 *
 * The boot flow lives in the SHARED node-root core (`runNodeStarter`,
 * bundled into `./server-root/index.js` at build time — see the barrel's
 * BUILD NOTE): workspace defer → apply a staged root swap + migrate the legacy
 * layout to the single `current/` copy → host-external resolver hooks → load
 * the single copy (or the baked seed). This file only binds the hub's names:
 * `@camstack/server`, `dist/launcher.js`, the `CAMSTACK_SERVER_*` env
 * markers and the `CAMSTACK_DATA` data dir.
 *
 * Console usage is intentional: the starter runs before any logging exists.
 */
import * as path from 'node:path'
import { HUB_ROOT_SPEC, runNodeStarter } from './server-root/index.js'

function start(): void {
  const seedPackageDir = path.resolve(__dirname, '..')
  if (process.env['CAMSTACK_SEED_SERVER_DIR'] === undefined) {
    process.env['CAMSTACK_SEED_SERVER_DIR'] = seedPackageDir
  }

  runNodeStarter({
    spec: HUB_ROOT_SPEC,
    envNames: {
      bootMode: 'CAMSTACK_SERVER_BOOT_MODE',
      activeRoot: 'CAMSTACK_SERVER_ACTIVE_ROOT',
      activeVersion: 'CAMSTACK_SERVER_ACTIVE_VERSION',
      killSwitch: 'CAMSTACK_SERVER_ROOT',
    },
    dataDir: path.resolve(process.env['CAMSTACK_DATA'] ?? 'camstack-data'),
    seedEntry: path.join(__dirname, 'launcher.js'),
    starterDir: __dirname,
    // The launcher is CJS (tsc build) — a plain require keeps the starter
    // synchronous and lets the launcher's own dynamic imports take over.
    loadEntry: (entryPath) => require(entryPath),
  })
}

try {
  start()
} catch (err) {
  console.error('[starter] FATAL:', err)
  process.exit(1)
}
