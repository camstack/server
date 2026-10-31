/**
 * The custom action the Alert Center's "Retry" button invokes (D987): an alert
 * carries `{ addonId, action, input }`, so a retry is an addon action, not a
 * route. `auth: 'admin'`, a mutation.
 */
import { z } from 'zod'
import { customAction, defineCustomActions, type CustomActionsSpec } from '@camstack/types'

export const retryMigrationInput: z.ZodObject<{ id: z.ZodString }> = z.object({
  id: z.string().min(1),
})
const retryMigrationOutput = z.object({ retried: z.array(z.string()) })

export const migrationActions: CustomActionsSpec = defineCustomActions({
  retryMigration: customAction(retryMigrationInput, retryMigrationOutput, {
    kind: 'mutation',
    auth: 'admin',
  }),
})

export type MigrationActions = typeof migrationActions
