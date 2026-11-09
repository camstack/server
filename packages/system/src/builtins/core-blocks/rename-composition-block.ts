/**
 * An operator rename of a composed device writes the composition block's
 * name, so the next composer apply does not put the old name back (D659).
 * Name-only: the composition body is not touched, and a customization (which
 * has no name of its own) is never a composed device.
 */
import {
  COMPOSER_ADDON_ID,
  COMPOSED_DEVICE_STABLE_ID_PREFIX,
  type AddonApi,
  type CompositionGetRead,
  errMsg,
  type IScopedLogger,
} from '@camstack/types'

/** `CoreBlockSchema` / `ComposerBlockSchema` name max. A longer device name cannot be stored on the block. */
const BLOCK_NAME_MAX = 120

/** The block id behind a composed device, or null when the row is not one. */
export function composedBlockIdOf(addonId: string, stableId: string): string | null {
  if (addonId !== COMPOSER_ADDON_ID) return null
  if (!stableId.startsWith(COMPOSED_DEVICE_STABLE_ID_PREFIX)) return null
  const blockId = stableId.slice(COMPOSED_DEVICE_STABLE_ID_PREFIX.length)
  return blockId.length === 0 ? null : blockId
}

interface BlockNameRead {
  readonly name: string
  readonly updatedAt: number
}

type BlockNameLookup =
  | { readonly kind: 'ready'; readonly block: BlockNameRead }
  | { readonly kind: 'skip'; readonly reason: string }

function lookupBlockName(read: CompositionGetRead, blockId: string): BlockNameLookup {
  if (read.state === 'not-loaded') {
    return { kind: 'skip', reason: 'core_blocks has not loaded' }
  }
  if (read.view === null) return { kind: 'skip', reason: `no composition "${blockId}"` }
  return {
    kind: 'ready',
    block: { name: read.view.block.name, updatedAt: read.view.block.updatedAt },
  }
}

async function writeBlockName(
  api: AddonApi,
  blockId: string,
  name: string,
): Promise<BlockNameLookup> {
  const read = await api.coreBlocks.getComposition.query({ blockId })
  const found = lookupBlockName(read, blockId)
  if (found.kind === 'skip' || found.block.name === name) return found
  await api.coreBlocks.updateComposition.mutate({
    blockId,
    expectedUpdatedAt: found.block.updatedAt,
    block: { name },
  })
  return found
}

/**
 * Make the stored block name `name`. A conflict with a save that landed
 * between the read and the write is retried once. A failure is logged and
 * swallowed: the device rename has already landed, and the composer's next
 * apply writes the block again.
 */
export async function renameCompositionBlock(
  api: AddonApi,
  logger: IScopedLogger,
  deviceId: number,
  blockId: string,
  name: string,
): Promise<void> {
  if (name.length < 1 || name.length > BLOCK_NAME_MAX) {
    logger.warn(
      'composed rename did not reach the block — the name is outside what a block stores',
      {
        tags: { deviceId },
        meta: { blockId, length: name.length },
      },
    )
    return
  }
  try {
    const found = await writeBlockName(api, blockId, name)
    if (found.kind === 'skip') {
      logger.warn('composed rename did not reach the block — retried on the next apply', {
        tags: { deviceId },
        meta: { blockId, reason: found.reason },
      })
    }
  } catch (err: unknown) {
    const message = errMsg(err)
    if (!message.includes('changed since you read it')) {
      logBlockRenameFailed(logger, deviceId, blockId, message)
      return
    }
    try {
      const found = await writeBlockName(api, blockId, name)
      if (found.kind === 'skip') {
        logger.warn('composed rename did not reach the block — retried on the next apply', {
          tags: { deviceId },
          meta: { blockId, reason: found.reason },
        })
      }
    } catch (retryErr: unknown) {
      logBlockRenameFailed(logger, deviceId, blockId, errMsg(retryErr))
    }
  }
}

function logBlockRenameFailed(
  logger: IScopedLogger,
  deviceId: number,
  blockId: string,
  error: string,
): void {
  logger.warn('composed rename did not reach the block — retried on the next apply', {
    tags: { deviceId },
    meta: { blockId, error },
  })
}
