// Checks that the token breakdown shows how much input came from the prompt cache,
// for the run in a Cache use tile and per agent in Cache read / Cache write columns.
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

const record = (type, payload) => ({ timestamp: new Date().toISOString(), type, payload });
const session = ({ id, parent, cwd, usage }) => [
  record('session_meta', {
    id, cwd, model_provider: 'openai', model: 'gpt-6-astra', thread_source: parent ? 'subagent' : 'user',
    ...(parent ? { parent_thread_id: parent, agent_role: 'worker', agent_nickname: 'Helper' } : {}),
  }),
  record('turn_context', { model: 'gpt-6-astra', effort: 'medium' }),
  record('event_msg', { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } }),
];

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-cache-use-'));
  let electronApp;
  try {
    const sourceDir = path.join(tempRoot, 'codex-sessions', '2026', '10', '22');
    const cwd = path.join(tempRoot, 'cache-project');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const lines = records => `${records.map(item => JSON.stringify(item)).join('\n')}\n`;
    await writeFile(path.join(sourceDir, 'cache-root.jsonl'), lines(session({ id: 'cache-root', cwd,
      usage: { input_tokens: 100000, cached_input_tokens: 80000, cache_write_input_tokens: 0, output_tokens: 10000 } })));
    await writeFile(path.join(sourceDir, 'cache-child.jsonl'), lines(session({ id: 'cache-child', parent: 'cache-root', cwd,
      usage: { input_tokens: 50000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5000 } })));

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
    await page.locator('button.run-item').filter({ hasText: 'cache-project' }).first().click({ timeout });
    await page.locator('summary.run-token-totals').click({ timeout });

    const tile = page.locator('.token-breakdown__tile--cache');
    await expect(tile.locator('span').first()).toHaveText('Cache use', { timeout });
    await expect(tile.locator('strong')).toHaveText('53.3%', { timeout });
    await expect(tile.locator('small')).toContainText('read', { timeout });
    await expect(tile.locator('small')).toContainText('written', { timeout });

    const headers = await page.locator('.token-breakdown__scroll thead th').allInnerTexts();
    if (headers.join('|') !== 'Agent|IN|CACHE READ|CACHE WRITE|OUT|USD') throw new Error(`Unexpected agent columns: ${headers.join('|')}`);
    const row = name => page.locator('.token-breakdown__scroll tbody tr').filter({ hasText: name }).locator('td');
    await expect(row('Main agent').nth(1)).toHaveText('80.0%', { timeout });
    await expect(row('Main agent').nth(2)).toHaveText('0.0%', { timeout });
    await expect(row('Helper').nth(1)).toHaveText('0.0%', { timeout });
    await expect(page.locator('.token-breakdown__scroll tfoot td').nth(1)).toHaveText('53.3%', { timeout });

    console.log('PASS: the token breakdown shows cache use for the run and per agent');
  } finally {
    if (electronApp) await electronApp.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
