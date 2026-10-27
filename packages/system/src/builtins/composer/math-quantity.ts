/**
 * A sum or a difference of readings is a reading of the SAME quantity, so the
 * chart needs the unit its inputs have; a ratio is dimensionless (D944). The
 * save already refused mixed inputs, so the first input names the quantity.
 * Best effort: a failed read is logged and the device stays unit-less.
 */
import {
  type CompositionSourceRef,
  errMsg,
  type HelperSpec,
  type IScopedLogger,
  type ReadingQuantity,
} from '@camstack/types'

export interface MathQuantityBlock {
  readonly id: string
  readonly helper: HelperSpec | undefined
}

export interface MathQuantityPorts {
  readonly logger: IScopedLogger
  readonly sourceDeviceId: (ref: CompositionSourceRef) => number | null
  readonly deviceIdOf: (blockId: string) => number | null
  /** Absent in tests that predate the copy. */
  readonly sourceQuantity?: (deviceId: number) => Promise<ReadingQuantity | null>
  readonly adopt: (blockId: string, quantity: ReadingQuantity) => Promise<void>
}

async function quantityFor(
  block: MathQuantityBlock,
  ports: MathQuantityPorts,
): Promise<ReadingQuantity | null> {
  const helper = block.helper
  if (helper === undefined || helper.kind !== 'arithmetic') return null
  if (helper.op === 'ratio') return 'ratio'
  const first = helper.inputs[0]
  const read = ports.sourceQuantity
  if (first === undefined || read === undefined) return null
  const deviceId = ports.sourceDeviceId(first.source)
  if (deviceId === null) return null
  return read(deviceId)
}

export async function adoptMathQuantities(
  blocks: readonly MathQuantityBlock[],
  ports: MathQuantityPorts,
): Promise<void> {
  for (const block of blocks) {
    try {
      const quantity = await quantityFor(block, ports)
      if (quantity !== null) await ports.adopt(block.id, quantity)
    } catch (err: unknown) {
      const deviceId = ports.deviceIdOf(block.id)
      ports.logger.warn(
        'a math helper could not take its inputs’ quantity — the chart has no unit',
        {
          ...(deviceId === null ? {} : { tags: { deviceId } }),
          meta: { blockId: block.id, error: errMsg(err) },
        },
      )
    }
  }
}
