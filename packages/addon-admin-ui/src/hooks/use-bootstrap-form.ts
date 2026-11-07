/**
 * The `system-config` bootstrap form: `server.name` and the sign-in policy
 * (token lifetimes, trusted proxies and networks, allowed browser origins).
 *
 * These nine values are bootstrap `ConfigManager` keys, not addon settings, so
 * the form is served by a custom action pair on the hub's `system-config`
 * addon - `getBootstrapForm` / `saveBootstrapForm` - rather than the
 * addon-level settings hooks (D986 section 7). A failed read is an error, never
 * an empty form: the screen must not show defaults as if they were saved.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import type { ConfigUISchemaWithValues } from '@camstack/types'
import { useSystem } from '@camstack/ui-library'

const SYSTEM_CONFIG_ADDON_ID = 'system-config'

/** Query key of the hydrated form; a save invalidates it. */
export const BOOTSTRAP_FORM_QUERY_KEY = ['system-config', 'bootstrap-form'] as const

function isConfigUISchemaWithValues(raw: unknown): raw is ConfigUISchemaWithValues {
  return typeof raw === 'object' && raw !== null && 'sections' in raw && Array.isArray(raw.sections)
}

export function useBootstrapForm(): UseQueryResult<ConfigUISchemaWithValues> {
  const system = useSystem()
  return useQuery({
    queryKey: BOOTSTRAP_FORM_QUERY_KEY,
    queryFn: async (): Promise<ConfigUISchemaWithValues> => {
      const raw: unknown = await system.trpcClient.addons.custom.mutate({
        addonId: SYSTEM_CONFIG_ADDON_ID,
        action: 'getBootstrapForm',
        input: {},
      })
      if (!isConfigUISchemaWithValues(raw)) {
        throw new Error('The hub did not return the settings form')
      }
      return raw
    },
  })
}

export interface BootstrapFormSave {
  readonly mutateAsync: (input: { readonly patch: Record<string, unknown> }) => Promise<void>
  readonly isPending: boolean
}

/** Save a patch of the bootstrap form (admin-only on the hub); refreshes the form after. */
export function useSaveBootstrapForm(): BootstrapFormSave {
  const system = useSystem()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (input: { readonly patch: Record<string, unknown> }): Promise<void> => {
      await system.trpcClient.addons.custom.mutate({
        addonId: SYSTEM_CONFIG_ADDON_ID,
        action: 'saveBootstrapForm',
        input,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BOOTSTRAP_FORM_QUERY_KEY }),
  })
  return { mutateAsync: mutation.mutateAsync, isPending: mutation.isPending }
}
