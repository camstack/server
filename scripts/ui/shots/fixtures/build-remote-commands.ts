/**
 * Build → Custom device: a built device whose media-player commands are served
 * by its own remote. The Commands card shows "Served by this device's remote"
 * with a link to the device page (no "Edit remote" button). Open with
 * `--route "/build/compositions/blk-fountain"`. Reuses the `build-fountain`
 * fleet and adds a media-player feature to its composition.
 */
import { mediaPlayerExtensionCommands } from '../../../../packages/types/src/composition/validate-forward.ts'
import { defineFixtures } from './_define'
import fountain from './build-fountain'

const base = fountain.handlers['coreBlocks.getComposition'] as (input: { blockId?: string }) => {
  view: { block: { source: { composition: { features: readonly unknown[] } } } } | null
} & Record<string, unknown>

function withRemote(input: { blockId?: string }) {
  const answer = base(input)
  if (answer.view === null) return answer
  const block = answer.view.block
  return {
    ...answer,
    view: {
      ...answer.view,
      block: {
        ...block,
        source: {
          ...block.source,
          composition: {
            ...block.source.composition,
            features: [
              ...block.source.composition.features,
              {
                kind: 'fields',
                cap: 'media-player',
                fields: {},
                commands: mediaPlayerExtensionCommands(),
              },
            ],
          },
        },
      },
    },
  }
}

export default defineFixtures({
  area: 'build-remote-commands',
  description: 'Built device whose media-player commands are served by its remote',
  handlers: {
    ...fountain.handlers,
    'coreBlocks.getComposition': withRemote,
    'schedulers.list': [],
    'template.list': [],
  },
})
