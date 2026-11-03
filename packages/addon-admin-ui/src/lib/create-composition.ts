import { useCoreBlocksCreateComposition } from '@camstack/ui-library'

/**
 * The one door through which the admin UI creates a composed device (D1004).
 * A device is created naked and grows through Customize, so every creation
 * surface (the create page, the build tab, Customize on a native device) calls
 * this hook and nothing else. `scripts/check-single-composition-creator.ts`
 * fails when a second file reaches the generated hook.
 */
export function useCreateComposition(): ReturnType<typeof useCoreBlocksCreateComposition> {
  return useCoreBlocksCreateComposition()
}
