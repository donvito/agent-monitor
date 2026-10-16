import { _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const electronExecutable = process.env.ELECTRON_EXECUTABLE_PATH || require('electron');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const screenshotPath = path.join(os.tmpdir(), 'agent-monitor-smoke.png');
const timeoutMs = Number(process.env.AGENT_MONITOR_SMOKE_TIMEOUT_MS) || 20_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(description, predicate, timeout = timeoutMs) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeout) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  const suffix = lastError ? ` (${lastError.message})` : '';
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function sessionMeta({ id, threadSource, parentThreadId, model, role, nickname, cwd }) {
  return {
    timestamp: iso(),
    type: 'session_meta',
    payload: {
      id,
      cwd,
      model_provider: 'openai',
      model,
      thread_source: threadSource,
      ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
      ...(role ? { agent_role: role } : {}),
      ...(nickname ? { agent_nickname: nickname } : {}),
    },
  };
}

function turnContext({ model, effort }) {
  return {
    timestamp: iso(),
    type: 'turn_context',
    payload: {
      model,
      effort,
      collaboration_mode: {
        settings: { model, reasoning_effort: effort },
      },
    },
  };
}

function eventMessage(message) {
  return {
    timestamp: iso(),
    type: 'event_msg',
    payload: { type: 'agent_message', message },
  };
}

function taskComplete(message) {
  return {
    timestamp: iso(),
    type: 'event_msg',
    payload: { type: 'task_complete', message },
  };
}

function lines(records) {
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
}

async function appendRecords(filePath, records) {
  await appendFile(filePath, lines(records), 'utf8');
}

async function writeTrace(filePath, records) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, lines(records), 'utf8');
}

function textLocator(page, pattern, { exact = false } = {}) {
  return page.getByText(pattern, { exact });
}

async function bodyText(page) {
  return page.locator('body').innerText().catch(() => '');
}

async function visibleText(page, pattern, options = {}) {
  const locator = textLocator(page, pattern, options).first();
  await expect(locator).toBeVisible({ timeout: timeoutMs });
  return locator;
}

