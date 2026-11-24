import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { NOT_A_DEVICE } from '../device/cap-vocabulary/system-reasons.js'
import { AppDeclarationSchema } from './app-source.cap.js'

/**
 * `apps` — hub singleton aggregator over `app-source`. The shell reads the apps
 * it may offer here (D1096). `listApps` is filtered by the caller's role.
 */

/** One app as the shell receives it: the declaration, stamped with its provider. */
export const AppInfoSchema = z.object({
  addonId: z.string(),
  app: AppDeclarationSchema,
})
export type AppInfo = z.infer<typeof AppInfoSchema>

/** A badge count that could not be measured is `null`, never `0` (D393). */
export const AppNavBadgeSchema = z.object({
  count: z.number().nullable(),
  tone: z.enum(['neutral', 'info', 'warning', 'danger']),
})
export type AppNavBadge = z.infer<typeof AppNavBadgeSchema>

export const appsCapability = {
  name: 'apps',
  scope: 'system',
  mode: 'singleton',
  methods: {
    listApps: method(z.object({}), z.array(AppInfoSchema).readonly(), {
      auth: 'protected',
      caller: 'required',
      role: 'viewer',
    }),
    getNavBadges: method(z.object({ appId: z.string() }), z.record(z.string(), AppNavBadgeSchema), {
      auth: 'protected',
      caller: 'required',
      role: 'viewer',
    }),
  },
  vocabulary: { notOperatorFacing: NOT_A_DEVICE.UI_PLUMBING },
} as const satisfies CapabilityDefinition

export type IAppsAggregatorProvider = InferProvider<typeof appsCapability>
