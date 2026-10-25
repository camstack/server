import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../generated/capability-router-map.js'
import { WELL_KNOWN_TAB_MAP } from '../interfaces/config-ui.js'

/**
 * A widget cap that asks for a top-level tab (`deviceConfig.ui.topTab`) names
 * that tab by id, and the device page labels the tab from
 * `WELL_KNOWN_TAB_MAP` — deliberately with NO capitalisation fallback, so a
 * missing declaration is shown loudly as the raw id. That is what the operator
 * saw for the robot camera: a tab called "navigation" next to "PTZ"
 * (2026-09-06). The rule is cheap to state and impossible to remember, so it is
 * a test: a widget top-tab's id must be a well-known tab.
 */
describe('widget top-tabs are well-known tabs', () => {
  it('every deviceConfig widget with topTab names a tab in WELL_KNOWN_TAB_MAP', () => {
    const offenders: string[] = []
    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      const ui = def.deviceConfig?.ui
      if (ui === undefined || ui.kind !== 'widget' || ui.topTab !== true) continue
      if (!(ui.tab in WELL_KNOWN_TAB_MAP)) offenders.push(`${def.name} → tab '${ui.tab}'`)
    }
    expect(
      offenders,
      `these top-tabs would render their raw id as the label: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})
