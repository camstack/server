/**
 * D878 - rows holding a keychain secret are written by their owner only.
 * Fixtures pin each rule on a throwaway tree; the last test runs the real one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scan } from '../check-keychain-backed-rows.ts'
import { itRealTree } from './lib/real-tree.js'

const OWNER_OK = 'const m = makeSecretMarker(ref)\nawait secrets.put(ref, value)\n'
const roots: string[] = []

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kb-rows-'))
  roots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const OWNERS = {
  'packages/addon-ai/src/record-kinds.ts': 'apiKey: z.string().optional().meta({ secret: true })',
  'packages/addon-ai/src/profile-store.ts': "const c = 'ai:llm-profiles'",
  'packages/system/src/auth/totp-manager.ts': OWNER_OK,
  'packages/system/src/builtins/local-auth/auth-schema.ts':
    "export const USER_TOTP_COLLECTION = 'user_totp'",
}

describe('check-keychain-backed-rows', () => {
  it('passes when only the owners name the collections', () => {
    expect(scan(tree(OWNERS))).toEqual([])
  })

  it('flags an owner that stopped writing a marker', () => {
    const root = tree({
      ...OWNERS,
      'packages/system/src/auth/totp-manager.ts': 'await store.insert(x)',
    })
    expect(scan(root).map((f) => `${f.rule}:${f.file}`)).toContain(
      'owner-writes-marker:packages/system/src/auth/totp-manager.ts',
    )
  })

  it('flags an LLM profile kind whose apiKey stopped being a secret field', () => {
    const root = tree({
      ...OWNERS,
      'packages/addon-ai/src/record-kinds.ts': 'apiKey: z.string().optional()',
    })
    expect(scan(root).map((f) => `${f.rule}:${f.file}`)).toContain(
      'owner-writes-marker:packages/addon-ai/src/record-kinds.ts',
    )
  })

  it('flags a second writer of user_totp', () => {
    const root = tree({
      ...OWNERS,
      'packages/addon-x/src/import.ts':
        "await store.insert.mutate({ collection: 'user_totp', record })",
    })
    expect(scan(root).map((f) => `${f.rule}:${f.file}`)).toEqual([
      'single-writer:packages/addon-x/src/import.ts',
    ])
  })

  it('flags a second writer of the LLM profiles, ignores comments and tests', () => {
    const root = tree({
      ...OWNERS,
      'packages/addon-x/src/a.ts': "// reads 'ai:llm-profiles' in a comment",
      'packages/addon-x/src/__tests__/a.spec.ts': "const c = 'ai:llm-profiles'",
      'server/backend/src/b.ts': "const c = 'ai:llm-profiles'",
    })
    expect(scan(root).map((f) => f.file)).toEqual(['server/backend/src/b.ts'])
  })

  itRealTree('the real tree is clean', { timeout: 180_000 }, () => {
    expect(scan(resolve(import.meta.dirname, '../..'))).toEqual([])
  })
})
