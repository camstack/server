/**
 * Converging the running block processes onto the stored blocks.
 *
 * Reconcile against the registry, not one-shot reactions to events: a spawn
 * that was missed because an event was dropped (D8 — events are telemetry) has
 * to be fixed by the next pass, and an operator restarting the hub must end up
 * with exactly the blocks the store says are enabled. So `converge()` is
 * idempotent and safe to call from a timer, from a write, and from boot.
 *
 * **The supervision itself is not in this file, and that is deliberate.** A
 * block that never returns is bounded by `process-service`'s `CrashSupervisor`
 * (D6) — the same circuit-breaker that bounds every addon. This class only
 * decides which runners should exist and translates their state back into
 * something the author can read. Re-implementing backoff here would be a second
 * supervisor to keep in step with the first.
 *
 * The invariant it exists to hold: **a block that is not running says why.**
 * Every path out of `converge()` that does not end in a live process writes a
 * status the operator can see, with the reason attached. A block that is
 * silently absent is the failure mode this whole feature has to avoid.
 */

import {
  COMPOSER_RUNNER_ID,
  type ComposerApplyInput,
  type ComposerApplyResult,
  type ComposerUnreadableBlock,
  type CoreBlock,
  coreBlockComposition,
  coreBlockSourceKind,
  errMsg,
  type IScopedLogger,
  resolveCoreBlockFiles,
  type UnreleasedClaim,
} from '@camstack/types'
import {
  blockAddonId,
  blockIdFromAddonId,
  materializeBlock,
  removeBlockPackage,
} from './block-package.js'

/** The runner lifecycle states `$process.list` reports. `stopping`/`stopped`
 *  are transient states of a runner on its way out and are treated as absent. */
export type BlockRunnerState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'failed'

export interface BlockRunnerSnapshot {
  /** The runner id — equal to the generated addon id for a block runner. */
  readonly name: string
  readonly state: BlockRunnerState
}

/**
 * The process plane, narrowed to the three things a block needs.
 *
 * Injected rather than reached for, so the decision logic above is testable
 * without a broker — and so the day a block runs on an agent, only this
 * implementation changes.
 */
export interface BlockProcessHost {
  list(): Promise<readonly BlockRunnerSnapshot[]>
  spawn(input: { runnerId: string; addonId: string; addonDir: string }): Promise<void>
  stop(runnerId: string): Promise<void>
}

export interface BlockCompileOutcome {
  readonly ok: boolean
  readonly error?: string
  readonly js?: string
}

export interface BlockCompileSource {
  readonly code: string
  readonly files?: Readonly<Record<string, string>>
  readonly entry?: string
}

/** The composer's one verb, as the supervisor needs it. */
export interface ComposerPort {
  apply(input: ComposerApplyInput): Promise<ComposerApplyResult>
}

interface ClaimReleaseReport {
  readonly error: string | null
  readonly unreleased: readonly UnreleasedClaim[]
}

export interface BlockSupervisorDeps {
  /** This node's id, already stripped of any `/<addon>` runner suffix. */
  readonly nodeId: string
  /** Where block packages are materialised — one directory per block. */
  readonly root: string
  readonly store: BlockStoreView
  readonly host: BlockProcessHost
  readonly compile: (source: BlockCompileSource) => Promise<BlockCompileOutcome>
  readonly logger: IScopedLogger
  /** Null when this node exposes no composer, and then every composition says so. */
  readonly composer: ComposerPort | null
  /** The shared Blocks integration, null until it has reconciled. */
  readonly integrationId: () => string | null
  /** False while the `core_blocks` read has not succeeded — the composer then withdraws nothing (D49). */
  readonly storeLoaded: () => boolean
  /** Re-read `core_blocks`. Called by a converge while `storeLoaded()` is false — the converge IS the retry (D3). Never throws. */
  readonly loadStore: () => Promise<void>
}

/** The slice of `CoreBlockStore` the supervisor uses. */
export interface BlockStoreView {
  list(): readonly CoreBlock[]
  get(blockId: string): CoreBlock | null
  /** Stored composition rows that do not parse: sent to the composer so their devices are held (D49). */
  unreadableCompositions(): readonly ComposerUnreadableBlock[]
  setStatus(blockId: string, status: CoreBlock['status'], error?: string): Promise<void>
}

