import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';

// Acceptance check: switching between the graph and trace tabs keeps the run
// list scroll, each trace tab's scroll position, and its search text.

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

function expectNear(actual, expected, label) {
  if (Math.abs(actual - expected) > 2) throw new Error(`${label}: expected scrollTop ${expected}, got ${actual}`);
}

async function writeTrace(filePath, records, mtime) {
  await writeFile(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  if (mtime) await utimes(filePath, mtime, mtime);
}

function session(id, cwd, timestamp, extra = {}) {
  return [
    { timestamp, type: 'session_meta', payload: { id, cwd, model_provider: 'openai', model: 'gpt-5.5', ...extra } },
    { timestamp, type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'low' } },
  ];
}

function message(timestamp, text) {
  return { timestamp, type: 'event_msg', payload: { type: 'agent_message', message: text } };
}

async function scrollTop(page, selector) {
  return page.locator(selector).first().evaluate(element => Math.round(element.scrollTop));
}

async function setScrollTop(page, selector, value) {
  return page.locator(selector).first().evaluate((element, top) => {
    element.scrollTop = top;
    return Math.round(element.scrollTop);
  }, value);
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-tabs-'));
  let electronApp;
  try {
    const traceRoot = path.join(tempRoot, 'codex-sessions');
    await mkdir(traceRoot, { recursive: true });
    const recent = new Date();
    const old = new Date('2026-01-01T00:00:00Z');

    // Enough recent runs to make the run list scroll; the long run is the oldest, at the bottom.
    for (let index = 0; index < 40; index += 1) {
      const cwd = path.join(tempRoot, `filler-${String(index).padStart(2, '0')}`);
      await writeTrace(path.join(traceRoot, `filler-${index}.jsonl`), [
        ...session(`filler-${index}`, cwd, recent.toISOString()),
        { timestamp: recent.toISOString(), type: 'event_msg', payload: { type: 'task_complete', message: 'done' } },
      ], recent);
    }

    const rootId = 'tabs-root-thread';
    const childId = 'tabs-child-thread';
    const longCwd = path.join(tempRoot, 'long-run');
    const at = second => new Date(old.getTime() + second * 1000).toISOString();
    const lines = Array.from({ length: 120 }, (_, index) => message(at(index + 1), `Root message ${index + 1}\n\nA paragraph of filler text so that the trace is long enough to scroll.`));
    await writeTrace(path.join(traceRoot, `${rootId}.jsonl`), [
      ...session(rootId, longCwd, at(0), { thread_source: 'user', agent_nickname: 'Root' }),
      ...lines,
      { timestamp: at(200), type: 'event_msg', payload: { type: 'task_complete', message: 'done' } },
    ], old);
    await writeTrace(path.join(traceRoot, `${childId}.jsonl`), [
      ...session(childId, longCwd, at(10), { thread_source: 'subagent', parent_thread_id: rootId, agent_role: 'worker', agent_nickname: 'Child' }),
      ...Array.from({ length: 80 }, (_, index) => message(at(index + 20), `Child message ${index + 1}\n\nMore filler text for scrolling.`)),
      { timestamp: at(150), type: 'event_msg', payload: { type: 'task_complete', message: 'done' } },
    ], old);

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [projectRoot, `--user-data-dir=${path.join(tempRoot, 'user-data')}`],
      env: { ...process.env, AGENT_MONITOR_TRACE_ROOT: traceRoot, HOME: path.join(tempRoot, 'home') },
    });
    const page = await electronApp.firstWindow();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error));

    const longRun = page.locator('button.run-item').filter({ has: page.locator('.run-item__path', { hasText: /^Root$/ }) });
    await waitFor('the run list', async () => await page.locator('button.run-item').count() >= 41);
    await longRun.scrollIntoViewIfNeeded();
    const sidebarTop = await scrollTop(page, '.sidebar__section');
    if (sidebarTop < 100) throw new Error(`run list did not scroll (scrollTop ${sidebarTop})`);
    await longRun.click();

    const openTraceTab = async id => {
      const button = page.locator(`.react-flow__node[data-id="${id}"] [title="Open trace in tab"]`);
      await waitFor(`the ${id} node`, () => button.isVisible());
      await button.click();
      await page.locator('.trace-workspace:visible').waitFor({ timeout: timeoutMs });
    };
    const traceTab = name => page.getByRole('tab', { name: `Trace · ${name}` });
    const visibleTrace = '.trace-workspace:visible .trace-workspace__content';

    await openTraceTab(rootId);
    await waitFor('the root trace to load', () => page.getByText('Root message 120').first().isVisible());
    // Search first: focusing the field scrolls it into view.
    await page.locator('.trace-workspace:visible input[type="search"]').fill('message');
    const rootTop = await setScrollTop(page, visibleTrace, 1500);
    if (rootTop < 1000) throw new Error(`root trace did not scroll (scrollTop ${rootTop})`);

    await page.getByRole('tab', { name: 'Graph' }).click();
    await page.locator('.sidebar').waitFor({ state: 'visible', timeout: timeoutMs });
    expectNear(await scrollTop(page, '.sidebar__section'), sidebarTop, 'run list after returning to Graph');

    await openTraceTab(childId);
    await waitFor('the child trace to load', () => page.getByText('Child message 80').first().isVisible());
    const childTop = await setScrollTop(page, visibleTrace, 800);

    await traceTab('Root').click();
    await waitFor('the root tab to show', () => page.getByText('Root message 120').first().isVisible());
    expectNear(await scrollTop(page, visibleTrace), rootTop, 'root trace after switching tabs');
    const search = await page.locator('.trace-workspace:visible input[type="search"]').inputValue();
    if (search !== 'message') throw new Error(`root trace search was reset to "${search}"`);

    await traceTab('Child').click();
    await waitFor('the child tab to show', () => page.getByText('Child message 80').first().isVisible());
    expectNear(await scrollTop(page, visibleTrace), childTop, 'child trace after switching tabs');

    if (pageErrors.length) throw new Error(`renderer errors: ${pageErrors.map(String).join('; ')}`);
    console.log('PASS: run list and trace tabs keep scroll and search state across tab switches');
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
