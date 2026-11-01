import { authSettingsHandlers } from './_auth-settings'
import { defineFixtures } from './_define'

export default defineFixtures({
  area: 'auth-settings',
  description: 'System -> Settings with the Authentication section incl. allowed browser origins',
  handlers: authSettingsHandlers(true),
})
