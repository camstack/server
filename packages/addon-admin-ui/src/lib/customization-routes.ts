/**
 * Every href of the customization UI (D676), in ONE place — a link spelled in
 * two components is two links that drift. These are react-router paths,
 * resolved against `routerBasename()`, never fetched.
 */
export const CUSTOMIZE_TAB_ID = 'customize'

export const NEW_COMPOSITION_PATH = '/build/compositions/new' // hub-path-ok: react-router path
export const COMPOSITION_EDITOR_ROUTE = '/build/compositions/:blockId' // hub-path-ok: router pattern
/** `/build` with the Custom Device tab selected (compositions list). */
export const BUILD_CUSTOM_DEVICE_PATH = '/build?tab=custom-device' // hub-path-ok: react-router path

export function devicePath(deviceId: number): string {
  return `/devices/${deviceId}` // hub-path-ok: react-router path
}

export function customizePath(deviceId: number): string {
  return `/devices/${deviceId}?tab=${CUSTOMIZE_TAB_ID}` // hub-path-ok: react-router path
}

export function compositionEditorPath(blockId: string): string {
  return `/build/compositions/${encodeURIComponent(blockId)}` // hub-path-ok: react-router path
}
