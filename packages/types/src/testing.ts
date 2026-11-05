/**
 * `@camstack/types/testing` — test doubles for addon authors. Kept off the
 * root entry: it pulls the tRPC client, which no runtime consumer of the
 * package needs.
 */
export {
  fakeAddonContext,
  type FakeAddonContextOptions,
  type FakeSettings,
} from './addon/fake-addon-context.js'
