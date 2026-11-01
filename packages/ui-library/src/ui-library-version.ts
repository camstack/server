/**
 * The version of this ui-library build. Page remotes share ui-library from the
 * host instead of bundling it, so the host is the one place that can say which
 * version a remote is running against (`AddonPageLoader` compares it with the
 * `requiredVersion` the remote declared).
 *
 * `__UI_LIBRARY_VERSION__` is substituted at build time from this package's
 * `package.json` by every config that compiles this source (ui-library,
 * admin-ui, admin-ui's vitest). Where nothing defines it the version is `null`
 * — unknown, never a made-up number.
 */
declare const __UI_LIBRARY_VERSION__: string | undefined

export const uiLibraryVersion: string | null =
  typeof __UI_LIBRARY_VERSION__ === 'string' ? __UI_LIBRARY_VERSION__ : null
