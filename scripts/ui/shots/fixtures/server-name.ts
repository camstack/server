/**
 * The hub was never named (D861): `system.info` answers the hostname default,
 * so an admin signing in gets the "Name this server" dialog.
 */
import { defineFixtures } from './_define'
import { serverNameHandlers } from './_server-name'

export default defineFixtures({
  area: 'server-name',
  description: 'Unnamed hub: system.info says isDefault, the first-login dialog shows',
  handlers: serverNameHandlers({ name: 'nas', isDefault: true }, ''),
})
