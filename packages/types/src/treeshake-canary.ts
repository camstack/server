import { z } from 'zod'

/**
 * Tree-shaking canary (D1073). Nothing reads it. Its schema holds a literal that
 * `scripts/check-addon-dist-footprint.ts` searches for in every BUILT addon dist:
 * an addon bundle inlines `@camstack/types`, so when the literal shows up there a
 * top-level initializer of the types package is being kept although no addon code
 * reaches it, and every other unreachable schema is kept with it.
 */
export const TREESHAKE_CANARY_LITERAL = 'camstack-types-treeshake-canary-7c1e'

export const TreeshakeCanarySchema = z.object({
  [TREESHAKE_CANARY_LITERAL]: z.string(),
})
