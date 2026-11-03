import { describe, expect, it } from 'vitest'
import { AGGREGATOR_KINDS, checkHelperKinds } from '../check-helper-kinds-are-aggregators'

const spec = (kinds: readonly string[]): string =>
  kinds.map((k) => `const x = z.object({\n  kind: z.literal('${k}'),\n})`).join('\n')

describe('check-helper-kinds-are-aggregators', () => {
  it('passes when the spec declares exactly the aggregators', () => {
    expect(checkHelperKinds(spec(AGGREGATOR_KINDS))).toEqual({ extra: [], missing: [] })
  })

  it('flags a non-aggregator helper kind', () => {
    expect(checkHelperKinds(spec([...AGGREGATOR_KINDS, 'appliance'])).extra).toEqual(['appliance'])
  })

  it('flags an aggregator that disappeared', () => {
    expect(checkHelperKinds(spec(AGGREGATOR_KINDS.slice(1))).missing).toEqual([AGGREGATOR_KINDS[0]])
  })
})
