import { describe, it, expectTypeOf } from 'vitest'
import { z } from 'zod'
import { customAction, defineCustomActions } from '../../capabilities/custom-actions.js'
import { bindAddonActions } from '../bind-addon-actions.js'
import type { AddonApi } from '../../generated/addon-api.js'

const cat = defineCustomActions({
  run: customAction(z.object({ n: z.number() }), z.object({ id: z.string() }), {
    kind: 'mutation',
  }),
  ping: customAction(z.void(), z.literal('pong')),
})

describe('bindAddonActions', () => {
  it('produces typed methods that infer input/output from the catalog', () => {
    const api = {} as AddonApi
    const b = bindAddonActions(api, 'benchmark', cat)
    expectTypeOf(b.run).toEqualTypeOf<(input: { n: number }) => Promise<{ id: string }>>()
    expectTypeOf(b.ping).toEqualTypeOf<(input: void) => Promise<'pong'>>()
  })
})
