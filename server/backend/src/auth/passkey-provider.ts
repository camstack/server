/**
 * The `user-passkeys` provider as the hub reaches it, and the two passkey
 * questions a login asks (enrolled? opted in as a second factor?). Moved out
 * of `auth.router.ts` so the SSO finish asks them through the same code
 * (D782 — every primary login owes the same second factors).
 */
import type { CapabilityRegistry } from '@camstack/system'
import { type IUserPasskeysProvider, PasskeySummarySchema } from '@camstack/types'
import { z } from 'zod'
import type { MoleculerService } from '../core/moleculer/moleculer.service.js'

// ── Passkey (user-passkeys cap) resolution ───────────────────────────
//
// Cap-agnostic: the passkey provider is resolved through the
// `user-passkeys` CAPABILITY, never by addon id. Any addon registering
// the cap works. Resolution mirrors `hwaccel.router`:
//   1. hub-in-process collection provider (a future hub-resident impl),
//   2. else the hub-local forked child over UDS via the Moleculer cap
//      proxy (`createCapabilityProxy(cap, 'hub')`) — the same routing the
//      generated cap routers use.
// The proxy is loosely typed (`Record<method, (params)=>Promise<unknown>>`);
// its outputs are narrowed through the cap's own Zod schemas rather than
// cast to the provider type (repo rule: no `as` on cross-boundary values).

export const OptionsJsonSchema = z.object({ optionsJSON: z.record(z.string(), z.unknown()) })
export const FinishRegistrationSchema = z.object({
  success: z.literal(true),
  credentialId: z.string(),
})
export const FinishAuthenticationSchema = z.object({ verified: z.boolean() })
export const FinishDiscoverableAuthenticationSchema = z.object({
  verified: z.boolean(),
  userId: z.string().nullable(),
})
export const RemovePasskeySchema = z.object({ success: z.literal(true) })
export const SecondFactorPreferenceSchema = z.object({ enabled: z.boolean() })
export const SetSecondFactorPreferenceSchema = z.object({ success: z.literal(true) })

type CapProxy = Record<string, (params: unknown) => Promise<unknown>>

function proxyPasskeyProvider(proxy: CapProxy): IUserPasskeysProvider {
  const call = async (method: string, params: unknown): Promise<unknown> => {
    const fn = proxy[method]
    if (typeof fn !== 'function') throw new Error(`user-passkeys proxy missing method '${method}'`)
    return fn(params)
  }
  return {
    beginRegistration: async (input) =>
      OptionsJsonSchema.parse(await call('beginRegistration', input)),
    finishRegistration: async (input) =>
      FinishRegistrationSchema.parse(await call('finishRegistration', input)),
    beginAuthentication: async (input) =>
      OptionsJsonSchema.parse(await call('beginAuthentication', input)),
    finishAuthentication: async (input) =>
      FinishAuthenticationSchema.parse(await call('finishAuthentication', input)),
    beginDiscoverableAuthentication: async (input) =>
      OptionsJsonSchema.parse(await call('beginDiscoverableAuthentication', input)),
    finishDiscoverableAuthentication: async (input) =>
      FinishDiscoverableAuthenticationSchema.parse(
        await call('finishDiscoverableAuthentication', input),
      ),
    listPasskeys: async (input) =>
      z.array(PasskeySummarySchema).parse(await call('listPasskeys', input)),
    removePasskey: async (input) => RemovePasskeySchema.parse(await call('removePasskey', input)),
    getSecondFactorPreference: async (input) =>
      SecondFactorPreferenceSchema.parse(await call('getSecondFactorPreference', input)),
    setSecondFactorPreference: async (input) =>
      SetSecondFactorPreferenceSchema.parse(await call('setSecondFactorPreference', input)),
  }
}

export function resolvePasskeyProvider(
  registry: CapabilityRegistry | null,
  moleculer: MoleculerService | null,
): IUserPasskeysProvider | null {
  const local = registry?.getCollection<IUserPasskeysProvider>('user-passkeys')?.[0] ?? null
  if (local) return local
  const proxy = moleculer?.createCapabilityProxy('user-passkeys', 'hub') ?? null
  return proxy ? proxyPasskeyProvider(proxy) : null
}

/**
 * Whether the user has at least one enrolled passkey. Never throws — a
 * missing provider or a transport hiccup degrades to `false` so the
 * login flow is never blocked by passkey introspection.
 */
export async function userHasPasskey(
  userId: string,
  provider: IUserPasskeysProvider | null,
): Promise<boolean> {
  if (!provider) return false
  try {
    const list = await provider.listPasskeys({ userId })
    return list.length > 0
  } catch {
    return false
  }
}

/**
 * Whether the user OPTED IN to their passkey doubling as a mandatory
 * second factor after a password login. Enrolling a passkey alone only
 * enables passkey-FIRST sign-in — this flag (default OFF, stored by the
 * `user-passkeys` provider) is what re-arms the 2FA gate. Never throws:
 * a missing provider, a provider predating the method, or a transport
 * hiccup all read as `false` so the preference lookup can never lock a
 * user out of the password flow.
 */
export async function passkeySecondFactorOptedIn(
  userId: string,
  provider: IUserPasskeysProvider | null,
): Promise<boolean> {
  if (!provider || typeof provider.getSecondFactorPreference !== 'function') return false
  try {
    const pref = await provider.getSecondFactorPreference({ userId })
    return pref.enabled
  } catch {
    return false
  }
}
