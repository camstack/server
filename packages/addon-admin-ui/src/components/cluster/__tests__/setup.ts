import { expect } from 'vitest'
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'

// Register the jest-dom matchers against the `expect` THIS package resolves.
//
// The obvious `import '@testing-library/jest-dom/vitest'` does not work here and
// fails silently: `@testing-library/jest-dom` is hoisted to the repo root, so the
// `vitest` it imports resolves to the root's vitest 4.x, while this package pins
// its own vitest 3.x in `packages/addon-admin-ui/node_modules`. Two module
// instances, two `expect` objects — the matchers landed on the one no test ever
// sees, and every DOM matcher threw `Invalid Chai property: toHaveAttribute`.
// Importing `expect` from here resolves the package-local vitest, which is the
// instance the runner hands to the specs.
expect.extend(jestDomMatchers)
