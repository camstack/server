// @vitest-environment jsdom
/**
 * The Actions tab must survive a PHONE.
 *
 * The contract: ALWAYS stack (this tab never has a full-width page), and let
 * the cluster WRAP. Class-contract assertions because jsdom has no layout.
 * Quick add presets are gone — only On trigger / Buttons remain.
 */
import { DeviceType } from '@camstack/types'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NotificationRuleActions, type RuleActionDevice } from '../NotificationRuleActions'
import { EMPTY_RULE_ACTIONS } from '../notification-rule-actions'

const DEVICES: readonly RuleActionDevice[] = [
  { id: 1, name: 'Alarm', type: DeviceType.AlarmPanel },
  { id: 2, name: 'Baby monitor Siren', type: DeviceType.Siren },
  { id: 3, name: 'Camera camera Carol Siren', type: DeviceType.Siren },
  { id: 4, name: 'Camera camera principale Siren', type: DeviceType.Siren },
]

function headerRowFor(container: HTMLElement, heading: string): HTMLElement {
  const headings = [...container.querySelectorAll('h4')]
  const h4 = headings.find((node) => node.textContent === heading)
  if (h4 === undefined) throw new Error(`heading not found: ${heading}`)
  const textBlock = h4.parentElement
  const row = textBlock?.parentElement
  if (!(row instanceof HTMLElement)) throw new Error(`no header row for: ${heading}`)
  return row
}

function renderTab() {
  return render(
    <NotificationRuleActions
      value={EMPTY_RULE_ACTIONS}
      onChange={() => {}}
      devices={DEVICES}
      devicesState="answered"
      sequences={[]}
      onCreateSequence={async () => 'new-id'}
    />,
  )
}

describe.each([
  ['On trigger'],
  ['Buttons on the notification'],
])('Actions tab header — %s', (heading) => {
  it('ALWAYS stacks — a viewport sm: row crushes the text in the 512 px dialog', () => {
    const { container } = renderTab()
    const row = headerRowFor(container, heading)
    expect(row.className).toContain('flex-col')
    expect(row.className).not.toContain('sm:flex-row')
    expect(row.className).not.toContain('justify-between')
  })

  it('wraps the action cluster instead of letting it overflow the screen', () => {
    const { container } = renderTab()
    const row = headerRowFor(container, heading)
    const cluster = row.lastElementChild
    expect(cluster?.className).toContain('flex-wrap')
  })
})

describe('Actions tab — Quick add is gone', () => {
  it('does not render a Quick add heading or preset cluster', () => {
    const { container } = renderTab()
    const headings = [...container.querySelectorAll('h4')].map((n) => n.textContent)
    expect(headings).not.toContain('Quick add')
  })
})
