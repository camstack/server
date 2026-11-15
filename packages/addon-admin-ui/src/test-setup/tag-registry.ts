// The tag registry (D1054) is asked by every tag input, chip list and tagged
// table the library renders. A spec that mocks the library's tRPC hooks does
// not reach this one (the library imports it by relative path), so every spec
// starts from "no tags provider" — tags type freely, no style affordance, the
// name-derived colour. A spec about tags overrides it with its own `vi.mock`.
import { vi } from 'vitest'

vi.mock('../../../ui-library/src/composites/tags/use-tag-registry', () => ({
  useTagRegistry: () => ({
    entries: undefined,
    failed: false,
    presence: 'absent',
    setStyle: async () => {},
    rename: async () => {},
    remove: async () => {},
  }),
}))
