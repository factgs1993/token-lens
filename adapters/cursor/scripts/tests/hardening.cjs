'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lens-test-'));
process.env.USERPROFILE = tmp;
process.env.HOME = tmp;

const libPath = path.join(__dirname, '..', 'lib.cjs');
delete require.cache[require.resolve(libPath)];
const {
  measuredFromPayload,
  saveTurn,
  loadChat,
  writeSessionPending,
  readSessionPending,
  emptyPending,
  mergeTurnReports,
  writeJson,
  deleteAnswerReports,
  listAnswerReports,
  writeSettings,
  purgeOldAnswers,
  DATA_DIR,
  CHATS_DIR,
} = require(libPath);

function testWriteJsonOverwritesOnWindows() {
  const file = path.join(DATA_DIR, 'write-json-overwrite.json');
  writeJson(file, { n: 1 });
  writeJson(file, { n: 2 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 2);
  // Concurrent-ish second writer with same destination.
  writeJson(file, { n: 3 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 3);
}

function testMeasuredNulls() {
  const onlyIn = measuredFromPayload({ input_tokens: 100 });
  assert.equal(onlyIn.input_tokens, 100);
  assert.equal(onlyIn.output_tokens, null);
  assert.equal(onlyIn.total_tokens, null);
  assert.equal(onlyIn.incomplete, true);

  const both = measuredFromPayload({ input_tokens: 10, output_tokens: 3, cache_read_tokens: 4 });
  assert.equal(both.total_tokens, 13);
  assert.equal(both.incomplete, false);
  assert.equal(both.uncached_input_tokens, 6);

  assert.equal(measuredFromPayload({}), null);
}

function testSaveTurnUpsert() {
  const chatId = 'chat-upsert-1';
  const report1 = {
    at: '2026-01-01T00:00:00.000Z',
    conversation_id: chatId,
    generation_id: 'gen-1',
    measured: { input_tokens: 10, output_tokens: 2, total_tokens: 12, incomplete: false },
    consumers: [{ name: 'Shell', tokens: 2 }],
    categories: { tool_calls: 5, tool_results: 2 },
  };
  const first = saveTurn(report1);
  assert.equal(first.isNew, true);
  assert.equal(first.turn_count, 1);

  const report2 = {
    at: '2026-01-01T00:01:00.000Z',
    conversation_id: chatId,
    generation_id: 'gen-1',
    measured: { input_tokens: 11, output_tokens: 3, total_tokens: 14, incomplete: false },
    consumers: [],
    categories: { tool_calls: 0, tool_results: 0 },
  };
  const second = saveTurn(report2);
  assert.equal(second.isNew, false);
  assert.equal(second.turn_count, 1);

  const chat = loadChat(chatId);
  assert.equal(chat.turns.length, 1);
  assert.equal(chat.turns[0].measured.total_tokens, 14);
  assert.equal(chat.turns[0].consumers.length, 1);
  assert.equal(chat.turns[0].consumers[0].name, 'Shell');
  assert.equal(chat.turns[0].categories.tool_results, 2);
}

function testMergeTurnReports() {
  const merged = mergeTurnReports(
    {
      generation_id: 'g',
      consumers: [{ name: 'Shell', tokens: 2 }],
      categories: { tool_calls: 9, tool_results: 2 },
      measured: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
    {
      generation_id: 'g',
      consumers: [],
      categories: { tool_calls: 0, tool_results: 0 },
      measured: { input_tokens: 120, output_tokens: 5, total_tokens: 125 },
      status: 'completed',
    }
  );
  assert.equal(merged.measured.total_tokens, 125);
  assert.equal(merged.consumers[0].tokens, 2);
  assert.equal(merged.categories.tool_calls, 9);
}

function testParallelSessions() {
  const a = emptyPending('chat-a');
  a.generation_id = 'ga';
  a.prompt_preview = 'hello A';
  writeSessionPending('chat-a', a);

  const b = emptyPending('chat-b');
  b.generation_id = 'gb';
  b.prompt_preview = 'hello B';
  writeSessionPending('chat-b', b);

  assert.equal(readSessionPending('chat-a').prompt_preview, 'hello A');
  assert.equal(readSessionPending('chat-b').prompt_preview, 'hello B');
  assert.notEqual(readSessionPending('chat-a').generation_id, readSessionPending('chat-b').generation_id);
}

function testAnswerLinkKeepsCompleted() {
  const chatId = 'chat-link-1';
  const gid = 'gen-link-1';
  saveTurn({
    at: '2026-01-01T00:00:00.000Z',
    conversation_id: chatId,
    generation_id: gid,
    status: 'completed',
    measured: { input_tokens: 100, output_tokens: 20, total_tokens: 120, incomplete: false },
    consumers: [{ name: 'Read', tokens: 3 }],
    prompt_preview: 'hi',
  });
  // Leftover prompt/pending metadata must not force in_progress rewrite.
  writeSessionPending(chatId, {
    ...emptyPending(chatId),
    generation_id: null,
    prompt_preview: 'hi',
  });
  writeJson(path.join(DATA_DIR, 'sessions', chatId, 'prompt.json'), {
    conversation_id: chatId,
    generation_id: gid,
    prompt_preview: 'hi',
    prompt_length: 2,
  });
  const answersDir = path.join(DATA_DIR, 'answers');
  fs.mkdirSync(answersDir, { recursive: true });
  writeJson(path.join(answersDir, `${gid}.json`), {
    conversation_id: chatId,
    generation_id: gid,
    status: 'completed',
    measured: { input_tokens: 100, output_tokens: 20, total_tokens: 120, incomplete: false },
    consumers: [{ name: 'Read', tokens: 3 }],
    prompt_preview: 'hi',
  });

  const link = path.join(__dirname, '..', 'answer-link.cjs');
  const run = spawnSync(process.execPath, [link, chatId, gid], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: tmp, HOME: tmp },
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const out = JSON.parse(run.stdout.trim());
  assert.equal(out.live, false);
  assert.equal(out.measured.total_tokens, 120);
  assert.equal(out.generation_id, gid);

  const saved = JSON.parse(fs.readFileSync(path.join(answersDir, `${gid}.json`), 'utf8'));
  assert.equal(saved.measured.total_tokens, 120);
  assert.notEqual(saved.status, 'in_progress');
}

function testAnswerLinkRequiresChatArgForParallel() {
  writeSessionPending('chat-a', { ...emptyPending('chat-a'), generation_id: 'ga', prompt_preview: 'A' });
  writeSessionPending('chat-b', { ...emptyPending('chat-b'), generation_id: 'gb', prompt_preview: 'B' });
  writeJson(path.join(DATA_DIR, 'active.json'), {
    conversation_id: 'chat-b',
    generation_id: 'gb',
    at: new Date().toISOString(),
  });
  const link = path.join(__dirname, '..', 'answer-link.cjs');
  const runA = spawnSync(process.execPath, [link, 'chat-a'], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: tmp, HOME: tmp },
    windowsHide: true,
  });
  assert.equal(runA.status, 0, runA.stderr || runA.stdout);
  const outA = JSON.parse(runA.stdout.trim());
  assert.equal(outA.conversation_id, 'chat-a');
  assert.equal(outA.generation_id, 'ga');
}

function testEnableDefaultKeepsBrokenMcp() {
  const mcpDir = path.join(tmp, '.cursor');
  fs.mkdirSync(mcpDir, { recursive: true });
  const mcpPath = path.join(mcpDir, 'mcp.json');
  const broken = '{ not json';
  fs.writeFileSync(mcpPath, broken);
  const enable = path.join(__dirname, '..', 'enable-default.cjs');
  const run = spawnSync(process.execPath, [enable], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: tmp, HOME: tmp, APPDATA: path.join(tmp, 'AppData', 'Roaming') },
    windowsHide: true,
  });
  assert.notEqual(run.status, 0);
  assert.equal(fs.readFileSync(mcpPath, 'utf8'), broken);
}

