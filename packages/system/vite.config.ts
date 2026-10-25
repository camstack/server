import { defineConfig } from 'vite'
import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'
import { SYSTEM_EXTRA_EXTERNALS } from './vite.shared.ts'

/**
 * Framework package — core. 23 entries (root index + per-builtin
 * index/addon files). DTS limited to the public root entry only —
 * matches tsup's prior behavior (emitting DTS for all 23 entries
 * OOM'd the TS compiler on CI runners with ~7GB heap).
 *
 * Consumers always import from `@camstack/system` (root), not
 * `@camstack/system/builtins/<x>`, so the missing builtin .d.ts files
 * are invisible to typed callers.
 */
const base = buildLibPreset({
  entries: {
    index: 'src/index.ts',
    // Lightweight addon-facing util surface — avoids loading the full
    // kernel+builtins barrel (~64MB heap). See src/addon-utils.ts.
    'addon-utils': 'src/addon-utils.ts',
    'builtins/sqlite-storage/index': 'src/builtins/sqlite-storage/index.ts',
    'builtins/sqlite-storage/filesystem-storage.addon':
      'src/builtins/sqlite-storage/filesystem-storage.addon.ts',
    'builtins/sqlite-storage/sqlite-settings.addon':
      'src/builtins/sqlite-storage/sqlite-settings.addon.ts',
    'builtins/winston-logging/index': 'src/builtins/winston-logging/index.ts',
    'builtins/console-logging/index': 'src/builtins/console-logging/index.ts',
    'builtins/loki-logging/index': 'src/builtins/loki-logging/index.ts',
    'builtins/hub-forwarder/index': 'src/builtins/hub-forwarder/index.ts',
    'builtins/backup-orchestrator/index': 'src/builtins/backup-orchestrator/index.ts',
    'builtins/backup-orchestrator/backup-orchestrator.addon':
      'src/builtins/backup-orchestrator/backup-orchestrator.addon.ts',
    'builtins/storage-orchestrator/index': 'src/builtins/storage-orchestrator/index.ts',
    'builtins/keychain/index': 'src/builtins/keychain/index.ts',
    'builtins/record-entries/index': 'src/builtins/record-entries/index.ts',
    'builtins/storage-orchestrator/storage-orchestrator.addon':
      'src/builtins/storage-orchestrator/storage-orchestrator.addon.ts',
    'builtins/native-metrics/native-metrics.addon':
      'src/builtins/native-metrics/native-metrics.addon.ts',
    'builtins/device-history/device-history.addon':
      'src/builtins/device-history/device-history.addon.ts',
    'builtins/snapshot/index': 'src/builtins/snapshot/index.ts',
    'builtins/autotrack/index': 'src/builtins/autotrack/index.ts',
    'builtins/camera-grid/index': 'src/builtins/camera-grid/index.ts',
    'builtins/alerts/index': 'src/builtins/alerts/index.ts',
    'builtins/alerts/alerts.addon': 'src/builtins/alerts/alerts.addon.ts',
    'builtins/core-blocks/index': 'src/builtins/core-blocks/index.ts',
    'builtins/core-blocks/core-blocks.addon': 'src/builtins/core-blocks/core-blocks.addon.ts',
    'builtins/composer/index': 'src/builtins/composer/index.ts',
    'builtins/composer/composer.addon': 'src/builtins/composer/composer.addon.ts',
    'builtins/liveness-monitor/index': 'src/builtins/liveness-monitor/index.ts',
    'builtins/liveness-monitor/liveness-monitor.addon':
      'src/builtins/liveness-monitor/liveness-monitor.addon.ts',
    'builtins/system-config/index': 'src/builtins/system-config/index.ts',
    'builtins/system-config/system-config.addon':
      'src/builtins/system-config/system-config.addon.ts',
    'builtins/calendars/index': 'src/builtins/calendars/index.ts',
    'builtins/calendars/calendars.addon': 'src/builtins/calendars/calendars.addon.ts',
    'builtins/addon-pages-aggregator/index': 'src/builtins/addon-pages-aggregator/index.ts',
    'builtins/addon-pages-aggregator/addon-pages-aggregator.addon':
      'src/builtins/addon-pages-aggregator/addon-pages-aggregator.addon.ts',
    'builtins/addon-widgets-aggregator/index': 'src/builtins/addon-widgets-aggregator/index.ts',
    'builtins/addon-widgets-aggregator/addon-widgets-aggregator.addon':
      'src/builtins/addon-widgets-aggregator/addon-widgets-aggregator.addon.ts',
    'builtins/device-manager/index': 'src/builtins/device-manager/index.ts',
    'builtins/device-manager/device-manager.addon':
      'src/builtins/device-manager/device-manager.addon.ts',
    'builtins/local-auth/index': 'src/builtins/local-auth/index.ts',
    'builtins/local-auth/local-auth.addon': 'src/builtins/local-auth/local-auth.addon.ts',
    // Promoted from @camstack/addon-platform-probe-native (Phase B).
    'builtins/platform-probe/index': 'src/builtins/platform-probe/index.ts',
    // Hub-only — host interface enumeration + SDK connection-endpoint
    // ranking. See packages/types/src/capabilities/local-network.cap.ts.
    'builtins/local-network/index': 'src/builtins/local-network/index.ts',
    'builtins/local-network/local-network.addon':
      'src/builtins/local-network/local-network.addon.ts',
    // Backend-only orchestrator for the network-access collection cap.
    'builtins/remote-access-orchestrator/index': 'src/builtins/remote-access-orchestrator/index.ts',
    'builtins/remote-access-orchestrator/remote-access-orchestrator.addon':
      'src/builtins/remote-access-orchestrator/remote-access-orchestrator.addon.ts',
    // `addon-runner` is NOT an entry here: it has its own build,
    // `vite.runner.config.ts` ("The forked runner has its own build", below).
    // Worker-thread entry for the WAL checkpoint (D452). Top-level for the
    // same reason as `addon-runner`: `wal-checkpointer.ts` resolves it as
    // `<package root>/dist/wal-checkpoint-worker.js` through the package's
    // own `exports["./package.json"]`, so the path is the same from the
    // workspace and from an installed closure. It imports `better-sqlite3`
    // and the pure policy module, nothing from the kernel.
    'wal-checkpoint-worker': 'src/builtins/sqlite-storage/wal-checkpoint-worker.ts',
    // Worker-thread entry for the owner's database snapshot (D693). Top-level
    // for the same reason; `sqlite-snapshotter.ts` resolves it as
    // `<package root>/dist/sqlite-snapshot-worker.js`. It imports
    // `better-sqlite3` and the pure protocol module, nothing from the kernel.
    'sqlite-snapshot-worker': 'src/builtins/sqlite-storage/sqlite-snapshot-worker.ts',
    // Worker-thread entry that serves one non-settings database file
    // (`events.db`, `history.db` — D851). Top-level for the same reason;
    // `file-host-client.ts` resolves it as `<package root>/dist/file-host-worker.js`.
    // It imports `better-sqlite3`, the engine's backend class and the pure
    // protocol module, nothing from the kernel.
    'file-host-worker': 'src/builtins/sqlite-storage/file-host-worker.ts',
    // Worker-thread entry of the rotated-file log reader (D898). Top-level for
    // the same reason; `log-file-read-client.ts` resolves it as
    // `<package root>/dist/log-file-read-worker.js`. It imports the index, the
    // reader and the shared line filter, nothing from the kernel.
    'log-file-read-worker': 'src/builtins/winston-logging/log-file-read-worker.ts',
  },
  externals: 'framework',
  // Bundle the BARE `@camstack/types` entry into system's dist (subpaths stay
  // external) so the hub sources its cap-derived runtime symbols
  // (ALL_CAPABILITY_DEFINITIONS, METHOD_ACCESS_MAP, …) from `@camstack/system`.
  // `camstack deploy packages/system` then refreshes the hub's capability
  // surface with no new server image, and `@camstack/types` is never deployed
  // to the hub. See tools/build/vite-lib.preset.ts.
  bundleTypesMainEntry: true,
  extraExternals: SYSTEM_EXTRA_EXTERNALS,
})

