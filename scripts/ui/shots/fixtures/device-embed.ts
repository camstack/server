/**
 * The session's grant for the embedded device card (`/embed/device/<id>`):
 * `auth.deviceAccess`. Load beside `hero-mockups` (the device) and
 * `device-transitions` (the Interactions list).
 */
import { defineFixtures } from './_define'

export default defineFixtures({
  area: 'device-embed',
  description: 'auth.deviceAccess for the embedded device card',
  handlers: {
    'auth.deviceAccess': { view: true, command: true },
  },
})