function testDeleteAnswerReports() {
  const chatId = 'chat-del-1';
  const gid = 'gen-del-1';
  saveTurn({
    at: '2026-01-01T00:00:00.000Z',
    conversation_id: chatId,
    generation_id: gid,
    measured: { input_tokens: 10, output_tokens: 2, total_tokens: 12, incomplete: false },
    consumers: [],
    categories: {},
    status: 'completed',
    prompt_preview: 'delete me',
  });
  const answersDir = path.join(DATA_DIR, 'answers');
  fs.mkdirSync(answersDir, { recursive: true });
  writeJson(path.join(answersDir, `${gid}.json`), {
    conversation_id: chatId,
    generation_id: gid,
    at: '2026-01-01T00:00:00.000Z',
    measured: { total_tokens: 12 },
    prompt_preview: 'delete me',
  });
  fs.writeFileSync(path.join(answersDir, `${gid}.html`), '<html>x</html>');
  assert.equal(listAnswerReports().some((row) => row.key === gid), true);
  const out = deleteAnswerReports([gid]);
  assert.deepEqual(out.deleted, [gid]);
  assert.equal(fs.existsSync(path.join(answersDir, `${gid}.json`)), false);
  assert.equal(fs.existsSync(path.join(answersDir, `${gid}.html`)), false);
  const chat = loadChat(chatId);
  assert.equal(chat.turns.some((row) => row.generation_id === gid), false);
}

