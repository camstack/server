/**
 * The scope derivation moved to `@camstack/types`
 * (`src/auth/principal-scope.ts`) so that ADDONS can reach it — they may not
 * import `@camstack/system`, which is why `addon-export-alexa` had hand-copied
 * `scopesAllowDeviceCap` into its `directive-router.ts`. This module is the
 * kernel-side re-export; there is no second implementation.
 */
export { scopesAllowAddon, scopesAllowDeviceCap } from '@camstack/types'