/** Runner state → what the author should read. `crashed` is the window between
 *  an exit and the scheduled respawn, so it reads as `starting` with the reason
 *  attached rather than as a terminal failure it is not. */
const RUNNER_STATE_TO_STATUS: Readonly<Record<BlockRunnerState, CoreBlock['status'] | null>> = {
  starting: 'starting',
  running: 'running',
  crashed: 'starting',
  failed: 'failed',
  // A runner on its way out is not a state the block should report — the next
  // pass sees it gone and reports `stopped`.
  stopping: null,
  stopped: null,
}

export class BlockSupervisor {
  private readonly deps: BlockSupervisorDeps
  /**
   * `blockId → updatedAt` of the source this supervisor last materialised.
   * The only way to know a running block is running YESTERDAY'S code: the
   * process is alive either way, and nothing on disk carries the version.
   * In-memory is correct — a hub restart takes every child with it.
   */
  private readonly materialized = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  /** Serialises passes so a timer tick cannot interleave with a write-driven
   *  converge and spawn the same runner twice. */
  private inFlight: Promise<void> = Promise.resolve()
  /** Composition restarts not yet delivered to the composer. Stores nothing durable (D62). */
  private pendingCompositionRestarts: ReadonlySet<string> = new Set()
  /**
   * Empty applies still owed: the composer withdraws only after TWO agree
   * (D49), and a boot sends one. Only an apply the composer says it ACTED on
   * (`result.acted`) pays one off — it can refuse with the store loaded.
   */
  private emptyAppliesOwed = 2
  /** Consecutive applies that could not reach the composer: warned once per run. */
  private failedApplies = 0
  /** Composition ids the operator deleted. Passed until their claims are released. */
  private retiredBlockIds: ReadonlySet<string> = new Set()
  /** What the last composition apply said about claim releases. */
  private releaseReport: ClaimReleaseReport = { error: null, unreleased: [] }

  constructor(deps: BlockSupervisorDeps) {
    this.deps = deps
  }

