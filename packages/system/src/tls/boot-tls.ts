import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CertOptions,
  type EnsureTlsResult,
  ensureTlsCert,
  loadTlsCert,
  replaceUnconstrainedLocalCa,
  type TlsCertPair,
} from './cert-manager.js'
import { readTlsMode, writeTlsMode } from './tls-status.js'

/** The certificate source a booting listener serves. */
export type BootTlsMode = 'generated' | 'uploaded'

export interface BootTls {
  readonly mode: BootTlsMode
  readonly pair: TlsCertPair
  /**
   * The `ensureTlsCert` outcome — present only for a generated certificate,
   * so a reissue reaches the operator as an alert. `undefined` when an
   * uploaded certificate is served: the hub never evaluates, let alone
   * reissues, a certificate the operator supplied.
   */
  readonly ensured: EnsureTlsResult | undefined
  /**
   * True when the mode marker said `uploaded` but the files were gone, so
   * the node fell back to its generated certificate. The caller logs it:
   * a certificate source that changed under the operator is never silent.
   */
  readonly uploadedMissing: boolean
  /**
   * True when an UNCONSTRAINED local CA kept beside an uploaded certificate was replaced
   * by a constrained one (D873). The served pair is untouched; agents' leaves chain to
   * the new CA and clients that trusted the old one must re-trust. The caller logs it.
   */
  readonly dormantCaReplaced: boolean
}

/**
 * Decide what the listener serves at boot. The admin UI (Network → Local
 * access) is the only way to set a certificate (D726): it either leaves the
 * hub on its generated local-CA leaf (D227) or uploads one, recorded by the
 * `tls/mode` marker. An uploaded certificate is served verbatim — running it
 * through `ensureTlsCert` would replace it on the first restart, because a
 * leaf the local root did not issue is one of that rule's reissue triggers.
 */
export async function prepareBootTls(dataDir: string, options?: CertOptions): Promise<BootTls> {
  const certPath = join(dataDir, 'tls', 'camstack.crt')
  const keyPath = join(dataDir, 'tls', 'camstack.key')
  const marked = readTlsMode(dataDir)
  if (marked === 'uploaded' && existsSync(certPath) && existsSync(keyPath)) {
    return {
      mode: 'uploaded',
      pair: loadTlsCert(certPath, keyPath),
      ensured: undefined,
      uploadedMissing: false,
      dormantCaReplaced: await replaceUnconstrainedLocalCa(dataDir, options),
    }
  }
  const uploadedMissing = marked === 'uploaded'
  if (uploadedMissing) writeTlsMode(dataDir, 'generated')
  const ensured = await ensureTlsCert(dataDir, options)
  return {
    mode: 'generated',
    pair: loadTlsCert(ensured.certPath, ensured.keyPath),
    ensured,
    uploadedMissing,
    dormantCaReplaced: false,
  }
}
