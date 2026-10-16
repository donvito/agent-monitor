import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

// Acceptance check for find in a trace tab: Cmd+F, highlighting, match
// navigation, revealing collapsed tool output, and the Filter mode.

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

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-find-'));
  let electronApp;
  try {
    const traceRoot = path.join(tempRoot, 'codex-sessions');
    await mkdir(traceRoot, { recursive: true });
    const start = Date.now() - 60_000;
    const at = second => new Date(start + second * 1000).toISOString();
    const message = (second, text) => ({ timestamp: at(second), type: 'event_msg', payload: { type: 'agent_message', message: text } });
    const rootId = 'find-root-thread';
    await writeFile(path.join(traceRoot, `${rootId}.jsonl`), `${[
      { timestamp: at(0), type: 'session_meta', payload: { id: rootId, cwd: path.join(tempRoot, 'find-run'), model_provider: 'openai', model: 'gpt-5.5', thread_source: 'user' } },
      { timestamp: at(0), type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'low' } },
      { timestamp: at(1), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: 'grep -r marker .' } },
      { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'line one\nfound needle-in-result here\nline three' } },
      ...Array.from({ length: 60 }, (_, index) => message(index + 3, `Filler message ${index + 1}\n\nPlain text without the search word.`)),
      message(70, 'The final answer mentions needle-in-text once.'),
      { timestamp: at(71), type: 'event_msg', payload: { type: 'task_complete', message: 'done' } },
    ].map(record => JSON.stringify(record)).join('\n')}\n`);

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [projectRoot, `--user-data-dir=${path.join(tempRoot, 'user-data')}`],
      env: { ...process.env, AGENT_MONITOR_TRACE_ROOT: traceRoot, HOME: path.join(tempRoot, 'home') },
    });
    const page = await electronApp.firstWindow();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error));

    await page.locator('button.run-item').first().click({ timeout: timeoutMs });
    const openTrace = page.locator(`.react-flow__node[data-id="${rootId}"] [title="Open trace in tab"]`);
    await waitFor('the root node', () => openTrace.isVisible());
    await openTrace.click();
    await waitFor('the trace to load', () => page.getByText('Filler message 60').first().isVisible());

    const workspace = page.locator('.trace-workspace:visible');
    const content = workspace.locator('.trace-workspace__content');
    const input = workspace.locator('input[type="search"]');
    const count = workspace.locator('.trace-find__count');
    const highlights = () => page.evaluate(() => ({
      all: CSS.highlights?.get('trace-find')?.size ?? 0,
      current: CSS.highlights?.get('trace-find-current')?.size ?? 0,
    }));
    // The collapsed row also previews the result, so look inside the expanded details only.
    const resultVisible = () => workspace.locator('.trace-tool__details pre', { hasText: 'found needle-in-result here' }).isVisible();

    // Cmd+F from deep in the trace focuses the search, which stays on screen.
    await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.keyboard.press('Meta+f');
    await waitFor('search focus after Cmd+F', () => input.evaluate(element => element === document.activeElement));
    const box = await input.boundingBox();
    const viewport = await content.boundingBox();
    check(box && viewport && box.y >= viewport.y - 1 && box.y + box.height <= viewport.y + viewport.height, 'search field is not visible after scrolling');

    await page.keyboard.type('needle');
    await waitFor('the first match', async () => (await count.innerText()).trim() === '1 / 2');
    await waitFor('the collapsed result to open', resultVisible);
    const firstHighlights = await waitFor('highlights', async () => {
      const value = await highlights();
      return value.all === 2 && value.current === 1 ? value : null;
    });
    check(firstHighlights, 'expected 2 highlighted matches and 1 current');

    await page.keyboard.press('Enter');
    await waitFor('the second match', async () => (await count.innerText()).trim() === '2 / 2');
    await waitFor('the second match in view', async () => {
      const target = await workspace.getByText('The final answer mentions needle-in-text once.').boundingBox();
      const area = await content.boundingBox();
      return target && area && target.y >= area.y && target.y + target.height <= area.y + area.height;
    });
    await page.keyboard.press('Shift+Enter');
    await waitFor('back to the first match', async () => (await count.innerText()).trim() === '1 / 2');

    await workspace.getByRole('button', { name: 'Filter' }).click();
    await waitFor('filter mode', async () => await workspace.locator('.trace-card').count() === 2);
    await workspace.getByRole('button', { name: 'Find' }).click();
    await waitFor('find mode', async () => await workspace.locator('.trace-card').count() > 2);

    await input.focus();
    await page.keyboard.press('Escape');
    await waitFor('search to clear', async () => await input.inputValue() === '');
    await waitFor('the revealed result to collapse again', async () => !await resultVisible());
    check((await highlights()).all === 0, 'highlights remain after clearing the search');

    if (pageErrors.length) throw new Error(`renderer errors: ${pageErrors.map(String).join('; ')}`);
    console.log('PASS: find in trace highlights, navigates, reveals collapsed output, and filters');
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