  /** Start the reconcile timer. The first pass runs immediately. */
  start(intervalMs: number): void {
    if (this.timer !== null) return
    void this.converge()
    this.timer = setInterval(() => void this.converge(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** One reconcile pass. Never throws — a pass that failed must not stop the
   *  next one, and the reason belongs in the log, not in a rejected promise
   *  nobody awaits. */
  converge(): Promise<void> {
    this.inFlight = this.inFlight.then(
      () => this.runPass(),
      () => this.runPass(),
    )
    return this.inFlight
  }

  /**
   * Stop one block's runner and let the pass that follows bring it back.
   *
   * The same path a code change already takes (see `stale` in `reconcile`),
   * exposed on purpose. It writes NO state of its own: forgetting the
   * materialised `updatedAt` is what makes the next pass treat the block as
   * needing a launch, and that pass is still the authority — so a restart that
   * raced a converge ends with one runner, not two.
   *
   * Queued on the same chain as `converge()`: a restart that interleaved with a
   * timer tick could stop a runner the tick had just decided was healthy and
   * then never re-launch it.
   */
  /**
   * The block row is already gone. The next apply names it retired so its
   * claims are released before this resolves. A release that does not land is
   * returned; the id stays retired so the following pass tries again.
   */
  retireComposition(blockId: string): Promise<readonly UnreleasedClaim[]> {
    this.retiredBlockIds = new Set([...this.retiredBlockIds, blockId])
    return this.converge().then(() => this.claimsOf(blockId))
  }

  /**
   * One apply, awaited. Used when an edit replaced a block's caps: the
   * composer releases what the new plan dropped before this resolves.
   */
  convergeForClaims(): Promise<readonly UnreleasedClaim[]> {
    if (this.deps.composer === null) {
      return Promise.reject(
        new Error('core-blocks: no composer is available — a replaced claim cannot be released'),
      )
    }
    return this.converge().then(() => {
      if (this.releaseReport.error !== null) {
        throw new Error(
          `core-blocks: a replaced claim was not released — ${this.releaseReport.error}`,
        )
      }
      return this.releaseReport.unreleased
    })
  }

  restart(blockId: string): Promise<void> {
    const block = this.deps.store.get(blockId)
    if (block !== null && coreBlockSourceKind(block) === 'composition') {
      // No runner of its own to stop: the composer rebuilds its runtime on the
      // next apply, which this converge sends.
      this.pendingCompositionRestarts = new Set([...this.pendingCompositionRestarts, blockId])
      return this.converge()
    }
    this.inFlight = this.inFlight.then(
      () => this.runRestart(blockId),
      () => this.runRestart(blockId),
    )
    return this.inFlight
  }

  private async runRestart(blockId: string): Promise<void> {
    try {
      await this.deps.host.stop(blockAddonId(blockId))
      this.deps.logger.info('core block runner stopped for restart', { meta: { blockId } })
    } catch (err) {
      // A runner that was not there is already the state the stop wanted; the
      // pass below is what starts it. Logged either way — a restart that only
      // half happened must not be inferred from a block that stayed stopped.
      this.deps.logger.warn('could not stop the core block runner before restart', {
        meta: { blockId, error: err instanceof Error ? err.message : String(err) },
      })
    }
    this.materialized.delete(blockId)
    await this.runPass()
  }

  private async runPass(): Promise<void> {
    try {
      await this.reconcile()
    } catch (err) {
      this.deps.logger.error('core-blocks converge failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private async reconcile(): Promise<void> {
    if (!this.deps.storeLoaded()) await this.deps.loadStore()
    const blocks = this.deps.store.list()
    // Only CODE blocks get a runner of their own. A composition goes to the
    // composer (below); a recipe is refused by name.
    const mine = blocks.filter(
      (b) => b.enabled && this.isPlacedHere(b) && coreBlockSourceKind(b) === 'code',
    )
    const snapshots = await this.deps.host.list()
    const runners = new Map(
      snapshots
        .map((r) => [blockIdFromAddonId(r.name), r] as const)
        .filter((pair): pair is readonly [string, BlockRunnerSnapshot] => pair[0] !== null),
    )

    // 1. An enabled block somebody put on a node that runs no supervisor is
    //    not idle — nothing anywhere will start it. Say so.
    for (const block of blocks) {
      if (!block.enabled || this.isPlacedHere(block)) continue
      await this.report(
        block.id,
        'failed',
        `no core-block supervisor runs on "${block.placement}" — this block is not running anywhere. ` +
          `Move it to "${this.deps.nodeId}" to run it.`,
      )
    }

    // 2. Tear down every block runner that should not be up: disabled, moved,
    //    or deleted outright (the store knows nothing about it, so its own
    //    runner name is the only handle on it).
    const wanted = new Set(mine.map((b) => b.id))
    for (const [blockId, runner] of runners) {
      if (wanted.has(blockId)) continue
      this.deps.logger.info('stopping core block runner', {
        meta: { blockId, runnerState: runner.state, reason: this.stopReason(blockId) },
      })
      await this.deps.host.stop(blockAddonId(blockId))
      this.materialized.delete(blockId)
      const stillExists = this.deps.store.get(blockId) !== null
      if (stillExists) {
        await this.report(blockId, 'stopped')
      } else {
        await removeBlockPackage(this.deps.root, blockId)
      }
    }

    for (const block of blocks) {
      if (block.enabled && coreBlockSourceKind(block) === 'recipe') {
        await this.report(
          block.id,
          'failed',
          'a recipe block cannot run yet — recipes are stored, not executed, in this release',
        )
      }
    }

    // 3. Bring every wanted block to a live runner, and read back the state of
    //    the ones that already are.
    for (const block of mine) {
      const runner = runners.get(block.id)
      const stale = runner !== undefined && this.materialized.get(block.id) !== block.updatedAt
      if (runner !== undefined && !stale) {
        await this.reportRunnerState(block, runner)
        continue
      }
      if (stale) {
        this.deps.logger.info('core block code changed — restarting its runner', {
          meta: { blockId: block.id, name: block.name },
        })
        await this.deps.host.stop(blockAddonId(block.id))
        this.materialized.delete(block.id)
      }
      await this.launch(block)
    }

    // 4. Compositions: the whole set, every pass (idempotent), to the composer.
    await this.convergeCompositions(blocks, snapshots)
  }

  /**
   * Send every composition placed here to the composer and mirror its verdicts
   * into the block status, reason verbatim. A `starting` verdict (the composer
   * does not trust its store or seed yet) is mirrored as `starting`; the next
   * pass of this same converge is the retry — no timer of its own (D3).
   */
  private async convergeCompositions(
    blocks: readonly CoreBlock[],
    runners: readonly BlockRunnerSnapshot[],
  ): Promise<void> {
    const compositions = blocks.flatMap((block) => {
      const composition = coreBlockComposition(block)
      return composition !== null && this.isPlacedHere(block) ? [{ block, composition }] : []
    })
    // An unreadable composition is NOT absent: it is sent every pass, so its
    // device is held and its failure named (D49).
    const unreadable = this.deps.store.unreadableCompositions()
    const nothingToSay = compositions.length === 0 && unreadable.length === 0
    if (nothingToSay && this.emptyAppliesOwed === 0 && this.retiredBlockIds.size === 0) return
    const composer = this.deps.composer
    if (composer === null) {
      if (this.retiredBlockIds.size > 0) {
        this.releaseReport = {
          error: 'no composer is available on this node — claims cannot be released',
          unreleased: [],
        }
      }
      for (const { block } of compositions) {
        await this.report(
          block.id,
          'failed',
          'no composer is available on this node — a composition cannot run here',
        )
      }
      return
    }
    if (runners.find((r) => r.name === COMPOSER_RUNNER_ID)?.state === 'failed') {
      for (const { block } of compositions) {
        await this.report(
          block.id,
          'failed',
          "the composer runner's crash circuit-breaker tripped — no composition runs until it is restarted",
        )
      }
      return
    }
    const restart = this.pendingCompositionRestarts
    const integrationId = this.deps.integrationId()
    const storeLoaded = this.deps.storeLoaded()
    try {
      const result = await composer.apply({
        integrationId,
        storeLoaded,
        blocks: compositions.map(({ block, composition }) => ({
          id: block.id,
          name: block.name,
          enabled: block.enabled,
          updatedAt: block.updatedAt,
          composition,
        })),
        restartBlockIds: [...restart],
        unreadableBlocks: [...unreadable],
        retiredBlockIds: [...this.retiredBlockIds],
      })
      if (this.failedApplies > 0) {
        this.deps.logger.info('the composer answered again', {
          meta: { failedApplies: this.failedApplies },
        })
        this.failedApplies = 0
      }
      this.pendingCompositionRestarts = new Set(
        [...this.pendingCompositionRestarts].filter((id) => !restart.has(id)),
      )
      this.emptyAppliesOwed =
        !nothingToSay || !result.acted ? 2 : Math.max(0, this.emptyAppliesOwed - 1)
      this.noteRelease(result)
      const verdicts = new Map(result.blocks.map((v) => [v.blockId, v]))
      for (const { block } of compositions) {
        const verdict = verdicts.get(block.id)
        if (verdict === undefined) {
          await this.report(block.id, 'starting', 'the composer did not answer for this block')
        } else {
          await this.report(block.id, verdict.status, verdict.reason)
        }
      }
    } catch (err: unknown) {
      // An unreachable composer tells us NOTHING about a block (D49): a status
      // already reported stays. Only a block never reported learns it is waiting.
      const error = errMsg(err)
      this.releaseReport = { error, unreleased: [] }
      this.failedApplies += 1
      if (this.failedApplies === 1) {
        this.deps.logger.warn(
          'the composer could not be reached — compositions keep their last status',
          { meta: { error, compositions: compositions.length } },
        )
      }
      for (const { block } of compositions) {
        if (block.status === 'stopped' && block.enabled) {
          await this.report(block.id, 'starting', `the composer is not reachable yet: ${error}`)
        }
      }
    }
  }

  private claimsOf(blockId: string): readonly UnreleasedClaim[] {
    if (this.releaseReport.error !== null) {
      throw new Error(
        `core-blocks: claims of "${blockId}" were not released — ${this.releaseReport.error}`,
      )
    }
    return this.releaseReport.unreleased.filter((claim) => claim.owner === blockId)
  }

  /** Remember which retired ids still hold a claim. An apply that did not act keeps every id. */
  private noteRelease(result: ComposerApplyResult): void {
    const unreleased = result.unreleasedClaims ?? []
    if (!result.acted) {
      this.releaseReport = {
        error: 'the composer did not apply — claims stay until it does',
        unreleased,
      }
      return
    }
    this.releaseReport = { error: null, unreleased }
    const failed = new Set(unreleased.map((claim) => claim.owner))
    this.retiredBlockIds = new Set([...this.retiredBlockIds].filter((id) => failed.has(id)))
  }

  /** Compile, write the package, spawn. Each failure is reported ON the block
   *  — the author asked for this to run, so they are owed the reason it does
   *  not. */
  private async launch(block: CoreBlock): Promise<void> {
    const { files, entry } = resolveCoreBlockFiles(block)
    const compiled = await this.deps.compile({ code: block.code, files, entry })
    if (!compiled.ok || compiled.js === undefined) {
      await this.report(
        block.id,
        'failed',
        `the block does not compile: ${compiled.error ?? 'unknown'}`,
      )
      return
    }
    try {
      const pkg = await materializeBlock({
        root: this.deps.root,
        blockId: block.id,
        blockName: block.name,
        js: compiled.js,
        files,
        settingsSchema: block.settingsSchema,
      })
      await this.deps.host.spawn({
        runnerId: pkg.addonId,
        addonId: pkg.addonId,
        addonDir: pkg.addonDir,
      })
      this.materialized.set(block.id, block.updatedAt)
      this.deps.logger.info('core block runner spawned', {
        meta: { blockId: block.id, name: block.name, runnerId: pkg.addonId },
      })
      await this.report(block.id, 'starting')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A runner that is already up is the outcome we wanted, reached by
      // somebody else — a converge that raced a write, most often. Reporting
      // `failed` there would tell the operator their running block is broken.
      // Same tolerance `ensureForkedRunner` applies to addons.
      if (/already running/i.test(message)) {
        this.materialized.set(block.id, block.updatedAt)
        await this.report(block.id, 'starting')
        return
      }
      this.deps.logger.error('core block failed to start', {
        meta: { blockId: block.id, name: block.name, error: message },
      })
      await this.report(block.id, 'failed', `could not start the block: ${message}`)
    }
  }

  private async reportRunnerState(block: CoreBlock, runner: BlockRunnerSnapshot): Promise<void> {
    const status = RUNNER_STATE_TO_STATUS[runner.state]
    if (status === null) return
    if (runner.state === 'failed') {
      await this.report(
        block.id,
        'failed',
        'the crash circuit-breaker tripped — the block crashed repeatedly and will not be respawned. ' +
          'Fix it and save, or disable and re-enable it.',
      )
      return
    }
    if (runner.state === 'crashed') {
      await this.report(block.id, 'starting', 'the block crashed — a respawn is scheduled')
      return
    }
    await this.report(block.id, status)
  }

  /**
   * Write a status only when it actually changed.
   *
   * A reconcile pass runs on a timer, and every write rewrites the row AND
   * moves `lastChangedAt` — which is the only thing telling an operator WHEN a
   * block last did something. Rewriting it every tick would make it read as
   * "just now", forever.
   */
  private async report(
    blockId: string,
    status: CoreBlock['status'],
    error?: string,
  ): Promise<void> {
    const current = this.deps.store.get(blockId)
    if (current !== null && current.status === status && current.lastError === error) return
    await this.deps.store.setStatus(blockId, status, error)
  }

  private isPlacedHere(block: CoreBlock): boolean {
    return block.placement === this.deps.nodeId
  }

  private stopReason(blockId: string): string {
    const block = this.deps.store.get(blockId)
    if (block === null) return 'deleted'
    if (!block.enabled) return 'disabled'
    return `moved to "${block.placement}"`
  }
}
