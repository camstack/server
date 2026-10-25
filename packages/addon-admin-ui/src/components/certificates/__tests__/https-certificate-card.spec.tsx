// @vitest-environment jsdom
/**
 * The HTTPS certificate (generated local CA / uploaded pair, D873) is managed
 * under Identity → Certificates: the card renders there, with the status, the
 * CA download and the revert / use-stored actions, and Network no longer
 * carries it (only a hint that links here).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  tls: { current: undefined as unknown },
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })
  return {
    ...actual,
    useLocalNetworkGetTlsStatus: () => ({ data: h.tls.current, isError: false }),
    useLocalNetworkRegenerateCertificate: mutation,
    useLocalNetworkRevertToGeneratedCertificate: mutation,
    useLocalNetworkUseStoredUploadedCertificate: mutation,
    useLocalNetworkUploadCertificate: mutation,
  }
})
vi.mock('../../settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: () => <div data-testid="lan-http-panel" />,
}))

import { LocalAccessPage } from '../../../pages/system/LocalAccess'
import { NetworkPage } from '../../../pages/system/Network'
import { HttpsCertificateCard } from '../HttpsCertificateCard'

function renderAt(node: React.ReactNode, path = '/') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/system/identity" element={<div data-testid="identity-page" />} />
          <Route path="*" element={node} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('HTTPS certificate placement', () => {
  it('renders the certificate card with its actions under Identity → Certificates', () => {
    h.tls.current = {
      mode: 'uploaded',
      caCertPem: 'PEM',
      validTo: null,
      leafFingerprintSha256: null,
      caFingerprintSha256: null,
      sans: [],
      storedUpload: null,
    }
    renderAt(<HttpsCertificateCard />)
    expect(screen.getByText('Uploaded')).toBeTruthy()
    expect(screen.getByText('Download CA')).toBeTruthy()
    expect(screen.getByText('Revert to generated')).toBeTruthy()
  })

  it('offers the stored upload again from the generated mode', () => {
    h.tls.current = {
      mode: 'generated',
      caCertPem: 'PEM',
      validTo: null,
      leafFingerprintSha256: null,
      caFingerprintSha256: null,
      sans: [],
      storedUpload: { validTo: '2030-01-01T00:00:00Z', hasCa: true },
    }
    renderAt(<HttpsCertificateCard />)
    expect(screen.getAllByText('Use uploaded certificate').length).toBeGreaterThan(0)
  })

  it('Network → Local access no longer carries the certificate, only a link to it', () => {
    h.tls.current = undefined
    renderAt(<LocalAccessPage />)
    expect(screen.getByTestId('lan-http-panel')).toBeTruthy()
    expect(screen.queryByText('Download CA')).toBeNull()
    expect(screen.queryByText('Regenerate')).toBeNull()
    const link = screen.getByRole('link', { name: 'Identity → Certificates' })
    expect(link.getAttribute('href')).toBe('/system/identity?tab=certificates')
  })

  it('the retired Network certificate tab redirects to Identity → Certificates', () => {
    renderAt(<NetworkPage />, '/system/network?tab=certificate')
    expect(screen.getByTestId('identity-page')).toBeTruthy()
  })
})
