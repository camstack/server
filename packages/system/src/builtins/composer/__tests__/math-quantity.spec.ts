import { describe, expect, it } from 'vitest'
import type {
  ArithmeticHelperSpec,
  HelperSpec,
  IScopedLogger,
  ReadingQuantity,
} from '@camstack/types'
import { adoptMathQuantities, type MathQuantityPorts } from '../math-quantity.js'

function reading(n: number) {
  return {
    source: { addonId: 'demo', stableId: `sensor-${n}` },
    cap: 'numeric-sensor',
    fieldPath: 'value',
  }
}

function arithmetic(op: ArithmeticHelperSpec['op']): ArithmeticHelperSpec {
  return { kind: 'arithmetic', op, inputs: [reading(1), reading(2)] }
}

function setup(over: Partial<MathQuantityPorts> = {}) {
  const warnings: { message: string; deviceId: unknown }[] = []
  const adopted: { blockId: string; quantity: ReadingQuantity }[] = []
  const asked: number[] = []
  const sink: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, extra) => {
      warnings.push({ message, deviceId: extra?.tags?.deviceId })
    },
    error: () => undefined,
    child: () => sink,
    withTags: () => sink,
  }
  const ports: MathQuantityPorts = {
    logger: sink,
    sourceDeviceId: (ref) => Number(ref.stableId.replace('sensor-', '')) + 100,
    deviceIdOf: () => 77,
    sourceQuantity: async (deviceId) => {
      asked.push(deviceId)
      return 'power'
    },
    adopt: async (blockId, quantity) => {
      adopted.push({ blockId, quantity })
    },
    ...over,
  }
  return { ports, warnings, adopted, asked }
}

function block(id: string, helper: HelperSpec | undefined) {
  return { id, helper }
}

describe('math helper quantity', () => {
  it('a sum and a difference carry the quantity their inputs report', async () => {
    const { ports, adopted } = setup()
    await adoptMathQuantities(
      [block('s', arithmetic('sum')), block('d', arithmetic('difference'))],
      ports,
    )
    expect(adopted).toEqual([
      { blockId: 's', quantity: 'power' },
      { blockId: 'd', quantity: 'power' },
    ])
  })

  it('a ratio is a plain number whatever its inputs measure, and reads nothing', async () => {
    const { ports, adopted, asked } = setup()
    await adoptMathQuantities([block('r', arithmetic('ratio'))], ports)
    expect(adopted).toEqual([{ blockId: 'r', quantity: 'ratio' }])
    expect(asked).toEqual([])
  })

  it('leaves other helpers and free compositions alone', async () => {
    const { ports, adopted } = setup()
    await adoptMathQuantities(
      [
        block('free', undefined),
        block('t', {
          kind: 'threshold',
          source: reading(1),
          high: 2,
          low: 1,
          onForMs: 0,
          offForMs: 0,
        }),
      ],
      ports,
    )
    expect(adopted).toEqual([])
  })

  it('says so, with the device id, when the input quantity cannot be read, and goes on', async () => {
    const { ports, adopted, warnings } = setup({
      sourceQuantity: async () => {
        throw new Error('hub busy')
      },
    })
    await adoptMathQuantities(
      [block('s', arithmetic('sum')), block('r', arithmetic('ratio'))],
      ports,
    )
    expect(adopted).toEqual([{ blockId: 'r', quantity: 'ratio' }])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.deviceId).toBe(77)
  })

  it('does not guess when the first input has no quantity yet', async () => {
    const { ports, adopted } = setup({ sourceQuantity: async () => null })
    await adoptMathQuantities([block('s', arithmetic('sum'))], ports)
    expect(adopted).toEqual([])
  })
})
