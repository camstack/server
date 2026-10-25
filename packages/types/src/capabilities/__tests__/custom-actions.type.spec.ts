import { describe, it, expectTypeOf } from 'vitest'
import { z } from 'zod'
import { customAction, defineCustomActions, type CustomActionSpec } from '../custom-actions.js'

const cat = defineCustomActions({
  runIt: customAction(z.object({ times: z.number() }), z.object({ id: z.string() }), {
    kind: 'mutation',
    auth: 'admin',
  }),
  ping: customAction(z.void(), z.literal('pong')),
})

describe('custom-actions', () => {
  it('preserves literal types through defineCustomActions', () => {
    expectTypeOf<typeof cat.runIt.kind>().toEqualTypeOf<'mutation'>()
    expectTypeOf<typeof cat.runIt.auth>().toEqualTypeOf<'admin'>()
  })

  it('defaults kind to "query" and auth to "protected" and scope to system', () => {
    expectTypeOf<typeof cat.ping.kind>().toEqualTypeOf<'query'>()
    expectTypeOf<typeof cat.ping.auth>().toEqualTypeOf<'protected'>()
    expectTypeOf<typeof cat.ping.scope>().toEqualTypeOf<{ readonly kind: 'system' }>()
  })

  it('satisfies CustomActionSpec', () => {
    expectTypeOf(cat.runIt).toExtend<CustomActionSpec>()
  })
})
