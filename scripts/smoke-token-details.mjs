// Checks that Escape closes the token breakdown, also after a click inside it
// (for example to select text), which leaves no focused control.
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

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-token-details-'));
  let electronApp;
  try {
    const sourceDir = path.join(tempRoot, 'codex-sessions', '2026', '10', '20');
    const cwd = path.join(tempRoot, 'details-project');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const usage = { input_tokens: 100000, cached_input_tokens: 80000, cache_write_input_tokens: 0, output_tokens: 10000 };
    await writeFile(path.join(sourceDir, 'details-root.jsonl'), `${[
      record('session_meta', { id: 'details-root', cwd, model_provider: 'openai', model: 'gpt-6-astra', thread_source: 'user' }),
      record('turn_context', { model: 'gpt-6-astra', effort: 'medium' }),
      record('event_msg', { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } }),
    ].map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8');

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
    await page.locator('button.run-item').filter({ hasText: 'details-project' }).first().click({ timeout });
    const details = page.locator('details.run-token-details');
    const isOpen = () => details.evaluate(element => element.open);

    await page.locator('summary.run-token-totals').click({ timeout });
    await expect(page.locator('.token-breakdown')).toBeVisible({ timeout });
    await page.keyboard.press('Escape');
    if (await isOpen()) throw new Error('Escape did not close the breakdown right after opening it');

    await page.locator('summary.run-token-totals').click({ timeout });
    await expect(page.locator('.token-breakdown')).toBeVisible({ timeout });
    // A click on plain text inside the panel, as when selecting it.
    await page.locator('.token-breakdown__tile--cost span').first().click({ timeout });
    if (!await isOpen()) throw new Error('A click inside closed the breakdown');
    await page.keyboard.press('Escape');
    if (await isOpen()) {
      const focused = await page.evaluate(() => document.activeElement?.tagName.toLowerCase());
      throw new Error(`Escape did not close the breakdown after a click inside it (focus on ${focused})`);
    }

    console.log('PASS: Escape closes the token breakdown, also after a click inside it');
  } finally {
    if (electronApp) await electronApp.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
