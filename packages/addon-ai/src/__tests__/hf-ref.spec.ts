/**
 * `hf-ref` — the Hugging Face reference parser/resolver.
 *
 * NO REAL NETWORK. Every resolve test drives an injected `fetchFn`; the
 * fixtures are transcribed from live probes of huggingface.co (2026-08-15) so
 * the error taxonomy matches what HF actually sends:
 *   - a GATED repo answers 401 with `x-error-code: GatedRepo`
 *   - an UNKNOWN repo answers 401 with NO `x-error-code` (HF refuses to leak
 *     whether a private repo exists) — the two are only distinguishable by
 *     that header, which is why the code reads it instead of the status
 *   - a missing file in a public repo answers 404 `EntryNotFound`
 *   - a `resolve` HEAD answers 302 carrying `x-linked-size` and
 *     `x-linked-etag` (the LFS sha256)
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_MODEL_BYTES,
  parseHfRef,
  quantizationOf,
  resolveHfReference,
  shardInfoOf,
} from '../runtime/hf-ref.js'
import { isMmprojFile } from '../runtime/mmproj.js'

// ── parse ────────────────────────────────────────────────────────────────

describe('parseHfRef', () => {
  it('accepts a full resolve URL', () => {
    const out = parseHfRef(
      'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    )
    expect(out).toEqual({
      ok: true,
      ref: {
        kind: 'file',
        repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
        revision: 'main',
        filePath: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
      },
    })
  })

  it('accepts the browser blob URL and the ?download=true suffix', () => {
    const blob = parseHfRef(
      'https://huggingface.co/unsloth/X-GGUF/blob/main/sub/dir/X-Q4_K_M.gguf?download=true',
    )
    expect(blob.ok).toBe(true)
    if (!blob.ok) return
    expect(blob.ref).toEqual({
      kind: 'file',
      repo: 'unsloth/X-GGUF',
      revision: 'main',
      filePath: 'sub/dir/X-Q4_K_M.gguf',
    })
  })

  it('accepts the bare org/repo/file.gguf form', () => {
    const out = parseHfRef('unsloth/Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf')
    expect(out).toEqual({
      ok: true,
      ref: {
        kind: 'file',
        repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
        revision: 'main',
        filePath: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf',
      },
    })
  })

  it('accepts org/repo and org/repo:QUANT', () => {
    expect(parseHfRef('unsloth/Qwen3.6-35B-A3B-GGUF')).toEqual({
      ok: true,
      ref: { kind: 'repo', repo: 'unsloth/Qwen3.6-35B-A3B-GGUF', revision: 'main' },
    })
    expect(parseHfRef('unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M')).toEqual({
      ok: true,
      ref: {
        kind: 'repo',
        repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
        revision: 'main',
        quant: 'UD-Q4_K_M',
      },
    })
  })

  it('carries a non-default revision from the URL', () => {
    const out = parseHfRef('https://huggingface.co/a/b/resolve/v1.2/m.gguf')
    expect(out.ok && out.ref.revision).toBe('v1.2')
  })

  it.each([
    ['https://example.com/a/b/resolve/main/m.gguf', 'not-huggingface'],
    ['http://huggingface.co.evil.test/a/b/resolve/main/m.gguf', 'not-huggingface'],
    ['https://huggingface.co/a/b/resolve/main/model.safetensors', 'not-gguf'],
    ['a/b/model.safetensors', 'not-gguf'],
    ['', 'malformed'],
    ['justonesegment', 'malformed'],
    ['a/b/../../etc/passwd.gguf', 'malformed'],
    ['https://huggingface.co/a/b', 'malformed'],
  ])('rejects %s as %s', (input, code) => {
    const out = parseHfRef(input)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe(code)
    expect(out.error.message.length).toBeGreaterThan(0)
  })
})

// ── filename helpers ─────────────────────────────────────────────────────

describe('quantizationOf / shardInfoOf', () => {
  it.each([
    ['Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', 'UD-Q4_K_M'],
    ['Qwen3.6-35B-A3B-MXFP4_MOE.gguf', 'MXFP4_MOE'],
    ['Qwen3.6-35B-A3B-UD-IQ2_XXS.gguf', 'UD-IQ2_XXS'],
    ['qwen2.5-1.5b-instruct-q4_k_m.gguf', 'Q4_K_M'],
    ['Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf', 'BF16'],
    // Qwen's own GGUF repos name the unquantized file `…-fp16.gguf`.
    ['qwen2.5-1.5b-instruct-fp16.gguf', 'FP16'],
    ['something-with-no-known-tag.gguf', ''],
  ])('reads the quantization of %s', (file, quant) => {
    expect(quantizationOf(file)).toBe(quant)
  })

  it('reads shard coordinates and ignores unsharded names', () => {
    expect(shardInfoOf('X-BF16-00001-of-00002.gguf')).toEqual({
      stem: 'X-BF16',
      index: 1,
      total: 2,
    })
    expect(shardInfoOf('X-BF16.gguf')).toBeNull()
  })
})

// ── resolve fixtures ─────────────────────────────────────────────────────

interface TreeFile {
  readonly path: string
  readonly size: number
  readonly oid: string
}

function treeResponse(files: readonly TreeFile[]): Response {
  const body = files.map((f) => ({
    type: 'file',
    path: f.path,
    size: f.size,
    lfs: { oid: f.oid, size: f.size },
  }))
  return new Response(JSON.stringify(body), { status: 200 })
}

function headResponse(sizeBytes: number, sha256: string): Response {
  return new Response(null, {
    status: 200,
    headers: { 'x-linked-size': String(sizeBytes), 'x-linked-etag': `"${sha256}"` },
  })
}

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)

/** A repo with one text GGUF, sized well under the ceiling. */
const SINGLE: readonly TreeFile[] = [{ path: 'model-Q4_K_M.gguf', size: 1_000, oid: SHA_A }]

