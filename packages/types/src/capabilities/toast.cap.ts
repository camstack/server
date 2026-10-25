import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * toast — system-scoped singleton capability that streams toast
 * notifications from the hub to connected admin-UI clients.
 *
 * Single push subscription (`onToast`). The provider lives in the
 * server's `ToastService` (always available after boot) and is
 * registered from `trpc.router.ts` against that service. No addon
 * owns this state — toasts are server-broadcasted side-effects of
 * other admin actions.
 *
 * Phase E of the API consolidation: previously a hand-written core
 * router (re-introduced after a brief detour as a cap years ago).
 * Cap conversion unifies the codegen pipeline so admin-ui consumers
 * pick up the standard `useToastOnToast` hook through the same
 * generator that emits every other system-cap subscription wrapper.
 */

const ToastSchema = z.object({
  title: z.string(),
  message: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  duration: z.number().optional(),
  action: z
    .object({
      label: z.string(),
      url: z.string(),
    })
    .optional(),
})

export const toastCapability = {
  name: 'toast',
  scope: 'system',
  mode: 'singleton',
  methods: {
    onToast: method(z.void(), ToastSchema, { kind: 'subscription' }),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'server-provided' },
} as const satisfies CapabilityDefinition

export type IToastProvider = InferProvider<typeof toastCapability>

export { ToastSchema }
