import type { z } from 'zod'

/** The addon id the page's custom actions are dispatched to. */
export const HOMEMATIC_ADDON_ID = 'provider-homematic'

/**
 * The one tRPC call the page makes: `addons.custom`. A structural type, so the
 * hub's client and a spec's fake both satisfy it.
 */
export interface CcuTrpc {
  readonly addons: {
    readonly custom: {
      mutate(input: { addonId: string; action: string; input?: unknown }): Promise<unknown>
    }
  }
}

/** Run a custom action and parse its answer; a malformed answer is an error, never a silent empty. */
export async function callCcuAction<S extends z.ZodType>(
  trpc: CcuTrpc,
  action: string,
  input: unknown,
  schema: S,
): Promise<z.infer<S>> {
  const raw = await trpc.addons.custom.mutate({ addonId: HOMEMATIC_ADDON_ID, action, input })
  return schema.parse(raw)
}
