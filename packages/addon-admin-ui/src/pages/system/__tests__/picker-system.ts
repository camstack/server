/**
 * A minimal `System` for specs that mount the shared `DevicePicker`.
 *
 * The picker lives in `@dominevo/ui-library` (it moved there so addon MFEs
 * share it) and reads its site zones through the library's OWN `useSystem`.
 * A `vi.mock('@dominevo/ui-library')` that replaces the exported `useSystem`
 * never reaches that internal call, so the picker needs a real
 * `<SystemProvider>` around it.
 */
import type { System } from '@dominevo/sdk'

export function pickerSystem(): System {
  // Documented type boundary: a spec fake carrying only the one tRPC read the
  // picker makes, not a whole `System`.
  return {
    trpcClient: {
      deviceManager: { listSiteZones: { query: () => Promise.resolve([]) } },
    },
  } as unknown as System
}
