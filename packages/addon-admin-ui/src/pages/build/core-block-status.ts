/**
 * How a core block's state is presented.
 *
 * The whole feature rests on one invariant: **a block that is not running says
 * why.** The runner already guarantees the data — every path that does not end
 * in a live process writes a status with its reason — so this file's only job
 * is to not throw that away on the way to the screen.
 *
 * Pure, so the rules can be tested without mounting a page.
 */

import type { CoreBlock } from '@camstack/types'
import i18n from '../../i18n/index'

export type BlockTone = 'ok' | 'pending' | 'error' | 'idle'

export interface BlockStatusView {
  readonly tone: BlockTone
  /** i18n-free short label for the badge. */
  readonly label: string
  /**
   * The line under the badge. NEVER empty for a block that should be running
   * and is not — that silence is the failure this whole surface exists to
   * prevent.
   */
  readonly detail: string
}

/**
 * A block that is DISABLED reads as idle, not as broken: the operator turned it
 * off and the status field may still hold whatever it last was.
 *
 * A block that is ENABLED and not running is an ERROR even when its status says
 * `stopped` — the supervisor should have started it, so "stopped" there means
 * something did not happen and nobody said so.
 */
export function describeBlockStatus(block: CoreBlock): BlockStatusView {
  if (!block.enabled) {
    return {
      tone: 'idle',
      label: i18n.t('helpers.coreBlockStatus.disabled'),
      detail: i18n.t('helpers.coreBlockStatus.disabledDetail'),
    }
  }
  switch (block.status) {
    case 'running':
      return {
        tone: 'ok',
        label: i18n.t('helpers.coreBlockStatus.running'),
        detail: i18n.t('helpers.coreBlockStatus.runningDetail'),
      }
    case 'starting':
      return {
        tone: 'pending',
        label: i18n.t('helpers.coreBlockStatus.starting'),
        detail: block.lastError ?? i18n.t('helpers.coreBlockStatus.startingDetail'),
      }
    case 'failed':
      return {
        tone: 'error',
        label: i18n.t('helpers.coreBlockStatus.failed'),
        detail: block.lastError ?? i18n.t('helpers.coreBlockStatus.failedDetail'),
      }
    default:
      // `stopped` while ENABLED. Not a resting state: the supervisor converges
      // enabled blocks, so this means a pass has not run yet or did not reach
      // this block.
      return {
        tone: 'error',
        label: i18n.t('helpers.coreBlockStatus.notRunning'),
        detail: block.lastError ?? i18n.t('helpers.coreBlockStatus.notRunningDetail'),
      }
  }
}

/**
 * Which `Badge` variant a tone renders as.
 *
 * Here rather than inline in the row so the mapping is asserted: `idle` and
 * `error` differing only by a colour name is exactly the kind of thing a
 * refactor collapses, and a failed block rendering in the neutral grey of a
 * disabled one is the failure this surface exists to prevent.
 */
export type BlockBadgeVariant = 'default' | 'success' | 'warning' | 'danger'

export function badgeVariantForTone(tone: BlockTone): BlockBadgeVariant {
  switch (tone) {
    case 'ok':
      return 'success'
    case 'pending':
      return 'warning'
    case 'error':
      return 'danger'
    default:
      return 'default'
  }
}

/**
 * The fresher of the two views of one block, by the server's own `updatedAt`.
 *
 * Neither view alone is right. The polled list is what moves the status badge,
 * so a frozen copy of a block would read `starting` forever — but the list is up
 * to one poll behind a save, and an editor that gates on "does the screen match
 * what the server stored" would keep refusing for five seconds after a
 * successful save, telling the operator their save did not take. `updatedAt` is
 * the tiebreak, and it is the server's own stamp.
 *
 * Here rather than in one tab because both editors on this page need it, and two
 * copies of a freshness rule is how they end up disagreeing.
 */
export function freshest(listed: readonly CoreBlock[], held: CoreBlock): CoreBlock {
  const fromList = listed.find((b) => b.id === held.id)
  if (fromList === undefined) return held
  return fromList.updatedAt >= held.updatedAt ? fromList : held
}

/** Blocks the operator most needs to look at, first. */
export function sortBlocksForDisplay(blocks: readonly CoreBlock[]): CoreBlock[] {
  const rank = (b: CoreBlock): number => {
    const tone = describeBlockStatus(b).tone
    if (tone === 'error') return 0
    if (tone === 'pending') return 1
    if (tone === 'ok') return 2
    return 3
  }
  return [...blocks].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** A one-line summary for the page header — so a failure is visible before any
 *  row is read. */
export function summariseBlocks(blocks: readonly CoreBlock[]): string {
  if (blocks.length === 0) return i18n.t('helpers.coreBlockStatus.noBlocks')
  const failed = blocks.filter((b) => describeBlockStatus(b).tone === 'error').length
  const running = blocks.filter((b) => describeBlockStatus(b).tone === 'ok').length
  const parts = [i18n.t('helpers.coreBlockStatus.blocks', { count: blocks.length })]
  if (running > 0) parts.push(i18n.t('helpers.coreBlockStatus.runningCount', { count: running }))
  if (failed > 0) parts.push(i18n.t('helpers.coreBlockStatus.notRunningCount', { count: failed }))
  return parts.join(' · ')
}