async function visibleAnyText(page, patterns) {
  return waitFor(`one of: ${patterns.join(', ')}`, async () => {
    for (const pattern of patterns) {
      const locator = textLocator(page, pattern).filter({ visible: true }).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    return null;
  });
}

async function visible(locator) {
  return await locator.count() > 0 && await locator.first().isVisible().catch(() => false);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runButton(page, cwdName) {
  const runName = new RegExp(escapeRegExp(cwdName), 'i');
  return waitFor(`the run selector for ${cwdName}`, async () => {
    const candidates = [
      page.locator('button.run-item').filter({ has: page.getByTitle(runName) }).first(),
      page.locator('button.run-item').filter({ hasText: cwdName }).first(),
      page.locator('[data-testid="run-item"]').filter({ hasText: cwdName }).first(),
      page.getByRole('button', { name: runName }).first(),
    ];
    for (const candidate of candidates) {
      if (await visible(candidate)) return candidate;
    }
    return null;
  });
}

async function agentLocator(page, id, labels) {
  const selectors = [
    `[data-agent-id="${id}"]`,
    `[data-testid="agent-node-${id}"]`,
    `[data-testid="agent-${id}"]`,
    `[data-id="${id}"]`,
    `.react-flow__node-${id}`,
  ];
  const byId = page.locator(selectors.join(', ')).first();
  if (await visible(byId)) return byId;

  for (const label of labels) {
    // Hidden copies of a label (e.g. a previous graph still in the DOM) must
    // not win over the visible node.
    const text = textLocator(page, label, { exact: true }).filter({ visible: true }).first();
    if (!await text.count()) continue;
    const ancestors = [
      text.locator('xpath=ancestor::*[@data-agent-id][1]'),
      text.locator('xpath=ancestor::*[@data-testid][1]'),
      text.locator('xpath=ancestor::*[contains(@class,"react-flow__node")][1]'),
      text.locator('xpath=ancestor::*[@role="button"][1]'),
    ];
    for (const candidate of ancestors) {
      if (await visible(candidate)) return candidate;
    }
    return text;
  }
  throw new Error(`Could not find agent ${id} (${labels.join(', ')})`);
}

async function flowNodeLocator(page, id, labels) {
  const flowNode = page.locator(`.react-flow__node[data-id="${id}"]`).first();
  if (await visible(flowNode)) return flowNode;
  return agentLocator(page, id, labels);
}

async function clickAgent(page, id, labels) {
  // The graph can still be laying out right after a run switch. Resolve the
  // node again until it is visible instead of settling on the first lookup.
  const locator = await waitFor(`agent ${id} to be visible`, async () => {
    const candidate = await flowNodeLocator(page, id, labels).catch(() => null);
    return candidate && await candidate.isVisible().catch(() => false) ? candidate : null;
  });
  await locator.click({ timeout: timeoutMs });
  return locator;
}

async function agentStatus(page, id, labels, statusPattern) {
  const locator = await agentLocator(page, id, labels);
  const text = await locator.innerText().catch(() => '');
  return statusPattern.test(text) ? text : null;
}

async function nodePosition(locator) {
  const transform = await locator.evaluate(element => element.style.transform).catch(() => '');
  if (transform) return { transform };
  const box = await locator.boundingBox().catch(() => null);
  return box ? { x: box.x, y: box.y } : null;
}

function positionsDiffer(before, after, tolerance = 8) {
  if (!before || !after) return true;
  if (before.transform && after.transform) return before.transform !== after.transform;
  if (before.x === undefined || after.x === undefined) return true;
  return Math.abs(after.x - before.x) > tolerance || Math.abs(after.y - before.y) > tolerance;
}

function boxesOverlap(first, second) {
  return first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y;
}

async function visibleGraphNodeCount(page) {
  return page.locator('.react-flow__node').evaluateAll(elements => elements.filter(element => {
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }).length).catch(() => 0);
}

async function visibleGraphEdgeCount(page) {
  return page.locator('.react-flow__edges .react-flow__edge').evaluateAll(elements => elements.filter(element => {
    const path = element.querySelector('path');
    if (!path || !path.getAttribute('d')) return false;
    const groupStyle = getComputedStyle(element);
    const pathStyle = getComputedStyle(path);
    const box = path.getBoundingClientRect();
    const inViewport = box.right > 0 && box.bottom > 0 && box.left < window.innerWidth && box.top < window.innerHeight;
    return inViewport && groupStyle.visibility !== 'hidden' && groupStyle.display !== 'none' &&
      pathStyle.visibility !== 'hidden' && pathStyle.display !== 'none' && pathStyle.opacity !== '0' &&
      pathStyle.stroke !== 'none' && (box.width > 0 || box.height > 0);
  }).length).catch(() => 0);
}

async function dragNode(page, locator, dx, dy) {
  // Let the graph's animated initial framing settle before using screen coordinates.
  await sleep(700);
  const before = await locator.boundingBox();
  if (!before) throw new Error('Cannot drag an agent without a visible bounding box');
  const start = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 });
  await page.mouse.up();
  const after = await waitFor('the dragged node to move', async () => {
    const box = await locator.boundingBox().catch(() => null);
    return box && (Math.abs(box.x - before.x) > 10 || Math.abs(box.y - before.y) > 10) ? box : null;
  });
  return { before, after };
}

async function maybeOpenTrace(page) {
  // The details pane already contains the trace. Keep the graph visible for
  // the following live status and run-switching assertions.
  if (await page.locator('.details-section--trace').isVisible().catch(() => false)) return false;
  const traceButton = page.getByRole('button', { name: /open trace|view trace|trace/i }).first();
  if (await traceButton.isVisible().catch(() => false)) {
    await traceButton.click();
    return true;
  }
  const traceLink = page.getByText(/open trace|view trace/i).first();
  if (await traceLink.isVisible().catch(() => false)) {
    await traceLink.click();
    return true;
  }
  return false;
}

