/**
 * Main-window preload — bridges the agent UI (served over http://localhost:4444)
 * to the Electron main process for app version + auto-update control.
 *
 * The renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`).
 * The agent UI feature-detects `window.camstackAgentApp` and degrades gracefully
 * when opened in a plain browser (where this bridge is absent).
 */
import { contextBridge, ipcRenderer } from 'electron'

interface UpdateState {
  readonly available: boolean
  readonly downloaded: boolean
  readonly version: string | null
  readonly checking: boolean
}

contextBridge.exposeInMainWorld('camstackAgentApp', {
  // Synchronous one-shot — the app version never changes during a run.
  version: ipcRenderer.sendSync('camstack:app:get-version-sync') as string,
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('camstack:app:get-update-state'),
  onUpdateState: (cb: (state: UpdateState) => void): (() => void) => {
    const listener = (_evt: unknown, state: UpdateState): void => cb(state)
    ipcRenderer.on('camstack:update-state', listener)
    return () => ipcRenderer.removeListener('camstack:update-state', listener)
  },
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('camstack:app:check-updates'),
  installUpdate: (): void => ipcRenderer.send('camstack:app:install-update'),
})
