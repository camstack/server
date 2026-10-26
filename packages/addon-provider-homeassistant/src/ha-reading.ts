import { ingestReading, type IScopedLogger, type ReadingQuantity } from '@camstack/types'

/**
 * Convert one sample into the quantity's base unit. A refusal publishes
 * nothing (the caller stores null) and is logged with the device id —
 * an unknown unit is never guessed (D393, D944).
 */
export function takeReading(
  logger: IScopedLogger,
  deviceId: number,
  value: number,
  rawUnit: string | undefined,
  quantity: ReadingQuantity,
): number | null {
  const result = ingestReading({ value, rawUnit, quantity })
  if (result.ok) return result.value
  logger.warn('numeric reading refused', {
    tags: { deviceId },
    meta: { quantity, unit: rawUnit ?? '', reason: result.reason },
  })
  return null
}
