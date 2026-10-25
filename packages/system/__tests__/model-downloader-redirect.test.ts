/**
 * Task 7B security RED — downloadFile redirect hops must be policy-checked.
 *
 * Default callers stay compatible (open follow). A supplied policy is applied
 * to the initial URL and every Location hop; rejected hops are never fetched.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { downloadFile } from '../src/download/model-downloader.js'

function dest(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-redir-'))
  return path.join(dir, 'artifact.bin')
}

afterEach(() => {
  // Best-effort: each test removes its own dest parent in the assertion path.
})

describe('downloadFile redirect policy', () => {
  it('keeps default follow-compatible behavior when no policy is supplied', async () => {
    const destPath = dest()
    const fetched: string[] = []
    await downloadFile('https://huggingface.co/file.bin', destPath, {
      fetchImpl: async (input) => {
        fetched.push(String(input))
        return new Response(Buffer.from('ok-default'), { status: 200 })
      },
    })
    expect(fs.readFileSync(destPath, 'utf8')).toBe('ok-default')
    expect(fetched).toEqual(['https://huggingface.co/file.bin'])
    fs.rmSync(path.dirname(destPath), { recursive: true, force: true })
  })

  it('validates the initial URL and every redirect hop before the next fetch', async () => {
    const destPath = dest()
    const fetched: string[] = []
    const seen: string[] = []
    const policy = (url: URL) => {
      seen.push(url.href)
      if (url.hostname !== 'huggingface.co' && url.hostname !== 'cas-bridge.xethub.hf.co') {
        throw new Error(`redirect host not allowed: ${url.hostname}`)
      }
    }
    await downloadFile('https://huggingface.co/resolve/pin/model.xml', destPath, {
      redirectPolicy: policy,
      maxRedirects: 4,
      fetchImpl: async (input) => {
        const url = String(input)
        fetched.push(url)
        if (url === 'https://huggingface.co/resolve/pin/model.xml') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://cas-bridge.xethub.hf.co/blob/model.xml' },
          })
        }
        return new Response(Buffer.from('xml-bytes'), { status: 200 })
      },
    })
    expect(fetched).toEqual([
      'https://huggingface.co/resolve/pin/model.xml',
      'https://cas-bridge.xethub.hf.co/blob/model.xml',
    ])
    expect(seen).toEqual(fetched)
    expect(fs.readFileSync(destPath, 'utf8')).toBe('xml-bytes')
    fs.rmSync(path.dirname(destPath), { recursive: true, force: true })
  })

  it('resolves a relative Location against the current hop', async () => {
    const destPath = dest()
    const fetched: string[] = []
    await downloadFile('https://huggingface.co/resolve/pin/a.xml', destPath, {
      redirectPolicy: (url) => {
        if (url.origin !== 'https://huggingface.co') throw new Error('bad origin')
      },
      fetchImpl: async (input) => {
        fetched.push(String(input))
        if (String(input).endsWith('/a.xml')) {
          return new Response(null, { status: 301, headers: { Location: '/resolve/pin/b.xml' } })
        }
        return new Response(Buffer.from('rel-ok'), { status: 200 })
      },
    })
    expect(fetched[1]).toBe('https://huggingface.co/resolve/pin/b.xml')
    fs.rmSync(path.dirname(destPath), { recursive: true, force: true })
  })

  it('never fetches a rejected hop (localhost, metadata IP, lookalike, http, userinfo, unknown host)', async () => {
    const cases = [
      'http://huggingface.co/x',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://huggingface.co.evil.example/x',
      'https://user:pass@huggingface.co/x',
      'https://evil-cdn.example/x',
    ]
    for (const location of cases) {
      const destPath = dest()
      const fetched: string[] = []
      await expect(
        downloadFile('https://huggingface.co/start', destPath, {
          redirectPolicy: (url) => {
            if (url.protocol !== 'https:') throw new Error('http downgrade')
            if (url.username || url.password) throw new Error('userinfo')
            if (url.hostname !== 'huggingface.co')
              throw new Error(`host not allowed: ${url.hostname}`)
          },
          fetchImpl: async (input) => {
            fetched.push(String(input))
            return new Response(null, { status: 302, headers: { Location: location } })
          },
        }),
      ).rejects.toThrow(/host|http|userinfo|allowed|downgrade/i)
      expect(fetched).toEqual(['https://huggingface.co/start'])
      expect(fs.existsSync(destPath)).toBe(false)
      fs.rmSync(path.dirname(destPath), { recursive: true, force: true })
    }
  })

  it('rejects a missing Location, a redirect loop and an over-budget hop count', async () => {
    const destPath = dest()
    await expect(
      downloadFile('https://huggingface.co/a', destPath, {
        redirectPolicy: () => undefined,
        fetchImpl: async () => new Response(null, { status: 302 }),
      }),
    ).rejects.toThrow(/location/i)

    await expect(
      downloadFile('https://huggingface.co/loop', destPath, {
        redirectPolicy: () => undefined,
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'https://huggingface.co/loop' },
          }),
      }),
    ).rejects.toThrow(/loop/i)

    await expect(
      downloadFile('https://huggingface.co/a', destPath, {
        redirectPolicy: () => undefined,
        maxRedirects: 1,
        fetchImpl: async (input) =>
          new Response(null, {
            status: 302,
            headers: {
              Location:
                String(input) === 'https://huggingface.co/a'
                  ? 'https://huggingface.co/b'
                  : 'https://huggingface.co/c',
            },
          }),
      }),
    ).rejects.toThrow(/redirect/i)
    fs.rmSync(path.dirname(destPath), { recursive: true, force: true })
  })

  it('cleans the staging tmp file when a later hop is rejected', async () => {
    const destPath = dest()
    await expect(
      downloadFile('https://huggingface.co/start', destPath, {
        redirectPolicy: (url) => {
          if (url.hostname !== 'huggingface.co') throw new Error('host not allowed')
        },
        fetchImpl: async (input) => {
          if (String(input).includes('/start')) {
            return new Response(null, {
              status: 302,
              headers: { Location: 'https://127.0.0.1/secret' },
            })
          }
          return new Response(Buffer.from('stolen'), { status: 200 })
        },
      }),
    ).rejects.toThrow(/host/i)
    expect(fs.existsSync(destPath)).toBe(false)
    expect(fs.existsSync(`${destPath}.downloading`)).toBe(false)
    fs.rmSync(path.dirname(destPath), { recursive: true, force: true })
  })
})
