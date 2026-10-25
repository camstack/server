/**
 * Setup window preload script.
 *
 * The renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`)
 * so it can't reach Node APIs. We expose a tiny typed bridge via
 * `contextBridge` for the setup form to push the chosen config to
 * the main process via IPC.
 */
import { contextBridge, ipcRenderer } from 'electron'

interface SetupPayload {
  role: 'hub' | 'agent' | 'viewer'
  hubMode: 'auto' | 'manual'
  hubAddress: string
  agentName: string
  hubPort: number
  /** Viewer role only: the full hub URL its window will load. */
  viewerHubUrl: string
}

contextBridge.exposeInMainWorld('camstackSetup', {
  save: (data: SetupPayload): Promise<void> => ipcRenderer.invoke('camstack:setup:save', data),
  cancel: (): Promise<void> => ipcRenderer.invoke('camstack:setup:cancel'),
})