testWriteJsonOverwritesOnWindows();
testMeasuredNulls();
testSaveTurnUpsert();
testMergeTurnReports();
testParallelSessions();
testAnswerLinkKeepsCompleted();
testAnswerLinkRequiresChatArgForParallel();
testEnableDefaultKeepsBrokenMcp();
testDeleteAnswerReports();

function testAutoPurgeByDays() {
  const gid = 'gen-old-1';
  const answersDir = path.join(DATA_DIR, 'answers');
  fs.mkdirSync(answersDir, { recursive: true });
  writeJson(path.join(answersDir, `${gid}.json`), {
    conversation_id: 'chat-old',
    generation_id: gid,
    at: '2020-01-01T00:00:00.000Z',
    measured: { total_tokens: 1 },
    prompt_preview: 'old',
  });
  fs.writeFileSync(path.join(answersDir, `${gid}.html`), '<html>old</html>');
  writeSettings({ autoDeleteDays: 7, lastAutoPurgeAt: null });
  const out = purgeOldAnswers({ force: true });
  assert.equal(out.skipped, false);
  assert.ok(out.deleted.includes(gid));
  assert.equal(fs.existsSync(path.join(answersDir, `${gid}.json`)), false);
  writeSettings({ autoDeleteDays: 0 });
}

testAutoPurgeByDays();

function testAnswerMarkdownFlags() {
  writeSettings({
    autoDeleteDays: 0,
    appendPlanLimits: true,
    lastAutoPurgeAt: null,
  });
  delete require.cache[require.resolve(path.join(__dirname, '..', 'answer-page.cjs'))];
  const { buildAnswerMarkdown } = require(path.join(__dirname, '..', 'answer-page.cjs'));
  const md = buildAnswerMarkdown('http://127.0.0.1:3847/answers/x.html', {
    measured: { input_tokens: 1200, output_tokens: 34, incomplete: false },
    plan_usage: {
      membership: 'pro',
      billing_cycle_end: '2026-12-01T00:00:00.000Z',
      plan: { auto_percent_used: 12.4, api_percent_used: 3.1 },
    },
  });
  assert.match(md, /^\[📊 Аналитика запроса\/ответа\]/);
  assert.equal(md.includes('↓'), false);
  assert.match(md, /Лимиты:.*Auto 12%/);
  writeSettings({ appendPlanLimits: false });
}

testAnswerMarkdownFlags();

console.log(JSON.stringify({ ok: true, tmp, chats: CHATS_DIR }));
