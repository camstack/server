import { z } from 'zod'

/**
 * Tree-shaking canary (D1074). Nothing reads it. It holds a literal that
 * `scripts/check-addon-dist-footprint.ts` searches for in every BUILT addon dist: an addon
 * bundle inlines `@dominevo/types`, so when the literal shows up there a top-level
 * initializer of the types package is being kept although no addon code reaches it, and
 * every other unreachable schema is kept with it. It catches the package going back to
 * one pre-bundled, side-effectful file; the finer regression (an initializer kept inside a
 * module that IS reached) is `check-addon-types-reachability.ts`.
 */
export const TREESHAKE_CANARY_LITERAL = 'camstack-types-treeshake-canary-7c1e'

export const TreeshakeCanarySchema = Object.freeze({
  literal: TREESHAKE_CANARY_LITERAL,
  schema: z.object({ [TREESHAKE_CANARY_LITERAL]: z.string() }),
})
