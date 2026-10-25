/**
 * `lucide-react` ships no declarations for its per-icon index module, which is
 * the one entry that re-exports EVERY icon (PascalCase, one named export each)
 * without being the package barrel — and being a different module from the
 * barrel is what lets a bundler put it in its own lazy chunk (see
 * `composites/icon-glyphs.ts`). A shorthand declaration types the namespace as
 * `any`; the single consumer assigns it to a typed table, which is the
 * documented type boundary.
 */
declare module 'lucide-react/dist/esm/icons/index.js'
