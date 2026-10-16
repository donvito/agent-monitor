import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { MultiSourceMonitor } from '../src/main/trace-monitor/MultiSourceMonitor';
import type { Agent, MonitorSnapshot, TraceRangeRequest } from '../src/shared/types';

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

class PagedSource extends Source {
  async getTraceRange(_agentId: string, request: TraceRangeRequest) { return { entries: [{ id: 'page', kind: 'assistant' as const, text: `page from ${request.start}` }], start: request.start ?? 0, total: 500 }; }
}

test('trace ranges go to the selected source, or are cut from its trace', async () => {
  const files = new PagedSource('claude:a', 'claude');
  const database = new Source('hermes:b', 'hermes');
  const monitor = new MultiSourceMonitor([files, database]);
  await monitor.start();
  assert.deepEqual(await monitor.getTraceRange('claude:a', { start: 0, limit: 200 }), { entries: [], start: 0, total: 0 });
  await monitor.loadRun('claude:a');
  assert.deepEqual(await monitor.getTraceRange('claude:a', { start: 200, limit: 200 }), { entries: [{ id: 'page', kind: 'assistant', text: 'page from 200' }], start: 200, total: 500 });
  await monitor.loadRun('hermes:b');
  const page = await monitor.getTraceRange('hermes:b', { start: 0, limit: 200 });
  assert.deepEqual([page.total, page.entries[0].text], [1, 'hermes:b']);
  await monitor.stop();
});
