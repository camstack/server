import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

/** Custom actions of the Velux addon: the LAN scan behind the integration form's gateway picker. */
export const veluxActions = defineCustomActions({
  discoverGateway: customAction(
    z.object({}),
    z.object({
      hosts: z.array(z.object({ host: z.string(), name: z.string(), id: z.string() })),
      summary: z.string(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type VeluxActions = typeof veluxActions
