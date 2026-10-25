#!/usr/bin/env tsx
/**
 * D694 — event-media plane URLs that name an event owner MUST be able to carry
 * the event's generation (`/g/<deviceId>/<recordAt>`), and slim / search
 * emitters MUST mint through `mediaOwnerUrl` rather than a bare
 * `${base}/${id}` that neither names the table nor survives a reused rowid.
 *
 * Accepting the scoped form on the server is not enough if every new stamp
 * still ships the bare path — this guard pins both halves.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const failures: string[] = []

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

const mint = read('packages/addon-post-analysis/src/pipeline-analytics/media-file-url.ts')
const parse = read('packages/addon-post-analysis/src/pipeline-analytics/event-media-handler.ts')
const facade = read('packages/addon-post-analysis/src/pipeline-analytics/analytics-query-facade.ts')
const search = read(
  'packages/addon-post-analysis/src/pipeline-analytics/pipeline/object-embedding-selection.ts',
)

if (!mint.includes('MEDIA_GENERATION_SEGMENT')) {
  failures.push('media-file-url.ts: missing MEDIA_GENERATION_SEGMENT — generation mint is gone')
}
if (!mint.includes('EventMediaGeneration')) {
  failures.push('media-file-url.ts: missing EventMediaGeneration type')
}
if (!/mediaOwnerUrl[\s\S]*MEDIA_GENERATION_SEGMENT/.test(mint)) {
  failures.push('media-file-url.ts: mediaOwnerUrl must mint /g/<deviceId>/<recordAt>')
}

if (!parse.includes('MEDIA_GENERATION_SEGMENT')) {
  failures.push('event-media-handler.ts: parser must know the generation segment')
}
if (!parse.includes('generation:')) {
  failures.push('event-media-handler.ts: MediaAddress must carry generation')
}

// The closed bare stamp: `${base}/${e.id}` neither names the table nor the
// generation. Slim projections go through mediaOwnerUrl.
if (/mediaUrl:\s*`\$\{base\}\/\$\{e\.id\}`/.test(facade)) {
  failures.push(
    'analytics-query-facade.ts: bare `${base}/${e.id}` mediaUrl stamp is back — ' +
      'use mediaOwnerUrl with owner type + generation (D482 + D694)',
  )
}
if (!facade.includes('mediaOwnerUrl(')) {
  failures.push('analytics-query-facade.ts: withMediaUrl must call mediaOwnerUrl')
}

if (!search.includes('mediaOwnerUrl(') || !search.includes('mediaFileUrl(')) {
  failures.push(
    'object-embedding-selection.ts: resolveSearchThumbnailUrl must mint via ' +
      'mediaFileUrl / mediaOwnerUrl (not a bare `${base}/${id}`)',
  )
}
if (/return `\$\{input\.baseUrl\}\/\$\{/.test(search)) {
  failures.push('object-embedding-selection.ts: bare `${baseUrl}/${id}` stamp is back — D482/D694')
}

if (failures.length > 0) {
  console.error('check-event-media-generation-url FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('check-event-media-generation-url: ok')
