/**
 * File sha256 — a local copy of the private `computeSha256` at
 * model-downloader.ts (not exported from @camstack/system), streamed so it
 * never buffers a multi-GB artifact.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