async function main() {
  let tempRoot;
  let electronApp;
  let page;
  const pageErrors = [];
  const consoleErrors = [];

  try {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-smoke-'));
    const traceRoot = path.join(tempRoot, 'codex-sessions');
    const sourceDir = path.join(traceRoot, '2026', '09', '16');
    const userDataDir = path.join(tempRoot, 'electron-user-data');
    const cwd = path.join(tempRoot, 'fixture-project');
    const otherCwd = path.join(tempRoot, 'other-project');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(otherCwd, { recursive: true });

    const rootId = 'smoke-root-thread';
    const childId = 'smoke-child-thread';
    const siblingId = 'smoke-sibling-thread';
    const nestedId = 'smoke-nested-thread';
    const otherId = 'smoke-other-root-thread';
    const rootPath = path.join(sourceDir, `${rootId}.jsonl`);
    const childPath = path.join(sourceDir, `${childId}.jsonl`);
    const siblingPath = path.join(sourceDir, `${siblingId}.jsonl`);
    const nestedPath = path.join(sourceDir, `${nestedId}.jsonl`);
    const otherPath = path.join(sourceDir, `${otherId}.jsonl`);

    await writeTrace(rootPath, [
      sessionMeta({ id: rootId, threadSource: 'user', model: 'gpt-6-astra', role: 'main', nickname: 'Astra', cwd }),
      turnContext({ model: 'gpt-6-astra', effort: 'medium' }),
    ]);
    await writeTrace(otherPath, [
      sessionMeta({ id: otherId, threadSource: 'user', model: 'gpt-5.5', role: 'main', nickname: 'Other', cwd: otherCwd }),
      turnContext({ model: 'gpt-5.5', effort: 'low' }),
    ]);

    const env = {
      ...process.env,
      AGENT_MONITOR_TRACE_ROOT: traceRoot,
      CODEX_HOME: path.join(tempRoot, 'codex-home'),
      HOME: path.join(tempRoot, 'home'),
      ELECTRON_USER_DATA_DIR: userDataDir,
      ELECTRON_IS_DEV: '0',
    };

    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [projectRoot, `--user-data-dir=${userDataDir}`],
      env,
    });
    page = await electronApp.firstWindow();
    const windowState = await waitFor('the Agent Monitor window to maximize', async () => {
      const state = await electronApp.evaluate(({ BrowserWindow }) => {
        const current = BrowserWindow.getAllWindows()[0];
        return current ? { maximized: current.isMaximized(), bounds: current.getBounds() } : null;
      });
      return state?.maximized ? state : null;
    }, 5_000);
    expect(windowState.maximized).toBe(true);
    page.on('pageerror', error => pageErrors.push(error));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await visibleAnyText(page, ['Agent Monitor', 'Agents', 'LIVE', 'Live']);

    const primaryRun = await runButton(page, 'fixture-project');
    const otherRun = await runButton(page, 'other-project');
    await expect(primaryRun).toBeVisible({ timeout: timeoutMs });
    await expect(otherRun).toBeVisible({ timeout: timeoutMs });
    await waitFor('the graph to remain unloaded before selecting a run', async () => {
      return await visibleGraphNodeCount(page) === 0;
    });

    await primaryRun.click();
    const rootLabels = ['Astra', 'GPT-6 Astra', 'gpt-6-astra', 'Main Agent'];
    await waitFor('the selected root agent', async () => {
      const locator = await agentLocator(page, rootId, rootLabels).catch(() => null);
      return locator && await locator.isVisible().catch(() => false) ? locator : null;
    });
    await appendRecords(rootPath, [eventMessage('SMOKE ROOT TRACE MARKER')]);
    await visibleAnyText(page, ['SMOKE ROOT TRACE MARKER', 'Astra', 'GPT-6 Astra', 'gpt-6-astra']);
    const rootNode = await flowNodeLocator(page, rootId, rootLabels);
    const rootPositionBefore = await nodePosition(rootNode);
    if (!rootPositionBefore) throw new Error('Root agent has no visible position');
    await waitFor('the root status', async () => agentStatus(page, rootId, rootLabels, /active|starting|running|idle|waiting/i));
    await visibleAnyText(page, ['GPT-6 Astra', 'gpt-6-astra']);
    await visibleAnyText(page, ['medium', 'MEDIUM']);

    await writeTrace(childPath, [
      sessionMeta({
        id: childId,
        threadSource: 'subagent',
        parentThreadId: rootId,
        model: 'gpt-5.6-luna',
        role: 'explorer',
        nickname: 'Explorer',
        cwd,
      }),
      turnContext({ model: 'gpt-5.6-luna', effort: 'high' }),
      eventMessage('SMOKE CHILD TRACE MARKER'),
    ]);
    const childLabels = ['Explorer', 'gpt-5.6-luna', 'GPT-5.6 Luna', 'explorer'];
    const child = await waitFor('the Explorer child agent', async () => {
      const locator = await flowNodeLocator(page, childId, childLabels).catch(() => null);
      return locator && await locator.isVisible().catch(() => false) ? locator : null;
    });
    const childBox = await child.boundingBox();
    if (!childBox) throw new Error('Child agent has no visible bounding box');
    await visibleAnyText(page, ['GPT-5.6 Luna', 'gpt-5.6-luna']);
    await visibleAnyText(page, ['high', 'HIGH']);

    const draggedPosition = await dragNode(page, child, 120, 70);
    const childPositionAfterDrag = await nodePosition(child);
    if (!childPositionAfterDrag || (draggedPosition.after.x === draggedPosition.before.x && draggedPosition.after.y === draggedPosition.before.y)) {
      throw new Error('Dragged child position was not retained immediately after drag');
    }

    await writeTrace(siblingPath, [
      sessionMeta({
        id: siblingId,
        threadSource: 'subagent',
        parentThreadId: rootId,
        model: 'gpt-5.6-luna',
        role: 'tester',
        nickname: 'Sibling Tester',
        cwd,
      }),
      turnContext({ model: 'gpt-5.6-luna', effort: 'high' }),
      eventMessage('SMOKE SIBLING TRACE MARKER'),
    ]);
    const siblingLabels = ['Sibling Tester', 'sibling', 'gpt-5.6-luna'];
    const sibling = await waitFor('the sequential sibling agent', async () => {
      const locator = await flowNodeLocator(page, siblingId, siblingLabels).catch(() => null);
      return locator && await locator.isVisible().catch(() => false) ? locator : null;
    });
    const siblingLayout = await waitFor('the sibling nodes to remain non-overlapping', async () => {
      const currentChildBox = await child.boundingBox().catch(() => null);
      const currentSiblingBox = await sibling.boundingBox().catch(() => null);
      if (!currentChildBox || !currentSiblingBox || boxesOverlap(currentChildBox, currentSiblingBox)) return null;
      return { currentChildBox, currentSiblingBox };
    });
    const childPositionAfterSibling = await nodePosition(child);
    if (positionsDiffer(childPositionAfterDrag, childPositionAfterSibling, 12)) {
      throw new Error(`Dragged child position changed after sibling discovery (${JSON.stringify(childPositionAfterDrag)} -> ${JSON.stringify(childPositionAfterSibling)})`);
    }
    if (!siblingLayout) throw new Error('Sibling layout was not measurable');

    await writeTrace(nestedPath, [
      sessionMeta({
        id: nestedId,
        threadSource: 'subagent',
        parentThreadId: childId,
        model: 'gpt-5.6-luna',
        role: 'tester',
        nickname: 'Nested Tester',
        cwd,
      }),
      turnContext({ model: 'gpt-5.6-luna', effort: 'max' }),
      eventMessage('SMOKE NESTED TRACE MARKER'),
    ]);
    const nestedLabels = ['Nested Tester', 'tester', 'SMOKE NESTED TRACE MARKER'];
    await waitFor('the nested tester agent', async () => {
      const locator = await flowNodeLocator(page, nestedId, nestedLabels).catch(() => null);
      return locator && await locator.isVisible().catch(() => false) ? locator : null;
    });
    await visibleAnyText(page, ['Nested Tester', 'tester', 'SMOKE NESTED TRACE MARKER']);

    const rootPositionAfter = await nodePosition(await flowNodeLocator(page, rootId, rootLabels));
    if (positionsDiffer(rootPositionBefore, rootPositionAfter, 12)) {
      throw new Error(`Root graph position moved after child discovery (${JSON.stringify(rootPositionBefore)} -> ${JSON.stringify(rootPositionAfter)})`);
    }

    await page.getByTitle('Fit graph', { exact: true }).click();
    try {
      await waitFor('three visible React Flow spawn edges', async () => await visibleGraphEdgeCount(page) >= 3);
    } catch (error) {
      const edgeDebug = await page.locator('.react-flow__edges').evaluate(element => ({
        childCount: element.childElementCount,
        html: element.innerHTML.slice(0, 12_000),
      })).catch(() => null);
      console.error(`SMOKE EDGE DOM: ${JSON.stringify(edgeDebug)}`);
      throw error;
    }

    await clickAgent(page, childId, childLabels);
    await visibleAnyText(page, ['Explorer', 'explorer']);
    await visibleAnyText(page, ['high', 'HIGH']);
    await waitFor('the child status in the detail view', async () => agentStatus(page, childId, childLabels, /active|starting|running|idle|waiting/i));
    await maybeOpenTrace(page);
    await visibleText(page, 'SMOKE CHILD TRACE MARKER');

    await appendRecords(childPath, [taskComplete('SMOKE CHILD COMPLETE MARKER')]);
    await waitFor('the child finished status', async () => agentStatus(page, childId, childLabels, /finished/i));

    await appendRecords(rootPath, [taskComplete('SMOKE ROOT COMPLETE MARKER')]);
    await waitFor('the root finished status', async () => agentStatus(page, rootId, rootLabels, /finished/i));

    if (await visibleGraphNodeCount(page) < 4) {
      throw new Error('The selected primary run did not retain all four graph nodes before switching runs');
    }
    const otherIdLocator = page.locator(`.react-flow__node[data-id="${otherId}"], [data-agent-id="${otherId}"]`);
    if (await otherIdLocator.count() !== 0) {
      throw new Error('The unrelated run appeared in the primary graph before selection');
    }

    await otherRun.click();
    const otherLabels = ['Other', 'gpt-5.5', 'GPT-5.5'];
    await waitFor('the selected unrelated run agent', async () => {
      const locator = await agentLocator(page, otherId, otherLabels).catch(() => null);
      return locator && await locator.isVisible().catch(() => false) ? locator : null;
    });
    await visibleAnyText(page, ['gpt-5.5', 'GPT-5.5']);
    await visibleAnyText(page, ['low', 'LOW']);
    await waitFor('the previous run nodes to leave the selected graph', async () => {
      const primaryNodes = page.locator(`.react-flow__node[data-id="${rootId}"], .react-flow__node[data-id="${childId}"], .react-flow__node[data-id="${siblingId}"], .react-flow__node[data-id="${nestedId}"]`);
      return await primaryNodes.evaluateAll(elements => elements.filter(element => {
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      }).length).catch(() => 0) === 0;
    });

    await primaryRun.click();
    await waitFor('the primary run to reload after switching back', async () => {
      const locator = await agentLocator(page, rootId, rootLabels).catch(() => null);
      return locator && await locator.isVisible().catch(() => false) ? locator : null;
    });
    await clickAgent(page, childId, childLabels);
    await maybeOpenTrace(page);
    await visibleText(page, 'SMOKE CHILD TRACE MARKER');

    await page.screenshot({ path: screenshotPath, fullPage: true });
    if (pageErrors.length) throw new Error(`Renderer page errors: ${pageErrors.map(error => error.message).join('; ')}`);
    if (consoleErrors.length) throw new Error(`Renderer console errors: ${consoleErrors.join('; ')}`);
    console.log(`PASS: Electron acceptance flow completed; screenshot saved to ${screenshotPath}`);
  } catch (error) {
    if (page) {
      console.error(`SMOKE BODY:\n${await bodyText(page)}`);
      if (pageErrors.length) console.error(`SMOKE PAGE ERRORS: ${pageErrors.map(item => item.message).join('; ')}`);
      if (consoleErrors.length) console.error(`SMOKE CONSOLE ERRORS: ${consoleErrors.join('; ')}`);
    }
    throw error;
  } finally {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    }
    if (electronApp) await electronApp.close().catch(() => {});
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  console.error(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
