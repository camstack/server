/**
 * A named hub (D861): no dialog; the name titles the sidebar and the hub's
 * Nodes row, and fills the Server name field on System -> Settings.
 */
import { defineFixtures } from './_define'
import { serverNameHandlers } from './_server-name'

export default defineFixtures({
  area: 'server-name-set',
  description: 'Named hub: sidebar caption, Nodes row with the id secondary, Settings field',
  handlers: serverNameHandlers({ name: 'Casa Napoli', isDefault: false }, 'Casa Napoli'),
})
