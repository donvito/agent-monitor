import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunNameStore } from '../src/main/runNames';
import { claudeCustomTitle, claudeTitle, codexThreadNames } from '../src/main/trace-monitor/agentTitles';
import { TraceMonitor } from '../src/main/trace-monitor/TraceMonitor';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'agent-monitor-names-'));
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test('run names persist, trim, and an empty name removes the entry', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'run-names.json');
    const store = new RunNameStore(file);
    assert.deepEqual(await store.all(), {});
    assert.deepEqual(await store.set('claude:abc', '  VPS review  '), { 'claude:abc': 'VPS review' });
    await store.set('01a1', 'Build fix');
    assert.deepEqual(await new RunNameStore(file).all(), { 'claude:abc': 'VPS review', '01a1': 'Build fix' });
    assert.deepEqual(await store.set('01a1', '   '), { 'claude:abc': 'VPS review' });
    // Writes go through a temporary file that is renamed into place.
    assert.deepEqual(await readdir(dir), ['run-names.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unreadable names file reads as no names', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'run-names.json');
    await writeFile(file, '{ not json');
    assert.deepEqual(await new RunNameStore(file).all(), {});
    await writeFile(file, JSON.stringify({ ok: 'Name', bad: 42 }));
    assert.deepEqual(await new RunNameStore(file).all(), { ok: 'Name' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the latest Claude title is read from the end of the session file', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'session.jsonl');
    const filler = Array.from({ length: 3000 }, (_, index) => line({ type: 'assistant', message: { content: `filler ${index} ${'x'.repeat(100)}` } })).join('');
    await writeFile(file, line({ type: 'ai-title', aiTitle: 'First title' }) + filler + line({ type: 'ai-title', aiTitle: 'Latest title' }) + line({ type: 'user' }));
    assert.equal(await claudeTitle(file), 'Latest title');
    // A title only near the start, beyond the tail that is read first, is still found.
    const early = path.join(dir, 'early.jsonl');
    await writeFile(early, line({ type: 'ai-title', aiTitle: 'Only title' }) + filler);
    assert.equal(await claudeTitle(early), 'Only title');
    const none = path.join(dir, 'none.jsonl');
    await writeFile(none, line({ type: 'user' }));
    assert.equal(await claudeTitle(none), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Codex thread names come from the session index, the latest entry winning', async () => {
  const dir = await tempDir();
  try {
    const index = path.join(dir, 'session_index.jsonl');
    await writeFile(index, line({ id: 'a', thread_name: 'Old name' }) + 'not json\n' + line({ id: 'b', thread_name: 'B' }) + line({ id: 'a', thread_name: 'New name' }));
    assert.deepEqual([...(await codexThreadNames(index))], [['a', 'New name'], ['b', 'B']]);
    assert.equal((await codexThreadNames(path.join(dir, 'missing.jsonl'))).size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the monitor gives the agent title of any discovered run without loading it', async () => {
  const dir = await tempDir();
  const root = path.join(dir, 'sessions');
  await mkdir(path.join(root, 'project'), { recursive: true });
  await writeFile(path.join(root, 'codex-thread.jsonl'), line({ type: 'session_meta', payload: { id: 'codex-thread', cwd: '/tmp/a', thread_source: 'user' } }));
  await writeFile(path.join(dir, 'session_index.jsonl'), line({ id: 'codex-thread', thread_name: 'Fix the build' }));
  await writeFile(path.join(root, 'project', 'claude-session.jsonl'), line({ type: 'user', sessionId: 'claude-session', uuid: 'u1', cwd: '/tmp/b', message: { role: 'user', content: 'Hi' } })
    + line({ type: 'ai-title', aiTitle: 'Review the PR', sessionId: 'claude-session' }));
  const monitor = new TraceMonitor({ roots: [root] });
  try {
    await monitor.start();
    assert.equal(await monitor.getRunTitle('codex-thread'), 'Fix the build');
    assert.equal(await monitor.getRunTitle('claude:claude-session'), 'Review the PR');
    assert.equal(await monitor.getRunTitle('unknown'), undefined);
  } finally {
    await monitor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a name set in Claude Code is read wherever it is in the file, the latest winning', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'session.jsonl');
    const filler = Array.from({ length: 3000 }, (_, index) => line({ type: 'assistant', message: { content: `filler ${index} ${'x'.repeat(100)}` } })).join('');
    await writeFile(file, line({ type: 'custom-title', customTitle: 'Early name' }) + filler + line({ type: 'ai-title', aiTitle: 'Auto title' }));
    assert.equal(await claudeCustomTitle(file), 'Early name');
    await writeFile(file, line({ type: 'custom-title', customTitle: 'Early name' }) + filler + line({ type: 'custom-title', customTitle: 'Renamed' }));
    assert.equal(await claudeCustomTitle(file), 'Renamed');
    await writeFile(file, line({ type: 'ai-title', aiTitle: 'Auto title' }));
    assert.equal(await claudeCustomTitle(file), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('agent names cover Codex thread names and Claude names, and nothing for other runs', async () => {
  const dir = await tempDir();
  const root = path.join(dir, 'sessions');
  await mkdir(path.join(root, 'project'), { recursive: true });
  await writeFile(path.join(root, 'codex-thread.jsonl'), line({ type: 'session_meta', payload: { id: 'codex-thread', cwd: '/tmp/a', thread_source: 'user' } }));
  await writeFile(path.join(root, 'codex-unnamed.jsonl'), line({ type: 'session_meta', payload: { id: 'codex-unnamed', cwd: '/tmp/c', thread_source: 'user' } }));
  await writeFile(path.join(dir, 'session_index.jsonl'), line({ id: 'codex-thread', thread_name: 'Fix the build' }));
  await writeFile(path.join(root, 'project', 'claude-named.jsonl'), line({ type: 'user', sessionId: 'claude-named', uuid: 'u1', cwd: '/tmp/b', message: { role: 'user', content: 'Hi' } })
    + line({ type: 'custom-title', customTitle: 'My review', sessionId: 'claude-named' }) + line({ type: 'ai-title', aiTitle: 'Auto', sessionId: 'claude-named' }));
  await writeFile(path.join(root, 'project', 'claude-auto.jsonl'), line({ type: 'user', sessionId: 'claude-auto', uuid: 'u2', cwd: '/tmp/d', message: { role: 'user', content: 'Hi' } })
    + line({ type: 'ai-title', aiTitle: 'Only auto', sessionId: 'claude-auto' }));
  const monitor = new TraceMonitor({ roots: [root] });
  try {
    await monitor.start();
    assert.deepEqual(await monitor.getAgentNames(), { 'codex-thread': 'Fix the build', 'claude:claude-named': 'My review' });
  } finally {
    await monitor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
