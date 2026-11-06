import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_PATH,
  findViolations,
  isBespokeInstanceList,
} from '../check-one-instances-list.js'
import { isProductSource, loadBaseline, ROOT, readSources, walk } from '../lib/family-baseline.js'
import { itRealTree } from './lib/real-tree.js'

const UI = 'packages/addon-admin-ui/src/'
const file = (p: string, text: string) => ({ path: UI + p, text })

const STORAGE_PAGE = file(
  'pages/system/Storage.tsx',
  "import { DataTable } from '@camstack/ui-library'\nconst upsert = useStorageUpsertLocation()\n",
)
const LLM_EDITOR = file(
  'pages/system/AiProfileEditor.tsx',
  'await system.trpcClient.llm.upsertProfile.mutate({ profile })\n',
)
const MESH_PAGE = file(
  'pages/system/MeshNetworks.tsx',
  'import { DataTable } from "x"\nconst leave = useMeshNetworkLeave()\n',
)
const BASELINE = {
  families: {
    storage: { [STORAGE_PAGE.path]: 'P6d' },
    llm: { [LLM_EDITOR.path]: 'P6b' },
    tailscale: { [MESH_PAGE.path]: 'P6f' },
  },
}

describe('check-one-instances-list', () => {
  it('flags a CRUD call of a family, with or without a surface, and a surface with a family mutation', () => {
    expect(isBespokeInstanceList(STORAGE_PAGE)).toBe(true)
    expect(isBespokeInstanceList(LLM_EDITOR)).toBe(true)
    expect(isBespokeInstanceList(MESH_PAGE)).toBe(true)
  })

  it('leaves alone the instances table itself, a read-only list, and a list of something else', () => {
    expect(
      isBespokeInstanceList(
        file('components/instances/InstancesTable.tsx', 'DataTable\nuseStorageUpsertLocation()'),
      ),
    ).toBe(false)
    expect(
      isBespokeInstanceList(
        file('pages/Readonly.tsx', 'import { DataTable } from "x"\nuseStorageListLocations()'),
      ),
    ).toBe(false)
    expect(
      isBespokeInstanceList(
        file('pages/system/Users.tsx', 'DataTable\nuseUserManagementCreateUser()'),
      ),
    ).toBe(false)
    expect(
      isBespokeInstanceList(
        file('pages/Locations.tsx', 'DataTable\nuseDeviceManagerAddLocation()'),
      ),
    ).toBe(false)
    expect(
      isBespokeInstanceList({
        path: 'packages/other/src/x.tsx',
        text: 'useStorageUpsertLocation()',
      }),
    ).toBe(false)
  })

  it('is green on a baseline that lists every page', () => {
    expect(findViolations([STORAGE_PAGE, LLM_EDITOR, MESH_PAGE], BASELINE)).toEqual([])
  })

  it('is red when a baseline line is removed', () => {
    const found = findViolations([STORAGE_PAGE, LLM_EDITOR, MESH_PAGE], {
      families: { storage: BASELINE.families.storage, llm: BASELINE.families.llm },
    })
    expect(found).toHaveLength(1)
    expect(found[0]?.where).toBe(MESH_PAGE.path)
  })

  it('is red on a stale entry (the page moved to InstancesTable)', () => {
    const found = findViolations([STORAGE_PAGE, LLM_EDITOR], BASELINE)
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('remove the line')
  })

  it('is red on a new bespoke page', () => {
    const fresh = file(
      'pages/system/OidcThing.tsx',
      'trpcClient.oidcConnections.createConnection.mutate({})',
    )
    const found = findViolations([STORAGE_PAGE, LLM_EDITOR, MESH_PAGE, fresh], BASELINE)
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('InstancesTable')
  })

  itRealTree('holds on the committed tree and baseline', { timeout: 120_000 }, () => {
    const files = walk(path.join(ROOT, 'packages/addon-admin-ui/src'), isProductSource)
    expect(findViolations(readSources(files), loadBaseline(BASELINE_PATH))).toEqual([])
  })
})
