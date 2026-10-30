import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

/** Custom actions of the Homematic addon: the LAN scan behind the integration form's CCU picker. */
export const homematicActions = defineCustomActions({
  discoverCcu: customAction(
    z.object({}),
    z.object({
      hosts: z.array(z.object({ host: z.string(), name: z.string(), id: z.string() })),
      summary: z.string(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type HomematicActions = typeof homematicActions
