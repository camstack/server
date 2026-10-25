import { describe, expect, it } from 'vitest'
import {
  classifyProbeOutcome,
  connectionLabel,
  nextProbeDelayMs,
  PROBE_MAX_DELAY_MS,
  PROBE_MIN_DELAY_MS,
  renderCertTrustPage,
  renderUnreachablePage,
  renderViewerStartingPage,
  shouldLoadViewerUi,
  TRUST_ACCEPT_URL,
} from '../role/viewer-connection'

describe('nextProbeDelayMs', () => {
  it('starts at 1s and doubles', () => {
    expect(nextProbeDelayMs(0)).toBe(PROBE_MIN_DELAY_MS)
    expect(nextProbeDelayMs(1)).toBe(2_000)
    expect(nextProbeDelayMs(2)).toBe(4_000)
    expect(nextProbeDelayMs(4)).toBe(16_000)
  })

  it('is bounded at 30s and never gives up', () => {
    expect(nextProbeDelayMs(5)).toBe(PROBE_MAX_DELAY_MS)
    expect(nextProbeDelayMs(50)).toBe(PROBE_MAX_DELAY_MS)
    expect(nextProbeDelayMs(5_000)).toBe(PROBE_MAX_DELAY_MS)
  })
})

describe('classifyProbeOutcome', () => {
  it('keeps "hub up but viewer starting" distinct from "unreachable"', () => {
    expect(classifyProbeOutcome({ kind: 'viewer-starting' })).toBe('viewer-starting')
    expect(classifyProbeOutcome({ kind: 'unreachable', detail: 'ECONNREFUSED' })).toBe(
      'unreachable',
    )
  })

  it('maps the remaining outcomes', () => {
    expect(classifyProbeOutcome({ kind: 'reachable' })).toBe('connected')
    expect(classifyProbeOutcome({ kind: 'cert-rejected' })).toBe('cert-not-trusted')
  })
})

describe('shouldLoadViewerUi', () => {
  it('loads the UI when a fallback page recovers', () => {
    expect(shouldLoadViewerUi('unreachable', 'connected')).toBe(true)
    expect(shouldLoadViewerUi('viewer-starting', 'connected')).toBe(true)
    expect(shouldLoadViewerUi('cert-not-trusted', 'connected')).toBe(true)
    expect(shouldLoadViewerUi('connecting', 'connected')).toBe(true)
  })

  it('never reloads a window that already holds a live session', () => {
    expect(shouldLoadViewerUi('connected', 'connected')).toBe(false)
  })

  it('never loads the UI for a failure state', () => {
    expect(shouldLoadViewerUi('connected', 'unreachable')).toBe(false)
    expect(shouldLoadViewerUi('connecting', 'viewer-starting')).toBe(false)
  })
})

describe('connectionLabel', () => {
  it('names each state distinctly', () => {
    const labels = (
      ['connecting', 'connected', 'unreachable', 'viewer-starting', 'cert-not-trusted'] as const
    ).map(connectionLabel)
    expect(new Set(labels).size).toBe(labels.length)
    expect(connectionLabel('connected')).toBe('Connection: connected')
  })
})

describe('shell pages', () => {
  it('names the hub and the last error on the unreachable page', () => {
    const html = renderUnreachablePage('https://192.168.10.9:4443', 'ECONNREFUSED')
    expect(html).toContain('https://192.168.10.9:4443')
    expect(html).toContain('ECONNREFUSED')
  })

  it('says the hub is UP on the viewer-starting page', () => {
    const html = renderViewerStartingPage('https://192.168.10.9:4443')
    expect(html).toContain('viewer-ui')
    expect(html).toMatch(/hub is up/i)
    expect(html).not.toMatch(/cannot reach/i)
  })

  it('first contact shows the fingerprint to compare out of band', () => {
    const html = renderCertTrustPage({
      hubUrl: 'https://192.168.10.9:4443',
      hostname: '192.168.10.9',
      hadPin: false,
      presentedIssuerFingerprint: 'sha256/ABC=',
      leafSubjectName: 'camstack-hub',
      leafIssuerName: 'CamStack Local CA',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
      verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
    })
    expect(html).toContain('sha256/ABC=')
    expect(html).toMatch(/first use/i)
    expect(html).toContain('Local access certificate')
  })

  it('a changed root gets a harder page with no acceptance offered', () => {
    const html = renderCertTrustPage({
      hubUrl: 'https://192.168.10.9:4443',
      hostname: '192.168.10.9',
      hadPin: true,
      presentedIssuerFingerprint: 'sha256/XYZ=',
      leafSubjectName: 'camstack-hub',
      leafIssuerName: 'Someone Else',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
      verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
    })
    expect(html).toMatch(/CHANGED/)
    expect(html).toMatch(/will not offer to accept/i)
    expect(html).not.toMatch(/trust on first use/i)
  })

  /**
   * The button is the whole difference between a page that EXPLAINS the
   * refusal and a page that lets the operator act on it. Slice 1 shipped only
   * the explanation, so a hub with its own local CA — which is every hub —
   * stopped the viewer at a wall with no way past it.
   */
  it('offers the accept action on a first contact, pointing at the intercepted url', () => {
    const html = renderCertTrustPage({
      hubUrl: 'https://192.168.10.9:4443',
      hostname: '192.168.10.9',
      hadPin: false,
      presentedIssuerFingerprint: 'sha256/ABC=',
      leafSubjectName: 'camstack-hub',
      leafIssuerName: 'CamStack Local CA',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
      verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
    })
    expect(html).toContain(`href="${TRUST_ACCEPT_URL}"`)
  })

  /**
   * And NEVER on the changed-root page. That page's whole value is that it
   * refuses — an accept button on it would turn a detected substitution into
   * one click, which is the opposite of what pinning is for.
   */
  it('never offers acceptance once a pin exists', () => {
    const html = renderCertTrustPage({
      hubUrl: 'https://192.168.10.9:4443',
      hostname: '192.168.10.9',
      hadPin: true,
      presentedIssuerFingerprint: 'sha256/XYZ=',
      leafSubjectName: 'camstack-hub',
      leafIssuerName: 'Someone Else',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
      verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
    })
    expect(html).not.toContain(TRUST_ACCEPT_URL)
  })

  it('escapes hostile text rather than injecting it into the page', () => {
    const html = renderUnreachablePage('https://h', '<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})
