/**
 * Normalizes the module specifiers ts-morph prints when it expands a core
 * router's type through the SERVER tsconfig (see `generate-api-types.ts`).
 * Extracted into its own side-effect-free module — same reason
 * `core-router-degradation.ts` and `framework-dist-freshness.ts` are
 * separate files — so it is importable from a test without triggering
 * `generate-api-types.ts`'s top-level `void main()`.
 *
 * WHY THIS EXISTS (2026-08-26): `generate-api-types.ts` unsets `baseUrl` on
 * the throwaway ts-morph Project specifically so TypeScript's specifier
 * printer falls back to the package-name form (`@dominevo/types`) instead of
 * a path relative to `baseUrl`. That is the primary fix — see the comment on
 * `expandCoreRouters`'s `Project` construction. This function is the
 * defensive backstop: it normalizes BOTH the absolute-path form (leading
 * "/…/", the form seen when a symlink escapes `baseUrl` entirely) and the
 * baseUrl-relative form (no leading slash — e.g. `packages/types/dist`, the
 * form seen whenever the resolved `.d.ts` falls inside `baseUrl`, which is
 * true on every self-contained checkout including CI). Before this file
 * handled the relative form, CI was permanently red on "codegen drift":
 * every CI run builds `packages/types/dist` before checking, `dist` is
 * always inside `baseUrl` on a real checkout, so TS always printed
 * `import("packages/types/dist")` and neither this cleanup NOR the (then
 * absent) `baseUrl` override caught it.
 */
export function cleanupExpandedRouterType(typeText: string, root: string): string {
  return (
    typeText
      .replace(/import\("(?:\/[^"]*\/)?packages\/types\/[^"]*"\)/g, 'import("@dominevo/types")')
      .replace(/import\("(?:\/[^"]*\/)?packages\/core\/[^"]*"\)/g, 'import("@dominevo/types")')
      .replace(/import\("(?:\/[^"]*\/)?packages\/kernel\/[^"]*"\)/g, 'import("@dominevo/types")')
      .replace(/import\("(?:\/[^"]*\/)?server\/backend\/[^"]*"\)/g, 'import("@dominevo/types")')
      .replace(/import\("@dominevo\/core[^"]*"\)/g, 'import("@dominevo/types")')
      .replace(/import\("@dominevo\/kernel[^"]*"\)/g, 'import("@dominevo/types")')
      .replace(/import\("@dominevo\/system[^"]*"\)/g, 'import("@dominevo/types")')
      .replace(/import\("@dominevo\/types\/[^"]*"\)/g, 'import("@dominevo/types")')
      .replace(
        new RegExp(`import\\("${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/node_modules/`, 'g'),
        'import("',
      )
      .replace(
        /import\("[^"]*unstable-core-do-not-import[^"]*"\)/g,
        'import("@trpc/server/unstable-core-do-not-import")',
      )
      .replace(/import\("[^"]*trpc\.context[^"]*"\)\.\w+/g, 'any')
      .replace(/import\("\.\.[^"]*"\)/g, 'import("@dominevo/types")')
      .replace(/import\("\.[^"]*"\)/g, 'import("@dominevo/types")')
      .replace(/nodeId: unknown/g, 'nodeId?: string | undefined')
      // The server-side error shape maps to the LOCAL structural declaration.
      .replace(/import\("@dominevo\/types"\)\.AugmentedErrorShape/g, 'AugmentedErrorShape')
  )
}
