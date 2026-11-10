const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseTranscript, createStore, normalizeUsage } = require('../src/usage.cjs');
const { responseLink } = require('../src/link.cjs');
const tokens = (input, output) => ({ input_tokens: input, cached_input_tokens: 2, output_tokens: output, reasoning_output_tokens: 1, total_tokens: input + output });
const row = (type, payload) => ({ type, timestamp: '2026-11-10T10:00:00Z', payload });
const stringify = rows => rows.map(JSON.stringify).join('\n')+'\n';

test('measured totals are isolated by turn and not doubled by legacy mirror or duplicate response', () => {
  const report=parseTranscript(stringify([
    row('event_msg',{type:'task_started',turn_id:'t1'}),row('turn_context',{turn_id:'t1',model:'test-model'}),
    row('token_usage_record',{turn_id:'t1',response_id:'r1',usage:tokens(10,3)}),
    row('token_usage_record',{turn_id:'t1',response_id:'r1',usage:tokens(10,3)}),
    row('event_msg',{type:'token_count',info:{total_token_usage:tokens(10,3),last_token_usage:tokens(10,3)}}),
    row('event_msg',{type:'task_complete',turn_id:'t1'}),row('event_msg',{type:'task_started',turn_id:'t2'}),
    row('token_usage_record',{turn_id:'t2',response_id:'r2',usage:tokens(20,5)})
  ]));
  assert.equal(report.turns[0].usage.total_tokens,13);assert.equal(report.turns[0].usage.cached_input_tokens,2);
  assert.equal(report.turns[0].usage.output_tokens,3);assert.equal(report.turns[0].status,'completed');
  assert.equal(report.turns[1].usage.total_tokens,25);assert.equal(report.turns[0].requests.length,1);
});
test('input proxy excludes current generated call; tool results repeat only on later requests', () => {
  const report=parseTranscript(stringify([
    row('event_msg',{type:'task_started',turn_id:'t'}),row('response_item',{type:'custom_tool_call',call_id:'c',name:'exec',input:'abc'}),
    row('token_usage_record',{turn_id:'t',response_id:'r1',usage:tokens(10,3)}),row('response_item',{type:'custom_tool_call_output',call_id:'c',output:'abcdef'}),
    row('token_usage_record',{turn_id:'t',response_id:'r2',usage:tokens(20,4)}),row('token_usage_record',{turn_id:'t',response_id:'r3',usage:tokens(20,4)})
  ]));
  assert.equal(report.turns[0].categories.tool_calls,2);assert.equal(report.turns[0].consumers.exec,4);assert.equal(report.turns[0].usage.total_tokens,61);
});
test('legacy mirrors repeat safely and cumulative counters can reset', () => {
  const info=(total,last)=>row('event_msg',{type:'token_count',info:{total_token_usage:total,last_token_usage:last}});
  const report=parseTranscript(stringify([info(tokens(10,3),tokens(10,3)),info(tokens(10,3),tokens(10,3)),info(tokens(30,7),tokens(20,4)),info(tokens(5,2),tokens(5,2))]));
  assert.equal(report.turns[0].usage.total_tokens,44);assert.equal(report.turns[0].requests.length,3);
});
test('damaged lines are reported; incomplete writer line is tolerated; missing usage is unavailable', () => {
  const report=parseTranscript(stringify([row('event_msg',{type:'task_started',turn_id:'t'})])+'bad line\n{"unfinished":');
  assert.equal(report.malformedLines,1);assert.equal(report.turns[0].hasUsage,false);
  assert.equal(normalizeUsage({input_tokens:-1,output_tokens:2}),null);assert.equal(normalizeUsage({input_tokens:NaN,output_tokens:2}),null);
});
test('deep link binds both IDs and rejects traversal', () => {
  const link=responseLink('session-1','turn-2');
  const route=new URL(new URL(link.url).searchParams.get('path'),'https://example.invalid');
  assert.equal(route.searchParams.get('sessionId'),'session-1');assert.equal(route.searchParams.get('turnId'),'turn-2');assert.throws(()=>responseLink('../../auth','turn-2'));
});
test('store only reads session rollouts and refuses unknown turns', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'token-lens-test-'));const dir=path.join(home,'sessions','2026','11','10');fs.mkdirSync(dir,{recursive:true});
  const sessionId='11111111-2222-3333-4444-555555555555';const file=path.join(dir,`rollout-2026-11-10T10-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file,stringify([row('event_msg',{type:'task_started',turn_id:'turn'}),row('token_usage_record',{turn_id:'turn',response_id:'r',usage:tokens(10,3)})]));
  const store=createStore(home);assert.equal(store.answer(sessionId,'turn').turn.usage.total_tokens,13);
  assert.throws(()=>store.report('../auth'));assert.throws(()=>store.answer(sessionId,'unknown'));
  fs.appendFileSync(file,stringify([row('token_usage_record',{turn_id:'turn',response_id:'r2',usage:tokens(20,4)})]));
  assert.equal(store.answer(sessionId,'turn').turn.usage.total_tokens,37);
});
