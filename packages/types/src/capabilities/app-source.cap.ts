import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { NOT_A_DEVICE } from '../device/cap-vocabulary/system-reasons.js'

/**
 * `app-source` — collection cap: every addon that offers an app in the viewer
 * shell registers a provider and lists its declarations. The hub singleton
 * `apps` (see `apps.cap.ts`) aggregates them. No app id is spelled in the
 * shell (D1096).
 */

/** An i18n key with its English fallback, translated by the shell per app bundle. */
export const AppLabelSchema = z.object({ key: z.string().min(1), fallback: z.string() })
export type AppLabel = z.infer<typeof AppLabelSchema>

/** How the shell opens the app. */
export const AppEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native'), route: z.string() }),
  z.object({
    kind: z.literal('web'),
    /** Hub-relative path; the shell prefixes the mount (D373). */
    path: z.string(),
    auth: z.enum(['session-cookie', 'handoff']),
  }),
  z.object({ kind: z.literal('addon-page'), pageId: z.string() }),
])
export type AppEntry = z.infer<typeof AppEntrySchema>

/**
 * Where the app can be reached from. `lan-only` and `node` are interpreted by the
 * shell (phase 4); the aggregator passes them through untouched.
 */
export const AppReachSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hub') }),
  z.object({ kind: z.literal('lan-only') }),
  z.object({ kind: z.literal('node'), nodeId: z.string() }),
])
export type AppReach = z.infer<typeof AppReachSchema>

/** The role an app is offered to. */
export const AppRoleSchema = z.enum(['admin', 'user'])
export type AppRole = z.infer<typeof AppRoleSchema>

export const AppNavItemSchema = z.object({
  id: z.string(),
  label: AppLabelSchema,
  /** A lucide icon name. */
  icon: z.string(),
  path: z.string(),
  adminOnly: z.boolean().optional(),
  keywords: z.array(z.string()).optional(),
  badgeKey: z.string().optional(),
  /** Interpreted by the shell (phase 4): the item is hidden while the capability is absent. */
  requiresCapability: z.string().optional(),
})
export type AppNavItem = z.infer<typeof AppNavItemSchema>

export const AppNavSectionSchema = z.object({
  id: z.string(),
  label: AppLabelSchema.nullable(),
  items: z.array(AppNavItemSchema),
})
export type AppNavSection = z.infer<typeof AppNavSectionSchema>

export const AppDeclarationSchema = z.object({
  id: z.string(),
  label: AppLabelSchema,
  icon: z.string(),
  order: z.number().optional(),
  entry: AppEntrySchema,
  reach: AppReachSchema,
  adminOnly: z.boolean(),
  /** Only these roles; `["user"]` excludes admins; absent = every role `adminOnly` allows. */
  roles: z.array(AppRoleSchema).optional(),
  nav: z.array(AppNavSectionSchema),
  takesSharedSearch: z.boolean(),
  settings: z.object({ label: AppLabelSchema.optional(), path: z.string() }).nullable(),
})
export type AppDeclaration = z.infer<typeof AppDeclarationSchema>

export const appSourceCapability = {
  name: 'app-source',
  scope: 'system',
  mode: 'collection',
  internal: true,
  mount: { kind: 'skip' },
  methods: {
    listApps: method(z.void(), z.array(AppDeclarationSchema).readonly(), { auth: 'admin' }),
  },
  vocabulary: { notOperatorFacing: NOT_A_DEVICE.UI_PLUMBING },
} as const satisfies CapabilityDefinition

export type IAppSourceProvider = InferProvider<typeof appSourceCapability>
