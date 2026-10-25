/**
 * Record kinds owned by alert-center (records plan phase 4).
 */
import { AlertSchema, defineRecordKinds, type Alert, type DefinedRecordKind } from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

/** The legacy collection the kind replaced (canonical KV before phase 4); read only without records. */
export const ALERTS_COLLECTION = 'alerts'

export type AlertBody = Omit<Alert, 'id'>
const _alertBody: z.ZodType<AlertBody> = AlertSchema.omit({ id: true })
export const AlertBodySchema: z.ZodType<AlertBody> = _alertBody

const _alertCenterRecordKinds = defineRecordKinds({
  alerts: {
    schema: AlertBodySchema,
    class: 'audit',
    writeTrigger:
      'EventBus categories the alert center tracks, operator mark read/dismiss, and model-download progress merges',
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'read', fields: ['read'] },
      { name: 'created_at', fields: ['createdAt'] },
      { name: 'updated_at', fields: ['updatedAt'] },
    ],
    retention: {
      owner: 'alert-center',
      reason:
        'maxAlerts cap and retentionDays enforced on write (enforceMaxAlerts / enforceRetention); read alerts preferred when trimming overflow',
    },
  },
}) satisfies IsolatedRecordKinds

export type AlertCenterRecordKindsMap = {
  readonly alerts: DefinedRecordKind<z.ZodType<AlertBody>>
}

export const alertCenterRecordKinds: AlertCenterRecordKindsMap = _alertCenterRecordKinds

/** Narrow kind for `records.kind()` — `IsolatedRecordKinds` string index is `| undefined`. */
export const alertsRecordKind: DefinedRecordKind<z.ZodType<AlertBody>> =
  _alertCenterRecordKinds.alerts
