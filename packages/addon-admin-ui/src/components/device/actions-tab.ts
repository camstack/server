/**
 * Whether the quick-detail modal shows an Actions tab.
 *
 * `device-transitions` is a wrapper cap bound per device, and it is not bound to
 * a container (a place, not something that changes state). So the tab needs the
 * cap to exist on the cluster AND this device to bind it (D12/D13). A bindings
 * read that has not answered shows no tab yet and never claims the device lacks
 * it (D315).
 */

export interface BindingsSnapshot {
  readonly status: 'pending' | 'error' | 'success'
  readonly entries: readonly { readonly capName: string }[]
}

export const DEVICE_TRANSITIONS_CAP = 'device-transitions'

export function actionsTabVisible(
  presence: 'pending' | 'present' | 'absent' | 'unknown',
  bindings: BindingsSnapshot,
): boolean {
  return (
    presence === 'present' &&
    bindings.status === 'success' &&
    bindings.entries.some((entry) => entry.capName === DEVICE_TRANSITIONS_CAP)
  )
}
