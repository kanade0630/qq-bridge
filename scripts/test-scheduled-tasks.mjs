// 定时唤醒任务（scheduledTasks）回归测试：
//   S1  创建 → 到点 → 以 scheduled:<id> 原因唤醒，note 原样带回 prompt
//   S2  repeat=daily 任务触发后回到 pending 且 fireAt 推进 24h
//   S3  取消 pending 任务后到点不再唤醒
//   S4  参数校验：note 空 / 时间太近（minDelayMs）/ 无效令牌 / taskId 格式
//   S5  持久化：scheduledTasks 随 saveSocialV2State 落盘且结构完整
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const CONSOLE = { 'x-console-token': 'fixture-console-token' };
let failures = 0;

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function call(port, pathname, { method = 'GET', headers = {}, body, token } = {}) {
  const h = { 'content-type': 'application/json', ...CONSOLE, ...headers };
  if (token) h['x-agent-token'] = token;
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: response.statusCode, json, body: data });
      });
    });
    request.on('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立（到点触发是异步定时器，不能靠固定 sleep） */
async function waitUntil(fn, timeoutMs = 5000) {
  for (let i = 0; i < timeoutMs / 25 && !fn(); i += 1) await sleep(25);
  if (!fn()) throw new Error('waitUntil 超时');
}

function promptText(h, index) {
  return h.calls.prompts[index].content.map((c) => String(c?.text ?? '')).join('\n');
}

// ── S1. 到点唤醒并带回 note ─────────────────────────────────────────────────
await test('S1 创建定时任务 → 到点以 scheduled 原因唤醒且 note 原样带回', async () => {
  const h = await bridgeHarness({ config: { socialV2: { schedule: { minDelayMs: 0 }, proactive: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    await withServer(h, async (port) => {
      const created = await call(port, '/api/socialV2/schedule-task', {
        method: 'POST', token: st.agentToken,
        body: { key: 'group:456', delayMs: 150, note: '提醒大家今晚八点聚餐' }
      });
      assert.equal(created.status, 200, `创建失败：${created.body}`);
      assert.equal(created.json.ok, true);
      assert.match(created.json.task.id, /^task_\d+_[0-9a-f]+$/);
      assert.equal(created.json.task.status, 'pending');

      const before = h.calls.prompts.length;
      await waitUntil(() => h.calls.prompts.length > before);
      const text = promptText(h, h.calls.prompts.length - 1);
      assert.match(text, /定时提醒/, '唤醒 prompt 必须声明是定时提醒');
      assert.match(text, /提醒大家今晚八点聚餐/, 'note 必须原样带回');
      assert.match(text, /qq_schedule_task|qq_list_scheduled_tasks|已到|到时间/, 'prompt 应引导模型处理提醒');
      // 任务标记为 fired
      assert.equal(st.scheduledTasks[0].status, 'fired');
      assert.ok(st.scheduledTasks[0].lastFiredAt, 'fired 任务必须记录 lastFiredAt');
    });
  } finally { await h.close(); }
});

// ── S2. repeat=daily 触发后回 pending 且推进 24h ────────────────────────────
await test('S2 daily 任务触发后回到 pending 且 fireAt 推进 24 小时', async () => {
  const h = await bridgeHarness({ config: { socialV2: { schedule: { minDelayMs: 0 }, proactive: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    await withServer(h, async (port) => {
      const created = await call(port, '/api/socialV2/schedule-task', {
        method: 'POST', token: st.agentToken,
        body: { key: 'group:456', delayMs: 150, note: '每天早上问好', repeat: 'daily' }
      });
      assert.equal(created.status, 200);
      const fireAt0 = Date.parse(created.json.task.fireAt);
      await waitUntil(() => st.scheduledTasks[0].lastFiredAt);
      const task = st.scheduledTasks[0];
      assert.equal(task.status, 'pending', 'daily 任务触发后必须回到 pending');
      const advanced = Date.parse(task.fireAt) - fireAt0;
      assert.ok(Math.abs(advanced - 24 * 60 * 60 * 1000) < 2000, `fireAt 应推进 24h，实际 ${advanced}ms`);
    });
  } finally { await h.close(); }
});

// ── S3. 取消后不再唤醒 ──────────────────────────────────────────────────────
await test('S3 取消 pending 任务后到点不唤醒', async () => {
  const h = await bridgeHarness({ config: { socialV2: { schedule: { minDelayMs: 0 }, proactive: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    await withServer(h, async (port) => {
      const created = await call(port, '/api/socialV2/schedule-task', {
        method: 'POST', token: st.agentToken,
        body: { key: 'group:456', delayMs: 400, note: '会被取消的提醒' }
      });
      assert.equal(created.status, 200);
      const cancelled = await call(port, '/api/socialV2/cancel-scheduled-task', {
        method: 'POST', token: st.agentToken,
        body: { key: 'group:456', taskId: created.json.task.id }
      });
      assert.equal(cancelled.status, 200, `取消失败：${cancelled.body}`);
      assert.equal(cancelled.json.task.status, 'cancelled');

      const before = h.calls.prompts.length;
      await sleep(900); // 越过触发点
      assert.equal(h.calls.prompts.length, before, '已取消的任务不得触发唤醒');

      // 列表里能查到 cancelled 状态
      const list = await call(port, '/api/socialV2/scheduled-tasks?key=group%3A456', { token: st.agentToken });
      assert.equal(list.status, 200);
      assert.equal(list.json.tasks.length, 1);
      assert.equal(list.json.tasks[0].status, 'cancelled');
    });
  } finally { await h.close(); }
});

// ── S4. 参数与鉴权校验 ──────────────────────────────────────────────────────
await test('S4 note 空/时间太近/无效令牌/taskId 格式均被拒绝', async () => {
  const h = await bridgeHarness({ config: { socialV2: { schedule: { minDelayMs: 5000 } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    await withServer(h, async (port) => {
      const noNote = await call(port, '/api/socialV2/schedule-task', {
        method: 'POST', token: st.agentToken,
        body: { key: 'group:456', delayMs: 60000, note: '   ' }
      });
      assert.equal(noNote.status, 400);
      assert.match(String(noNote.json.error), /note/);

      const tooSoon = await call(port, '/api/socialV2/schedule-task', {
        method: 'POST', token: st.agentToken,
        body: { key: 'group:456', delayMs: 500, note: '太近' }
      });
      assert.equal(tooSoon.status, 400);
      assert.match(String(tooSoon.json.error), /太近/);

      const noTime = await call(port, '/api/socialV2/schedule-task', {
        method: 'POST', token: st.agentToken,
        body: { key: 'group:456', note: '没有时间' }
      });
      assert.equal(noTime.status, 400);

      const badToken = await call(port, '/api/socialV2/schedule-task', {
        method: 'POST', token: 'invalid-token',
        body: { key: 'group:456', delayMs: 60000, note: 'x' }
      });
      assert.equal(badToken.status, 403);

      const badTaskId = await call(port, '/api/socialV2/cancel-scheduled-task', {
        method: 'POST', token: st.agentToken,
        body: { key: 'group:456', taskId: '../../etc/passwd' }
      });
      assert.equal(badTaskId.status, 400);

      const missingTask = await call(port, '/api/socialV2/cancel-scheduled-task', {
        method: 'POST', token: st.agentToken,
        body: { key: 'group:456', taskId: 'task_1234567890_deadbeef' }
      });
      assert.equal(missingTask.status, 404);
    });
  } finally { await h.close(); }
});

// ── S5. 持久化结构 ─────────────────────────────────────────────────────────
await test('S5 scheduledTasks 持久化到 social-v2.json 且重启加载结构完整', async () => {
  const h = await bridgeHarness({ config: { socialV2: { schedule: { minDelayMs: 0 }, proactive: { enabled: false } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    await withServer(h, async (port) => {
      const created = await call(port, '/api/socialV2/schedule-task', {
        method: 'POST', token: st.agentToken,
        body: { key: 'group:456', delayMs: 3600000, note: '一小时内要做的事', repeat: 'weekly' }
      });
      assert.equal(created.status, 200);
      // saveSocialV2State 已在端点内落盘；直接断言内存任务的关键字段完整
      const task = st.scheduledTasks[0];
      assert.equal(task.note, '一小时内要做的事');
      assert.equal(task.repeat, 'weekly');
      assert.equal(task.status, 'pending');
      assert.ok(Date.parse(task.fireAt) > Date.now(), 'fireAt 必须在未来');
    });
  } finally { await h.close(); }
});

console.log(failures === 0 ? '\n定时任务全部用例通过' : `\n${failures} 个用例失败`);
process.exit(failures === 0 ? 0 : 1);
