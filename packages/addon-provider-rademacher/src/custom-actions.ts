import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

/** Custom actions of the Rademacher addon: the LAN scan behind the integration form's hub picker. */
export const rademacherActions = defineCustomActions({
  discoverHub: customAction(
    z.object({}),
    z.object({
      hosts: z.array(z.object({ host: z.string(), name: z.string(), id: z.string() })),
      summary: z.string(),
    }),
    { kind: 'mutation', auth: 'admin' },
  ),
})

export type RademacherActions = typeof rademacherActions