/**
 * The forked runner has its own build (D28).
 *
 * `dist/addon-runner.{js,mjs}` is built by `vite.runner.config.ts`, a
 * single-entry build with `inlineDynamicImports`, run AFTER this one
 * (`emptyOutDir: false`; see the package `build` script). The entry list above
 * is a multi-entry build and rolldown shares chunks between entries however
 * `manualChunks` is set: the runner used to `require()` the same
 * `child-cap-dispatch-*` / `custom-action-registry-*` chunks the hub does, so
 * ANY hub-only module that touched the `@camstack/types` barrel (inlined here
 * by `bundleTypesMainEntry`) could land in a chunk the runner then loaded -
 * 2.4 MB, ~2,500 schema calls, ~90-115 MB of private heap in EVERY forked
 * runner (52 on the live hub). In its own build the runner file holds only
 * what the runner's own import graph reaches, so hub code cannot leak in.
 *
 * Rules that keep it so:
 *   - a new forked-child entry (anything `process-service` forks) gets its own
 *     `vite.<name>.config.ts` run by the `build` script, never a line in `entries`;
 *   - the runner's import graph uses `@camstack/types/addon` (or `/node`,
 *     `/enums`), never the bare barrel: `scripts/check-runner-barrel-free.ts`
 *     reads the source, `scripts/check-runner-dist-barrel-free.ts` reads the
 *     BUILT file and measures the heap (it runs in ci.yml after the build).
 */

// Declarations are emitted by `scripts/tsc7 -p tsconfig.dts.json` after
// `vite build` (P2, docs/design/2026-10-09-ts7-transition-plan.md) — not by
// vite-plugin-dts (TS 6 API, in-process heap).
export default defineConfig(base)
