// @vitest-environment jsdom
/**
 * The source picker selects ONE provider, it is the library's own `Select`,
 * and it writes no authority.
 *
 * Three operator decisions shaped this control, in the order he made them:
 *
 *  - *"possiamo selezionare le source con un multiselect common, non componenti
 *    nuovi anonimi"* [we can select the sources with a common multiselect, no new anonymous components] — the picker is a shared component, never a hand-rolled
 *    tick-box list.
 *  - *"il get videoclips prendere un provider opzionale … l'utilizzatore è uno
 *    solo."* [the get videoclips should take an optional provider … there is only one user.] — `listClips` takes ONE `provider`, not a list of sources, and
 *    naming it is required (D554 amended). So the control is a SELECTOR, not a sum,
 *    and its value is always what the query carries: a multi-pick control
 *    over a one-at-a-time argument would offer a sum the hub cannot answer,
 *    which is worse than the wrong component. The shared single-choice control
 *    is `Select` — the same one the Recordings page's camera picker uses.
 *  - *"non è affatto necessario lo stato di abilitato o meno delle sources.
 *    Loro vivono lì, ad esempio hksv c'è se la camera è esportata su homekit,
 *    reolink la dà di suo così come il camstack."* [the enabled-or-not state of the sources is not necessary at all. They live there, for example hksv is there if the camera is exported to homekit, reolink provides it on its own, as does camstack.] — a source EXISTS because of
 *    a configuration that lives somewhere else, so this surface writes nothing.
 *
 * And one fleet fact the surface must not paper over: `listSources` derives
 * from `deviceManager.getBindings`, and a camera with ONE bound provider must
 * read as a fleet state — a named, inert selector — never as an empty control.
 * (Device 107 is no longer such a camera: measured 2026-09-20 it is bound to
 * both `recorder` and `provider-reolink`.)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const CAMSTACK = {
  source: 'analytics',
  label: 'CamStack recordings',
  addonId: 'pipeline-analytics',
  availability: { state: 'ok' },
}
const ONBOARD = {
  source: 'native:reolink:onboard',
  label: 'SD card',
  addonId: 'addon-provider-reolink',
  availability: { state: 'ok' },
}

let sourceRows: readonly unknown[] = [CAMSTACK, ONBOARD]

function clip(sourceId: string) {
  return {
    id: `${sourceId}:1`,
    source: sourceId,
    kind: 'native',
    timeRange: {
      startMs: Date.parse('2026-09-20T10:00:00Z'),
      endMs: Date.parse('2026-09-20T10:01:00Z'),
    },
    thumbnailUnavailable: { reason: 'unsupported' },
  }
}

const listClipsInputs: unknown[] = []

vi.mock('../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => 'present',
}))
vi.mock('../../../generated/system-hooks', () => ({
  useVideoclipsListSources: () => ({ status: 'success', data: sourceRows }),
  useVideoclipsListClips: (input: unknown, options?: { enabled?: boolean }) => {
    // Only a call that was actually ENABLED is a call. A camera with no source
    // to name must ask nothing, and a hook that records regardless cannot tell
    // that apart from asking without a provider.
    if (options?.enabled !== false) listClipsInputs.push(input)
    return {
      status: 'success',
      data: [clip('analytics'), clip('native:reolink:onboard')],
    }
  },
  usePipelineAnalyticsGetEventDensity: () => ({ status: 'success', data: [] }),
  useVideoclipsGetClipPlayback: () => ({ status: 'pending', data: undefined }),
}))

const { ClipsSection } = await import('../ClipsSection.js')

beforeEach(() => {
  listClipsInputs.length = 0
  sourceRows = [CAMSTACK, ONBOARD]
})

/** The one control the section offers for choosing a provider. */
function picker(): HTMLSelectElement {
  const found = screen.getByRole('combobox', { name: /source/i })
  if (!(found instanceof HTMLSelectElement)) throw new Error('the picker is not a <select>')
  return found
}

