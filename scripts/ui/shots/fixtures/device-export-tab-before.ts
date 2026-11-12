/**
 * The device Export tab before D1049: Alexa's own hand-written "Alexa name" field, no HomeKit
 * name. `--fixtures device-export-tab-before,camera --route "/devices/101?tab=export"`.
 */
import { defineFixtures } from './_define'
import { exportTabHandlers } from './_device-export-tab'

export default defineFixtures({
  area: 'device-export-tab-before',
  description: 'Device Export tab with the retired Alexa-only name field',
  handlers: exportTabHandlers('legacy'),
})
