import { expect } from 'vitest'
import * as matchers from '@testing-library/jest-dom/matchers'
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

expect.extend(matchers)

// The jest-dom matchers, declared on THIS package's vitest. The package's own
// `@testing-library/jest-dom/vitest` augments the vitest the ROOT resolves
// (v4), not the v3 this package runs, so its declaration never reached these
// specs. The type parameter must repeat vitest's own declaration exactly —
// interface merging refuses any other spelling.
declare module 'vitest' {
  // biome-ignore lint/suspicious/noExplicitAny: must match vitest's `Assertion<T = any>` to merge
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must match vitest's declaration to merge
  interface Assertion<T = any> extends TestingLibraryMatchers<unknown, T> {}
}
