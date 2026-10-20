// Checks that the graph lays out sibling subagents left to right in launch order,
// although the monitor reads Codex session files newest first.
import { _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const electronExecutable = process.env.ELECTRON_EXECUTABLE_PATH || require('electron');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeout = Number(process.env.AGENT_MONITOR_SMOKE_TIMEOUT_MS) || 20_000;

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-graph-order-'));
  let electronApp;
  try {
    const sourceDir = path.join(tempRoot, 'codex-sessions', '2026', '10', '20');
    const cwd = path.join(tempRoot, 'order-project');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const start = Date.now() - 10 * 60_000;
    const sessions = [
      { id: 'order-root', minute: 0 },
      { id: 'order-first', minute: 1, nickname: 'First' },
      { id: 'order-second', minute: 2, nickname: 'Second' },
      { id: 'order-third', minute: 3, nickname: 'Third' },
    ];
    for (const session of sessions) {
      const at = new Date(start + session.minute * 60_000).toISOString();
      const child = session.id !== 'order-root';
      // Codex names files after their start time, so newer sessions sort first in reverse order.
      await writeFile(path.join(sourceDir, `rollout-${at.replaceAll(':', '-')}-${session.id}.jsonl`), `${JSON.stringify({
        timestamp: at, type: 'session_meta',
        payload: {
          id: session.id, timestamp: at, cwd, model_provider: 'openai', model: 'gpt-6-astra',
          thread_source: child ? 'subagent' : 'user',
          ...(child ? { parent_thread_id: 'order-root', agent_role: 'worker', agent_nickname: session.nickname } : {}),
        },
      })}\n`, 'utf8');
    }

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [projectRoot, `--user-data-dir=${path.join(tempRoot, 'electron-user-data')}`],
      env: {
        ...process.env,
        AGENT_MONITOR_TRACE_ROOT: path.join(tempRoot, 'codex-sessions'),
        CODEX_HOME: path.join(tempRoot, 'codex-home'),
        HOME: path.join(tempRoot, 'home'),
        ELECTRON_IS_DEV: '0',
      },
    });
    const page = await electronApp.firstWindow();
    await page.locator('button.run-item').first().click({ timeout });
    const node = id => page.locator(`.react-flow__node[data-id$="${id}"]`);
    for (const id of ['order-first', 'order-second', 'order-third']) await expect(node(id)).toBeVisible({ timeout });
    const xs = [];
    for (const id of ['order-first', 'order-second', 'order-third']) xs.push((await node(id).boundingBox()).x);
    if (!(xs[0] < xs[1] && xs[1] < xs[2])) throw new Error(`subagents are not in launch order left to right: x = ${xs.map(Math.round).join(', ')}`);

    console.log('PASS: sibling subagents are laid out left to right in launch order');
  } finally {
    if (electronApp) await electronApp.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
