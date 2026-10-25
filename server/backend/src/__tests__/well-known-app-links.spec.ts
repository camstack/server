import { describe, it, expect } from 'vitest'

import { buildAppLinkFiles, parseCertFingerprints } from '../core/app-links/well-known-app-links'

describe('buildAppLinkFiles', () => {
  it('the AASA claims ONLY the viewer mount — admin UI taps stay in the browser', () => {
    const { appleAppSiteAssociation } = buildAppLinkFiles([])
    const json = JSON.stringify(appleAppSiteAssociation)
    expect(json).toContain('/viewer/camstack/*')
    expect(json).toContain('C3F24V5NS5.com.apocaliss92.camstack')
    expect(json).not.toContain('"/*"')
  })

  it('assetlinks carries both packages and the provided fingerprints verbatim', () => {
    const fp =
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
    const { assetLinks } = buildAppLinkFiles([fp])
    expect(assetLinks).toHaveLength(2)
    expect(assetLinks[0]).toMatchObject({
      target: { package_name: 'com.apocaliss92.camstack', sha256_cert_fingerprints: [fp] },
    })
  })
})

describe('parseCertFingerprints', () => {
  const FP =
    'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99'
  it('uppercases, trims, and drops junk', () => {
    expect(parseCertFingerprints(` ${FP} , nonsense`)).toEqual([FP.toUpperCase()])
  })
  it('absent env means empty, never a throw', () => {
    expect(parseCertFingerprints(undefined)).toEqual([])
  })
})
