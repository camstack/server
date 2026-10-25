/**
 * Task 7B security — plugin catalog download allow-list is the observed pin set.
 */
import { describe, expect, it } from 'vitest'
import {
  assertPluginCatalogDownloadUrl,
  PLUGIN_CATALOG_DOWNLOAD_REDIRECT_HOSTS,
} from '../plugin-catalog/plugin-catalog-download-policy.js'

describe('assertPluginCatalogDownloadUrl', () => {
  it('allows only the HTTPS hosts observed from the pinned revision', () => {
    expect(PLUGIN_CATALOG_DOWNLOAD_REDIRECT_HOSTS).toEqual(['huggingface.co', 'us.aws.cdn.hf.co'])
    expect(() =>
      assertPluginCatalogDownloadUrl(
        new URL('https://huggingface.co/scrypted/plugin-models/resolve/x'),
        0,
      ),
    ).not.toThrow()
    expect(() =>
      assertPluginCatalogDownloadUrl(new URL('https://us.aws.cdn.hf.co/xet-bridge-us/abc'), 1),
    ).not.toThrow()
  })

  it('rejects localhost, metadata IP, lookalike, http, userinfo and unknown hosts', () => {
    const rejected = [
      'http://huggingface.co/x',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://huggingface.co.evil.example/x',
      'https://user:pass@huggingface.co/x',
      'https://cas-bridge.xethub.hf.co/x',
      'https://s3.amazonaws.com/bucket/x',
      'https://evil-cdn.example/x',
    ]
    for (const href of rejected) {
      expect(() => assertPluginCatalogDownloadUrl(new URL(href), 1), href).toThrow(
        /host|http|userinfo|downgrade|allowed/i,
      )
    }
  })
})
