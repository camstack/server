/**
 * The npm name the kernel + builtins package carried before they were folded
 * into `@camstack/server` (shipped as `@camstack/server/system`).
 *
 * It is no longer published and nothing imports it, but a node that was
 * installed before the fold can still hold a directory by that name — an addons
 * copy, a legacy framework dir, a quarantined `.bak`. The residue handling
 * (single-copy cleanup, the package inventory, the loader skip list) needs the
 * NAME to find and refuse it. This constant is the one place it is spelled;
 * `scripts/check-no-system-package.ts` allows it here and nowhere else in code.
 */
export const LEGACY_SYSTEM_PACKAGE_NAME = '@camstack/system'
