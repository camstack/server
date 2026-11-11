/**
 * Save-time: a `time-is` window bounded by a sun event cannot be placed on a
 * site without a location. It is refused with a typed reason before it is
 * saved, instead of reading `unknown` forever at run time.
 */
import { describe, expect, it } from 'vitest'
import type { AutomationRecipe } from '../recipe.js'
import { recipeSiteIssues, whenSiteIssues } from '../when-site.js'
import type { AutomationWhen } from '../when.js'

const WITH_LOCATION = {
  location: { latitude: 41.9, longitude: 12.5 },
  timeZone: 'Europe/Rome',
}
const NO_LOCATION = { location: null, timeZone: 'Europe/Rome' }

const afterSunset: AutomationWhen = {
  kind: 'time-is',
  between: {
    from: { kind: 'sun', event: 'sunset', offsetMin: 0 },
    to: { kind: 'clock', hh: 23, mm: 0 },
  },
}
const night: AutomationWhen = {
  kind: 'time-is',
  between: {
    from: { kind: 'clock', hh: 22, mm: 0 },
    to: { kind: 'clock', hh: 6, mm: 0 },
  },
}
const button: AutomationWhen = {
  kind: 'device-event',
  category: 'button.pressed',
}

describe('whenSiteIssues', () => {
  it('refuses a sun-bounded window on a site with no location, naming the leaf end and the reason', () => {
    const issues = whenSiteIssues({ kind: 'all', children: [button, afterSunset] }, NO_LOCATION)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      path: 'when.1.between.from',
      reason: 'sun-needs-site-location',
    })
    expect(issues[0]?.message).toContain('needs the site location')
  })

  it('accepts the same window once the site has a location', () => {
    expect(whenSiteIssues({ kind: 'all', children: [button, afterSunset] }, WITH_LOCATION)).toEqual(
      [],
    )
  })

  it('accepts a clock window and a days-only leaf on a site with no location', () => {
    expect(whenSiteIssues(night, NO_LOCATION)).toEqual([])
    expect(whenSiteIssues({ kind: 'time-is', days: ['sat'] }, NO_LOCATION)).toEqual([])
  })

  it('refuses any window on an unknown time zone', () => {
    const issues = whenSiteIssues(night, {
      location: null,
      timeZone: 'Mars/Olympus',
    })
    expect(issues.map((i) => i.reason)).toEqual(['unknown-time-zone', 'unknown-time-zone'])
  })

  it('reads through a not, and reports under the root it is given', () => {
    const issues = whenSiteIssues({ kind: 'not', child: afterSunset }, NO_LOCATION, 'activeWhen')
    expect(issues.map((i) => i.path)).toEqual(['activeWhen.0.between.from'])
  })
})

describe('recipeSiteIssues', () => {
  it('covers the when tree and every step guard', () => {
    const recipe: AutomationRecipe = {
      when: { kind: 'all', children: [button, afterSunset] },
      actions: [
        { kind: 'wait', seconds: 1 },
        { kind: 'wait', seconds: 1, if: afterSunset },
      ],
    }
    expect(recipeSiteIssues(recipe, NO_LOCATION).map((i) => i.path)).toEqual([
      'when.1.between.from',
      'actions.1.if.between.from',
    ])
    expect(recipeSiteIssues(recipe, WITH_LOCATION)).toEqual([])
  })
})
