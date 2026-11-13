import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_PATH,
  findViolations,
  stackedListBreaches,
} from '../check-no-stacked-provider-lists.js'
import { isProductSource, loadBaseline, ROOT, readSources, walk } from '../lib/family-baseline.js'
import { itRealTree } from './lib/real-tree.js'

const UI = 'packages/addon-admin-ui/src/'
const file = (p: string, text: string) => ({ path: UI + p, text })

const HUB_OVER_TABLE = file(
  'pages/system/Auth.tsx',
  'import { IntegrationHub } from \'../../components/integration-hub/IntegrationHub\'\n<IntegrationHub groups={g} />\n<InstancesTable functionCap="login-method" />',
)
const PROVIDERS_TWICE = file(
  'pages/system/Tunnels.tsx',
  '<InstancesTable functionCap="network-access" />\nuseAddonsListCapabilityProviders({ capName: "network-access" })',
)
const SECOND_SWITCH = file(
  'pages/system/Legend.tsx',
  '<InstanceSwitchCell row={row} pinning={0} />',
)
const ADDON_MAP = file(
  'components/Hints.tsx',
  "if (addonId.startsWith('auth-oidc')) return a\nconst X = { 'auth-totp': 1 }",
)
const CARD_NEXT_TO_TABLE = file(
  'pages/system/Turn.tsx',
  '<InstancesTable functionCap="turn" />\n<SectionCard>{allServers.map((s) => s)}</SectionCard>',
)
const HAND_OMIT = file('pages/system/Settings.tsx', 'omitSectionIds={[A_ID]}')

const CLEAN_PAGE = file(
  'pages/system/Logging.tsx',
  '<InstancesTable functionCap="log-destination" />\n<SectionCard><Policy /></SectionCard>',
)

describe('check-no-stacked-provider-lists', () => {
  it('flags a pill row and a table in one file', () => {
    expect(stackedListBreaches(HUB_OVER_TABLE).join()).toContain('IntegrationHub')
  })

  it('flags the deleted IntegrationHub pill row and AddonIntegrationBody anywhere, their own folder included', () => {
    const hubPage = file('pages/system/Authentication.tsx', '<IntegrationHub groups={g} />')
    expect(stackedListBreaches(hubPage).join()).toContain('IntegrationHub')
    const declared = file(
      'components/integration-hub/IntegrationHub.tsx',
      'export function IntegrationHub({ groups }: Props) {}',
    )
    expect(stackedListBreaches(declared).join()).toContain('IntegrationHub')
    const imported = file(
      'pages/system/Tunnels.tsx',
      "import { AddonIntegrationBody } from '../../components/integration-hub/AddonIntegrationBody'",
    )
    expect(stackedListBreaches(imported).join()).toContain('AddonIntegrationBody')
    expect(
      stackedListBreaches(
        file('components/integration-hub/X.tsx', 'export const AddonIntegrationBody = () => null'),
      ).join(),
    ).toContain('AddonIntegrationBody')
  })

  it('leaves a comment that names the deleted hub alone', () => {
    expect(
      stackedListBreaches(
        file(
          'pages/system/Access.tsx',
          '/**\n * not the `<IntegrationHub>` pill row\n */\n// IntegrationHub',
        ),
      ),
    ).toEqual([])
  })

  it('flags providers listed twice beside an InstancesTable', () => {
    expect(stackedListBreaches(PROVIDERS_TWICE).join()).toContain(
      'useAddonsListCapabilityProviders',
    )
  })

  it('flags a second switch outside the instances table', () => {
    expect(stackedListBreaches(SECOND_SWITCH)).toHaveLength(1)
    expect(
      stackedListBreaches(file('components/instances/InstancesTable.tsx', SECOND_SWITCH.text)),
    ).toEqual([])
    expect(
      stackedListBreaches(
        file(
          'components/integration-hub/addon-controls.tsx',
          'export function EnableToggleButton() {}',
        ),
      ),
    ).toHaveLength(1)
  })

  it('flags a hand-written addon id comparison, map key and package list line', () => {
    expect(stackedListBreaches(ADDON_MAP)).toHaveLength(1)
    expect(
      stackedListBreaches(file('components/P.tsx', "const L = [\n  '@camstack/server',\n]")),
    ).toHaveLength(1)
    expect(stackedListBreaches(file('pages/P.tsx', "if (addonId === 'addon-x') y()"))).toHaveLength(
      1,
    )
    expect(
      stackedListBreaches(file('pages/P.tsx', "import x from '@camstack/ui-library'")),
    ).toEqual([])
  })

  it('flags a card mapping providers, servers or nodes next to a table', () => {
    expect(stackedListBreaches(CARD_NEXT_TO_TABLE).join()).toContain('SectionCard')
    expect(
      stackedListBreaches(
        file('pages/system/Only.tsx', '<SectionCard>{servers.map(f)}</SectionCard>'),
      ),
    ).toEqual([])
  })

  it('flags omitSectionIds in a page but not in a component', () => {
    expect(stackedListBreaches(HAND_OMIT)).toHaveLength(1)
    expect(stackedListBreaches(file('components/settings/P.tsx', 'omitSectionIds'))).toEqual([])
  })

  it('flags a per-addon display-name map outside the instances table, lib included', () => {
    const text = 'const names = providerNamesByAddon(addons)'
    expect(stackedListBreaches(file('pages/system/Tunnels.tsx', text)).join()).toContain(
      'providerNamesByAddon',
    )
    expect(stackedListBreaches(file('lib/names.ts', text)).join()).toContain('providerNamesByAddon')
    expect(stackedListBreaches(file('components/instances/use-instances-data.ts', text))).toEqual(
      [],
    )
  })

  it('leaves a clean page, a spec and files outside admin-ui alone', () => {
    expect(stackedListBreaches(CLEAN_PAGE)).toEqual([])
    expect(
      stackedListBreaches({
        path: 'packages/other/src/x.tsx',
        text: HUB_OVER_TABLE.text,
      }),
    ).toEqual([])
  })

  it('is green on a baseline listing every offender, red on a new one or a stale line', () => {
    const baseline = {
      families: {
        a: { [HUB_OVER_TABLE.path]: 'r', [SECOND_SWITCH.path]: 'r' },
      },
    }
    expect(findViolations([HUB_OVER_TABLE, SECOND_SWITCH], baseline)).toEqual([])
    const fresh = findViolations([HUB_OVER_TABLE, SECOND_SWITCH, CARD_NEXT_TO_TABLE], baseline)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]?.where).toBe(CARD_NEXT_TO_TABLE.path)
    const stale = findViolations([HUB_OVER_TABLE], baseline)
    expect(stale).toHaveLength(1)
    expect(stale[0]?.message).toContain('remove the line')
    expect(findViolations([CLEAN_PAGE], { families: {} })).toEqual([])
  })

  it('is red on an entry without a reason', () => {
    const found = findViolations([SECOND_SWITCH], {
      families: { a: { [SECOND_SWITCH.path]: ' ' } },
    })
    expect(found.some((v) => v.message.includes('no reason'))).toBe(true)
  })

  itRealTree('the repository is green against the committed baseline', () => {
    const files = walk(path.join(ROOT, UI), isProductSource)
    expect(findViolations(readSources(files), loadBaseline(BASELINE_PATH))).toEqual([])
  })
})
