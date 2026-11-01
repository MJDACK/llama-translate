// 全量接口自测
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8787';
const results = [];
const t0 = Date.now();

function ok(name, detail = '', ms) { results.push({ name, pass: true, detail, ms }); console.log('  PASS', name, detail, ms ? ms + 'ms' : ''); }
function bad(name, detail = '') { results.push({ name, pass: false, detail }); console.log('  FAIL', name, detail); }

async function sse(url, body) {
  const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const rd = r.body.getReader(); const dec = new TextDecoder();
  let buf = '', done = null, start = null, err = null;
  while (true) {
    const { value, done: d } = await rd.read(); if (d) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = '', data = '';
      for (const l of raw.split('\n')) { if (l.startsWith('event:')) ev = l.slice(6).trim(); else if (l.startsWith('data:')) data += l.slice(5).trim(); }
      if (!data) continue;
      const j = JSON.parse(data);
      if (ev === 'done') done = j;
      if (ev === 'start') start = j;
      if (ev === 'error') err = j;
    }
  }
  if (err) throw new Error(err.message);
  return { start, done };
}

async function jget(url) { const r = await fetch(BASE + url); return r.json(); }
async function jpost(url, body) {
  const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { code: r.status, json: await r.json() };
}

async function waitReady(max = 120) {
  for (let i = 0; i < max; i++) {
    try { const s = await jget('/api/state'); if (s.status === 'ready') return s; if (s.status === 'error') return s; } catch { }
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

// ---------- 1. 状态 ----------
console.log('\n[1] 服务状态');
let st;
try {
  st = await jget('/api/state');
  if (st.status === 'ready' && st.vision) ok('state ready + vision', st.modelName + ' @' + st.port);
  else bad('state', JSON.stringify(st).slice(0, 200));
} catch (e) { bad('state', e.message); }

// ---------- 2. 中译英（按句 / 按短语 / 自动） ----------
console.log('\n[2] 中译英');
const zhText = '清晨的雾气漫过山谷，一个穿红裙的女孩站在石桥上。远处有座废弃的灯塔，逆光。浅景深，电影级打光。';
for (const mode of ['sentence', 'phrase', 'auto']) {
  const t = Date.now();
  try {
    const { start, done } = await sse('/api/translate', { text: zhText, mode, direction: 'zh2en' });
    const empty = done.blocks.filter(b => !b.trim()).length;
    if (done.units.length > 0 && empty === 0) ok('translate zh2en ' + mode, done.units.length + ' 块', Date.now() - t);
    else bad('translate zh2en ' + mode, 'units=' + done.units.length + ' empty=' + empty);
  } catch (e) { bad('translate zh2en ' + mode, e.message); }
}

// ---------- 3. 术语强制 ----------
console.log('\n[3] 词典强制');
try {
  const { done } = await sse('/api/translate', { text: '浅景深，逆光，赛博朋克，洛丽塔', mode: 'phrase', direction: 'zh2en' });
  const all = done.blocks.join(' | ').toLowerCase();
  const need = ['shallow depth of field', 'backlighting', 'cyberpunk', 'lolita'];
  const miss = need.filter(n => !all.includes(n));
  if (!miss.length) ok('glossary enforced', all.slice(0, 60));
  else bad('glossary enforced', '缺 ' + miss.join(', '));
} catch (e) { bad('glossary enforced', e.message); }

// ---------- 4. 英译中 ----------
console.log('\n[4] 英译中');
try {
  const t = Date.now();
  const { done } = await sse('/api/translate', { text: 'A girl with silver hair holds a transparent umbrella on a neon street after rain. Backlighting, shallow depth of field.', mode: 'auto', direction: 'en2zh' });
  const hasZh = done.blocks.every(b => /[\u4e00-\u9fa5]/.test(b));
  if (done.blocks.length && hasZh) ok('translate en2zh', done.blocks.length + ' 块', Date.now() - t);
  else bad('translate en2zh', JSON.stringify(done.blocks).slice(0, 120));
} catch (e) { bad('translate en2zh', e.message); }

// ---------- 5. 单块重译 ----------
console.log('\n[5] 单块重译');
for (const [dir, unit] of [['zh2en', '一个银发女孩撑着透明雨伞'], ['en2zh', 'a girl with silver hair']]) {
  try {
    const t = Date.now();
    const { code, json } = await jpost('/api/retranslate', { unit, full: unit, n: 1, mode: 'phrase', direction: dir });
    const good = code === 200 && json.text && (dir === 'zh2en' ? !/[\u4e00-\u9fa5]/.test(json.text) : /[\u4e00-\u9fa5]/.test(json.text));
    if (good) ok('retranslate ' + dir, json.text.slice(0, 50), Date.now() - t);
    else bad('retranslate ' + dir, JSON.stringify(json).slice(0, 120));
  } catch (e) { bad('retranslate ' + dir, e.message); }
}

// ---------- 6. 自然语言生成 ----------
console.log('\n[6] 自然语言生成');
try {
  const t = Date.now();
  const { done } = await sse('/api/generate', { instruction: '写 4 条提示词：雨夜赛博朋克少女，银发，透明雨伞' });
  const pairs = done.blocks.filter(b => b.a && b.b);
  if (pairs.length >= 3) ok('generate pairs', pairs.length + ' 对', Date.now() - t);
  else bad('generate pairs', JSON.stringify(done.blocks).slice(0, 200));
} catch (e) { bad('generate pairs', e.message); }

// ---------- 7. 对话改块 ----------
console.log('\n[7] 对话改块');
try {
  const t = Date.now();
  const { code, json } = await jpost('/api/revise', {
    direction: 'zh2en',
    blocks: ['neon street after rain', 'a girl with silver hair holding an umbrella', 'backlighting'],
    instruction: '把头发改成白色',
    history: []
  });
  if (code === 200 && json.changes.length >= 1 && /white/i.test(JSON.stringify(json.changes))) ok('revise blocks', json.changes.length + ' 处', Date.now() - t);
  else bad('revise blocks', JSON.stringify(json).slice(0, 200));
} catch (e) { bad('revise blocks', e.message); }

// ---------- 8. 改输入 ----------
console.log('\n[8] 对话改输入');
try {
  const t = Date.now();
  const { code, json } = await jpost('/api/rewrite', { text: '雨夜的霓虹街道，一个银发女孩撑着透明雨伞回头。', instruction: '把雨改成大雪', direction: 'zh2en' });
  if (code === 200 && /雪/.test(json.text) && !/雨夜的霓虹/.test(json.text)) ok('rewrite input', json.text.slice(0, 40), Date.now() - t);
  else bad('rewrite input', json.text);
} catch (e) { bad('rewrite input', e.message); }

// ---------- 9. 识图 ----------
console.log('\n[9] 识图');
const img = 'C:/Users/majia/AppData/Local/Temp/lt_test.png';
if (fs.existsSync(img)) {
  const b64 = fs.readFileSync(img).toString('base64');
  try {
    const t = Date.now();
    const { done } = await sse('/api/vision', { image: 'data:image/png;base64,' + b64, english: false });
    if (done.text && /[\u4e00-\u9fa5]/.test(done.text)) ok('vision cn', done.text.slice(0, 30) + '…', Date.now() - t);
    else bad('vision cn', JSON.stringify(done).slice(0, 120));
  } catch (e) { bad('vision cn', e.message); }
  try {
    const t = Date.now();
    const { done } = await sse('/api/vision', { image: 'data:image/png;base64,' + b64, english: true });
    if (done.blocks && done.blocks.length >= 3) ok('vision en blocks', done.blocks.length + ' 块', Date.now() - t);
    else bad('vision en blocks', JSON.stringify(done).slice(0, 150));
  } catch (e) { bad('vision en blocks', e.message); }
} else {
  bad('vision', '测试图不存在');
}

// ---------- 10. 词典接口 ----------
console.log('\n[10] 词典接口');
try {
  const g = await jget('/api/glossary');
  const allOn = g.categories.every(c => c.enabled);
  ok('glossary get', g.entries.length + ' 条 / ' + g.categories.length + ' 类' + (allOn ? '（全启用）' : '（有分类关闭）'));
} catch (e) { bad('glossary get', e.message); }

// ---------- 11. 切模型 ----------
console.log('\n[11] 切模型');
try {
  const t = Date.now();
  await jpost('/api/model', { id: 'qwen2b' });
  await new Promise(r => setTimeout(r, 1500));
  const s = await waitReady();
  if (s && s.status === 'ready' && /2B/i.test(s.modelName)) {
    const { done } = await sse('/api/translate', { text: '一个女孩站在桥上', mode: 'sentence', direction: 'zh2en' });
    ok('switch → 2B + 翻译', done.blocks[0] || '', Date.now() - t);
  } else bad('switch → 2B', JSON.stringify(s).slice(0, 150));
} catch (e) { bad('switch → 2B', e.message); }

try {
  const t = Date.now();
  await jpost('/api/model', { id: 'qwen4b' });
  await new Promise(r => setTimeout(r, 1500));
  const s = await waitReady();
  if (s && s.status === 'ready' && /4B/i.test(s.modelName)) ok('switch → 4B', s.modelName, Date.now() - t);
  else bad('switch → 4B', JSON.stringify(s).slice(0, 150));
} catch (e) { bad('switch → 4B', e.message); }

// ---------- 汇总 ----------
const pass = results.filter(r => r.pass).length;
console.log('\n================');
console.log(`通过 ${pass}/${results.length}，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const fails = results.filter(r => !r.pass);
if (fails.length) { console.log('失败项：'); fails.forEach(f => console.log(' -', f.name, '|', f.detail)); }
