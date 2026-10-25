/**
 * ServerUpdateService — hub-side adapter over the SHARED `RootUpdateService`
 * (`@camstack/node-root`, bundled into `dist/server-root/index.js`).
 *
 * The single-copy stage/apply engine — stage a closure into `.staging-*`,
 * arm the pending-root-swap marker, restart — lives in the shared core so the
 * hub and the agent can never drift. This class only binds the hub's
 * parameters: the `@camstack/server` root spec, the `CAMSTACK_SERVER_*` env
 * markers, the `CAMSTACK_DATA` data-dir default and the running package.json.
 *
 * The starter (server/backend/src/starter.ts → shared `runNodeStarter`) owns
 * the OTHER half: applying the staged swap of the single `current/` copy at
 * boot + the one-time migration off the legacy multi-copy layout. There is no
 * probation boot / N-1 / auto-rollback (2026-07-18 collapse).
 *
 * Spec: docs/superpowers/specs/2026-07-18-single-framework-copy-collapse-design.md
 */
import * as path from 'node:path'
import type {
  IEventBus,
  IScopedLogger,
  RunnerBootCheck,
  ServerUpdateCheckResult,
  UpdateBlocker,
} from '@camstack/types'
import {
  HUB_ROOT_SPEC,
  type NpmExecFn,
  type RootRestartUpdate,
  RootUpdateService,
} from '../../server-root/index.js'
import { UpdateAvailabilityEmitter } from '../update-availability-emitter.js'
import type { IUpdateAvailabilityStore } from '../update-availability-store.js'
import {
  buildSystemEnsureNativePrebuilds,
  type EnsureNativePrebuildsFn,
} from './system-ensure-prebuilds.js'
import {
  buildSystemApplyClosurePatches,
  type ApplyClosurePatchesFn,
} from './system-apply-closure-patches.js'
import { buildSystemExecNpm } from './system-exec-npm.js'

export type { NpmExecFn }

export interface ServerUpdateServiceOptions {
  readonly logger: IScopedLogger
  /**
   * Graceful restart seam (AddonPackageService.restartServer in prod). The
   * second argument carries both versions of an update-driven restart — the
   * marker (and therefore the "Server aggiornato" notification) is only as
   * complete as what is forwarded here.
   */
  readonly restartServer: (requestedBy: string, update?: RootRestartUpdate) => void
  /** Overrides for tests. */
  readonly dataDir?: string
  readonly execNpm?: NpmExecFn
  readonly ensureNativePrebuilds?: EnsureNativePrebuildsFn
  readonly applyClosurePatches?: ApplyClosurePatchesFn
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
  /** package.json of the RUNNING @camstack/server copy (test override). */
  readonly runningPackageJsonPath?: string
  readonly eventBus?: IEventBus
  /** Moleculer node id of THIS process — stamped on availability events. */
  readonly nodeId?: string
  /**
   * Durable dedup state for `update.available`. Boot wiring supplies a
   * file-backed store so a hub restart does not re-announce a server update
   * the operator already saw; tests leave it out (RAM-only).
   */
  readonly updateAvailabilityStore?: IUpdateAvailabilityStore
  /** Pre-flight (D877): addons the target version would refuse to start on this node's data. */
  readonly updatePreflight?: (targetVersion: string) => Promise<readonly UpdateBlocker[]>
  /** The runner boot check (D877), served on the status. */
  readonly runnerBootCheck?: () => RunnerBootCheck | undefined
}

export class ServerUpdateService extends RootUpdateService {
  private readonly updateAvailability: UpdateAvailabilityEmitter | null
  private readonly nodeId: string | undefined

  constructor(options: ServerUpdateServiceOptions) {
    const dataDir = path.resolve(
      options.dataDir ??
        options.env?.['CAMSTACK_DATA'] ??
        process.env['CAMSTACK_DATA'] ??
        'camstack-data',
    )
    // Resolved before `super` so the base class can stamp `tags.nodeId` on
    // every line it emits — `this.nodeId` below is the same value, kept for
    // the availability emitter.
    const nodeId = options.nodeId ?? 'hub'
    super({
      spec: HUB_ROOT_SPEC,
      nodeId,
      envNames: {
        bootMode: 'CAMSTACK_SERVER_BOOT_MODE',
        activeVersion: 'CAMSTACK_SERVER_ACTIVE_VERSION',
        seedDir: 'CAMSTACK_SEED_SERVER_DIR',
      },
      logger: options.logger,
      restartServer: options.restartServer,
      dataDir,
      // dist/core/server-update/ → ../../../package.json = the running copy's
      // package.json (workspace server/backend OR the active/baked closure).
      runningPackageJsonPath:
        options.runningPackageJsonPath ?? path.resolve(__dirname, '..', '..', '..', 'package.json'),
      workspaceProbeDir: __dirname,
      // Default to the runNpm-backed adapter so a host without system npm (a
      // packaged desktop app with a bare bundled Node) can still stage a root
      // update. `cacheDir` mirrors AddonInstaller's `<dataDir>/addons/.npm-bootstrap`.
      execNpm:
        options.execNpm ??
        buildSystemExecNpm({
          cacheDir: path.join(dataDir, 'addons', '.npm-bootstrap'),
          logger: options.logger,
        }),
      // Fetch a missing `better-sqlite3` prebuild for the running ABI before the
      // native-prebuild validator refuses the swap (toolchain-less packaged
      // desktop). No-op on docker where the install already carried it.
      ensureNativePrebuilds:
        options.ensureNativePrebuilds ?? buildSystemEnsureNativePrebuilds(options.logger),
      // Apply the closure patches ourselves. npm 12 blocks the root package's
      // postinstall by default, and a silently-unpatched closure is refused by
      // the validator — an update that can never apply. Idempotent, so this
      // costs nothing where npm did run the lifecycle.
      applyClosurePatches:
        options.applyClosurePatches ?? buildSystemApplyClosurePatches(options.logger),
      env: options.env,
      now: options.now,
      ...(options.updatePreflight !== undefined
        ? { updatePreflight: options.updatePreflight }
        : {}),
      ...(options.runnerBootCheck !== undefined
        ? { runnerBootCheck: options.runnerBootCheck }
        : {}),
    })
    this.updateAvailability =
      options.eventBus !== undefined
        ? new UpdateAvailabilityEmitter(
            options.eventBus,
            { type: 'core', id: 'server-update-service' },
            options.updateAvailabilityStore,
          )
        : null
    this.nodeId = nodeId
  }

  override async checkServerUpdate(): Promise<ServerUpdateCheckResult> {
    const result = await super.checkServerUpdate()
    if (result.error !== null) return result
    const nodeId = this.nodeId
    this.updateAvailability?.publishSnapshot(
      'server',
      result.updateAvailable && result.runningVersion !== null && result.latestVersion !== null
        ? [
            {
              target: 'server',
              packageName: result.packageName,
              currentVersion: result.runningVersion,
              latestVersion: result.latestVersion,
              ...(nodeId !== undefined ? { nodeId } : {}),
            },
          ]
        : [],
      nodeId,
    )
    return result
  }
}
