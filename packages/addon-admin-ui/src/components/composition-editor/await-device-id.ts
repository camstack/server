import { COMPOSED_DEVICE_STABLE_ID_PREFIX } from '@camstack/types'

export interface FleetRow {
  readonly id: number
  readonly stableId: string
}

async function deviceIdForBlock(
  blockId: string,
  read: () => Promise<readonly FleetRow[] | undefined>,
): Promise<number | null> {
  const stableId = `${COMPOSED_DEVICE_STABLE_ID_PREFIX}${blockId}`
  const rows = await read()
  return rows?.find((item) => item.stableId === stableId)?.id ?? null
}

const DEVICE_LOOKUP_ATTEMPTS = 10
const DEVICE_LOOKUP_DELAY_MS = 400

/**
 * `createComposition` answers with the block; its device registers a moment
 * later. Look it up by stable id until it is there, a bounded number of times.
 */
export async function awaitDeviceIdForBlock(
  blockId: string,
  read: () => Promise<readonly FleetRow[] | undefined>,
  delayMs: number = DEVICE_LOOKUP_DELAY_MS,
): Promise<number | null> {
  for (let attempt = 0; attempt < DEVICE_LOOKUP_ATTEMPTS; attempt += 1) {
    const id = await deviceIdForBlock(blockId, read)
    if (id !== null) return id
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
  }
  return null
}
