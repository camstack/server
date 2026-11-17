import { describe, expect, it } from 'vitest'
import { findUiOptimism, isUiSource, type SourceFile } from '../check-no-ui-optimism.js'

function file(path: string, text: string): SourceFile {
  return { path, text }
}

const PATCHING = 'const { display, applyOptimisticAction } = useOptimisticSlice(slice)\n'

describe('check-no-ui-optimism (D1061)', () => {
  it('flags a client-side patch in the library, the admin UI and an addon page', () => {
    const found = findUiOptimism([
      file('packages/ui-library/src/composites/x.tsx', PATCHING),
      file(
        'packages/addon-admin-ui/src/pages/y.ts',
        "import { useOptimisticSlice } from './use-optimistic-slice'\n",
      ),
      file('packages/addon-model-studio/src/page.tsx', 'const apply: OptimisticApply<S> = f\n'),
      file('packages/ui-library/src/x.spec.tsx', "vi.mock('../hooks/use-optimistic-slice')\n"),
    ])
    expect(found.map((f) => f.file)).toEqual([
      'packages/ui-library/src/composites/x.tsx',
      'packages/addon-admin-ui/src/pages/y.ts',
      'packages/addon-model-studio/src/page.tsx',
      'packages/ui-library/src/x.spec.tsx',
    ])
  })

  it('passes the served slice, prose and a provider that is not UI', () => {
    expect(
      findUiOptimism([
        file(
          'packages/ui-library/src/a.tsx',
          'const run = useDeviceCommand()\n// once useOptimisticSlice\n',
        ),
        file('packages/addon-provider-dreame/src/devices/d.ts', 'this.applyOptimisticAction(p)\n'),
      ]),
    ).toEqual([])
    expect(isUiSource('packages/addon-provider-dreame/src/devices/d.ts')).toBe(false)
    expect(isUiSource('packages/addon-provider-dreame/src/widget.tsx')).toBe(true)
  })
})
