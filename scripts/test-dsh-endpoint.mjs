// DSH 端点发现的单测：纯函数解析 + 返回形状 + 写回幂等。
// 不依赖真 DSH：判定逻辑用本地临时 HTTP 服务模拟（401 正文照抄实测原文）。
// 用法：node scripts/test-dsh-endpoint.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverDshBaseUrl,
  isLoopbackHost,
  parseDshPids,
  parseNetstatListeners,
  persistDshBaseUrl,
  probeDshBaseUrl
} from '../src/dsh-endpoint.js';

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`✅ ${name}`);
  } else {
    failed += 1;
    console.log(`❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ── parseNetstatListeners ──────────────────────────────────────────────────
const netstatSample = [
  '  TCP    127.0.0.1:14446        0.0.0.0:0              LISTENING       36668',
  '  TCP    0.0.0.0:1031           0.0.0.0:0              LISTENING       7244',
  '  TCP    127.0.0.1:3001         0.0.0.0:0              ESTABLISHED     41644',
  '  TCP    [::1]:54331            [::]:0                 LISTENING       3616',
  '  TCP    192.168.1.5:9000       0.0.0.0:0              LISTENING       111',
  '  乱码行'
].join('\r\n');
const parsed = parseNetstatListeners(netstatSample);
check('netstat：只收回环/通配的 LISTENING', parsed.length === 3, JSON.stringify(parsed));
check('netstat：端口与 PID 正确', parsed[0].port === 14446 && parsed[0].pid === '36668');
check('netstat：排除 ESTABLISHED', !parsed.some((p) => p.port === 3001));

// ── parseDshPids ───────────────────────────────────────────────────────────
const tasklistSample = [
  '"DeepSeek Harness.exe","24048","Console","1","120,000 K"',
  '"Code.exe","1234","Console","1","80,000 K"',
  '"dsh.exe","999","Console","1","10,000 K"',
  '"node.exe","777","Console","1","20,000 K"'
].join('\r\n');
const pids = parseDshPids(tasklistSample);
check('tasklist：识别桌面版与 CLI 版', pids.has('24048') && pids.has('999'), [...pids].join(','));
check('tasklist：不把 node.exe 当 DSH', !pids.has('777'));

// ── isLoopbackHost ────────────────────────────────────────────────────────
check('回环判定：127.0.0.1', isLoopbackHost('http://127.0.0.1:14446'));
check('回环判定：localhost', isLoopbackHost('http://localhost:3080'));
check('回环判定：IPv6 ::1', isLoopbackHost('http://[::1]:3080'));
check('回环判定：局域网地址为 false', !isLoopbackHost('http://192.168.1.9:3080'));
check('回环判定：非法串为 false', !isLoopbackHost('not-a-url'));

// ── probeDshBaseUrl：用本地服务模拟 DSH 的两种响应 ──────────────────────────
const dshLike = http.createServer((req, res) => {
  res.writeHead(401, { 'content-type': 'text/plain' });
  res.end('dsh web authentication required; reopen the URL printed by dsh web.');
});
const plainLike = http.createServer((req, res) => {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not here');
});
await new Promise((r) => dshLike.listen(0, '127.0.0.1', r));
await new Promise((r) => plainLike.listen(0, '127.0.0.1', r));
const dshPort = dshLike.address().port;
const plainPort = plainLike.address().port;

const hit = await probeDshBaseUrl(`http://127.0.0.1:${dshPort}`);
check('探测：401 特征串判为 DSH', hit.ok && hit.reason === 'auth-required', JSON.stringify(hit));
const miss = await probeDshBaseUrl(`http://127.0.0.1:${plainPort}`);
check('探测：普通 404 不判为 DSH', !miss.ok, JSON.stringify(miss));
const dead = await probeDshBaseUrl('http://127.0.0.1:1');
check('探测：死端口判为不可达', !dead.ok, JSON.stringify(dead));

// ── discoverDshBaseUrl：配置命中时零扫描 ───────────────────────────────────
const fast = await discoverDshBaseUrl({ configured: `http://127.0.0.1:${dshPort}` });
check('发现：配置值可用时直接采用', fast.baseUrl === `http://127.0.0.1:${dshPort}` && fast.source === 'configured');
check('发现：配置命中只探测 1 次', fast.scanned === 1, String(fast.scanned));

// ── discoverDshBaseUrl：远程地址不参与发现 ─────────────────────────────────
const remote = await discoverDshBaseUrl({ configured: 'http://192.168.1.9:3080' });
check('发现：远程 baseUrl 原样返回且不扫描', remote.baseUrl === 'http://192.168.1.9:3080' && remote.skipped === 'remote');

// ── discoverDshBaseUrl：配置错时能扫到可用端点 ─────────────────────────────
// 注意：这台机器上真 DSH 可能也在跑，扫描可能先命中它；这里只断言「扫出来的不是原配置，
// 且是个能用的端点」，不要求一定是 mock 端口（否则测试会和环境强耦合）。
const found = await discoverDshBaseUrl({ configured: 'http://127.0.0.1:1' });
check('发现：配置不可达时能找到可用端点', Boolean(found.baseUrl) && found.source !== 'configured',
  JSON.stringify({ baseUrl: found.baseUrl, source: found.source, scanned: found.scanned }));
check('发现：候选带来源标记', found.candidates.every((c) => ['configured', 'process', 'scan'].includes(c.source)));

await new Promise((r) => dshLike.close(r));
await new Promise((r) => plainLike.close(r));

// ── persistDshBaseUrl：幂等 + BOM 保留 ────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-endpoint-'));
const cfgPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(cfgPath, '\uFEFF' + JSON.stringify({ dsh: { baseUrl: 'http://127.0.0.1:3080', model: 'x' }, other: 1 }, null, 2) + '\n', 'utf8');
const w1 = persistDshBaseUrl(cfgPath, 'http://127.0.0.1:14446');
check('写回：值变化时 updated=true', w1.updated === true && w1.from === 'http://127.0.0.1:3080');
const afterText = fs.readFileSync(cfgPath, 'utf8');
check('写回：保留 UTF-8 BOM', afterText.charCodeAt(0) === 0xFEFF);
const afterCfg = JSON.parse(afterText.replace(/^\uFEFF/, ''));
check('写回：只改 dsh.baseUrl，其它字段不动', afterCfg.dsh.baseUrl === 'http://127.0.0.1:14446'
  && afterCfg.dsh.model === 'x' && afterCfg.other === 1);
const w2 = persistDshBaseUrl(cfgPath, 'http://127.0.0.1:14446');
check('写回：值相同时幂等（不重写文件）', w2.updated === false);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
