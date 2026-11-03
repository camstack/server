/**
 * The seam to `integrationInstances.setInstanceEnabled`: the panel depends on this hook only,
 * so its specs stub one module.
 */
import { useIntegrationInstancesSetInstanceEnabled } from '@camstack/ui-library'

export interface SetInstanceEnabledInput {
  readonly addonId: string
  readonly id: string
  readonly enabled: boolean
}

export interface SetInstanceEnabled {
  readonly mutate: (input: SetInstanceEnabledInput) => void
  readonly isPending: boolean
}

export function useSetInstanceEnabled(options: {
  readonly onSuccess: () => void
}): SetInstanceEnabled {
  const mutation = useIntegrationInstancesSetInstanceEnabled({ onSuccess: options.onSuccess })
  return { mutate: (input) => mutation.mutate({ ...input }), isPending: mutation.isPending }
}
