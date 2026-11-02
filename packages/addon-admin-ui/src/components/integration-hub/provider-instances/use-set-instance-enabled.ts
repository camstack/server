/**
 * The seam to `integrationInstances.setInstanceEnabled`: the panel depends on this hook only,
 * so its specs stub one module. The body is wired to the generated hook in its own commit
 * (needs instance-enabled-386); until then a switch change answers with a toast and writes nothing.
 */
import { pushToast } from '../../ui/toast-bus'

export interface SetInstanceEnabledInput {
  readonly addonId: string
  readonly id: string
  readonly enabled: boolean
}

export interface SetInstanceEnabled {
  readonly mutate: (input: SetInstanceEnabledInput) => void
  readonly isPending: boolean
}

export function useSetInstanceEnabled(_options: {
  readonly onSuccess: () => void
}): SetInstanceEnabled {
  return {
    mutate: () =>
      pushToast({
        title: 'Switch unavailable',
        message: 'This hub does not know the per-instance switch yet.',
        severity: 'warning',
      }),
    isPending: false,
  }
}
