import { cameraDetectionHandlers } from './_camera-detection'
import { defineFixtures } from './_define'

export default defineFixtures({
  area: 'camera-detection',
  description:
    'Cameras 107 (pipeline root), 593 (onboard root), 594 (no root): Detection pipeline tab',
  handlers: cameraDetectionHandlers(false),
})
