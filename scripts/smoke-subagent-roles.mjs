// Checks that Claude subagents are named by the role in their meta files,
// numbered when several share a role, and show their task in Agent detail.
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

const session = 'roles-session';
const lines = records => `${records.map(item => JSON.stringify(item)).join('\n')}\n`;
function message(role, text, at, extra = {}) {
  return {
    type: role, sessionId: session, uuid: `${extra.agentId ?? 'main'}-${role}-${at}`, timestamp: new Date(Date.now() - 60_000 + at * 1000).toISOString(),
    ...extra,
    message: { role, ...(role === 'assistant' ? { model: 'claude-haiku-5-5', id: `msg-${extra.agentId ?? 'main'}-${at}` } : {}), content: [{ type: 'text', text }] },
  };
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-roles-'));
  let electronApp;
  try {
    const projectDir = path.join(tempRoot, 'claude-projects', '-tmp-roles-project');
    const subagentDir = path.join(projectDir, session, 'subagents');
    const cwd = path.join(tempRoot, 'roles-project');
    await mkdir(subagentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(projectDir, `${session}.jsonl`), lines([
      message('user', 'Review both pull requests', 0, { cwd }),
      message('assistant', 'Starting reviewers', 1, { cwd }),
    ]));
    const subagents = [
      { id: 'a1', role: 'reviewer', task: 'Review PR 1570 diff', at: 2 },
      { id: 'a2', role: 'reviewer', task: 'Review PR 1571 diff', at: 3 },
      { id: 'a3', role: 'Explore', task: 'Find the lint config', at: 4 },
    ];
    for (const sub of subagents) {
      await writeFile(path.join(subagentDir, `agent-${sub.id}.jsonl`), lines([
        message('user', sub.task, sub.at, { cwd, isSidechain: true, agentId: sub.id }),
        message('assistant', `Done: ${sub.task}`, sub.at + 0.5, { cwd, isSidechain: true, agentId: sub.id }),
      ]));
      await writeFile(path.join(subagentDir, `agent-${sub.id}.meta.json`), JSON.stringify({ agentType: sub.role, description: sub.task, toolUseId: `toolu_${sub.id}` }));
    }

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [projectRoot, `--user-data-dir=${path.join(tempRoot, 'electron-user-data')}`],
      env: {
        ...process.env,
        AGENT_MONITOR_TRACE_ROOT: path.join(tempRoot, 'claude-projects'),
        CODEX_HOME: path.join(tempRoot, 'codex-home'),
        HOME: path.join(tempRoot, 'home'),
        ELECTRON_IS_DEV: '0',
      },
    });
    const page = await electronApp.firstWindow();
    await page.locator('button.run-item').first().click({ timeout });

    const node = id => page.locator(`.react-flow__node[data-id="claude:${session}:${id}"]`);
    await expect(node('a1')).toContainText('Subagent · reviewer #1', { timeout });
    await expect(node('a2')).toContainText('Subagent · reviewer #2', { timeout });
    await expect(node('a3')).toContainText('Subagent · Explore', { timeout });
    await expect(node('a3')).not.toContainText('#', { timeout });

    await node('a2').click({ timeout });
    const details = page.locator('.details-pane');
    await expect(details.locator('h2')).toHaveText('Subagent · reviewer #2', { timeout });
    await expect(details.locator('dt', { hasText: 'Task' }).locator('xpath=following-sibling::dd')).toHaveText('Review PR 1571 diff', { timeout });

    console.log('PASS: Claude subagents are named by role, numbered within a role, and show their task');
  } finally {
    if (electronApp) await electronApp.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
