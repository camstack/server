/**
 * Notifications router — fixed core API (not a capability).
 *
 * Routes events by category to `(addonId, targetId)` notification targets.
 * The NotificationService is a singleton from @camstack/system; the targets
 * themselves are provided by addons via the `notification-output` capability
 * collection (see the notifiers addon / HA addon). Target management + the
 * test panel live on the cap surface (`api.notificationOutput.*`); this
 * legacy router only exposes category→target routing.
 */
import { z } from 'zod'
import type { NotificationService } from '@camstack/system'
import { trpcRouter, protectedProcedure, adminProcedure } from '../trpc/trpc.middleware.js'

const NotificationTargetRefSchema = z.object({
  addonId: z.string(),
  targetId: z.string(),
})

export function createNotificationsRouter(ns: NotificationService | null) {
  return trpcRouter({
    getRouting: protectedProcedure
      .input(z.void())
      .output(z.record(z.string(), z.array(NotificationTargetRefSchema)))
      .query(() => {
        if (!ns) return {}
        const routing = ns.getRouting()
        const result: Record<string, z.infer<typeof NotificationTargetRefSchema>[]> = {}
        for (const [category, targets] of routing) {
          result[category] = [...targets]
        }
        return result
      }),

    setRouting: adminProcedure
      .input(
        z.object({
          category: z.string(),
          targets: z.array(NotificationTargetRefSchema),
        }),
      )
      .output(z.void())
      .mutation(({ input }) => {
        if (!ns) throw new Error('Notification service unavailable')
        ns.setRouting(input.category, input.targets)
      }),
  })
}
