import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { TraceMonitor } from './trace-monitor/TraceMonitor';
import { HermesMonitor } from './trace-monitor/HermesMonitor';
import { MultiSourceMonitor } from './trace-monitor/MultiSourceMonitor';
import type { TraceRangeRequest } from '../shared/types';

let window: BrowserWindow | null = null;
const idle = Number(process.env.AGENT_MONITOR_IDLE_MS);
const fileMonitor = new TraceMonitor({
  ...(process.env.AGENT_MONITOR_TRACE_ROOT ? {roots: [path.resolve(process.env.AGENT_MONITOR_TRACE_ROOT)]} : {}),
  ...(Number.isFinite(idle) && idle > 0 ? {idleMs: idle} : {}),
});
const monitor = new MultiSourceMonitor([
  ...(process.env.AGENT_MONITOR_TRACE_ROOT ? [] : [new HermesMonitor(Number.isFinite(idle) && idle > 0 ? {idleMs:idle} : {})]),
  fileMonitor,
]);
const developmentUrl = process.env.VITE_DEV_SERVER_URL;
// Packaged apps ship the icon as an extra resource; development reads it from build/ (icon.icns and icon.ico sit beside it).
const iconPath = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../build/icon.png');
/** Accepts a trace range whose indices and limit are non-negative integers. */
function traceRangeRequest(value: unknown): TraceRangeRequest {
  const request = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const index = (field: unknown) => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
  const limit = index(request.limit);
  const start = index(request.start);
  const end = index(request.end);
  if (limit === undefined || (request.start !== undefined && start === undefined) || (request.end !== undefined && end === undefined)) {
    throw new Error('Invalid trace range');
  }
  return { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}), limit };
}

function assertSender(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender');
}
function createWindow() {
  window = new BrowserWindow({ show: false, width: 1500, height: 950, minWidth: 960, minHeight: 640, backgroundColor: '#0c1016', title: 'Agent Monitor', icon: iconPath,
    // macOS: draw the window controls over the app's own header instead of a separate light title bar.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 20, y: 21 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.once('ready-to-show', () => { window?.show(); window?.maximize(); });
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('closed', () => { window = null; });
  if (developmentUrl) {
    const parsed = new URL(developmentUrl);
    // scripts/dev.mjs may bind any free port; only a loopback Vite server in an unpackaged app is trusted.
    if (app.isPackaged || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) throw new Error('Unexpected development server URL');
    void window.loadURL(developmentUrl);
  } else void window.loadFile(path.join(__dirname, '../dist/index.html'));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  void app.whenReady().then(() => {
    ipcMain.handle('monitor:snapshot', event => { assertSender(event); return monitor.snapshot(); });
    ipcMain.handle('monitor:trace', (event, agentId: unknown) => {
      assertSender(event);
      if (typeof agentId !== 'string' || agentId.length > 1024) throw new Error('Invalid agent identifier');
      return monitor.getTrace(agentId);
    });
    ipcMain.handle('monitor:trace-range', (event, agentId: unknown, request: unknown) => {
      assertSender(event);
      if (typeof agentId !== 'string' || agentId.length > 1024) throw new Error('Invalid agent identifier');
      return monitor.getTraceRange(agentId, traceRangeRequest(request));
    });
    ipcMain.handle('monitor:load-run', (event, runId: unknown) => {
      assertSender(event);
      if (typeof runId !== 'string' || !runId || runId.length > 1024) throw new Error('Invalid run identifier');
      return monitor.loadRun(runId);
    });
    monitor.on('snapshot', snapshot => { if (window && !window.webContents.isDestroyed()) window.webContents.send('monitor:changed', snapshot); });
    // Unpackaged macOS runs show Electron's own Dock icon unless it is replaced; packaged apps use the bundle icon.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconPath);
    createWindow();
    void monitor.start().catch(error => { console.error('Trace monitor failed:', error); });
    app.on('activate', () => { if (!window) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  let stopping = false;
  app.on('before-quit', event => {
    if (stopping) return;
    event.preventDefault(); stopping = true;
    void monitor.stop().finally(() => app.quit());
  });
}
