import type { CcuActionDeps, CcuFacade } from '../ccu/ccu-facade.js'
import type { CcuListItem } from '../ccu/ccu-schemas.js'
import { RecordingLogger } from './recording-logger.js'

/**
 * A spec supplies only the facade calls under test. Documented type boundary:
 * a call the spec did not stub does not exist on the fake, and a handler that
 * reaches for it fails loudly with "is not a function".
 */
export function asFacade(partial: Partial<CcuFacade>): CcuFacade {
  return partial as CcuFacade
}

export function fakeDeps(
  facade: Partial<CcuFacade> | null,
  options: { readonly integrations?: readonly CcuListItem[] } = {},
): { readonly deps: CcuActionDeps; readonly logger: RecordingLogger } {
  const logger = new RecordingLogger()
  return {
    deps: {
      facade: (id) => (id === 'hm_1' && facade !== null ? asFacade(facade) : null),
      integrations: () => options.integrations ?? [],
      logger,
    },
    logger,
  }
}
