// jest-dom matchers are registered in `src/components/cluster/__tests__/setup.ts`
// (see the note there — importing `@testing-library/jest-dom/vitest` extends the
// wrong `expect` instance and fails silently).
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
