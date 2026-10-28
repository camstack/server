/**
 * Alerts capability — collection-based internal alert system.
 *
 * Multiple providers can register. Each provider filters by EventBus category
 * and creates/updates alerts. The built-in Alert Center addon persists alerts
 * in the DB and serves them to the admin UI.
 */

import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

// ── Alert schemas ───────────────────────────────────────────────────

export const AlertSeveritySchema = z.enum(['info', 'success', 'warning', 'error', 'critical'])

/**
 * An action that RUNS something instead of going somewhere: the admin UI calls
 * the addon's custom action (`addons.custom`) with exactly these fields. The
 * producer owns the meaning; the UI knows nothing about the addon or the kind.
 */
export const AlertActionInvokeSchema = z.object({
  addonId: z.string().min(1),
  action: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
})

/** An action has `href` (a link) OR `invoke` (a button that runs a custom action). */
export const AlertActionSchema = z.object({
  label: z.string(),
  href: z.string().optional(),
  invoke: AlertActionInvokeSchema.optional(),
  /**
   * How `href` is followed. Absent / `app`: an admin-ui route (client-side).
   * `server`: a route the HUB serves (an addon HTTP route such as an OAuth
   * start) — the browser must leave the SPA with a full navigation, because
   * the SPA has no such route and would bounce to the home page.
   */
  navigation: z.enum(['app', 'server']).optional(),
})

export const AlertStatusSchema = z.enum([
  'active',
  'in-progress',
  'completed',
  'failed',
  'dismissed',
])

export const AlertSourceSchema = z.object({
  type: z.string(),
  id: z.string(),
})

export const AlertSchema = z.object({
  id: z.string(),
  category: z.string(),
  severity: AlertSeveritySchema,
  title: z.string(),
  message: z.string(),
  action: AlertActionSchema.optional(),
  status: AlertStatusSchema,
  progress: z.number().optional(),
  read: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  source: AlertSourceSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

// ── Inferred types ─────────────────────────────────────────────────

export type AlertSeverity = z.infer<typeof AlertSeveritySchema>
export type AlertStatus = z.infer<typeof AlertStatusSchema>
export type Alert = z.infer<typeof AlertSchema>

// ── Capability definition ──────────────────────────────────────────

export const alertsCapability = {
  name: 'alerts',
  scope: 'system',
  mode: 'singleton',
  methods: {
    emit: method(AlertSchema, z.void(), { kind: 'mutation' }),
    update: method(z.object({ alertId: z.string(), patch: AlertSchema.partial() }), z.void(), {
      kind: 'mutation',
    }),
    list: method(
      z
        .object({
          unreadOnly: z.boolean().optional(),
          limit: z.number().optional(),
        })
        .optional(),
      z.array(AlertSchema).readonly(),
    ),
    getUnreadCount: method(z.void(), z.number()),
    markRead: method(z.object({ alertId: z.string() }), z.void(), {
      kind: 'mutation',
    }),
    markAllRead: method(z.void(), z.void(), { kind: 'mutation' }),
    dismiss: method(z.object({ alertId: z.string() }), z.void(), {
      kind: 'mutation',
    }),
  },
} as const satisfies CapabilityDefinition

export type IAlertsProvider = InferProvider<typeof alertsCapability>
