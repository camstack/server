import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ALL_CAPABILITY_DEFINITIONS } from '../../packages/types/src/generated/capability-router-map.js'
import { builderMountedCapNames } from '../../packages/system/src/kernel/cap-router-builder.js'
import { findMountDisagreements, generatedMountKeys } from '../check-cap-mount-codegen-agrees.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const keys = generatedMountKeys(
  fs.readFileSync(path.join(ROOT, 'server/backend/src/api/trpc/generated-cap-mounts.ts'), 'utf8'),
)

describe('check-cap-mount-codegen-agrees', () => {
  it('the real tree has no disagreement', () => {
    expect(
      findMountDisagreements(ALL_CAPABILITY_DEFINITIONS, keys, builderMountedCapNames()),
    ).toEqual([])
  })

  it('the runtime builder mounts integrationInstances', () => {
    expect(builderMountedCapNames()).toContain('integrationInstances')
  })

  it('flags a public cap that resolves to skip', () => {
    const def = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === 'integration-instances')
    if (!def) throw new Error('integration-instances missing')
    const skipped = { ...def, mount: { kind: 'skip' as const } }
    const out = findMountDisagreements([skipped], keys, [])
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('integration-instances')
  })

  it('flags a runtime-mounted cap the codegen lacks', () => {
    expect(findMountDisagreements([], new Set(), ['ghostCap'])[0]).toContain('ghostCap')
  })
})
