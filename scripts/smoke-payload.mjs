import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

// Acceptance check for readable tool payloads: JSON tool input is shown
// decorated by default, Raw shows the original text, and Copy copies what
// is shown.

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
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-payload-'));
  let electronApp;
  try {
    const projectDir = path.join(tempRoot, 'claude-projects', '-payload');
    await mkdir(projectDir, { recursive: true });
    const sessionId = 'payload-session';
    const bashInput = { command: 'cd /tmp &&\n  ls -la', description: 'List temp files' };
    const editInput = { file_path: '/repo/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' };
    const assistant = (id, content) => ({ type: 'assistant', sessionId, uuid: id, cwd: path.join(tempRoot, 'payload-run'), message: { id, role: 'assistant', model: 'claude-sonnet-4', content } });
    const result = (id, toolUseId, text) => ({ type: 'user', sessionId, uuid: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } });
    const records = [
      { type: 'user', sessionId, uuid: 'u1', cwd: path.join(tempRoot, 'payload-run'), message: { role: 'user', content: [{ type: 'text', text: 'Tidy the repo' }] } },
      assistant('a1', [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: bashInput }]),
      result('u2', 'bash-1', 'a.txt\nb.txt'),
      assistant('a2', [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: editInput }]),
      result('u3', 'edit-1', 'The file has been updated.'),
    ];
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [projectRoot, `--user-data-dir=${path.join(tempRoot, 'user-data')}`],
      env: { ...process.env, AGENT_MONITOR_TRACE_ROOT: path.join(tempRoot, 'claude-projects'), HOME: path.join(tempRoot, 'home') },
    });
    const page = await electronApp.firstWindow();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error));

    await page.locator('button.run-item').first().click({ timeout: timeoutMs });
    const openTrace = page.locator('[title="Open trace in tab"]').first();
    await waitFor('the agent node', () => openTrace.isVisible());
    await openTrace.click();
    const workspace = page.locator('.trace-workspace:visible');
    const bash = workspace.locator('.trace-tool', { hasText: 'Bash' });
    await waitFor('the Bash call', () => bash.isVisible());

    // The collapsed row previews the description, not JSON.
    const summary = await bash.locator('.trace-tool__summary code').innerText();
    check(summary === 'List temp files', `the collapsed Bash row previews "${summary}"`);

    // Expanded input: the description and the command with real line breaks.
    await bash.locator('.trace-tool__summary').click();
    const input = bash.locator('.trace-code', { hasText: 'Input' });
    await waitFor('the expanded input', () => input.isVisible());
    const decorated = await input.innerText();
    check(decorated.includes('List temp files') && decorated.includes('cd /tmp &&\n  ls -la'), `the decorated input is not readable:\n${decorated}`);
    check(!decorated.includes('"command"') && !decorated.includes('\\n'), `the decorated input still shows JSON:\n${decorated}`);

    // Copy copies what is shown. Record what the page asks to copy instead of
    // touching the system clipboard, which also needs window focus.
    await page.evaluate(() => {
      window.__copied = [];
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.__copied.push(text); } });
    });
    const clipboard = () => page.evaluate(() => window.__copied.at(-1));
    await input.getByRole('button', { name: 'Copy input' }).click();
    await waitFor('the decorated copy', async () => (await clipboard()) === 'List temp files\n\ncd /tmp &&\n  ls -la');

    // Raw shows the original JSON.
    await input.getByRole('button', { name: 'Show raw input' }).click();
    await waitFor('the raw input', async () => (await input.locator('pre').innerText()).trim() === JSON.stringify(bashInput));
    await input.getByRole('button', { name: 'Copy input' }).click();
    await waitFor('the raw copy', async () => (await clipboard()) === JSON.stringify(bashInput));
    await input.getByRole('button', { name: 'Show formatted input' }).click();
    await waitFor('the decorated input again', async () => !(await input.innerText()).includes('"command"'));

    // An edit shows its file and the text before and after.
    const edit = workspace.locator('.trace-tool', { hasText: 'Edit' });
    check((await edit.locator('.trace-tool__summary code').innerText()) === '/repo/a.ts', 'the collapsed Edit row does not preview its file');
    await edit.locator('.trace-tool__summary').click();
    const editInputText = await waitFor('the expanded edit', async () => {
      // textContent: the labels are uppercased by CSS, which innerText reflects.
      const text = await edit.locator('.trace-code', { hasText: 'Input' }).textContent();
      return text.includes('Before') ? text : null;
    });
    check(editInputText.includes('const a = 1;') && editInputText.includes('After') && editInputText.includes('const a = 2;'), `the edit is not shown as before and after:\n${editInputText}`);

    if (pageErrors.length) throw new Error(`renderer errors: ${pageErrors.map(String).join('; ')}`);
    console.log('PASS: tool payloads are decorated by default, Raw shows the original, and Copy copies what is shown');
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
