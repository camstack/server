import { it } from 'vitest'

/**
 * A spec case that walks the WHOLE repository (or builds throwaway git repos).
 *
 * These cases are correct but slow: on a loaded runner they hit vitest's 10 s
 * timeout with nothing wrong (2026-10-13). The per-push CI therefore skips
 * them; the on-demand Checks workflow owns them through
 * `npm run test:scripts:slow`, which sets `CAMSTACK_REAL_TREE_SPECS=1`.
 * Unit cases of a rule (fixtures) stay on plain `it`.
 */
export const itRealTree: typeof it = it.runIf(process.env['CAMSTACK_REAL_TREE_SPECS'] === '1')
