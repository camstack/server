/**
 * TabbedSettingsForm — flatten-tabs behaviour.
 *
 * The device-detail "Detection Pipeline" top tab folds the former
 * "Detection" (zones) and "Detection pipeline" sub-tabs into ONE flat
 * surface. `flattenTabs` forces the flat render path (no SchemaTabBar)
 * even when the sections span multiple `tab` ids, while every section
 * stays visible.
 *
 * FormBuilder + FormSaveBar are stubbed so the test asserts the grouping
 * decision (tab bar vs flat) and the section set handed to the renderer
 * without pulling in the full field-rendering stack. SchemaTabBar is left
 * real — it renders a <button> per tab, which is what we assert on.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigUISchemaWithValues } from '../../../types/config-ui'

vi.mock('../FormBuilder', () => ({
  FormBuilder: ({ schema }: { readonly schema: ConfigUISchemaWithValues }) => (
    <div data-testid="form-builder">
      {schema.sections.map((s) => (
        <div key={s.id} data-testid="section" data-title={s.title} data-id={s.id} />
      ))}
    </div>
  ),
}))

vi.mock('../FormSaveBar', () => ({
  FormSaveBar: () => <div data-testid="save-bar" />,
}))

// Import AFTER the mocks are declared.
import { TabbedSettingsForm } from '../TabbedSettingsForm'

const noop = () => {}

/**
 * Two contributed sections on two different `tab` ids — mirrors the
 * detection-pipeline top-tab body (zones section + pipeline section) that
 * previously produced the "Detection" / "Detection pipeline" sub-tabs.
 */
function twoTabSchema(): ConfigUISchemaWithValues {
  return {
    tabs: [
      { id: 'detection-pipeline', label: 'Detection pipeline', icon: 'wrench', order: 0 },
      { id: 'zones', label: 'Detection', icon: 'wrench', order: 1 },
    ],
    sections: [
      {
        id: 'pipeline-object-detection',
        title: 'Object Detection',
        tab: 'detection-pipeline',
        fields: [],
      },
      { id: 'zones', title: 'Detection Zones', tab: 'zones', fields: [] },
    ],
  }
}

function renderForm(flattenTabs: boolean) {
  return render(
    <TabbedSettingsForm
      schema={twoTabSchema()}
      values={{}}
      pendingKeys={[]}
      onChange={noop}
      onSave={noop}
      onDiscard={noop}
      disabled={false}
      flattenTabs={flattenTabs}
    />,
  )
}

describe('TabbedSettingsForm — flattenTabs', () => {
  it('renders an inner sub-tab bar for a multi-tab schema by default', () => {
    renderForm(false)
    // The tab bar renders one button per declared tab (FormBuilder +
    // FormSaveBar are stubbed and contribute no buttons of their own).
    expect(screen.getByRole('button', { name: /Detection pipeline/ })).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    // Only the active tab's section is mounted at a time.
    expect(screen.getAllByTestId('section')).toHaveLength(1)
  })

  it('renders every section flat with no sub-tab bar when flattenTabs is set', () => {
    renderForm(true)
    // No SchemaTabBar buttons at all.
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    // Both sections render together in one flat FormBuilder.
    const sections = screen.getAllByTestId('section')
    expect(sections).toHaveLength(2)
    expect(sections.map((s) => s.getAttribute('data-title'))).toEqual([
      'Object Detection',
      'Detection Zones',
    ])
  })

  // ── a tab that blinks out must not move the operator ──────────────────────
  //
  // The schema is re-fetched on a 2.5 s poll and rebuilt from every contributing
  // provider. When one of them is slow or answers nothing for a beat, its tab is
  // briefly absent — and the old fallback read that as "the operator is on a tab
  // that does not exist" and switched to the first one. The visible effect is
  // the operator's report: the page content jumps to a different (shorter) tab
  // and leaves white space where the taller one was, right as the save banner
  // appears, because a change is exactly what triggers the re-fetch.
  //
  // A tab that has existed once belongs to the operator until they leave it.
  describe('a requested tab that disappears for a beat', () => {
    function schemaWith(tabIds: readonly string[]): ConfigUISchemaWithValues {
      return {
        tabs: tabIds.map((id, i) => ({ id, label: id, icon: 'wrench', order: i })),
        sections: tabIds.map((id) => ({
          id: `sec-${id}`,
          title: id,
          tab: id,
          fields: [],
        })),
      }
    }

    it('keeps the operator on it instead of switching to the first tab', () => {
      const { rerender } = render(
        <TabbedSettingsForm
          schema={schemaWith(['alpha', 'beta', 'omega'])}
          values={{}}
          pendingKeys={[]}
          onChange={noop}
          onAction={async () => undefined}
          onSave={noop}
          onDiscard={noop}
          disabled={false}
          activeSubTab="omega"
          onSubTabChange={noop}
        />,
      )
      expect(screen.getByTestId('section').getAttribute('data-id')).toBe('sec-omega')

      // The slow provider missed this poll — its tab is gone for one render.
      rerender(
        <TabbedSettingsForm
          schema={schemaWith(['alpha', 'beta'])}
          values={{}}
          pendingKeys={[]}
          onChange={noop}
          onAction={async () => undefined}
          onSave={noop}
          onDiscard={noop}
          disabled={false}
          activeSubTab="omega"
          onSubTabChange={noop}
        />,
      )
      // NOT alpha's content. Nothing is better than somewhere else: the tab
      // comes back on the next poll and the operator never moved.
      expect(screen.queryAllByTestId('section')).toHaveLength(0)
    })

    it('still falls back for a tab that has NEVER existed — a stale URL is not a blink', () => {
      render(
        <TabbedSettingsForm
          schema={schemaWith(['alpha', 'beta'])}
          values={{}}
          pendingKeys={[]}
          onChange={noop}
          onAction={async () => undefined}
          onSave={noop}
          onDiscard={noop}
          disabled={false}
          activeSubTab="from-an-old-bookmark"
          onSubTabChange={noop}
        />,
      )
      expect(screen.getByTestId('section').getAttribute('data-id')).toBe('sec-alpha')
    })
  })
})
