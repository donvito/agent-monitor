import { contextBridge, ipcRenderer } from 'electron';
import type { MonitorBridge, MonitorSnapshot } from '../shared/types';
const bridge: MonitorBridge = {
  platform: process.platform,
  getSnapshot: () => ipcRenderer.invoke('monitor:snapshot'),
  getTrace: agentId => ipcRenderer.invoke('monitor:trace', agentId),
  getRunTitle: runId => ipcRenderer.invoke('monitor:run-title', runId),
  getAgentNames: () => ipcRenderer.invoke('monitor:agent-names'),
  getRunNames: () => ipcRenderer.invoke('monitor:run-names'),
  renameRun: (runId, name) => ipcRenderer.invoke('monitor:rename-run', runId, name),
  loadRun: runId => ipcRenderer.invoke('monitor:load-run', runId),
  onSnapshot: callback => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: MonitorSnapshot) => callback(snapshot);
    ipcRenderer.on('monitor:changed', listener);
    return () => ipcRenderer.removeListener('monitor:changed', listener);
  },
};
contextBridge.exposeInMainWorld('agentMonitor', bridge);
