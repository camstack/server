import * as fs from 'node:fs'
import * as path from 'node:path'
import type { WorkspacePaths } from './types.js'

/**
 * Walk up from `cwd` until we find a camstack-server workspace root
 * (package.json with workspaces covering `packages/*`).
 */
export function findWorkspaceRoot(cwd: string = process.cwd()): string | null {
  let dir = path.resolve(cwd)
  for (;;) {
    const pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        if (isWorkspaceRoot(parsed) && fs.existsSync(path.join(dir, 'packages'))) {
          return dir
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function isWorkspaceRoot(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const workspaces = (parsed as { workspaces?: unknown }).workspaces
  if (!Array.isArray(workspaces)) return false
  return workspaces.some((w) => typeof w === 'string' && w.includes('packages'))
}

export function resolveWorkspacePaths(root: string): WorkspacePaths {
  return {
    root,
    packagesDir: path.join(root, 'packages'),
    capsDir: path.join(root, 'packages', 'types', 'src', 'capabilities'),
  }
}

export function requireWorkspaceRoot(cwd?: string): string {
  const root = findWorkspaceRoot(cwd)
  if (!root) {
    throw new Error(
      'Not inside a camstack-server workspace. Run from the repo root (or a subdirectory).',
    )
  }
  return root
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return asRecord(parsed)
  } catch {
    return null
  }
}
