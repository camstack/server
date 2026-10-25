import type { Composition, CompositionView } from '@camstack/types'
import { type CustomizationState, resolveCustomization } from '../../customization-read'

export function viewOf(composition: Composition, updatedAt = 1_790_000_000_000): CompositionView {
  return {
    block: {
      id: 'blk-test',
      name: 'customize:test',
      code: '',
      enabled: true,
      placement: 'hub',
      createdAt: 1,
      updatedAt,
      createdBy: 'admin',
      status: 'running',
      lastChangedAt: 1,
      source: { kind: 'composition', composition },
    },
    state: { kind: 'answered', state: null },
  }
}

/** The state the tab derives from an answered customization read — never a hand-built cast. */
export function presentState(composition: Composition): CustomizationState {
  return resolveCustomization({
    status: 'success',
    data: { state: 'loaded', view: viewOf(composition) },
  })
}
