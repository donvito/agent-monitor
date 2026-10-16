import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';

// Acceptance check for run filters: the list opens on the last month, narrows
// to a project, keeps both choices across restarts, and keeps the open run.

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
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-run-filters-'));
  const userData = path.join(tempRoot, 'user-data');
  let electronApp;
  const launch = async () => {
    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [projectRoot, `--user-data-dir=${userData}`],
      env: { ...process.env, AGENT_MONITOR_TRACE_ROOT: path.join(tempRoot, 'codex-sessions'), HOME: path.join(tempRoot, 'home') },
    });
    return electronApp.firstWindow();
  };
  try {
    const traceRoot = path.join(tempRoot, 'codex-sessions');
    await mkdir(traceRoot, { recursive: true });
    const day = 86_400_000;
    const runs = [
      { id: 'shops-new', cwd: path.join(tempRoot, 'a', 'shops', 'dev'), age: 2 * day },
      { id: 'pays', cwd: path.join(tempRoot, 'a', 'pays', 'pays_dev'), age: 10 * day },
      { id: 'shops-old', cwd: path.join(tempRoot, 'b', 'shops', 'dev'), age: 40 * day },
    ];
    for (const run of runs) {
      const time = new Date(Date.now() - run.age);
      const file = path.join(traceRoot, `${run.id}.jsonl`);
      await writeFile(file, `${JSON.stringify({ timestamp: time.toISOString(), type: 'session_meta', payload: { id: run.id, cwd: run.cwd, model_provider: 'openai', model: 'gpt-5.5', thread_source: 'user' } })}\n`
        + `${JSON.stringify({ timestamp: time.toISOString(), type: 'event_msg', payload: { type: 'task_complete', message: 'done' } })}\n`);
      await utimes(file, time, time);
    }

    let page = await launch();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error));
    const rows = () => page.locator('button.run-item');
    const count = () => page.locator('.sidebar__section-count').innerText();
    const choose = async (label, option) => {
      await page.getByRole('button', { name: new RegExp(`^${label}:`) }).click();
      await page.getByRole('option', { name: option }).click();
    };

    // The last month is the default: the 40-day-old run is hidden.
    await waitFor('last month by default', async () => await rows().count() === 2 && (await count()).replace(/\s/g, '') === '2/3');

    await choose('Project', /^shops\/dev/);
    await waitFor('one project', async () => await rows().count() === 1);
    await choose('Period', 'All');
    await waitFor('the project over all time', async () => await rows().count() === 2);

    // Both choices survive a restart.
    await electronApp.close();
    page = await launch();
    page.on('pageerror', error => pageErrors.push(error));
    await waitFor('filters restored after restart', async () => await rows().count() === 2
      && await page.getByRole('button', { name: 'Project: shops/dev' }).count() === 1
      && await page.getByRole('button', { name: 'Period: All' }).count() === 1);

    // The open run stays in the list when it stops matching the filters.
    await page.locator('button.run-item', { has: page.locator(`[title="${runs[2].cwd}"]`) }).click();
    await choose('Period', 'Last week');
    await waitFor('the selected run kept', async () => await rows().count() === 2
      && await page.locator(`button.run-item [title="${runs[2].cwd}"]`).count() === 1);

    // A narrow window shows the period and project behind a Filters button.
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.unmaximize();
      window.setSize(1100, 800);
    });
    const filtersButton = page.getByRole('button', { name: /^Filters/ });
    await waitFor('the compact Filters button', async () => await filtersButton.isVisible()
      && !await page.getByRole('button', { name: /^Period:/ }).isVisible());
    if (!(await filtersButton.innerText()).includes('2')) throw new Error('the Filters button does not count the two changed filters');
    await filtersButton.click();
    await choose('Period', 'Last month');
    await waitFor('the compact panel to apply filters', async () => (await filtersButton.innerText()).replace(/\s/g, '') === 'Filters1');

    if (pageErrors.length) throw new Error(`renderer errors: ${pageErrors.map(String).join('; ')}`);
    console.log('PASS: run filters default to the last month, narrow to a project, persist, and keep the open run');
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
