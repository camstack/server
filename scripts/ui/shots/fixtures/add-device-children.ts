/**
 * The same integration page with a provider that says `addDevice: 'children'` (an NVR / Home Hub
 * integration): Add device shows adoption and the manual form, no LAN scan. Invented data only.
 */
import { addDeviceFixtures } from './add-device'

export default addDeviceFixtures(
  'add-device-children',
  'Add device modal inside an integration whose provider adopts only its own children',
  'children',
)
