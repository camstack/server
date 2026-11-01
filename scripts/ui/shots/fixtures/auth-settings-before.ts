import { authSettingsHandlers } from './_auth-settings'
import { defineFixtures } from './_define'

export default defineFixtures({
  area: 'auth-settings-before',
  description: 'System -> Settings with the Authentication section as before the CORS field',
  handlers: authSettingsHandlers(false),
})
