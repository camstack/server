import { z } from 'zod'

/**
 * The `postMessage` bridge between the viewer shell and an embedded app (D1096).
 * Every message is `{ camstack: 'app-bridge', v: 1, type, ... }`; anything else
 * parses to `null` and is ignored.
 */
const Envelope = { camstack: z.literal('app-bridge'), v: z.literal(1) } as const

export const ShellToAppMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...Envelope, type: z.literal('hello') }),
  z.object({ ...Envelope, type: z.literal('navigate'), path: z.string() }),
  z.object({ ...Envelope, type: z.literal('search'), query: z.string() }),
  z.object({ ...Envelope, type: z.literal('theme'), mode: z.enum(['light', 'dark']) }),
])
export type ShellToAppMessage = z.infer<typeof ShellToAppMessageSchema>

export const AppToShellMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...Envelope, type: z.literal('ready'), path: z.string() }),
  z.object({ ...Envelope, type: z.literal('path'), path: z.string(), title: z.string() }),
  z.object({ ...Envelope, type: z.literal('invalidate'), what: z.enum(['badges', 'nav']) }),
  z.object({
    ...Envelope,
    type: z.literal('open-app'),
    appId: z.string(),
    path: z.string().optional(),
  }),
])
export type AppToShellMessage = z.infer<typeof AppToShellMessageSchema>

export const AppBridgeMessageSchema = z.union([ShellToAppMessageSchema, AppToShellMessageSchema])
export type AppBridgeMessage = z.infer<typeof AppBridgeMessageSchema>

/** The typed bridge message, or `null` for anything that is not one. */
export function parseAppBridgeMessage(value: unknown): AppBridgeMessage | null {
  const parsed = AppBridgeMessageSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
