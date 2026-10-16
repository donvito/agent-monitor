import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

// Acceptance check for the run search in the sidebar: a pasted session id
// narrows the list to its run, which then opens as usual.

const require = createRequire(import.meta.url);
const electronExecutable = process.env.ELECTRON_EXECUTABLE_PATH || require('electron');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = Number(process.env.AGENT_MONITOR_SMOKE_TIMEOUT_MS) || 20_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(description, predicate, timeout = timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const value = await predicate().catch(() => undefined);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-run-search-'));
  let electronApp;
  try {
    const traceRoot = path.join(tempRoot, 'codex-sessions');
    await mkdir(traceRoot, { recursive: true });
    const ids = ['01a13342-cc1a-7863-985b-aa03329c87d8', '01a13316-1dbe-7a12-a0ae-08e6bd0de298', '019f754f-0b14-7952-944a-e1568e3f8f80'];
    for (const id of ids) {
      // Every run shares one working directory, so only the id tells them apart.
      await writeFile(path.join(traceRoot, `${id}.jsonl`), `${JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd: path.join(tempRoot, 'artem'), model_provider: 'openai', model: 'gpt-5.5', thread_source: 'user' },
      })}\n`);
    }

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [projectRoot, `--user-data-dir=${path.join(tempRoot, 'user-data')}`],
      env: { ...process.env, AGENT_MONITOR_TRACE_ROOT: traceRoot, HOME: path.join(tempRoot, 'home') },
    });
    const page = await electronApp.firstWindow();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error));

    const runs = page.locator('button.run-item');
    await waitFor('every run', async () => await runs.count() === 3);
    const search = page.getByRole('searchbox', { name: 'Search runs' });

    await search.fill('ID 01a13342');
    await waitFor('one matching run', async () => await runs.count() === 1);
    const marked = await runs.first().locator('mark').innerText();
    if (marked.toLowerCase() !== '01a13342') throw new Error(`the matching part of the id is not highlighted (got "${marked}")`);

    await search.fill('no-such-run');
    await waitFor('the empty result', () => page.getByText('No runs match').isVisible());

    await search.fill('01a13342');
    await runs.first().click();
    await waitFor('the run graph', () => page.locator(`.react-flow__node[data-id="${ids[0]}"]`).isVisible());

    await search.focus();
    await page.keyboard.press('Escape');
    await waitFor('the full list again', async () => await runs.count() === 3 && await search.inputValue() === '');

    if (pageErrors.length) throw new Error(`renderer errors: ${pageErrors.map(String).join('; ')}`);
    console.log('PASS: run search narrows the list by session id and opens the run');
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
