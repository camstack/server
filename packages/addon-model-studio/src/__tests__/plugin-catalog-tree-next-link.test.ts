/**
 * Task 7B security RED — pagination Link rel=next must not be an SSRF oracle.
 *
 * A production change that would fail this test: following an absolute or
 * relative next-link to another host, another repo, another revision, http,
 * userinfo, or a lookalike origin.
 */
import { describe, expect, it } from 'vitest'
import {
  fetchPluginCatalogRemoteTree,
  resolvePluginCatalogTreeNextLink,
} from '../plugin-catalog/plugin-catalog-tree-drift.js'
import {
  PLUGIN_CATALOG_HF_REPO,
  PLUGIN_CATALOG_HF_REVISION,
} from '../plugin-catalog/plugin-catalog-yolo-manifest.js'

const CURRENT = `https://huggingface.co/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${PLUGIN_CATALOG_HF_REVISION}?recursive=true&expand=true`
const VALID_NEXT = `https://huggingface.co/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${PLUGIN_CATALOG_HF_REVISION}?recursive=true&expand=true&cursor=abc`

function link(url: string): string {
  return `<${url}>; rel="next"`
}

describe('resolvePluginCatalogTreeNextLink', () => {
  it('accepts an https huggingface.co tree URL for the same repo and revision', () => {
    expect(
      resolvePluginCatalogTreeNextLink(link(VALID_NEXT), CURRENT, PLUGIN_CATALOG_HF_REVISION),
    ).toBe(VALID_NEXT)
  })

  it('resolves a same-origin relative next path against the current tree URL', () => {
    const relative = `/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${PLUGIN_CATALOG_HF_REVISION}?cursor=page2`
    expect(
      resolvePluginCatalogTreeNextLink(link(relative), CURRENT, PLUGIN_CATALOG_HF_REVISION),
    ).toBe(
      `https://huggingface.co/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${PLUGIN_CATALOG_HF_REVISION}?cursor=page2`,
    )
  })

  it('rejects protocol downgrade, userinfo, lookalike hosts, protocol-relative and foreign paths', () => {
    const rejected = [
      `http://huggingface.co/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${PLUGIN_CATALOG_HF_REVISION}?cursor=x`,
      `https://evil-user@huggingface.co/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${PLUGIN_CATALOG_HF_REVISION}?cursor=x`,
      `https://huggingface.co.evil.example/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${PLUGIN_CATALOG_HF_REVISION}?cursor=x`,
      `//evil.example/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${PLUGIN_CATALOG_HF_REVISION}?cursor=x`,
      `https://huggingface.co/api/models/other/repo/tree/${PLUGIN_CATALOG_HF_REVISION}?cursor=x`,
      `https://huggingface.co/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/main?cursor=x`,
      `https://127.0.0.1/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${PLUGIN_CATALOG_HF_REVISION}?cursor=x`,
    ]
    for (const url of rejected) {
      expect(() =>
        resolvePluginCatalogTreeNextLink(link(url), CURRENT, PLUGIN_CATALOG_HF_REVISION),
      ).toThrow(/link|origin|https|revision|repo|userinfo|ssrf/i)
    }
  })

  it('returns undefined when the header has no rel=next', () => {
    expect(
      resolvePluginCatalogTreeNextLink('', CURRENT, PLUGIN_CATALOG_HF_REVISION),
    ).toBeUndefined()
    expect(
      resolvePluginCatalogTreeNextLink(
        '<https://huggingface.co/>; rel="prev"',
        CURRENT,
        PLUGIN_CATALOG_HF_REVISION,
      ),
    ).toBeUndefined()
  })
})

describe('fetchPluginCatalogRemoteTree refuses HTTP redirects', () => {
  it('uses no-follow redirect mode and never fetches Location, even if allow-listed', async () => {
    const fetched: string[] = []
    const modes: Array<RequestRedirect | undefined> = []
    await expect(
      fetchPluginCatalogRemoteTree({
        revision: PLUGIN_CATALOG_HF_REVISION,
        retryDelayMs: 0,
        maxRetries: 1,
        fetchImpl: async (input, init) => {
          fetched.push(String(input))
          modes.push(init?.redirect)
          return new Response(null, {
            status: 302,
            headers: {
              Location: `https://huggingface.co/api/models/${PLUGIN_CATALOG_HF_REPO}/tree/${PLUGIN_CATALOG_HF_REVISION}?stolen=1`,
            },
          })
        },
      }),
    ).rejects.toThrow(/redirect|3xx|302/i)
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toMatch(
      new RegExp(
        `^https://huggingface\\.co/api/models/${PLUGIN_CATALOG_HF_REPO.replace('/', '\\/')}/tree/`,
      ),
    )
    expect(fetched[0]).not.toContain('stolen=1')
    expect(modes[0] === 'manual' || modes[0] === 'error').toBe(true)
  })

  it('does not fetch a non-allow-listed Location such as 127.0.0.1', async () => {
    const fetched: string[] = []
    await expect(
      fetchPluginCatalogRemoteTree({
        revision: PLUGIN_CATALOG_HF_REVISION,
        retryDelayMs: 0,
        maxRetries: 1,
        fetchImpl: async (input) => {
          fetched.push(String(input))
          return new Response(null, {
            status: 307,
            headers: { Location: 'https://127.0.0.1/steal' },
          })
        },
      }),
    ).rejects.toThrow(/redirect|3xx|307/i)
    expect(fetched.some((url) => url.includes('127.0.0.1'))).toBe(false)
  })
})

describe('fetchPluginCatalogRemoteTree refuses a poisoned next link', () => {
  it('does not fetch a rejected next URL', async () => {
    const fetched: string[] = []
    await expect(
      fetchPluginCatalogRemoteTree({
        revision: PLUGIN_CATALOG_HF_REVISION,
        retryDelayMs: 0,
        maxRetries: 1,
        fetchImpl: async (input) => {
          const url = String(input)
          fetched.push(url)
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: {
              Link: `<https://127.0.0.1/steal>; rel="next"`,
            },
          })
        },
      }),
    ).rejects.toThrow(/link|origin|https|ssrf|127/i)
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toMatch(
      new RegExp(
        `^https://huggingface\\.co/api/models/${PLUGIN_CATALOG_HF_REPO.replace('/', '\\/')}/tree/`,
      ),
    )
    expect(fetched.some((url) => url.includes('127.0.0.1'))).toBe(false)
  })
})
