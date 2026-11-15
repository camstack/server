// The tag registry (D1054) is asked by every tag input, chip list, tagged
// table and the device list. Specs render those without a tRPC client, so
// every spec starts from "no tags provider" — tags type freely, no style
// affordance, the name-derived colour. A spec about tags overrides it with its
// own `vi.mock('../use-tag-registry', …)`.
import { vi } from 'vitest'

vi.mock('../composites/tags/use-tag-registry', () => ({
  useTagRegistry: () => ({
    entries: undefined,
    failed: false,
    presence: 'absent',
    setStyle: async () => {},
    rename: async () => {},
    remove: async () => {},
  }),
}))
