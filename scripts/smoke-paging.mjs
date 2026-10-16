import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

// Acceptance check for paged traces: a long trace opens at the edge the
// order reads from, loads further pages while scrolling, jumps to the
// other edge, and never unloads what was loaded.

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
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-paging-'));
  let electronApp;
  try {
    const traceRoot = path.join(tempRoot, 'codex-sessions');
    await mkdir(traceRoot, { recursive: true });
    const rootId = 'paging-root-thread';
    let count = 0;
    const message = () => ({ type: 'event_msg', payload: { type: 'agent_message', message: `message ${++count}` } });
    // Entry 0 is the prompt; the tool call is entry 198 and its result entry 200, just past the first page.
    const records = [
      { type: 'session_meta', payload: { id: rootId, cwd: path.join(tempRoot, 'paging-run'), model_provider: 'openai', model: 'gpt-5.5', thread_source: 'user' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start here' }] } },
      ...Array.from({ length: 197 }, message),
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'split-call', name: 'exec', input: 'echo split' } },
      message(),
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'split-call', output: 'split result arrived' } },
      ...Array.from({ length: 1300 }, message),
      // A call still running at the end of the session: it has no result anywhere yet.
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'running-call', name: 'exec', input: 'sleep 60' } },
    ];
    const total = records.length - 1;
    const last = `message ${count}`;
    const running = workspace => workspace.locator('.trace-tool', { hasText: 'sleep 60' }).locator('.trace-tool__preview');
    await writeFile(path.join(traceRoot, `${rootId}.jsonl`), `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

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

    const workspace = page.locator('.trace-workspace:visible');
    const content = workspace.locator('.trace-workspace__content');
    const cards = workspace.locator('.trace-card');
    const has = text => workspace.getByText(text, { exact: true }).count().then(found => found > 0);

    // Oldest first opens at the start of the session and reports the full size.
    await waitFor('the first page', () => has('Start here'));
    check((await cards.first().innerText()).includes('Start here'), 'the trace does not open with the prompt');
    // The count is formatted in the system locale, so compare its digits.
    await waitFor('the full entry count', async () => (await workspace.locator('.trace-hero__meta').innerText()).split('\n').find(line => line.endsWith(' items'))?.replace(/\D/g, '') === String(total));
    check(await has('Result not loaded yet'), 'a call whose result is on the next page is not marked as not loaded');

    // Scrolling loads the next pages without clicks.
    await waitFor('message 400 to load while scrolling', async () => {
      await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
      return has('message 400');
    });
    check(await has('Start here'), 'the start of the session was unloaded');
    check(!await has('Result not loaded yet'), 'the call did not pick up its result from the next page');

    // Jump to end loads the rest and keeps everything loaded so far.
    // Consecutive agent messages share one card, so check content rather than card counts.
    await workspace.getByRole('button', { name: 'Jump to end' }).click();
    await waitFor('the last message', () => has(last));
    check(await has('message 800'), 'jumping to the end skipped the middle of the trace');
    check(await has('Start here'), 'jumping to the end unloaded the start');

    // Newest first starts again from the end and loads older pages while scrolling.
    await workspace.getByRole('button', { name: /^Order:/ }).click();
    await page.getByRole('option', { name: 'Newest first' }).click();
    await waitFor('newest first', async () => (await cards.first().innerText()).includes(last));
    check(!await has('message 1000'), 'newest first did not start again from the end');
    // Results follow their calls, so with the end loaded a call without a result has none yet.
    check((await running(workspace).innerText()).includes('No result in the retained trace.'), 'a running call at the loaded end is marked as not loaded');
    await waitFor('older pages while scrolling', async () => {
      await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
      return has('message 1000');
    });

    if (pageErrors.length) throw new Error(`renderer errors: ${pageErrors.map(String).join('; ')}`);
    console.log('PASS: paged trace opens at the reading edge, loads while scrolling, jumps, and keeps loaded pages');
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
