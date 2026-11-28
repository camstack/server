/**
 * The scope derivation moved to `@dominevo/types`
 * (`src/auth/principal-scope.ts`) so that ADDONS can reach it — they may not
 * import `@dominevo/server/system`, which is why `addon-export-alexa` had hand-copied
 * `scopesAllowDeviceCap` into its `directive-router.ts`. This module is the
 * kernel-side re-export; there is no second implementation.
 */
export { scopesAllowAddon, scopesAllowDeviceCap } from '@dominevo/types'
