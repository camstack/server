import { cameraDetectionHandlers } from './_camera-detection'
import { defineFixtures } from './_define'

export default defineFixtures({
  area: 'camera-detection-legacy',
  description:
    'Same cameras with the pre-move shape: detectionSources as a contributed Settings section (for "before" shots)',
  handlers: cameraDetectionHandlers(true),
})
