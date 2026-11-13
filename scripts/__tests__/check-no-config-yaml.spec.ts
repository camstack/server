import { describe, expect, it } from 'vitest'
import { findConfigYamlReads } from '../check-no-config-yaml'

const file = (rel: string, content: string) => [{ rel, content }]

describe('check-no-config-yaml', () => {
  it('flags a runtime file that names config.yaml', () => {
    const findings = findConfigYamlReads(
      file(
        'packages/system/src/kernel/boot.ts',
        `const p = path.join(dataDir, 'config.yaml')\nconst raw = readFileSync(p)\n`,
      ),
    )
    expect(findings).toEqual([
      {
        file: 'packages/system/src/kernel/boot.ts',
        line: 1,
        text: "const p = path.join(dataDir, 'config.yaml')",
      },
    ])
  })

  it('flags the CONFIG_PATH variable and the .yml spelling', () => {
    const findings = findConfigYamlReads(
      file(
        'server/backend/src/main.ts',
        `const a = process.env['CONFIG_PATH']\nconst b = 'config.yml'\n`,
      ),
    )
    expect(findings.map((f) => f.line)).toEqual([1, 2])
  })

  it('ignores prose in comments', () => {
    expect(
      findConfigYamlReads(
        file(
          'server/backend/src/main.ts',
          `// there is no config.yaml (D1018)\n/**\n * not CONFIG_PATH either\n */\n`,
        ),
      ),
    ).toEqual([])
  })

  it('allows only the restore step that skips the entry of an older archive', () => {
    expect(
      findConfigYamlReads(
        file(
          'server/backend/src/pending-restore.ts',
          `const RETIRED_CONFIG_FILE = 'config.yaml'\n`,
        ),
      ),
    ).toEqual([])
  })
})
