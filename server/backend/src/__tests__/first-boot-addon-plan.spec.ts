/**
 * The first-boot addon plan — what a node installs when the image stops
 * carrying a non-system addon seed tree.
 *
 * Operator, 2026-08-12/13: *"tutti gli altri addons devono rimanere copia
 * unica, sempre, installati durante l'avvio iniziale"* [all the other addons must remain a single copy, always, installed during the initial boot] and *"il sistema è
 * designato per essere addons-agnostic, latest va sempre bene al primo boot"* [the system is designed to be addons-agnostic, latest is always fine at first boot].
 * So there is no pin to honour and no semver to adopt by: absent → fetch
 * `latest`, present → keep, closure-provided → never copy.
 *
 * The one thing worth reporting is the case task 32 exists for: the same
 * package at two truthful versions on one node — the hub runs `addon-pipeline`
 * 1.2.69 while its own closure carries 1.2.64. That is INFO and never an
 * action; `<dataDir>/addons` is the runtime authority (D90).
 */
import { describe, expect, it } from 'vitest'
import type { BootstrapDecision } from '../first-boot-addon-plan.js'
import { formatFirstBootPlan, planFirstBootAddons } from '../first-boot-addon-plan.js'

function decisionFor(decisions: readonly BootstrapDecision[], pkg: string): BootstrapDecision {
  const found = decisions.find((d) => d.pkg === pkg)
  if (found === undefined) throw new Error(`no decision for ${pkg}`)
  return found
}

describe('planFirstBootAddons', () => {
  it('fetches latest when nothing is on disk — the whole version contract', () => {
    const plan = planFirstBootAddons({
      required: ['@dominevo/addon-pipeline'],
      installed: {},
      closureVersions: { '@dominevo/addon-pipeline': '1.2.64' },
      closureProvided: [],
    })
    const d = decisionFor(plan.decisions, '@dominevo/addon-pipeline')
    expect(d.action).toBe('install-npm')
    expect(d.installedVersion).toBeNull()
    expect(plan.wouldInstall).toEqual(['@dominevo/addon-pipeline'])
  })

  it('adopts an installed copy whatever its version — a deploy outranks the closure', () => {
    // Live hub, 2026-08-13: addon-pipeline 1.2.69 installed, closure copy 1.2.64.
    const plan = planFirstBootAddons({
      required: ['@dominevo/addon-pipeline'],
      installed: { '@dominevo/addon-pipeline': '1.2.69' },
      closureVersions: { '@dominevo/addon-pipeline': '1.2.64' },
      closureProvided: [],
    })
    const d = decisionFor(plan.decisions, '@dominevo/addon-pipeline')
    expect(d.action).toBe('adopt-installed')
    expect(d.twoVersions).toBe(true)
    expect(plan.twoVersions).toEqual(['@dominevo/addon-pipeline'])
    expect(plan.needsRegistry).toBe(false)
  })

  it('adopts an OLDER installed copy too — nothing here ever upgrades or downgrades', () => {
    const plan = planFirstBootAddons({
      required: ['@dominevo/addon-admin-ui'],
      installed: { '@dominevo/addon-admin-ui': '1.2.33' },
      closureVersions: { '@dominevo/addon-admin-ui': '1.2.50' },
      closureProvided: [],
    })
    expect(decisionFor(plan.decisions, '@dominevo/addon-admin-ui').action).toBe('adopt-installed')
    expect(plan.wouldInstall).toEqual([])
  })

  it('says nothing about two versions when they agree', () => {
    const plan = planFirstBootAddons({
      required: ['@dominevo/addon-auth'],
      installed: { '@dominevo/addon-auth': '1.2.14' },
      closureVersions: { '@dominevo/addon-auth': '1.2.14' },
      closureProvided: [],
    })
    expect(decisionFor(plan.decisions, '@dominevo/addon-auth').twoVersions).toBe(false)
    expect(plan.twoVersions).toEqual([])
  })

  it('never seeds a package the closure already provides', () => {
    const plan = planFirstBootAddons({
      required: ['@dominevo/server', '@dominevo/addon-auth'],
      installed: {},
      closureVersions: { '@dominevo/server': '1.2.84' },
      closureProvided: ['@dominevo/server'],
    })
    expect(decisionFor(plan.decisions, '@dominevo/server').action).toBe('skip-closure-provided')
    expect(decisionFor(plan.decisions, '@dominevo/addon-auth').action).toBe('install-npm')
  })

  it('installs a closure-provided package that is NOT resolvable — the unbootable-node case', () => {
    const plan = planFirstBootAddons({
      required: ['@dominevo/server'],
      installed: {},
      closureVersions: {},
      closureProvided: [],
    })
    expect(decisionFor(plan.decisions, '@dominevo/server').action).toBe('install-npm')
  })

  it('treats an unreadable installed package.json as absent, and says so', () => {
    const plan = planFirstBootAddons({
      required: ['@dominevo/addon-notifiers'],
      installed: { '@dominevo/addon-notifiers': null },
      closureVersions: {},
      closureProvided: [],
    })
    const d = decisionFor(plan.decisions, '@dominevo/addon-notifiers')
    expect(d.action).toBe('install-npm')
    expect(d.reason).toContain('unreadable')
  })

  it('reports whether the boot needs the registry at all — the offline question', () => {
    const offlineSafe = planFirstBootAddons({
      required: ['@dominevo/addon-pipeline'],
      installed: { '@dominevo/addon-pipeline': '1.2.69' },
      closureVersions: {},
      closureProvided: [],
    })
    expect(offlineSafe.needsRegistry).toBe(false)

    const firstBoot = planFirstBootAddons({
      required: ['@dominevo/addon-pipeline', '@dominevo/addon-auth'],
      installed: {},
      closureVersions: {},
      closureProvided: [],
    })
    expect(firstBoot.needsRegistry).toBe(true)
    expect(firstBoot.wouldInstall).toEqual(['@dominevo/addon-pipeline', '@dominevo/addon-auth'])
  })
})

describe('formatFirstBootPlan', () => {
  it('says which mode it is in — an observe line must never read as an install', () => {
    const plan = planFirstBootAddons({
      required: ['@dominevo/addon-pipeline'],
      installed: {},
      closureVersions: {},
      closureProvided: [],
    })
    const text = formatFirstBootPlan(plan, 'observe').join('\n')
    expect(text).toContain('observe')
    expect(text).toContain('nothing was installed')
    expect(text).toContain('@dominevo/addon-pipeline@latest')
  })

  it('is silent about nothing — a plan with no work still states the roster it checked', () => {
    const plan = planFirstBootAddons({
      required: ['@dominevo/addon-pipeline'],
      installed: { '@dominevo/addon-pipeline': '1.2.69' },
      closureVersions: {},
      closureProvided: [],
    })
    const text = formatFirstBootPlan(plan, 'observe').join('\n')
    expect(text).toContain('1 package(s)')
    expect(text).toContain('0 to install')
    expect(text).toContain('no registry access needed')
  })

  it('names the two-version packages as INFO, not as work', () => {
    const plan = planFirstBootAddons({
      required: ['@dominevo/addon-pipeline'],
      installed: { '@dominevo/addon-pipeline': '1.2.69' },
      closureVersions: { '@dominevo/addon-pipeline': '1.2.64' },
      closureProvided: [],
    })
    const text = formatFirstBootPlan(plan, 'observe').join('\n')
    expect(text).toContain('two versions on this node')
    expect(text).toContain('INFO')
  })
})
