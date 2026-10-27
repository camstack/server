import { ingestReading, type IScopedLogger, type ReadingQuantity } from '@camstack/types'

/**
 * Convert one board sample into the quantity's base unit. A refusal publishes
 * nothing (the caller keeps the previous reading) and is logged with the device
 * id: an unknown unit is never guessed and a failed measurement is never 0
 * (D393, D944).
 */
export function takeReading(
  logger: IScopedLogger,
  deviceId: number,
  value: number | null,
  rawUnit: string | undefined,
  quantity: ReadingQuantity,
): number | null {
  if (value === null) return null
  const result = ingestReading({ value, rawUnit, quantity })
  if (result.ok) return result.value
  logger.warn('esphome: numeric reading refused', {
    tags: { deviceId },
    meta: { quantity, unit: rawUnit ?? '', reason: result.reason },
  })
  return null
}
