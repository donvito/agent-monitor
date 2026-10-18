import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { MultiSourceMonitor } from '../src/main/trace-monitor/MultiSourceMonitor';
import type { Agent, MonitorSnapshot } from '../src/shared/types';

class Source extends EventEmitter {
  selected?: string;
  constructor(readonly id: string, readonly harness: Agent['harness']) { super(); }
  async start() {}
  async stop() {}
  snapshot(): MonitorSnapshot {
    return { runs: [{id:this.id,harness:this.harness}], agents: this.selected ? [{ id:this.id,runId:this.id,parentId:null,harness:this.harness,type:'main',status:'idle',stats:{inputTokens:0,outputTokens:0,toolCalls:0,errors:0} }] : [], edges:[],errors:[],watching:true };
  }
  async loadRun(id:string) { this.selected=id; this.emit('snapshot'); }
  unloadRun() { this.selected=undefined; }
  async getTrace() { return [{id:'entry',kind:'assistant' as const,text:this.id}]; }
}

test('selection across file/database sources releases prior traces and preserves inventory', async () => {
  const files=new Source('claude:a','claude');
  const database=new Source('hermes:b','hermes');
  const monitor=new MultiSourceMonitor([files,database]);
  await monitor.start();
  assert.equal(monitor.snapshot().runs.length,2);
  assert.equal(monitor.snapshot().agents.length,0);
  await monitor.loadRun('claude:a');
  assert.equal((await monitor.getTrace('claude:a'))[0].text,'claude:a');
  await monitor.loadRun('hermes:b');
  assert.equal(files.selected,undefined);
  assert.deepEqual(monitor.snapshot().agents.map(a=>a.id),['hermes:b']);
  assert.deepEqual(await monitor.getTrace('claude:a'),[]);
  assert.equal(monitor.snapshot().runs.length,2);
  await monitor.stop();
});

class TitledSource extends Source {
  constructor(id: string, harness: Agent['harness'], private readonly titles: Record<string, string>) { super(id, harness); }
  async getRunTitle(runId: string) { return this.titles[runId]; }
}

test('agent titles come from whichever source knows the run, loaded or not', async () => {
  const files = new TitledSource('claude:a', 'claude', { 'claude:a': 'Review the PR' });
  const codex = new TitledSource('b', 'codex', { b: 'Fix the build' });
  const database = new Source('hermes:c', 'hermes');
  const monitor = new MultiSourceMonitor([files, codex, database]);
  await monitor.start();
  assert.equal(await monitor.getRunTitle('b'), 'Fix the build');
  assert.equal(await monitor.getRunTitle('claude:a'), 'Review the PR');
  assert.equal(await monitor.getRunTitle('hermes:c'), undefined);
  await monitor.stop();
});

class NamedSource extends Source {
  constructor(id: string, harness: Agent['harness'], private readonly names: Record<string, string>) { super(id, harness); }
  async getAgentNames() { return this.names; }
}

test('agent names from every source are combined', async () => {
  const monitor = new MultiSourceMonitor([new NamedSource('claude:a', 'claude', { 'claude:a': 'A' }), new NamedSource('b', 'codex', { b: 'B' }), new Source('hermes:c', 'hermes')]);
  await monitor.start();
  assert.deepEqual(await monitor.getAgentNames(), { 'claude:a': 'A', b: 'B' });
  await monitor.stop();
});
