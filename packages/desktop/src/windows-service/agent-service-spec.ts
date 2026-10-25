/**
 * What the service runs, derived from the packaged app's resources. Pure paths
 * and strings; `path.win32` throughout because the service is a Windows
 * object whatever machine computed it (and so a Mac can test it).
 */
import * as path from 'node:path'
import type { AgentServiceSpec } from './winsw-config'

export const SERVICE_RESOURCES_DIR = 'service'
export const WINSW_FILE_NAME = 'winsw.exe'
export const SUPERVISOR_FILE_NAME = 'service-supervisor.js'

export interface ServiceResourcePaths {
  /** The pinned WinSW shipped in the installer. */
  readonly winsw: string
  /** The supervisor script, a real file outside the asar. */
  readonly supervisor: string
  /** The bundled real Node. */
  readonly nodeExe: string
}

export function serviceResourcePaths(resourcesPath: string): ServiceResourcePaths {
  return {
    winsw: path.win32.join(resourcesPath, SERVICE_RESOURCES_DIR, WINSW_FILE_NAME),
    supervisor: path.win32.join(resourcesPath, SERVICE_RESOURCES_DIR, SUPERVISOR_FILE_NAME),
    nodeExe: path.win32.join(resourcesPath, 'node', 'node.exe'),
  }
}

export function buildAgentServiceSpec(input: {
  readonly resourcesPath: string
  readonly starterJs: string
  readonly env: Readonly<Record<string, string>>
}): AgentServiceSpec {
  const paths = serviceResourcePaths(input.resourcesPath)
  return {
    nodeExe: paths.nodeExe,
    supervisorJs: paths.supervisor,
    starterJs: input.starterJs,
    workingDir: path.win32.dirname(input.starterJs),
    env: input.env,
    // The install script points this into the admin-only service directory.
    logDir: '',
  }
}