/** The shape that motivated this work: many quantizations + mmproj companions. */
const MULTI: readonly TreeFile[] = [
  { path: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf', size: 2_000, oid: SHA_A },
  { path: 'Qwen3.6-35B-A3B-UD-Q5_K_M.gguf', size: 3_000, oid: SHA_B },
  { path: 'mmproj-F16.gguf', size: 500, oid: SHA_C },
  { path: 'mmproj-F32.gguf', size: 900, oid: SHA_C },
]

function fetcher(handlers: { tree?: () => Response; head?: () => Response }): {
  fetchFn: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url}`)
    if (url.includes('/api/models/')) return (handlers.tree ?? (() => treeResponse(SINGLE)))()
    return (handlers.head ?? (() => headResponse(1_000, SHA_A)))()
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, calls }
}

describe('resolveHfReference', () => {
  it('resolves a single-GGUF repo without asking the operator to choose', async () => {
    const { fetchFn, calls } = fetcher({})
    const out = await resolveHfReference('acme/solo-GGUF', { fetchFn })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.resolution.main).toEqual({
      url: 'https://huggingface.co/acme/solo-GGUF/resolve/main/model-Q4_K_M.gguf',
      filename: 'model-Q4_K_M.gguf',
      sizeBytes: 1_000,
      sha256: SHA_A,
    })
    expect(out.resolution.quantization).toBe('Q4_K_M')
    expect(out.resolution.purpose).toBe('text')
    expect(out.resolution.extras).toEqual([])
    expect(out.resolution.totalBytes).toBe(1_000)
    // The ceiling is enforced BEFORE any byte is fetched: a HEAD, never a GET.
    expect(calls.some((c) => c.startsWith('HEAD '))).toBe(true)
    expect(calls.some((c) => c.startsWith('GET https://huggingface.co/acme'))).toBe(false)
  })

  it('REFUSES a multi-quantization repo instead of guessing, and names the candidates', async () => {
    const { fetchFn } = fetcher({ tree: () => treeResponse(MULTI) })
    const out = await resolveHfReference('unsloth/Qwen3.6-35B-A3B-GGUF', { fetchFn })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('ambiguous')
    expect(out.error.candidates).toEqual(['UD-Q4_K_M', 'UD-Q5_K_M'])
    expect(out.error.message).toContain('UD-Q4_K_M')
  })

  it('picks the tagged quantization and attaches the mmproj for a vision repo', async () => {
    const { fetchFn } = fetcher({
      tree: () => treeResponse(MULTI),
      head: () => headResponse(2_000, SHA_A),
    })
    const out = await resolveHfReference('unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M', { fetchFn })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.resolution.main.filename).toBe('Qwen3.6-35B-A3B-UD-Q4_K_M.gguf')
    expect(out.resolution.purpose).toBe('vision')
    // F16 preferred over F32 — a declared, reported choice, not a silent one.
    expect(out.resolution.extras).toEqual([
      {
        url: 'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/mmproj-F16.gguf',
        filename: 'mmproj-F16.gguf',
        sizeBytes: 500,
        sha256: SHA_C,
      },
    ])
    expect(out.resolution.totalBytes).toBe(2_500)
  })

  /**
   * The invariant that makes the refusal USEFUL rather than merely honest: the
   * error tells the operator to retype `<repo>:<TAG>`, so every TAG it printed
   * has to be one that then resolves. A live probe of
   * `Qwen/Qwen2.5-1.5B-Instruct-GGUF` printed `qwen2.5-1.5b-instruct-fp16.gguf`
   * as a tag and that string did not parse — the advice was broken.
   */
  it('resolves EVERY tag it offered in the ambiguous error', async () => {
    const files: readonly TreeFile[] = [
      { path: 'X-UD-Q4_K_M.gguf', size: 10, oid: SHA_A },
      { path: 'X-fp16.gguf', size: 20, oid: SHA_B },
      { path: 'weird-name-no-tag.gguf', size: 30, oid: SHA_C },
    ]
    const { fetchFn } = fetcher({ tree: () => treeResponse(files) })
    const first = await resolveHfReference('acme/multi-GGUF', { fetchFn })
    expect(first.ok).toBe(false)
    if (first.ok) return
    const tags = first.error.candidates ?? []
    expect(tags).toEqual(['UD-Q4_K_M', 'FP16', 'weird-name-no-tag.gguf'])

    for (const tag of tags) {
      const sized = files.find((f) =>
        f.path.toUpperCase().includes(tag.toUpperCase().replace('.GGUF', '')),
      )
      const retry = await resolveHfReference(`acme/multi-GGUF:${tag}`, {
        fetchFn: fetcher({
          tree: () => treeResponse(files),
          head: () => headResponse(sized?.size ?? 0, sized?.oid ?? SHA_A),
        }).fetchFn,
      })
      expect(retry.ok, `tag "${tag}" was offered but does not resolve`).toBe(true)
    }
  })

  it('matches a quantization tag case-insensitively', async () => {
    const { fetchFn } = fetcher({
      tree: () => treeResponse(MULTI),
      head: () => headResponse(2_000, SHA_A),
    })
    const out = await resolveHfReference('unsloth/Qwen3.6-35B-A3B-GGUF:ud-q4_k_m', { fetchFn })
    expect(out.ok && out.resolution.main.filename).toBe('Qwen3.6-35B-A3B-UD-Q4_K_M.gguf')
  })

  it('names the available tags when the requested quantization does not exist', async () => {
    const { fetchFn } = fetcher({ tree: () => treeResponse(MULTI) })
    const out = await resolveHfReference('unsloth/Qwen3.6-35B-A3B-GGUF:Q4_0', { fetchFn })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('file-not-found')
    expect(out.error.candidates).toEqual(['UD-Q4_K_M', 'UD-Q5_K_M'])
  })

  it('collects every shard of a split GGUF', async () => {
    const sharded: readonly TreeFile[] = [
      { path: 'BF16/X-BF16-00001-of-00002.gguf', size: 10, oid: SHA_A },
      { path: 'BF16/X-BF16-00002-of-00002.gguf', size: 20, oid: SHA_B },
    ]
    const { fetchFn } = fetcher({
      tree: () => treeResponse(sharded),
      head: () => headResponse(10, SHA_A),
    })
    const out = await resolveHfReference('acme/split-GGUF:BF16', { fetchFn })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.resolution.main.filename).toBe('X-BF16-00001-of-00002.gguf')
    expect(out.resolution.extras.map((e) => e.filename)).toEqual(['X-BF16-00002-of-00002.gguf'])
    expect(out.resolution.totalBytes).toBe(30)
  })

  it('refuses a split GGUF whose shards are not all present', async () => {
    const sharded: readonly TreeFile[] = [
      { path: 'X-BF16-00001-of-00003.gguf', size: 10, oid: SHA_A },
      { path: 'X-BF16-00002-of-00003.gguf', size: 20, oid: SHA_B },
    ]
    const { fetchFn } = fetcher({ tree: () => treeResponse(sharded) })
    const out = await resolveHfReference('acme/split-GGUF:BF16', { fetchFn })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('incomplete-shards')
    expect(out.error.message).toContain('00003')
  })

  it('enforces the size ceiling on the TOTAL, and names both numbers', async () => {
    const { fetchFn } = fetcher({
      tree: () => treeResponse(MULTI),
      head: () => headResponse(2_000, SHA_A),
    })
    const out = await resolveHfReference('unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M', {
      fetchFn,
      maxBytes: 2_400, // main 2000 alone fits; main + mmproj 500 does not
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('too-large')
    expect(out.error.message).toContain('2500')
    expect(out.error.message).toContain('2400')
  })

  it('defaults the ceiling to DEFAULT_MAX_MODEL_BYTES', async () => {
    const huge: readonly TreeFile[] = [
      { path: 'huge-Q8_0.gguf', size: DEFAULT_MAX_MODEL_BYTES + 1, oid: SHA_A },
    ]
    const { fetchFn } = fetcher({ tree: () => treeResponse(huge) })
    const out = await resolveHfReference('acme/huge-GGUF', { fetchFn })
    expect(out.ok && 'never').not.toBe('never')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('too-large')
  })

  it('reports a gated repo as gated, and says CamStack cannot download it', async () => {
    const { fetchFn } = fetcher({
      tree: () =>
        new Response('{}', {
          status: 401,
          headers: { 'x-error-code': 'GatedRepo', 'x-error-message': 'Access is restricted.' },
        }),
    })
    const out = await resolveHfReference('meta-llama/Whatever-GGUF', { fetchFn })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('gated')
    expect(out.error.message).toContain('ungated')
    // No secret travels through the environment: the message never points there.
    expect(out.error.message).not.toContain('HF_TOKEN')
    expect(out.error.message).not.toContain('environment')
  })

  it('reports an unknown repo as not-found even though HF answers 401', async () => {
    const { fetchFn } = fetcher({
      tree: () =>
        new Response('{}', {
          status: 401,
          headers: { 'x-error-message': 'Invalid username or password.' },
        }),
    })
    const out = await resolveHfReference('acme/nope-GGUF', { fetchFn })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('repo-not-found')
    expect(out.error.message).not.toContain('HF_TOKEN')
  })

  it('reports a named file that is missing from an existing repo', async () => {
    const { fetchFn } = fetcher({ tree: () => treeResponse(SINGLE) })
    const out = await resolveHfReference('acme/solo-GGUF/absent.gguf', { fetchFn })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('file-not-found')
    expect(out.error.message).toContain('absent.gguf')
  })

  it('reports a repo with no GGUF at all', async () => {
    const { fetchFn } = fetcher({ tree: () => treeResponse([]) })
    const out = await resolveHfReference('acme/pytorch-only', { fetchFn })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('not-gguf')
  })

  it('never sends an Authorization header, even with HF_TOKEN in the environment', async () => {
    const seen: Array<Record<string, string>> = []
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string> | undefined) })
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/models/')) return treeResponse(SINGLE)
      return headResponse(1_000, SHA_A)
    }) as unknown as typeof fetch
    const before = { hf: process.env['HF_TOKEN'], hub: process.env['HUGGING_FACE_HUB_TOKEN'] }
    process.env['HF_TOKEN'] = 'hf_env_secret'
    process.env['HUGGING_FACE_HUB_TOKEN'] = 'hf_env_secret'
    try {
      await resolveHfReference('acme/solo-GGUF', { fetchFn })
    } finally {
      if (before.hf === undefined) delete process.env['HF_TOKEN']
      else process.env['HF_TOKEN'] = before.hf
      if (before.hub === undefined) delete process.env['HUGGING_FACE_HUB_TOKEN']
      else process.env['HUGGING_FACE_HUB_TOKEN'] = before.hub
    }
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((h) => h['Authorization'] === undefined)).toBe(true)
  })

  it('fails when the HEAD size contradicts the size the tree declared', async () => {
    const { fetchFn } = fetcher({ head: () => headResponse(999_999, SHA_A) })
    const out = await resolveHfReference('acme/solo-GGUF', { fetchFn })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('size-mismatch')
  })

  it('reports a gated file discovered only at HEAD time', async () => {
    const { fetchFn } = fetcher({
      head: () => new Response(null, { status: 401, headers: { 'x-error-code': 'GatedRepo' } }),
    })
    const out = await resolveHfReference('acme/solo-GGUF', { fetchFn })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('gated')
  })

  it('turns a transport failure into a network error rather than throwing', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const out = await resolveHfReference('acme/solo-GGUF', { fetchFn })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('network')
    expect(out.error.message).toContain('ECONNREFUSED')
  })

  it('never resolves an mmproj file as the model itself', async () => {
    const onlyProj: readonly TreeFile[] = [{ path: 'mmproj-F16.gguf', size: 10, oid: SHA_C }]
    const { fetchFn } = fetcher({ tree: () => treeResponse(onlyProj) })
    const out = await resolveHfReference('acme/proj-only', { fetchFn })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error.code).toBe('not-gguf')
  })

  /**
   * Prism ML names the projector `<model>-mmproj-Q8_0.gguf`. Read as a
   * PREFIX only, it was a second model candidate (an untagged reference went
   * `ambiguous`) and never the projector (a tagged one resolved text-only).
   */
  const SUFFIXED_PROJ: readonly TreeFile[] = [
    { path: 'Bonsai-8B-Q1_0.gguf', size: 1_000, oid: SHA_A },
    { path: 'Bonsai-8B-mmproj-Q8_0.gguf', size: 300, oid: SHA_C },
  ]

  it('attaches a projector whose name CONTAINS the mmproj token', async () => {
    const { fetchFn } = fetcher({ tree: () => treeResponse(SUFFIXED_PROJ) })
    const out = await resolveHfReference('prism-ml/Bonsai-8B-gguf:Q1_0', { fetchFn })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.resolution.main.filename).toBe('Bonsai-8B-Q1_0.gguf')
    expect(out.resolution.purpose).toBe('vision')
    expect(out.resolution.extras.map((e) => e.filename)).toEqual(['Bonsai-8B-mmproj-Q8_0.gguf'])
  })

  it('never offers a suffixed projector as a model candidate', async () => {
    const { fetchFn } = fetcher({ tree: () => treeResponse(SUFFIXED_PROJ) })
    const out = await resolveHfReference('prism-ml/Bonsai-8B-gguf', { fetchFn })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.resolution.main.filename).toBe('Bonsai-8B-Q1_0.gguf')
    expect(out.resolution.purpose).toBe('vision')
  })
})

describe('isMmprojFile', () => {
  it.each([
    ['mmproj-F16.gguf', true],
    ['mmproj.gguf', true],
    ['Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf', true],
    ['llava-v1.6-mistral-7b_mmproj_f16.gguf', true],
    ['model.mmproj-f16.gguf', true],
    ['sub/dir/X-MMPROJ-F16.gguf', true],
    ['mmprojfp16.gguf', true],
    ['mmproj-f16.gguf', true],
    ['X-mmprojf32.gguf', true],
    ['X-mmprojbf16.gguf', true],
    ['X-mmprojq8_0.gguf', true],
    ['X-mmprojector-f16.gguf', false],
    ['mmprojector.gguf', false],
    ['X-mmprojfp16x.gguf', false],
    ['Qwen3-VL-8B-Instruct-Q4_K_M.gguf', false],
    ['mmproj/Qwen3-VL-8B-Q4_K_M.gguf', false],
  ])('%s → %s', (name, expected) => {
    expect(isMmprojFile(name)).toBe(expected)
  })
})
