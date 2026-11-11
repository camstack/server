import { describe, expect, it } from 'vitest'
import { findViolations, type SourceFile } from '../check-action-block-importers.js'

const LIST = "import { ActionList } from '../automation/ActionList'\n"
const STEP = "import {\n  CommandStep,\n} from '../../pages/build/flow/CommandStep'\n"

function file(path: string, text: string): SourceFile {
  return { path, text }
}

describe('check-action-block-importers', () => {
  it('accepts a listed importer and the block reading its own parts', () => {
    const sources = [
      file('packages/addon-admin-ui/src/pages/x/Editor.tsx', LIST),
      file(
        'packages/addon-admin-ui/src/pages/build/automation/ActionList.tsx',
        "import { CommandStep } from '../flow/CommandStep'\n",
      ),
      file(
        'packages/addon-admin-ui/src/pages/build/flow/CommandStep.tsx',
        "import { DeviceDoActionFields } from '../../../components/device-do-action/DeviceDoActionFields'\nimport type { LooseVocabOffer } from '@camstack/types'\n",
      ),
    ]
    const importers = { 'packages/addon-admin-ui/src/pages/x/Editor.tsx': 'x editor' }
    expect(findViolations(sources, importers)).toEqual([])
  })

  it('refuses a page that mounts the block without being listed', () => {
    const sources = [file('packages/addon-admin-ui/src/pages/y/New.tsx', STEP)]
    const out = findViolations(sources, {})
    expect(out).toHaveLength(1)
    expect(out[0]?.where).toBe('packages/addon-admin-ui/src/pages/y/New.tsx')
    expect(out[0]?.message).toContain('IMPORTERS')
  })

  it('refuses a list entry that no longer mounts the block', () => {
    const sources = [file('packages/addon-admin-ui/src/pages/x/Editor.tsx', 'export const a = 1\n')]
    const out = findViolations(sources, {
      'packages/addon-admin-ui/src/pages/x/Editor.tsx': 'x editor',
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.message).toContain('no longer')
  })

  it('refuses a page that reaches under the block for the device fields', () => {
    const sources = [
      file(
        'packages/addon-admin-ui/src/pages/rules/RuleActions.tsx',
        "import { DeviceDoActionFields } from '../../components/device-do-action/DeviceDoActionFields'\n",
      ),
    ]
    const out = findViolations(sources, {})
    expect(out).toHaveLength(1)
    expect(out[0]?.message).toContain('DeviceDoActionFields')
  })

  it('refuses a UI file that reads the vocabulary offers to build its own picker', () => {
    const sources = [
      file(
        'packages/addon-osd/src/page/MyPicker.tsx',
        "import type { ResolvedVocabAction } from '@camstack/types'\n",
      ),
    ]
    const out = findViolations(sources, {})
    expect(out).toHaveLength(1)
    expect(out[0]?.message).toContain('vocabulary')
  })

  it('ignores a type-only import of the device target type', () => {
    const sources = [
      file(
        'packages/addon-admin-ui/src/pages/z/thing.ts',
        "import type { CapDeviceTarget } from '../../components/device-do-action/DeviceDoActionFields'\n",
      ),
    ]
    expect(findViolations(sources, {})).toEqual([])
  })
})