describe('ClipsSection — the picker is the shared Select, never a hand-rolled list', () => {
  it('is one combobox, with no tick boxes anywhere', () => {
    render(<ClipsSection deviceId={107} />)
    expect(picker()).toBeTruthy()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('offers every provider the camera is bound to, by the label its rows carry', () => {
    render(<ClipsSection deviceId={107} />)
    const labels = Array.from(picker().options).map((o) => o.textContent ?? '')
    expect(labels.join('|')).toContain('CamStack recordings')
    expect(labels.join('|')).toContain('SD card')
  })
})

/**
 * The section used to send NOTHING until the operator chose, on the strength of
 * the cap's documented default: *"absent means the device's bound provider,
 * which is CamStack on every camera"*. Measured on the live hub 2026-09-20,
 * device 107 bound to `recorder` AND `provider-reolink`: a bare `listClips`
 * with `limit: 3` came back with SIX rows, three per source, merged — and the
 * default option was LABELLED "CamStack recordings" while sending neither.
 *
 * There is no default to restore (D554 amended): a collection cap's binding set is
 * derived and plural, so the pick belongs to the surface, which has the
 * `listSources` rows in hand. It picks the first one the camera lists and says
 * so in the control.
 */
describe('ClipsSection — a provider is always NAMED', () => {
  it('never asks listClips without naming one', () => {
    render(<ClipsSection deviceId={107} />)
    expect(listClipsInputs.length).toBeGreaterThan(0)
    for (const input of listClipsInputs) {
      expect(typeof Reflect.get(Object(input), 'provider')).toBe('string')
    }
  })

  it('defaults to the FIRST source the camera lists, which is what the control shows', () => {
    render(<ClipsSection deviceId={107} />)
    expect(listClipsInputs.at(-1)).toMatchObject({ provider: CAMSTACK.addonId })
    expect(picker().value).toBe(CAMSTACK.addonId)
  })

  it('asks NOTHING when the camera lists no source to ask', () => {
    sourceRows = []
    render(<ClipsSection deviceId={107} />)
    expect(listClipsInputs).toHaveLength(0)
  })

  it('sends the ADDON id — never a source id — once one is chosen', () => {
    render(<ClipsSection deviceId={107} />)
    fireEvent.change(picker(), { target: { value: 'addon-provider-reolink' } })
    expect(listClipsInputs.at(-1)).toMatchObject({ provider: 'addon-provider-reolink' })
  })
})

describe('ClipsSection — one bound provider is a fleet STATE, not an empty control', () => {
  it('names the single provider and says why there is nothing to choose', () => {
    // Today's fleet: `listSources` derives from `getBindings`, and only
    // CamStack is bound for `videoclips`.
    sourceRows = [CAMSTACK]
    render(<ClipsSection deviceId={107} />)
    const only = picker()
    expect(only.disabled).toBe(true)
    expect(
      Array.from(only.options)
        .map((o) => o.textContent ?? '')
        .join(''),
    ).toContain('CamStack recordings')
    expect(screen.getByText(/one clip provider/i)).toBeTruthy()
  })
})

describe('ClipsSection — every source the camera has stays PICKABLE', () => {
  it('keeps them all in the picker, whichever provider is being asked', () => {
    // The diagnostics table that used to list every source was removed on
    // 2026-09-21. What must not be lost with it is the operator's ability to
    // REACH a source: a camera whose second source vanished from the picker
    // because the first one is being read would be the two-derivations defect
    // wearing a control.
    render(<ClipsSection deviceId={107} />)
    fireEvent.change(picker(), { target: { value: 'addon-provider-reolink' } })
    // The picker carries LABELS, which is what the operator picks by — the
    // addon id is the wire's business and was only ever visible in the table.
    const options = Array.from(picker().querySelectorAll('option')).map((o) => o.textContent ?? '')
    expect(options).toContain('CamStack recordings')
    expect(options).toContain('SD card')
  })
})

describe('the clips surface writes no authority', () => {
  /**
   * A source EXISTS because of a configuration that lives somewhere else. The
   * one thing a reviewer cannot see in a render test is a mutation that is
   * wired but not reached by the fixtures, so this reads the source.
   *
   * `setWrapperActive` itself is a real, pre-existing authority (D62) and is
   * not in question — what may never appear HERE is a call to it, or any read
   * of the per-source deny projection, because a clips list is not where an
   * operator decides whether a camera is exported to HomeKit.
   */
  const FORBIDDEN = ['setWrapperActive', 'switchedOff', 'DisabledSource', 'useMutation']

  it('mentions no activation authority anywhere in the surface', () => {
    // jsdom replaces the global `URL`, and node:url refuses a non-node one —
    // so the module's own path is converted from the STRING and walked up.
    const dir = dirname(dirname(fileURLToPath(import.meta.url)))
    const offenders: string[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
      const text = readFileSync(join(dir, name), 'utf8')
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) offenders.push(`${name}: ${needle}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
