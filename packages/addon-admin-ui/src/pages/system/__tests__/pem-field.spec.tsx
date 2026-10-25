/**
 * Identity → Certificates → HTTPS certificate → Upload: a certificate and key can be PICKED as
 * files as well as pasted. The file is read in the browser into the same
 * field — the upload action still receives PEM strings — and a file that is
 * not the PEM the field wants says so inline.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { checkPem, readPemFile } from '../pem-file'
import { PemField } from '../PemField'

const CERT = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----\n'
const KEY = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49\n-----END PRIVATE KEY-----\n'
const EC_KEY = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIB\n-----END EC PRIVATE KEY-----\n'

describe('checkPem', () => {
  it('accepts a certificate, a chain, and every unencrypted private-key flavour', () => {
    expect(checkPem('certificate', CERT)).toBeNull()
    expect(checkPem('certificate', `${CERT}${CERT}`)).toBeNull()
    expect(checkPem('privateKey', KEY)).toBeNull()
    expect(checkPem('privateKey', EC_KEY)).toBeNull()
    expect(checkPem('privateKey', KEY.replace(/PRIVATE KEY/g, 'RSA PRIVATE KEY'))).toBeNull()
    expect(checkPem('ca', CERT)).toBeNull()
  })

  it('treats an empty field as not filled in, not as an error', () => {
    expect(checkPem('certificate', '  \n')).toBeNull()
    expect(checkPem('privateKey', '')).toBeNull()
  })

  it('names a key dropped on the certificate field, and the reverse', () => {
    expect(checkPem('certificate', KEY)).toMatch(/private key, not a certificate/)
    expect(checkPem('privateKey', CERT)).toMatch(/certificate, not a private key/)
  })

  it('rejects non-PEM, a combined cert+key file, and a password-protected key', () => {
    expect(checkPem('certificate', 'MIIBszCCAVmgAwIBAgIUQ')).toMatch(/Not a PEM certificate/)
    expect(checkPem('privateKey', 'garbage')).toMatch(/Not a PEM private key/)
    expect(checkPem('certificate', `${CERT}${KEY}`)).toMatch(/also contains a private key/)
    expect(checkPem('privateKey', KEY.replace(/PRIVATE KEY/g, 'ENCRYPTED PRIVATE KEY'))).toMatch(
      /password-protected/,
    )
  })

  it('reads a chosen file as text', async () => {
    expect(await readPemFile(new File([CERT], 'leaf.pem'))).toBe(CERT)
  })
})

function Harness({ kind }: { readonly kind: 'certificate' | 'privateKey' }) {
  const [value, setValue] = useState('')
  return <PemField kind={kind} label="Field" value={value} onChange={setValue} />
}

describe('PemField', () => {
  it('reads a picked file into the field and shows the file name', async () => {
    render(<Harness kind="certificate" />)

    fireEvent.change(screen.getByTestId('pem-certificate-file'), {
      target: { files: [new File([CERT], 'camstack.local.pem')] },
    })

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(CERT))
    expect(screen.getByTestId('pem-certificate-file-name')).toHaveTextContent('camstack.local.pem')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows an inline error for a file that is not the PEM the field wants', async () => {
    render(<Harness kind="privateKey" />)

    fireEvent.change(screen.getByTestId('pem-privateKey-file'), {
      target: { files: [new File([CERT], 'oops.crt')] },
    })

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/certificate, not a private key/),
    )
    expect(screen.getByTestId('pem-privateKey-file-name')).toHaveTextContent('oops.crt')
  })

  it('keeps paste working, and pasting clears the picked file name', async () => {
    render(<Harness kind="privateKey" />)
    fireEvent.change(screen.getByTestId('pem-privateKey-file'), {
      target: { files: [new File([KEY], 'key.pem')] },
    })
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(KEY))

    fireEvent.change(screen.getByRole('textbox'), { target: { value: EC_KEY } })

    expect(screen.getByRole('textbox')).toHaveValue(EC_KEY)
    expect(screen.queryByTestId('pem-privateKey-file-name')).toBeNull()
  })
})
