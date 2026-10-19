import test from 'node:test';
import assert from 'node:assert/strict';
import { costLabel, unpricedNote } from '../src/renderer/costText';
import { estimateModelCosts } from '../src/shared/pricing';
import type { Agent, ModelTokenUsage } from '../src/shared/types';

const agent=(usage:ModelTokenUsage[]):Agent=>({id:'a',runId:'a',parentId:null,harness:'codex',type:'main',status:'active',tokenUsage:usage,stats:{inputTokens:usage.reduce((n,u)=>n+u.inputTokens,0),outputTokens:usage.reduce((n,u)=>n+u.outputTokens,0),toolCalls:0,errors:0}});
const priced:ModelTokenUsage={model:'gpt-6-astra',inputTokens:100000,outputTokens:10000,cacheReadTokens:80000,cacheWriteTokens:0,requestInputTokens:100000};
const unpriced=(model:string,inputTokens:number):ModelTokenUsage=>({model,inputTokens,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,requestInputTokens:inputTokens});
const format=(value:number)=>`$${value}`;
const lines=(agents:Agent[])=>unpricedNote(estimateModelCosts(agents)).split('\n');

test('complete cost shows the amount',()=>{assert.equal(costLabel(.78,true,format),'$0.78');assert.equal(costLabel(0,true,format),'$0');});
test('partial cost is marked',()=>{assert.equal(costLabel(.78,false,format),'$0.78+');});
test('nothing priced is Unknown',()=>{assert.equal(costLabel(0,false,format),'Unknown');});
test('tiny partial cost keeps the mark',()=>{assert.equal(costLabel(.00001,false,()=>'<$0.0001'),'<$0.0001+');});
test('note lists unpriced models by tokens',()=>{
  assert.deepEqual(lines([agent([priced,unpriced('mystery-model',10000),unpriced('codex-auto-review',55000)])]),[
    'Not priced:',
    `• codex-auto-review: ${(55000).toLocaleString()} tokens (No verified price for codex-auto-review.)`,
    `• mystery-model: ${(10000).toLocaleString()} tokens (No verified price for mystery-model.)`,
  ]);
});
test('note covers unattributed tokens',()=>{
  const a=agent([priced]);a.stats.inputTokens+=500;
  assert.deepEqual(lines([a]).slice(1),[`• Unattributed: ${(500).toLocaleString()} tokens (Some tokens have no model/cache attribution.)`]);
});
test('note keeps reasons for partly priced models',()=>{
  assert.deepEqual(lines([agent([priced,{...priced,cacheReadTokens:undefined}])]).slice(1),[`• gpt-6-astra: ${(110000).toLocaleString()} tokens (Cache accounting is unavailable for gpt-6-astra.)`]);
});
test('complete usage has no note',()=>{const rows=estimateModelCosts([agent([priced])]);assert.equal(unpricedNote(rows),'');});
