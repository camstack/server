/**
 * Harness stand-in for `@module-federation/runtime`: a widget remote
 * (`loadRemote('<remoteName>/<module>')`) resolves to the workspace SOURCE of
 * the module its `vite.widgets*.config.ts` exposes, so a device tab's widget
 * renders with the fixture-backed client instead of a hub-served bundle.
 * Addon pages keep their own loader stub (`AddonPageLoader.tsx`).
 */
import widgets from 'virtual:ui-shots-addon-widgets'

interface Instance {
  readonly name: string
}

const INSTANCE: Instance = { name: 'ui-shots-host' }

export function init(_options: unknown): Instance {
  return INSTANCE
}

export function getInstance(): Instance {
  return INSTANCE
}

export function registerRemotes(_remotes: unknown, _options?: unknown): void {}

export async function loadRemote<T>(id: string): Promise<T> {
  const importer = widgets[id]
  if (importer === undefined) throw new Error(`ui:shots: no workspace widget bundle for ${id}`)
  // The remote's module object, exactly what MF's `loadRemote` resolves to.
  return (await importer()) as T
}
