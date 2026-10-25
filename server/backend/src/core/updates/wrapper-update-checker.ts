/**
 * WrapperUpdateChecker — the fifth sweep target: is the SHELL this node runs
 * inside behind the release contract?
 *
 * ## Why it is not the fourth one
 *
 * `applyServerUpdate` swaps the data-root closure and NEVER touches the image.
 * On 2026-08-02 the hub's `runningVersion` was perfectly current while it ran
 * `camstack-server:intel-1.1.74` — a 13-day-old image from a repository that
 * had been renamed and received no builds. `checkNodeServerUpdate` answered
 * "up to date" and was right about the code. "Is my code current" and "is my
 * shell current" are two questions.
 *
 * ## What it publishes, and what it refuses to publish
 *
 * The verdict already exists: `assessImageContract` compares the baked seed —
 * the one image fingerprint readable from inside a container — against the
 * release the contract delivers. This adds nothing to it. It adds the WHO
 * (`WrapperIdentity.kind`), because that is what turns "behind" into an
 * instruction, and it puts both on the wire through the same
 * {@link UpdateAvailabilityEmitter} the other four targets use, so dedup and
 * durability stay in one place.
 *
 * Three outcomes, and the difference between them is the whole point:
 *
 *  - **`behind-patch` / `behind-series`** → publish the row.
 *  - **`in-sync`** → publish an EMPTY snapshot, which clears any standing
 *    announcement. This is the only case where "nothing available" is a fact.
 *  - **`unknown` / `ahead`** → publish NOTHING, and log it. Neither verdict
 *    knows anything; an empty snapshot here would clear the dedup state and
 *    read as "the image is fine", which is the fake green this whole path
 *    exists to kill.
 *
 * A node that cannot answer at all REJECTS, so `UpdateCheckScheduler.attempt`
 * records it as a failed check. A failed check is an error, never "no update".
 */
import type { IScopedLogger, ServerPackageStatus } from '@camstack/types'
import type {
  UpdateAvailabilityEmitter,
  UpdateAvailablePayload,
} from '../update-availability-emitter.js'

/**
 * The availability row's package name. A shell is not an npm package, but the
 * emitter keys dedup on `(target, node, packageName)` and a stable literal is
 * what makes "one shell per node" the dedup slot. Never rendered: the
 * notification body is chosen from the wrapper KIND.
 */
export const WRAPPER_PACKAGE_NAME = 'camstack-wrapper'

export interface WrapperUpdateCheckerOptions {
  readonly emitter: UpdateAvailabilityEmitter
  readonly logger: IScopedLogger
  /** The node's own `getServerPackageStatus` — locally on the hub, over the
   *  `server-management` proxy on an agent. Rejecting is the honest answer. */
  readonly readStatus: (nodeId: string, isHub: boolean) => Promise<ServerPackageStatus>
}

export class WrapperUpdateChecker {
  private readonly emitter: UpdateAvailabilityEmitter
  private readonly logger: IScopedLogger
  private readonly readStatus: (nodeId: string, isHub: boolean) => Promise<ServerPackageStatus>

  constructor(options: WrapperUpdateCheckerOptions) {
    this.emitter = options.emitter
    this.logger = options.logger
    this.readStatus = options.readStatus
  }

  async check(nodeId: string, isHub: boolean): Promise<void> {
    const status = await this.readStatus(nodeId, isHub)
    const wrapper = status.wrapper
    const contract = status.imageContract
    if (wrapper === undefined || contract === undefined) {
      // Version skew: this node's `@camstack/server` predates the wrapper
      // field. Unanswerable, so it is an ERROR — reporting it as "no wrapper
      // update" would be a claim nothing checked.
      throw new Error(
        `node ${nodeId} reports no wrapper identity (server-management payload predates it)`,
      )
    }

    if (contract.state === 'in-sync') {
      // The one case where an empty snapshot is a fact rather than a guess.
      this.emitter.publishSnapshot('wrapper', [], nodeId)
      return
    }

    const seedVersion = contract.seedVersion
    const contractVersion = contract.contractVersion
    const behind = contract.state === 'behind-patch' || contract.state === 'behind-series'
    if (!behind || seedVersion === null || contractVersion === null) {
      // `unknown` (no seed, or no registry answer yet) and `ahead` (a stale
      // check) both mean "nothing was proved". Publishing an empty snapshot
      // would clear a standing announcement on no evidence at all.
      this.logger.warn('Wrapper check inconclusive — nothing published', {
        tags: { nodeId },
        meta: { state: contract.state, wrapperKind: wrapper.kind, seedVersion, contractVersion },
      })
      return
    }

    const candidate: UpdateAvailablePayload = {
      target: 'wrapper',
      packageName: WRAPPER_PACKAGE_NAME,
      // The SHELL's versions, not the running code's. `wrapper.currentVersion`
      // is what the shell says about ITSELF (an Electron app version), which
      // is not on the same scale as a release; the seed is, and the seed is
      // what `contractVersion` was compared against.
      currentVersion: seedVersion,
      latestVersion: contractVersion,
      nodeId,
      wrapperKind: wrapper.kind,
    }
    this.emitter.publishSnapshot('wrapper', [candidate], nodeId)
  }
}
