/**
 * Build page, creating a Camera grid (`/build/compositions/new`): the camera
 * blocks fixtures plus the create answer and the device the block makes, so the
 * wizard reaches its cells step on the engine's own layout editor.
 */
import { defineFixtures } from './_define'
import cameraBlocks from './camera-blocks'

export default defineFixtures({
  area: 'build-grid-create',
  description: 'Create a Camera grid: name, save, then the cells editor',
  handlers: {
    ...cameraBlocks.handlers,
    'mut:coreBlocks.createComposition': { block: { id: 'blk-grid' } },
    'deviceManager.listPersistedByAddon': [{ id: 4600, stableId: 'composed-blk-grid' }],
    'mut:deviceManager.setName': { ok: true },
  },
})
