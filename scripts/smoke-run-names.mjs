import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

// Acceptance check for run names: hovering a run's folder line shows the
// agent's own title, double-clicking it renames the run (Enter saves,
// Escape cancels), and names survive a restart in the app's own file.

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

const line = value => `${JSON.stringify(value)}\n`;

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-run-names-'));
  const userData = path.join(tempRoot, 'user-data');
  const root = path.join(tempRoot, 'sessions');
  let electronApp;
  const launch = async () => {
    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [projectRoot, `--user-data-dir=${userData}`],
      env: { ...process.env, AGENT_MONITOR_TRACE_ROOT: root, HOME: path.join(tempRoot, 'home') },
    });
    return electronApp.firstWindow();
  };
  try {
    const codexCwd = path.join(tempRoot, 'work', 'artem');
    const claudeCwd = path.join(tempRoot, 'work', 'blog');
    const plainCwd = path.join(tempRoot, 'work', 'plain');
    const now = new Date().toISOString();
    await mkdir(path.join(root, 'blog'), { recursive: true });
    await writeFile(path.join(root, 'codex-thread.jsonl'), line({ timestamp: now, type: 'session_meta', payload: { id: 'codex-thread', cwd: codexCwd, model_provider: 'openai', thread_source: 'user' } }));
    await writeFile(path.join(root, 'codex-plain.jsonl'), line({ timestamp: now, type: 'session_meta', payload: { id: 'codex-plain', cwd: plainCwd, model_provider: 'openai', thread_source: 'user' } }));
    // Codex keeps thread names next to its sessions directory.
    await writeFile(path.join(tempRoot, 'session_index.jsonl'), line({ id: 'codex-thread', thread_name: 'Check the SSH connection' }));
    // A Claude session the user named with /rename, plus Claude's own automatic titles.
    await writeFile(path.join(root, 'blog', 'claude-session.jsonl'),
      line({ type: 'user', sessionId: 'claude-session', uuid: 'u1', cwd: claudeCwd, timestamp: now, message: { role: 'user', content: 'Hi' } })
      + line({ type: 'custom-title', customTitle: 'Blog draft', sessionId: 'claude-session' })
      + line({ type: 'ai-title', aiTitle: 'First title', sessionId: 'claude-session' })
      + line({ type: 'ai-title', aiTitle: 'Latest title', sessionId: 'claude-session' }));

    let page = await launch();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error));
    const label = cwd => page.locator(`button.run-item .run-item__path[data-cwd="${cwd}"]`);
    const row = cwd => page.locator('button.run-item', { has: page.locator(`.run-item__path[data-cwd="${cwd}"]`) });
    // A named run shows its name on its own line above the folder: "name | folder".
    const text = async cwd => {
      const name = row(cwd).locator('.run-item__name');
      const folder = (await label(cwd).innerText()).trim();
      return await name.count() ? `${(await name.innerText()).trim()} | ${folder}` : folder;
    };
    const popup = () => page.locator('.run-title-popup');
    const pencil = cwd => page.locator('button.run-item', { has: page.locator(`.run-item__path[data-cwd="${cwd}"]`) }).getByLabel('Name this run');
    const input = page.getByRole('textbox', { name: 'Run name' });
    await waitFor('all runs', async () => await page.locator('button.run-item').count() === 3);

    // Names kept by the agents show by default: Codex thread names and names given in Claude Code.
    await waitFor('the agent names', async () => await text(codexCwd) === 'Check the SSH connection | artem' && await text(claudeCwd) === 'Blog draft | blog');
    if (await text(plainCwd) !== 'plain') throw new Error(`an unnamed run shows "${await text(plainCwd)}"`);

    // Hovering shows the agent's own title: Claude's latest automatic title, Codex's thread name.
    await label(claudeCwd).hover();
    await waitFor('the latest Claude title', async () => (await popup().innerText()).includes('Latest title'));
    if (!(await popup().innerText()).includes(claudeCwd)) throw new Error('the popup does not show the folder');
    await label(codexCwd).hover();
    await waitFor('the Codex title', async () => (await popup().innerText()).includes('Check the SSH connection'));
    // The name equals the agent's title here, so the popup shows it once, as the agent title.
    const popupLabels = () => popup().locator('.run-title-popup__label').evaluateAll(labels => labels.map(label => label.textContent));
    if ((await popupLabels()).includes('Name')) throw new Error('the popup repeats a name equal to the agent title');


    // Only a run with no name at all offers the pencil, which names it without opening it.
    if (await pencil(codexCwd).count() || await pencil(claudeCwd).count()) throw new Error('a named run shows the pencil');
    await pencil(plainCwd).click();
    await waitFor('the editor from the pencil', () => input.isVisible());
    await input.press('Escape');
    if (await page.locator('button.run-item.run-item--selected').count()) throw new Error('the pencil opened the run');

    // A long name is cut on its line and shown in full in the popup.
    const longName = 'A very long automatic name that does not fit into the sidebar row at all';
    await label(plainCwd).dblclick();
    await input.fill(longName);
    await input.press('Enter');
    const nameLine = row(plainCwd).locator('.run-item__name');
    await waitFor('the long name on its own line', async () => await nameLine.count() === 1 && (await label(plainCwd).innerText()).trim() === 'plain');
    if (!await nameLine.evaluate(element => element.scrollWidth > element.clientWidth)) throw new Error('the long name is not cut to its line');
    await nameLine.hover();
    await waitFor('the full name in the popup', async () => (await popup().innerText()).includes(longName));
    await label(plainCwd).dblclick();
    await input.fill('');
    await input.press('Enter');
    await waitFor('the run unnamed again', async () => await text(plainCwd) === 'plain');

    // Double-click renames, starting from the shown name; Enter saves.
    await label(codexCwd).dblclick();
    if (await input.inputValue() !== 'Check the SSH connection') throw new Error('the editor does not start from the shown name');
    await input.fill('VPS review');
    await input.press('Enter');
    await waitFor('the saved name', async () => await text(codexCwd) === 'VPS review | artem');
    // A name different from the agent's title shows both. Move away first: the pointer is still over this row.
    await label(plainCwd).hover();
    await label(codexCwd).hover();
    await waitFor('both the name and the agent title', async () => {
      const labels = await popupLabels();
      return labels.includes('Name') && labels.includes('Agent title') && (await popup().innerText()).includes('VPS review');
    });

    // Escape cancels an edit.
    await label(codexCwd).dblclick();
    await input.fill('Something else');
    await input.press('Escape');
    await waitFor('the edit cancelled', async () => !await input.isVisible() && await text(codexCwd) === 'VPS review | artem');

    // Saving an agent's name unchanged stores nothing.
    await label(claudeCwd).dblclick();
    await input.press('Enter');

    // Names survive a restart and live in the app's own file.
    await electronApp.close();
    page = await launch();
    page.on('pageerror', error => pageErrors.push(error));
    await waitFor('the name after restart', async () => await text(codexCwd) === 'VPS review | artem');
    const stored = JSON.parse(await readFile(path.join(userData, 'run-names.json'), 'utf8'));
    if (JSON.stringify(stored) !== JSON.stringify({ 'codex-thread': 'VPS review' })) throw new Error(`unexpected names file: ${JSON.stringify(stored)}`);

    // Clearing a name brings back the agent's name.
    await label(codexCwd).dblclick();
    await page.getByRole('textbox', { name: 'Run name' }).fill('');
    await page.getByRole('textbox', { name: 'Run name' }).press('Enter');
    await waitFor('the agent name back', async () => await text(codexCwd) === 'Check the SSH connection | artem');

    if (pageErrors.length) throw new Error(`renderer errors: ${pageErrors.map(String).join('; ')}`);
    console.log('PASS: runs show the agent title on hover and can be renamed in place, kept across restarts');
  } finally {
    await electronApp?.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
