import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveWorkspacePaths } from '../workspace.js'
import type { CapabilitySummary } from '../types.js'

/**
 * Parse capability definitions from `*.cap.ts` source text.
 * Avoids importing `@camstack/types` so this works on a clean checkout
 * before packages are built.
 */
export function listCapabilities(workspaceRoot: string): readonly CapabilitySummary[] {
  const { capsDir } = resolveWorkspacePaths(workspaceRoot)
  if (!fs.existsSync(capsDir)) return []

  const out: CapabilitySummary[] = []
  for (const entry of fs.readdirSync(capsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.cap.ts')) continue
    const filePath = path.join(capsDir, entry.name)
    const text = fs.readFileSync(filePath, 'utf8')
    const parsed = parseCapFile(text, filePath, workspaceRoot)
    if (parsed) out.push(parsed)
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name))
}

export function getCapability(workspaceRoot: string, name: string): CapabilitySummary | null {
  const needle = name.trim().toLowerCase()
  return listCapabilities(workspaceRoot).find((c) => c.name.toLowerCase() === needle) ?? null
}

function parseCapFile(
  text: string,
  filePath: string,
  workspaceRoot: string,
): CapabilitySummary | null {
  // Prefer the capability object literal's `name:` field.
  const nameMatch =
    /\bname\s*:\s*['"]([a-z0-9][a-z0-9-]*)['"]/.exec(text) ??
    /\bname\s*:\s*['"]([A-Za-z0-9_-]+)['"]/.exec(text)
  if (!nameMatch?.[1]) return null

  const exportMatch = /export\s+const\s+(\w+Capability)\s*=/.exec(text)
  const scopeMatch = /\bscope\s*:\s*['"](system|device)['"]/.exec(text)
  const modeMatch = /\bmode\s*:\s*['"](singleton|collection)['"]/.exec(text)

  return {
    name: nameMatch[1],
    file: filePath,
    relativeFile: path.relative(workspaceRoot, filePath),
    ...(scopeMatch?.[1] ? { scope: scopeMatch[1] } : {}),
    ...(modeMatch?.[1] ? { mode: modeMatch[1] } : {}),
    ...(exportMatch?.[1] ? { exportName: exportMatch[1] } : {}),
  }
}
