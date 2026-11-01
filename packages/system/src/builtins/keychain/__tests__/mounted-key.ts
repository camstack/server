import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { MOUNTED_KEY_FILE_NAME, PREVIOUS_MOUNTED_KEY_FILE_NAME } from '../key-sources.js'
import { encodeKeyMaterial } from '../keychain-crypto.js'

/** Put key material where the operator would mount it, under a spec's own secrets dir. */
export async function mountKey(
  secretsDir: string,
  key: Buffer | string,
  which: 'primary' | 'previous' = 'primary',
): Promise<string> {
  await fsp.mkdir(secretsDir, { recursive: true })
  const file = path.join(
    secretsDir,
    which === 'primary' ? MOUNTED_KEY_FILE_NAME : PREVIOUS_MOUNTED_KEY_FILE_NAME,
  )
  await fsp.writeFile(file, typeof key === 'string' ? key : encodeKeyMaterial(key))
  return file
}
