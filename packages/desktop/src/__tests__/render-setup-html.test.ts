import { describe, expect, it } from 'vitest'
import type { SetupInitial } from '../setup/render-setup-html'
import { renderSetupHtml } from '../setup/render-setup-html'

function initial(overrides: Partial<SetupInitial> = {}): SetupInitial {
  return {
    product: 'node',
    role: 'hub',
    hubMode: 'auto',
    hubAddress: '',
    hubPort: 4443,
    agentName: '',
    viewerHubUrl: '',
    ...overrides,
  }
}

function viewerInitial(overrides: Partial<SetupInitial> = {}): SetupInitial {
  return initial({ product: 'viewer', role: 'viewer', ...overrides })
}

/**
 * Everything the operator can see or submit — markup and script, but not the
 * shared stylesheet, whose selectors cover both products' fields.
 */
function documentBody(html: string): string {
  return html.slice(html.indexOf('</style></head>'))
}

describe('renderSetupHtml — the node product', () => {
  it('offers the two roles this product can actually run', () => {
    const html = renderSetupHtml(initial())
    expect(html).toContain('value="hub"')
    expect(html).toContain('value="agent"')
  })

  it('never offers the viewer role, which ships as its own product', () => {
    const html = renderSetupHtml(initial())
    expect(html).not.toContain('value="viewer"')
    expect(html).not.toMatch(/viewer/i)
  })

  it('pre-selects the persisted role', () => {
    expect(renderSetupHtml(initial({ role: 'agent' }))).toContain(
      '<input type="radio" name="role" value="agent" checked />',
    )
    expect(renderSetupHtml(initial({ role: 'hub' }))).toContain(
      '<input type="radio" name="role" value="hub" checked />',
    )
  })

  it('falls back to hub when the store still holds the retired viewer role', () => {
    expect(renderSetupHtml(initial({ role: 'viewer' }))).toContain(
      '<input type="radio" name="role" value="hub" checked />',
    )
  })

  it('offers the agent its hub connection and no cluster secret (it is paired from the hub, D857)', () => {
    const html = renderSetupHtml(initial({ role: 'agent' }))
    expect(html).toContain('id="agentConfig" style="display:block"')
    expect(html).not.toContain('id="secret"')
    expect(html).not.toMatch(/cluster secret/i)
  })

  it('offers no join token or secret: the hub pairs the agent (D857)', () => {
    const html = renderSetupHtml(initial({ role: 'agent' }))
    expect(html).not.toContain('id="joinToken"')
    const body = documentBody(html)
    expect(body).toContain('agentName: name })')
    expect(body).not.toMatch(/secret|joinToken/)
  })

  it('escapes persisted values instead of injecting them', () => {
    const html = renderSetupHtml(initial({ role: 'agent', agentName: '"><script>x()</script>' }))
    expect(html).not.toContain('<script>x()')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
  })
})

describe('renderSetupHtml — the viewer product', () => {
  it('asks for the hub address and nothing else', () => {
    const html = renderSetupHtml(viewerInitial({ viewerHubUrl: 'https://192.168.10.9:4443' }))
    expect(html).toContain('id="viewerHub"')
    expect(html).toContain('value="https://192.168.10.9:4443"')
    expect(html).not.toContain('id="agentConfig"')
    expect(html).not.toContain('id="hub"')
    expect(html).not.toContain('id="port"')
    expect(html).not.toContain('id="name"')
  })

  it('has no role picker at all — the role is the product', () => {
    const html = renderSetupHtml(viewerInitial())
    expect(html).not.toContain('name="role"')
    expect(html).not.toContain('value="agent"')
    expect(html).not.toContain('value="hub"')
  })

  it('never offers the viewer a cluster secret', () => {
    const body = documentBody(renderSetupHtml(viewerInitial()))
    expect(body).not.toMatch(/secret/i)
    expect(body).not.toMatch(/password/i)
  })

  it('never promises the viewer a discovery that does not exist', () => {
    const body = documentBody(renderSetupHtml(viewerInitial()))
    expect(body).not.toMatch(/discover/i)
    expect(body).not.toMatch(/\bauto\b/i)
    expect(body).toMatch(/does not search the network/i)
  })

  it('escapes the persisted address instead of injecting it', () => {
    const html = renderSetupHtml(viewerInitial({ viewerHubUrl: '"><script>x()</script>' }))
    expect(html).not.toContain('<script>x()')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
  })

  it('saves the address under the viewer role', () => {
    const html = renderSetupHtml(viewerInitial())
    expect(html).toContain("role: 'viewer'")
    expect(html).toContain('camstackSetup.save')
  })
})
