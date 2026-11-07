import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guard, not a unit test: it pins the two settings surfaces to a scope that
 * matches the node they claim.
 *
 * The defect it prevents is invisible at runtime — both surfaces render, both
 * show a value, and only the store row afterwards says which node was written.
 * `AddonCard`'s dialog pinned a literal `nodeId="hub"` while the node card
 * wrote `@<that node>`, so the same label edited from two places hit two
 * different keys. A rule nothing checks has already been broken somewhere;
 * this is the check.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../..')

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf-8')
}

/**
 * Comments are prose about the defect, not the defect. Stripping them is what
 * lets the guard's own explanation quote the wrong call it forbids.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** The `<NodeAddonsSettingsPanel …>` opening tag in a file, whitespace-flattened. */
function panelUsage(source: string): string {
  const start = source.indexOf('<NodeAddonsSettingsPanel')
  expect(start, 'file renders no NodeAddonsSettingsPanel').toBeGreaterThan(-1)
  const end = source.indexOf('/>', start)
  expect(end, 'unterminated NodeAddonsSettingsPanel tag').toBeGreaterThan(start)
  return source.slice(start, end).replace(/\s+/g, ' ')
}

describe('the Addons card dialog does not claim a node it does not have', () => {
  const source = read('components/addons/AddonCard.tsx')

  it('passes no hardcoded node id', () => {
    expect(code(source)).not.toContain('nodeId="hub"')
    expect(code(source)).not.toMatch(/nodeId="[^"]+"/)
  })

  it('renders the cluster population, which is the only one it can address', () => {
    const usage = panelUsage(code(source))
    expect(usage).toContain('nodeId={null}')
    expect(usage).toContain('fieldScope="cluster"')
  })

  it('says on screen which scope it edits', () => {
    expect(source).toMatch(/Cluster-wide settings/)
  })
})

describe("the node card's Settings tab renders only what is true of that node", () => {
  const source = read('components/cluster/tabs/NodeDetailSettingsTab.tsx')

  it('is addressed by the real node and narrowed to per-node fields', () => {
    const usage = panelUsage(code(source))
    expect(usage).toContain('nodeId={nodeId}')
    expect(usage).toContain('fieldScope="perNode"')
  })

  it('explains an empty tab instead of rendering a blank', () => {
    const usage = panelUsage(code(source))
    expect(usage).toContain('emptyMessage=')
    expect(source).toMatch(/System → Settings/)
  })
})

describe('the integration page carries no addon-level settings surface (D986)', () => {
  const source = read('pages/IntegrationDetail.tsx')

  it('mounts no settings panel and reads no integration-level settings', () => {
    // No addon declares integration sections any more, so the read always answered `null` and the
    // panel never mounted. An integration's own configuration is its instance record.
    expect(code(source)).not.toContain('NodeAddonsSettingsPanel')
    expect(code(source)).not.toContain('IntegrationSettings')
  })

  it('carries no "Integration-wide settings" paragraph, anywhere', () => {
    // The paragraph was removed on operator request. The guard survives the
    // removal because it now pins the ABSENCE across every file that could
    // reintroduce it: the page that mounts the surface, the panel that used to
    // render it, and the module that used to own the string. A statement that
    // came back on one of the three would otherwise read as intended design.
    //
    // What is NOT removed: the scope itself. `NodeAddonsSettingsPanel` still
    // THROWS on a device/node/fieldScope mount — the enforcement was never the
    // sentence.
    for (const rel of [
      'pages/IntegrationDetail.tsx',
      'components/settings/NodeAddonsSettingsPanel.tsx',
      'lib/settings-forwarding.ts',
    ]) {
      expect(code(read(rel)), `${rel} reintroduces the scope paragraph`).not.toContain(
        'Integration-wide settings',
      )
    }
  })
})

describe('placement is never expressed as a tab', () => {
  it('no settings surface treats a tab id as a declaration of where a section lives', () => {
    // D268 declared placement as `tab: 'integration'`. `tab` also feeds the
    // settings tab bar, so the addon's own page grew a tab labelled
    // "integration" — the mechanism's name leaking into an operator-facing
    // label. D269 moved the declaration into core; `tab` is visual grouping
    // again, and nothing may read it to decide placement.
    for (const rel of [
      'components/settings/NodeAddonsSettingsPanel.tsx',
      'lib/settings-forwarding.ts',
      'pages/IntegrationDetail.tsx',
    ]) {
      expect(code(read(rel)), `${rel} treats a tab id as placement`).not.toMatch(
        /tab\s*===\s*['"]integration['"]|SURFACE_SECTION_TAB/,
      )
    }
  })
})
