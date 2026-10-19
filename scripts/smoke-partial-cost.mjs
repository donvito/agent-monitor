// Checks that a run with priced and unpriced models shows its known cost
// with a plus sign and names the unpriced model in the tooltip.
import { _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const electronExecutable = process.env.ELECTRON_EXECUTABLE_PATH || require('electron');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshotPath = path.join(os.tmpdir(), 'agent-monitor-partial-cost.png');
const timeout = Number(process.env.AGENT_MONITOR_SMOKE_TIMEOUT_MS) || 20_000;
const partial = /^\$0[.,]78\+$/;

const iso = () => new Date().toISOString();
const record = (type, payload) => ({ timestamp: iso(), type, payload });

function session({ id, parent, model, usage, cwd }) {
  return [
    record('session_meta', {
      id, cwd, model_provider: 'openai', model,
      thread_source: parent ? 'subagent' : 'user',
      ...(parent ? { parent_thread_id: parent, agent_role: 'reviewer', agent_nickname: 'Review' } : {}),
    }),
    record('turn_context', { model, effort: 'medium', collaboration_mode: { settings: { model, reasoning_effort: 'medium' } } }),
    record('event_msg', { type: 'token_count', info: { last_token_usage: usage, total_token_usage: usage } }),
  ];
}

async function writeTrace(filePath, records) {
  await writeFile(filePath, `${records.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8');
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-partial-cost-'));
  let electronApp;
  let page;
  try {
    const traceRoot = path.join(tempRoot, 'codex-sessions');
    const sourceDir = path.join(traceRoot, '2026', '10', '19');
    const cwd = path.join(tempRoot, 'cost-project');
    const userDataDir = path.join(tempRoot, 'electron-user-data');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeTrace(path.join(sourceDir, 'cost-root.jsonl'), session({
      id: 'cost-root', model: 'gpt-6-astra', cwd,
      usage: { input_tokens: 100000, cached_input_tokens: 80000, cache_write_input_tokens: 0, output_tokens: 10000 },
    }));
    await writeTrace(path.join(sourceDir, 'cost-review.jsonl'), session({
      id: 'cost-review', parent: 'cost-root', model: 'codex-auto-review', cwd,
      usage: { input_tokens: 50000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5000 },
    }));

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        AGENT_MONITOR_TRACE_ROOT: traceRoot,
        CODEX_HOME: path.join(tempRoot, 'codex-home'),
        HOME: path.join(tempRoot, 'home'),
        ELECTRON_IS_DEV: '0',
      },
    });
    page = await electronApp.firstWindow();
    await page.locator('button.run-item').filter({ hasText: 'cost-project' }).first().click({ timeout });

    const header = page.locator('.run-token-totals__stat--usd');
    await expect(header.locator('strong')).toHaveText(partial, { timeout });
    const headerTitle = await header.getAttribute('title');
    for (const text of ['Not priced:', 'codex-auto-review:']) {
      if (!headerTitle?.includes(text)) throw new Error(`Header tooltip lacks "${text}": ${headerTitle}`);
    }

    await page.locator('summary.run-token-totals').click({ timeout });
    await expect(page.locator('.token-breakdown__tile--cost strong')).toHaveText(partial, { timeout });

    const agentRows = page.locator('.token-breakdown__scroll tbody tr');
    await expect(agentRows.filter({ hasText: 'gpt-6-astra' }).locator('.token-breakdown__cost')).toHaveText(/^\$0[.,]78$/, { timeout });
    await expect(agentRows.filter({ hasText: 'codex-auto-review' }).locator('.token-breakdown__cost')).toHaveText('Unknown', { timeout });
    await expect(page.locator('.token-breakdown__scroll tfoot .token-breakdown__cost')).toHaveText(partial, { timeout });

    await page.getByRole('tab', { name: /By model/ }).click({ timeout });
    const modelRows = page.locator('.token-breakdown__models tbody tr');
    await expect(modelRows.filter({ hasText: 'codex-auto-review' }).locator('.token-breakdown__cost')).toHaveText('Unknown', { timeout });
    await expect(modelRows.filter({ hasText: 'gpt-6-astra' }).locator('.token-breakdown__cost')).toHaveText(/^\$0[.,]78$/, { timeout });
    console.log(`PASS: partial cost marked; screenshot ${screenshotPath}`);
  } finally {
    if (page && !page.isClosed()) await page.screenshot({ path: screenshotPath }).catch(() => {});
    if (electronApp) await electronApp.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
