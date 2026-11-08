import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RemoteControl } from './remote-control'

describe('RemoteControl icon', () => {
  it('renders the remote-control svg nodes and honours className', () => {
    const html = renderToStaticMarkup(<RemoteControl className="h-4 w-4" />)
    expect(html).toContain('<svg')
    expect(html).toMatch(/class="[^"]*lucide-remote-control[^"]*h-4 w-4"/)
    expect(html).toContain('<rect')
    expect(html).toContain('width="10"')
    expect(html).toContain('<circle')
    expect(html).toContain('r="2.5"')
    for (const d of ['M10 14h.01', 'M14 14h.01', 'M10 18h.01', 'M14 18h.01']) {
      expect(html).toContain(`d="${d}"`)
    }
  })
})
