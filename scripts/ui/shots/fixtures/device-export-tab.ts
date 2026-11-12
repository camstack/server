/**
 * The device Export tab (D1049): one derived "Name on <instance>" field per exposing export
 * instance. `--fixtures device-export-tab,camera --route "/devices/101?tab=export"`.
 */
import { defineFixtures } from './_define'
import { exportTabHandlers } from './_device-export-tab'

export default defineFixtures({
  area: 'device-export-tab',
  description: 'Device Export tab with the derived exported-name fields',
  handlers: exportTabHandlers('derived'),
})
