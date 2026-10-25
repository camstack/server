import { describe, expect, it } from 'vitest'
import { findTokenFileLookups } from '../check-no-token-file-lookup.js'

describe('check-no-token-file-lookup', () => {
  it('flags the implicit token-file lookups the scripts used to carry', () => {
    const old = [
      "const TOKEN_FILE = opt('token-file', join(REPO, 'scratchpad', '.tok'))",
      "const TOK = process.env.CAMSTACK_TOKEN || readScratch('.tok')",
      "path.resolve('scratchpad/.tok')",
      "const named = env['CAMSTACK_ADMIN_TOKEN_FILE']",
      'return path.join(dir, `${slugForServer(serverUrl)}.admin-token`)',
      'findAdminTokenFile(server)',
    ].join('\n')
    expect(findTokenFileLookups('x.mjs', old)).toHaveLength(6)
  })

  it('lets prose and the shared resolver through', () => {
    const fine = [
      '// the old scratchpad/.tok file is gone',
      ' * `--token-file` is an explicit override only',
      "const { token } = await resolveHubAuth({ tokenFile: args['token-file'] })",
    ].join('\n')
    expect(findTokenFileLookups('x.mjs', fine)).toEqual([])
  })
})
