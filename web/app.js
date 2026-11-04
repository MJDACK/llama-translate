'use strict';
/* 提示词翻译台 —— 前端（双向翻译 + 原文编辑联动 + 自然语言修改） */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const LS_KEY = 'tt.v2';

const S = {
  blocks: [],          // {a: 原文, b: 译文}
  mode: 'auto',
  dir: 'zh2en',        // 下一轮翻译方向
  blockDir: 'zh2en',   // 当前这批块是用哪个方向翻出来的
  imgSize: 768,
  imgMode: 'cn',
  image: null,
  glossary: null,
  server: null,
  busy: false,
  history: [],         // 自然语言修改历史
  snapshots: [],       // 撤销栈
  chatMode: 'blocks',  // blocks = 改提示词块，input = 改左边输入
  nl: false,           // 当前这批块是「自然语言生成」出来的（没有原文）
  tab: 'text',         // 当前页签
  providers: null,     // { active, list: [...] } 模型来源
  custom: { system: '', messages: [], images: [] },   // 自定义系统提示词 + 对话（可多图）
  noSync: false        // 翻译/生成进行中，先别回写输入框（避免闪空）
};

let outHeight = 240;   // 输出区展开时的高度
let chatH = 0;         // 左栏下半（自然语言修改）的高度，0 = 用默认比例

const LABELS = {
  zh2en: { src: '中文', dst: 'English', srcPh: '中文原文…', dstPh: '英文译文…' },
  en2zh: { src: 'English', dst: '中文', srcPh: 'English 原文…', dstPh: '中文译文…' }
};
const curLabels = () => LABELS[S.blockDir] || LABELS.zh2en;

/* ------------------------------ 小工具 ------------------------------ */
let toastTimer = null;
function toast(msg, ms = 1700) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { }
    ta.remove();
    return ok;
  }
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.max(el.classList.contains('src') ? 18 : 24, el.scrollHeight + 2) + 'px';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const esc = escapeHtml;

/* ------------------------------ 持久化 ------------------------------ */
const saveLocal = debounce(() => {
  try {
    const out = $('#output');
    if (out && !out.classList.contains('collapsed')) outHeight = out.offsetHeight;
    localStorage.setItem(LS_KEY, JSON.stringify({
      text: $('#zh').value,
      desc: $('#desc').value,
      nlText: $('#nl').value,
      nl: S.nl,
      tab: S.tab,
      blocks: S.blocks,
      mode: S.mode,
      dir: S.dir,
      blockDir: S.blockDir,
      imgSize: S.imgSize,
      imgMode: S.imgMode,
      sysText: $('#sysText') ? $('#sysText').value : (S.custom && S.custom.system) || '',
      chatMsgs: ((S.custom && S.custom.messages) || []).map(m => ({ role: m.role, content: m.content })),
      outH: outHeight,
      chatH: chatH,
      outCollapsed: out ? out.classList.contains('collapsed') : false
    }));
  } catch (_) { }
}, 400);

function restoreLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.text) $('#zh').value = d.text;
    if (d.desc) $('#desc').value = d.desc;
    if (d.nlText) $('#nl').value = d.nlText;
    if (typeof d.nl === 'boolean') S.nl = d.nl;
    if (d.tab) { S.tab = d.tab; switchTab(d.tab); }
    if (Array.isArray(d.blocks)) {
      S.blocks = d.blocks.map(b => ({
        a: b.a != null ? b.a : (b.zh || ''),
        b: b.b != null ? b.b : (b.en || '')
      }));
    }
    if (d.mode) S.mode = d.mode;
    if (d.dir) S.dir = d.dir;
    S.blockDir = d.blockDir || S.dir;
    if (d.imgSize) S.imgSize = d.imgSize;
    if (d.imgMode) S.imgMode = d.imgMode;
    if (typeof d.sysText === 'string' && $('#sysText')) $('#sysText').value = d.sysText;
    if (Array.isArray(d.chatMsgs)) {
      S.custom = S.custom || { system: '', messages: [], images: [] };
      S.custom.messages = d.chatMsgs
        .filter(m => m && typeof m.content === 'string')
        .map(m => ({
          role: m.role,
          content: m.content,
          images: Array.isArray(m.images) ? m.images.slice(0, 8) : (m.image ? [m.image] : [])
        }))
        .slice(-40);
    }
    if (d.outH) outHeight = d.outH;
    if (d.chatH) chatH = d.chatH;
    if (d.outCollapsed) {
      const o = $('#output');
      if (o) { o.classList.add('collapsed'); o.style.height = ''; }
      const b = $('#btnToggleOut');
      if (b) b.textContent = '▸';
    } else if (d.outH) {
      const o = $('#output');
      if (o) o.style.height = d.outH + 'px';
    }
  } catch (_) { }
}

/* ------------------------------ SSE ------------------------------ */
async function streamSSE(url, body, handlers, signal) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch (_) { }
    throw new Error(msg);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = 'message', data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch (_) { continue; }
      if (handlers[ev]) handlers[ev](parsed);
    }
  }
}

/* ------------------------------ 块渲染 ------------------------------ */
function buildBlock(b, i) {
  const L = curLabels();
  const el = document.createElement('div');
  el.className = 'block';
  el.dataset.i = i;
  el.innerHTML =
    '<div class="bh">' +
      '<span class="idx">' + String(i + 1).padStart(2, '0') + '</span>' +
      '<span class="lang">' + esc(L.src) + '</span>' +
      '<div class="ba">' +
        '<button data-act="up" title="上移">↑</button>' +
        '<button data-act="down" title="下移">↓</button>' +
        '<button data-act="re" title="按原文重译这块">重译</button>' +
        '<button data-act="copy" title="复制译文">复制</button>' +
        '<button data-act="del" class="del" title="删除">✕</button>' +
      '</div>' +
    '</div>' +
    '<textarea class="src" rows="1" spellcheck="false" placeholder="' + esc(L.srcPh) + '">' + esc(b.a || '') + '</textarea>' +
    '<textarea class="tgt" rows="1" spellcheck="false" placeholder="' + esc(L.dstPh) + '">' + esc(b.b || '') + '</textarea>';
  requestAnimationFrame(() => {
    const s = el.querySelector('.src'); if (s) autoGrow(s);
    const t = el.querySelector('.tgt'); if (t) autoGrow(t);
  });
  return el;
}

function renderBlocks() {
  const box = $('#blocks');
  box.innerHTML = '';
  S.blocks.forEach((b, i) => box.appendChild(buildBlock(b, i)));
  toggleEmpty();
  updateInfo();
}

function toggleEmpty() {
  $('#emptyTip').style.display = S.blocks.length ? 'none' : 'flex';
}

function updateInfo() {
  const n = S.blocks.filter(b => (b.b || '').trim()).length;
  $('#blockInfo').textContent = n + '/' + S.blocks.length + ' 块';
  syncInputFromBlocks();   // 输入框跟着块走
  updateOutput();
  updateSyncBtn();
}

// 输入框和块不一致时，给一个手动同步的按钮
function updateSyncBtn() {
  const btn = $('#btnSyncIn');
  if (!btn) return;
  const joined = S.blocks.map(b => (b.a || '').trim()).filter(Boolean).join('\n');
  const ta = inputEl();
  btn.hidden = !(joined && ta && ta.value.trim() !== joined);
}

/* 底部输出区：不管方向如何，永远中文在上、英文在下 */
function updateOutput() {
  const zhEl = $('#outZh'), enEl = $('#outEn');
  const boxZh = $('#outZhBox'), boxEn = $('#outEnBox');
  const lblZh = $('#outZhLabel');
  const cnt = $('#outCount');
  if (!zhEl || !enEl) return;

  if (lblZh) lblZh.textContent = '中文';
  if (boxEn) boxEn.style.display = '';
  if (boxZh) boxZh.style.gridRow = '';

  const srcIsZh = S.blockDir !== 'en2zh';
  const zh = [], en = [];
  for (const b of S.blocks) {
    const z = ((srcIsZh ? b.a : b.b) || '').trim();
    const e = ((srcIsZh ? b.b : b.a) || '').trim();
    if (z) zh.push(z);
    if (e) en.push(e);
  }
  zhEl.value = zh.join('\n');
  enEl.value = en.join('\n');
  if (cnt) cnt.textContent = zh.length + ' 段中文 · ' + en.length + ' 段英文';
}

function setTarget(i, text) {
  const el = document.querySelector('.block[data-i="' + i + '"] .tgt');
  if (!el) return;
  if (document.activeElement !== el) { el.value = text; autoGrow(el); }
}

function markStreaming(i) {
  $$('.block').forEach(el => el.classList.remove('streaming'));
  if (i >= 0) {
    const el = document.querySelector('.block[data-i="' + i + '"]');
    if (el) { el.classList.add('streaming'); el.scrollIntoView({ block: 'nearest' }); }
  }
}

function flashBlock(i) {
  const el = document.querySelector('.block[data-i="' + i + '"]');
  if (!el) return;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1100);
}

function toggleOutput() {
  const o = $('#output'), btn = $('#btnToggleOut');
  if (o.classList.contains('collapsed')) {
    o.classList.remove('collapsed');
    o.style.height = outHeight + 'px';
    btn.textContent = '▾';
  } else {
    outHeight = o.offsetHeight;
    o.classList.add('collapsed');
    o.style.height = '';
    btn.textContent = '▸';
  }
  saveLocal();
}

/* ------------------------------ 翻译 ------------------------------ */
// 同步目标就认「当前看得见的那一栏」：文字翻译 → 输入框，图片识图 → 描述框
function activeTab() {
  const el = document.querySelector('.tabbody:not([hidden])');
  const n = el ? el.dataset.pane : 'text';
  return (n === 'image' || n === 'nl') ? n : 'text';
}
// 同步目标：文字翻译 → 输入框，图片识图 → 描述框。
// 自然语言页签里那个框放的是「指令」，不是内容，所以块永远不回写它
const inputEl = () => (activeTab() === 'image' ? $('#desc') : $('#zh'));
function bumpCounter() {
  if ($('#zhCount')) $('#zhCount').textContent = $('#zh').value.length + ' 字';
  if ($('#nlCount')) $('#nlCount').textContent = $('#nl').value.length + ' 字';
}

async function doTranslate(text, modeOverride, dirOverride) {
  if (S.busy) return;
  if (!text.trim()) { toast('先写点东西'); return; }
  if (!S.server || S.server.status !== 'ready') {
    toast(S.server ? '模型还没就绪：' + (S.server.message || '') : '后端没连上');
    return;
  }
  setBusy(true);
  const started = performance.now();
  const ctrl = new AbortController();
  const dir = dirOverride || S.dir;
  S.nl = false;

  try {
    await streamSSE('/api/translate',
      { text, mode: modeOverride || S.mode, direction: dir },
      {
        start: (d) => {
          S.noSync = true;
          S.blockDir = d.direction || dir;
          S.blocks = d.units.map(u => ({ a: u, b: '' }));
          renderBlocks();
          $('#blocks').scrollTop = 0;
          markStreaming(0);
          $('#statusText').textContent = '翻译中 · 命中术语 ' + d.glossary.length;
        },
        line: (d) => {
          const i = d.n - 1;
          if (i < 0 || i >= S.blocks.length) return;
          S.blocks[i].b = d.text;
          setTarget(i, d.text);
          markStreaming(i);
          updateInfo();
        },
        done: (d) => {
          d.blocks.forEach((t, i) => { if (S.blocks[i]) S.blocks[i].b = t; });
          S.blocks.forEach((b, i) => setTarget(i, b.b));
          S.noSync = false;
          markStreaming(-1);
          updateInfo();
          const sec = ((performance.now() - started) / 1000).toFixed(1);
          const miss = d.missing ? '，' + d.missing + ' 块空着' : '';
          toast('完成 ' + S.blocks.length + ' 块 · ' + sec + 's' + miss);
        },
        error: (d) => toast('出错：' + d.message, 4000)
      },
      ctrl.signal);
  } catch (e) {
    if (e.name !== 'AbortError') toast('出错：' + e.message, 4000);
  } finally {
    setBusy(false);
    markStreaming(-1);
    saveLocal();
    refreshStatus();
  }
}

function setBusy(v) {
  S.busy = v;
  $('#btnGo').disabled = v;
  $('#btnVision').disabled = v;
  if ($('#btnGen')) $('#btnGen').disabled = v;
  $('#btnGo').innerHTML = v ? '<span class="spin"></span> 翻译中' : '翻译 <span class="arr">→</span>';
  if ($('#btnGen')) $('#btnGen').innerHTML = v ? '<span class="spin"></span> 生成中' : '生成 <span class="arr">→</span>';
}

/* ------------------------------ 自然语言生成 ------------------------------ */
async function doGenerate(instruction) {
  if (S.busy) return;
  if (!instruction.trim()) { toast('说说你要什么'); return; }
  if (!S.server || S.server.status !== 'ready') {
    toast(S.server ? '模型还没就绪：' + (S.server.message || '') : '后端没连上');
    return;
  }
  setBusy(true);
  const t0 = performance.now();
  const ctrl = new AbortController();
  try {
    await streamSSE('/api/generate', { instruction }, {
      start: () => {
        S.nl = true;
        S.noSync = true;
        S.blockDir = 'zh2en';
        S.blocks = [];
        renderBlocks();
        $('#statusText').textContent = '生成中…';
      },
      line: (d) => {
        const i = d.n - 1;
        while (S.blocks.length <= i) S.blocks.push({ a: '', b: '' });
        S.blocks[i] = { a: d.a || '', b: d.b || '' };
        const srcEl = document.querySelector('.block[data-i="' + i + '"] .src');
        if (!srcEl) {
          renderBlocks();
          markStreaming(i);
        } else {
          if (srcEl && document.activeElement !== srcEl) { srcEl.value = d.a || ''; autoGrow(srcEl); }
          setTarget(i, d.b || '');
        }
        updateInfo();
      },
      done: (d) => {
        S.blocks = (d.blocks || []).map(x => ({ a: x.a || '', b: x.b || '' }));
        S.noSync = false;
        renderBlocks();
        const sec = ((performance.now() - t0) / 1000).toFixed(1);
        toast('生成 ' + S.blocks.length + ' 对（中英） · ' + sec + 's');
      },
      error: (d) => toast('出错：' + d.message, 4000)
    }, ctrl.signal);
  } catch (e) {
    if (e.name !== 'AbortError') toast('出错：' + e.message, 4000);
  } finally {
    setBusy(false);
    markStreaming(-1);
    saveLocal();
    refreshStatus();
  }
}

/* ------------------------------ 单块重译 / 改原文联动 ------------------------------ */
// 把块里的原文拼回输入框（文字翻译 → 输入框；图片识图 → 描述框）
function syncInputFromBlocks() {
  if (S.noSync) return;
  const ta = inputEl();
  if (!ta) return;
  if (document.activeElement === ta) return;   // 正在这个框里打字，别抢
  const text = S.blocks.map(b => (b.a || '').trim()).filter(Boolean).join('\n');
  if (ta.value.trim() === text.trim()) return;
  ta.value = text;
  if (ta.id === 'desc') autoGrow(ta);
  bumpCounter();
  saveLocal();
}

// 改译文 → 反译回原文，让输入框跟着变
const backDone = new WeakMap();
const backTimers = {};

function scheduleBackSync(i) {
  clearTimeout(backTimers[i]);
  backTimers[i] = setTimeout(() => backTranslate(i), 900);
}

async function backTranslate(i) {
  const b = S.blocks[i];
  if (!b) return;
  const target = (b.b || '').trim();
  if (!target) return;
  if (backDone.get(b) === target) return;   // 这个版本已经同步过
  backDone.set(b, target);

  const el = document.querySelector('.block[data-i="' + i + '"]');
  if (el) el.classList.add('syncing');
  try {
    const r = await fetch('/api/retranslate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unit: target,
        full: S.blocks.map(x => (x.b || '').trim()).filter(Boolean).join('\n'),
        n: i + 1,
        mode: S.mode === 'phrase' ? 'phrase' : 'sentence',
        direction: S.blockDir === 'zh2en' ? 'en2zh' : 'zh2en'
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '失败');
    if (j.text && j.text !== b.a) {
      b.a = j.text;
      const srcEl = document.querySelector('.block[data-i="' + i + '"] .src');
      if (srcEl) {
        if (document.activeElement !== srcEl) { srcEl.value = j.text; autoGrow(srcEl); }
        srcEl.classList.add('updated');
        setTimeout(() => srcEl.classList.remove('updated'), 1400);
      }
      syncInputFromBlocks();
      updateInfo();
      saveLocal();
      flashBlock(i);
    }
  } catch (e) {
    backDone.delete(b);   // 失败就不记，下次还能重试
    toast('回写原文失败：' + e.message, 3000);
  } finally {
    if (el) el.classList.remove('syncing');
  }
}

async function retranslateBlock(i) {
  const b = S.blocks[i];
  if (!b) return;
  if (!b.a.trim()) { toast('这块没有原文'); return; }
  const el = document.querySelector('.block[data-i="' + i + '"]');
  if (el) el.classList.add('syncing');
  try {
    const r = await fetch('/api/retranslate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unit: b.a,
        full: S.blocks.map(x => x.a).filter(Boolean).join('\n'),
        n: i + 1,
        mode: S.mode === 'phrase' ? 'phrase' : 'sentence',
        direction: S.blockDir
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '失败');
    if (j.text) {
      b.b = j.text;
      setTarget(i, j.text);
      updateInfo();
      saveLocal();
      flashBlock(i);
    }
  } catch (e) {
    toast('重译失败：' + e.message);
  } finally {
    if (el) el.classList.remove('syncing');
  }
}

// 改原文 → 停手 1 秒后自动重译这一块
const syncTimers = {};
function scheduleSync(i) {
  clearTimeout(syncTimers[i]);
  syncTimers[i] = setTimeout(() => {
    const b = S.blocks[i];
    if (!b || !b.a.trim()) return;
    retranslateBlock(i);
  }, 1000);
}

/* ------------------------------ 识图 ------------------------------ */
function downscale(file, maxSide) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: c.toDataURL('image/jpeg', 0.9), w, h, ow: img.width, oh: img.height });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读不了')); };
    img.src = url;
  });
}

async function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('这不是图片'); return; }
  try {
    const d = await downscale(file, S.imgSize);
    S.image = d;
    const p = $('#preview');
    p.src = d.dataUrl;
    p.hidden = false;
    $('#dropInner').hidden = true;
    const kb = Math.round(d.dataUrl.length * 0.75 / 1024);
    $('#imgMeta').textContent = d.ow + '×' + d.oh + ' → ' + d.w + '×' + d.h + ' · ' + kb + 'KB';
    switchTab('image');
  } catch (e) {
    toast(e.message);
  }
}

async function doVision() {
  if (S.busy) return;
  if (!S.image) { toast('先放一张图'); return; }
  if (!S.server || S.server.status !== 'ready') { toast('模型还没就绪'); return; }
  setBusy(true);
  const ctrl = new AbortController();
  const english = S.imgMode === 'en';
  const t0 = performance.now();
  $('#desc').value = '';
  try {
    await streamSSE('/api/vision',
      { image: S.image.dataUrl, english, detail: 220 },
      {
        start: () => { $('#statusText').textContent = '识图中…'; },
        delta: (d) => { $('#desc').value = d.text; autoGrow($('#desc')); },
        done: (d) => {
          $('#desc').value = d.text;
          autoGrow($('#desc'));
          const sec = ((performance.now() - t0) / 1000).toFixed(1);
          if (english && d.blocks && d.blocks.length) {
            S.blockDir = 'zh2en';
            S.blocks = d.blocks.map(en => ({ a: '', b: en }));
            renderBlocks();
            toast('识图完成，出了 ' + d.blocks.length + ' 块 · ' + sec + 's（改英文会反译回描述框）');
          } else {
            toast('识图完成 · ' + sec + 's，可以改描述再翻');
          }
          saveLocal();
        },
        error: (d) => visionFail(d.message)
      },
      ctrl.signal);
  } catch (e) {
    if (e.name !== 'AbortError') visionFail(e.message);
  } finally {
    setBusy(false);
    refreshStatus();
  }
}

// 识图失败要把话说在明处：写进描述框（不会自己消失），别只弹个 toast
function visionFail(msg) {
  const raw = String(msg || '未知错误');
  let hint = '';
  if (/not activated|no permission|unauthorized|鉴权|401|403/i.test(raw)) {
    hint = '\n（这家服务没开通这个模型，或者密钥没权限——换一个模型/换一家再试）';
  } else if (/image|vision|multimodal|content.*type/i.test(raw)) {
    hint = '\n（这个模型不吃图片，换成支持识图的模型）';
  }
  const text = '识图失败：' + raw + hint;
  $('#desc').value = text;
  autoGrow($('#desc'));
  $('#statusText').textContent = '识图失败';
  toast('识图失败：' + raw.slice(0, 80), 6000);
}

/* -------------------- 自定义系统提示词 + 对话 -------------------- */
async function loadPromptList() {
  try {
    const r = await fetch('/api/prompts', { cache: 'no-store' });
    const j = await r.json();
    const sel = $('#sysPick');
    if (!j.list || !j.list.length) {
      sel.innerHTML = '<option value="">（目录里没有 .md）</option>';
      return;
    }
    sel.innerHTML = j.list
      .map(f => '<option value="' + esc(f.rel) + '">' + esc(f.rel.replace(/\.(md|txt)$/i, '')) + '</option>')
      .join('');
  } catch (e) {
    toast('读不到提示词目录：' + e.message, 3000);
  }
}

async function loadPromptFile() {
  const rel = $('#sysPick').value;
  if (!rel) return;
  try {
    const r = await fetch('/api/prompts/read?path=' + encodeURIComponent(rel));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '读不到');
    $('#sysText').value = j.text;
    S.custom.system = j.text;
    toast('已载入 ' + rel + '（' + j.text.length + ' 字）', 2200);
    saveLocal();
  } catch (e) {
    toast('载入失败：' + e.message, 3000);
  }
}

function renderChatLog() {
  const box = $('#cLog');
  const msgs = (S.custom && S.custom.messages) || [];
  if (!msgs.length) {
    box.innerHTML = '<div class="clogEmpty">选一份系统提示词（或自己写），下面说要求。<br>可以带图，一轮一轮改。</div>';
    return;
  }
  box.innerHTML = msgs.map(m => {
    const who = m.role === 'assistant' ? '模型' : (m.role === 'system' ? '系统' : '我');
    const cls = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
    const list = Array.isArray(m.images) ? m.images : (m.image ? [m.image] : []);
    const thumbs = list.length
      ? '<div class="thumbs">' + list.map(src => '<img src="' + src + '" alt="">').join('') + '</div>'
      : '';
    return '<div class="cmsg ' + cls + '"><span class="who">' + who + '</span>' + thumbs +
      '<div class="body">' + esc(m.content || '') + '</div></div>';
  }).join('');
  box.scrollTop = box.scrollHeight;
}

async function addChatImages(files) {
  const list = Array.from(files || []).filter(f => f && f.type && f.type.startsWith('image/'));
  if (!list.length) { toast('这不是图片'); return; }
  const room = 8 - (S.custom.images || []).length;
  if (room <= 0) { toast('最多 8 张，先去掉几张', 2500); return; }
  const take = list.slice(0, room);
  if (list.length > room) toast('一次最多 8 张，多的没加', 2500);
  for (const f of take) {
    try {
      const d = await downscale(f, 1024);
      S.custom.images.push(d.dataUrl);
    } catch (e) {
      toast(e.message, 2500);
    }
  }
  renderChatThumbs();
  if (take.length) toast('已加 ' + take.length + ' 张，共 ' + S.custom.images.length + ' 张', 1600);
}

function renderChatThumbs() {
  const box = $('#cThumbs');
  const imgs = (S.custom && S.custom.images) || [];
  box.innerHTML = imgs.map((src, i) =>
    '<div class="cthumb"><img src="' + src + '" alt="">' +
    '<button class="x" data-i="' + i + '" title="移除这张">✕</button></div>'
  ).join('');
}

function removeChatImage(i) {
  if (!S.custom.images) return;
  S.custom.images.splice(i, 1);
  renderChatThumbs();
}

function clearChatImages() {
  S.custom.images = [];
  renderChatThumbs();
}

async function sendCustom() {
  if (S.busy) return;
  if (!S.server || S.server.status !== 'ready') { toast('模型还没就绪'); return; }
  const sys = $('#sysText').value.trim();
  if (!sys) { toast('先载入或写一段系统提示词'); return; }
  const text = $('#cInput').value.trim();
  if (!text) { toast('说点什么'); return; }

  S.custom.system = sys;
  const imgs = (S.custom.images || []).slice();
  const userMsg = { role: 'user', content: text, images: imgs };
  S.custom.messages.push(userMsg);
  $('#cInput').value = '';
  renderChatLog();
  saveLocal();
  setBusy(true);

  const ctrl = new AbortController();
  const holder = { role: 'assistant', content: '' };
  S.custom.messages.push(holder);
  renderChatLog();

  clearChatImages();

  try {
    await streamSSE('/api/chat',
      {
        system: sys,
        messages: S.custom.messages.filter(m => m !== holder).map(m => ({ role: m.role, content: m.content })),
        images: imgs,
        maxTokens: 1600,
        temperature: 0.7
      },
      {
        start: () => { $('#statusText').textContent = '生成中…'; },
        delta: (d) => {
          holder.content = d.text;
          // 只刷最后一条，别整表重绘
          const box = $('#cLog');
          const last = box.lastElementChild;
          if (last && last.classList.contains('assistant')) {
            last.querySelector('.body').textContent = holder.content;
          } else {
            renderChatLog();
          }
          box.scrollTop = box.scrollHeight;
        },
        done: (d) => {
          holder.content = d.text || holder.content;
          renderChatLog();
          saveLocal();
        },
        error: (d) => {
          holder.role = 'errf';
          holder.content = '出错：' + (d.message || '未知错误');
          S.custom.messages[S.custom.messages.length - 1] = { role: 'assistant', content: holder.content };
          renderChatLog();
          toast('出错：' + String(d.message || '').slice(0, 90), 6000);
        }
      },
      ctrl.signal);
  } catch (e) {
    if (e.name !== 'AbortError') {
      S.custom.messages[S.custom.messages.length - 1] = { role: 'assistant', content: '出错：' + e.message };
      renderChatLog();
      toast('出错：' + e.message, 6000);
    }
  } finally {
    setBusy(false);
    refreshStatus();
    saveLocal();
  }
}


/* ------------------------------ 词典 ------------------------------ */
function renderDict() {
  const g = S.glossary;
  if (!g) return;
  const cats = g.categories || [];
  $('#dictCats').innerHTML = cats.map(c =>
    '<label class="dcat ' + (c.enabled ? 'on' : '') + '" data-cat="' + c.id + '">' +
    '<input type="checkbox" ' + (c.enabled ? 'checked' : '') + '><span>' + esc(c.name) + '</span></label>'
  ).join('');

  const q = ($('#dictSearch').value || '').trim().toLowerCase();
  const catName = {};
  cats.forEach(c => { catName[c.id] = c.name; });
  const groups = {};
  for (const e of g.entries) {
    if (q && !(e.zh.toLowerCase().includes(q) || e.en.toLowerCase().includes(q))) continue;
    (groups[e.cat] = groups[e.cat] || []).push(e);
  }
  const parts = [];
  for (const c of cats) {
    const list = groups[c.id];
    if (!list || !list.length) continue;
    parts.push('<div class="dgroup">' + esc(catName[c.id] || c.id) + ' · ' + list.length + '</div>');
    for (const e of list) {
      parts.push('<div class="ditem" data-en="' + esc(e.en) + '">' +
        '<span class="z">' + esc(e.zh) + '</span>' +
        '<span class="e">' + esc(e.en) + '</span>' +
        '<span class="tick">已复制</span></div>');
    }
  }
  $('#dictList').innerHTML = parts.join('') || '<div class="dgroup">没找到</div>';
  const total = g.entries.length;
  const on = g.entries.filter(e => {
    const c = cats.find(x => x.id === e.cat);
    return c && c.enabled;
  }).length;
  $('#dictSub').textContent = on + '/' + total + ' 条启用';
  $('#dictCount').textContent = on;
  $('#newCat').innerHTML = cats.map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('');
}

async function saveGlossary() {
  try {
    await fetch('/api/glossary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: S.glossary.entries, categories: S.glossary.categories })
    });
  } catch (_) { toast('词典保存失败'); }
}

/* ------------------------------ 自然语言修改 ------------------------------ */
function chatAdd(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  $('#chatlog').appendChild(d);
  $('#chatlog').scrollTop = $('#chatlog').scrollHeight;
  return d;
}

async function sendChat() {
  const ins = $('#chatInput').value.trim();
  if (!ins) return;
  if (!S.server || S.server.status !== 'ready') { toast('模型还没就绪'); return; }
  if (S.busy) return;
  if (S.chatMode === 'input') return sendRewriteInput(ins);
  if (!S.blocks.length) { toast('先翻出几块再改'); return; }

  const btn = $('#btnChatSend');
  btn.disabled = true;
  $('#chatInput').value = '';
  autoGrow($('#chatInput'));
  chatAdd('me', ins);
  const pending = chatAdd('ai pending', '正在改…');

  const before = JSON.stringify({ el: activeTab(), text: inputEl().value, blocks: S.blocks });
  try {
    const r = await fetch('/api/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        direction: S.blockDir,
        blocks: S.blocks.map(b => b.b || ''),
        instruction: ins,
        history: S.history
      })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '失败');

    S.history.push(ins);
    if (S.history.length > 12) S.history = S.history.slice(-12);

    pending.classList.remove('pending');
    if (!j.changes.length) {
      pending.textContent = j.reply || '没找到要改的地方';
    } else {
      S.snapshots.push(before);
      if (S.snapshots.length > 20) S.snapshots.shift();
      const flashed = [];
      for (const c of j.changes) {
        if (c.n >= 1 && c.n <= S.blocks.length) {
          S.blocks[c.n - 1].b = c.text;
          flashed.push(c.n - 1);
        } else if (c.n === S.blocks.length + 1) {
          S.blocks.push({ a: '', b: c.text });
          flashed.push(S.blocks.length - 1);
        }
      }
      renderBlocks();
      flashed.forEach(flashBlock);
      updateInfo();
      saveLocal();
      flashed.forEach(i => backTranslate(i));   // 改过的块反译回原文，让输入框跟上
      pending.textContent = (j.reply || '改好了') + '\n（改了 ' + flashed.length + ' 块，' + (j.ms / 1000).toFixed(1) + 's）';
    }
  } catch (e) {
    pending.classList.remove('pending');
    pending.textContent = '出错：' + e.message;
  } finally {
    btn.disabled = false;
    $('#chatInput').focus();
  }
}

function undoRevise() {
  if (!S.snapshots.length) { toast('没有可撤销的修改'); return; }
  const prev = S.snapshots.pop();
  try {
    const d = JSON.parse(prev);
    if (Array.isArray(d)) {
      S.blocks = d;                                  // 旧格式（只有块）
    } else {
      if (typeof d.text === 'string') {
        if (d.el === 'image') switchTab('image'); else switchTab('text');
        const ta = inputEl();
        ta.value = d.text;
        if (activeTab() === 'image') autoGrow($('#desc'));
      }
      S.blocks = d.blocks || [];
    }
    bumpCounter();
    renderBlocks();
    saveLocal();
    chatAdd('sys', '已撤销上一次修改');
    toast('已撤销');
  } catch (_) { toast('撤销失败'); }
}

/* 自然语言改写「左边输入」，改完自动重翻（识图模式下改的是描述框） */
async function sendRewriteInput(ins) {
  const ta = inputEl();
  const source = ta.value.trim();
  if (!source) { toast(activeTab() === 'image' ? '左边的识图描述还是空的' : '左边输入还是空的'); return; }

  const btn = $('#btnChatSend');
  btn.disabled = true;
  $('#chatInput').value = '';
  autoGrow($('#chatInput'));
  chatAdd('me', ins);
  const pending = chatAdd('ai pending', '正在改写输入…');

  const before = JSON.stringify({ el: activeTab(), text: ta.value, blocks: S.blocks });
  try {
    const r = await fetch('/api/rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: source, instruction: ins, direction: S.dir })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '失败');

    S.snapshots.push(before);
    if (S.snapshots.length > 20) S.snapshots.shift();

    ta.value = j.text;
    if (activeTab() === 'image') autoGrow($('#desc'));
    bumpCounter();
    saveLocal();

    pending.classList.remove('pending');
    pending.textContent = '输入已改写（' + source.length + ' → ' + j.text.length + ' 字），重新翻译中…';

    await doTranslate(j.text, S.mode, S.dir);
    pending.textContent = '输入已改写（' + source.length + ' → ' + j.text.length + ' 字），已重新翻成 ' + S.blocks.length + ' 块';
  } catch (e) {
    pending.classList.remove('pending');
    pending.textContent = '出错：' + e.message;
  } finally {
    btn.disabled = false;
    $('#chatInput').focus();
  }
}

/* ------------------------------ 服务状态 ------------------------------ */
async function refreshStatus() {
  let st;
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    st = await r.json();
  } catch (_) {
    $('#dot').className = 'dot error';
    $('#statusText').textContent = '后端没连上';
    return;
  }
  S.server = st;
  const dot = $('#dot');
  dot.className = 'dot ' + (st.status === 'ready' ? 'ready'
    : st.status === 'loading' ? 'loading'
    : st.status === 'error' ? 'error'
    : st.status === 'released' ? 'idle' : 'loading');
  if (st.status === 'ready') {
    const name = st.modelName || st.modelAlias || '';
    $('#statusText').textContent = name + (st.attached ? ' · 外部' : '') + (st.vision ? ' · 可识图' : ' · 纯文本');
  } else if (st.status === 'released') {
    $('#statusText').textContent = '模型已释放 · 显存空出';
  } else {
    $('#statusText').textContent = st.message || st.status;
  }
  $('#status').title = (st.message || '') + (st.hint ? '\n' + st.hint : '');

  const sel = $('#modelSel');
  if (sel.options.length !== st.models.length) {
    sel.innerHTML = st.models.map(m => '<option value="' + m.id + '">' + esc(m.name) + '</option>').join('');
  }
  if (!S.busy && st.modelId && sel.value !== st.modelId) {
    const opt = Array.from(sel.options).find(o => o.value === st.modelId);
    if (opt) sel.value = st.modelId;
  }
  sel.disabled = !!st.attached || st.status === 'loading' || !!st.remote;
  $('#btnVision').title = st.vision ? '' : '当前模型没有加载视觉模块';

  // 云端来源：本地那两个按钮没意义
  const remote = !!st.remote;
  $('#btnRelease').disabled = remote;
  $('#btnRestart').disabled = remote;
  $('#btnRelease').title = remote ? '当前用云端模型，本地没占显存'
    : '释放显存：停掉本地 llama-server，下次翻译会自动重新加载';
  $('#pCur').textContent = remote ? (st.modelName || '') : '本地 llama.cpp';
}

/* ------------------------------ 模型来源（API 密钥） ------------------------------ */
async function loadProviders() {
  try {
    const r = await fetch('/api/providers', { cache: 'no-store' });
    const j = await r.json();
    S.providers = j;
    const list = [{ id: 'local', name: '本地 llama.cpp（自带模型）' }].concat(j.list || []);
    $('#pSel').innerHTML = list
      .map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + (p.hasKey ? ' ✓' : '') + '</option>')
      .join('');
    $('#pSel').value = j.active || 'local';
    fillProviderForm($('#pSel').value);
  } catch (e) {
    toast('读不到模型来源：' + e.message, 3000);
  }
}

function currentProvider(id) {
  const j = S.providers || { list: [] };
  return (j.list || []).find(p => p.id === id) || null;
}

function fillProviderForm(id) {
  const isLocal = id === 'local';
  const pv = currentProvider(id);
  const hint = $('#pHint');
  const fields = ['#pBase', '#pKey', '#pModel'];
  fields.forEach(s => { $(s).disabled = isLocal; });
  $('#pTest').disabled = isLocal;
  $('#pSave').disabled = isLocal;
  $('#pRefresh').disabled = isLocal;
  $('#pVision').disabled = isLocal;
  $('#pModels').innerHTML = '';

  if (isLocal) {
    $('#pBase').value = '';
    $('#pKey').value = '';
    $('#pModel').value = '';
    $('#pVision').checked = false;
    $('#pBase').placeholder = '选一家云端服务后再填';
    $('#pModel').placeholder = '同上';
    $('#pKey').placeholder = '本地模型不需要密钥';
    hint.className = 'phint';
    hint.textContent = '本地 llama.cpp 有自己的 gguf 模型，不需要 API 密钥。选上面任意一家填密钥即可改用云端。';
    return;
  }
  if (!pv) return;
  $('#pBase').value = pv.baseURL || '';
  $('#pBase').placeholder = 'https://maas.qianwenaiapi.com/compatible-mode/v1';
  $('#pModel').placeholder = 'deepseek-v4.1-flash';
  $('#pKey').value = '';
  $('#pKey').placeholder = pv.hasKey
    ? '已保存（末尾 ' + pv.keyTail + '），留空表示不改'
    : 'sk-…（只存在本机 providers.json）';
  $('#pModel').value = pv.model || '';
  $('#pVision').checked = !!pv.vision;
  $('#pModels').innerHTML = (pv.presetModels || [])
    .filter(Boolean)
    .map(m => '<button data-m="' + esc(m) + '">' + esc(m) + '</button>')
    .join('');
  hint.className = 'phint';
  hint.textContent = '填完点「测试连接」，通了再「保存并使用」。模型名可以点下面的标签，或点「刷新模型」从服务端拉最新清单。';
}

// 把表单里的东西存到后端；onlySwitch 时不改动字段
async function saveProviderForm(id, { activate = false } = {}) {
  const pv = currentProvider(id);
  const body = {
    id,
    baseURL: $('#pBase').value.trim(),
    model: $('#pModel').value.trim(),
    vision: $('#pVision').checked
  };
  const key = $('#pKey').value.trim();
  if (key) body.apiKey = key;              // 留空 = 保留原来的
  if (!body.baseURL || !body.model) throw new Error('API 地址和模型名都要填');
  if (!pv) throw new Error('未知来源');
  let r = await fetch('/api/providers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error((await r.json()).error || '保存失败');
  if (activate) {
    r = await fetch('/api/providers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: id })
    });
    if (!r.ok) throw new Error((await r.json()).error || '切换失败');
  }
}

/* ------------------------------ 切模型 ------------------------------ */
async function switchModel(id) {
  if (!id) return;
  if (S.server && S.server.remote) { toast('当前用云端模型，先切回本地', 3000); return; }
  toast('正在切换模型…', 3000);
  try {
    const r = await fetch('/api/model', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!r.ok) {
      const j = await r.json();
      toast(j.error || '切换失败', 3000);
      refreshStatus();
    }
  } catch (e) {
    toast('切换失败：' + e.message);
  }
}

/* ------------------------------ 交互 ------------------------------ */
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tabbody').forEach(b => { b.hidden = b.dataset.pane !== name; });
  S.tab = name;
  // 自定义页签自己就是对话区，把下面那个「自然语言修改」框收起来，腾出高度
  const chatEl = $('#chat'), gripEl = $('#leftGrip');
  const hideChat = name === 'custom';
  if (chatEl) chatEl.classList.toggle('hide', hideChat);
  if (gripEl) gripEl.classList.toggle('hide', hideChat);
  // 自然语言页签里的框是「指令」，不是内容，不参与「改输入」
  const inBtn = document.querySelector('#chatMode button[data-m="input"]');
  if (inBtn) {
    const dis = name === 'nl';
    inBtn.disabled = dis;
    inBtn.title = dis ? '自然语言页签的框是指令，改块就好' : '';
    if (dis && S.chatMode === 'input') {
      const bb = document.querySelector('#chatMode button[data-m="blocks"]');
      if (bb) bb.click();
    }
  }
  updateSyncBtn();
  saveLocal();
}

function updatePlaceholders() {
  const t = $('#zh');
  if (S.dir === 'en2zh') {
    t.placeholder = 'English 粘进来，比如：\na girl in a red dress standing on a stone bridge at dawn, cyberpunk color grading, cinematic lighting.';
  } else {
    t.placeholder = '中文粘进来就行，比如：\n清晨的雾气漫过山谷，一个穿红裙的女孩站在石桥上，远处有座废弃的灯塔。赛博朋克色调，电影级打光。';
  }
}

function setDir(dir, silent) {
  if (dir === S.dir) return true;
  if (S.blocks.length && !silent && !confirm('切换翻译方向会清空当前这些块，继续？')) {
    $$('#dir button').forEach(b => b.classList.toggle('on', b.dataset.d === S.dir));
    return false;
  }
  S.dir = dir;
  S.blockDir = dir;
  S.blocks = [];
  S.snapshots = [];
  $$('#dir button').forEach(b => b.classList.toggle('on', b.dataset.d === dir));
  updatePlaceholders();
  renderBlocks();
  saveLocal();
  return true;
}

function bind() {
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('#zh').addEventListener('input', () => {
    $('#zhCount').textContent = $('#zh').value.length + ' 字';
    saveLocal();
  });
  $('#zh').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doTranslate($('#zh').value, undefined, undefined, 'zh'); }
  });
  $('#btnGo').addEventListener('click', () => doTranslate($('#zh').value, undefined, undefined, 'zh'));

  $('#btnGen').addEventListener('click', () => doGenerate($('#nl').value));
  $('#nl').addEventListener('input', () => {
    $('#nlCount').textContent = $('#nl').value.length + ' 字';
    saveLocal();
  });
  $('#nl').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doGenerate($('#nl').value); }
  });

  $('#btnSyncIn').addEventListener('click', () => {
    if (!S.blocks.length) return toast('还没有块');
    syncInputFromBlocks();
    updateSyncBtn();
    toast('已把块里的原文同步到输入框');
  });

  $$('#dir button').forEach(b => b.addEventListener('click', () => setDir(b.dataset.d)));
  $$('#gran button').forEach(b => b.addEventListener('click', () => {
    $$('#gran button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    S.mode = b.dataset.g;
    saveLocal();
  }));

  // 图片
  $('#drop').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', e => { if (e.target.files[0]) loadImageFile(e.target.files[0]); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => $('#drop').addEventListener(ev, e => { e.preventDefault(); $('#drop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => $('#drop').addEventListener(ev, e => { e.preventDefault(); $('#drop').classList.remove('over'); }));
  $('#drop').addEventListener('drop', e => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadImageFile(f);
  });
  document.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.indexOf('image/') === 0) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); loadImageFile(f); }
        break;
      }
    }
  });

  $$('#imgSize button').forEach(b => b.addEventListener('click', () => {
    $$('#imgSize button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    S.imgSize = parseInt(b.dataset.s, 10);
    saveLocal();
    if (S.image) toast('尺寸改了，重新拖一次图');
  }));
  $$('#imgMode button').forEach(b => b.addEventListener('click', () => {
    $$('#imgMode button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    S.imgMode = b.dataset.m;
    saveLocal();
  }));
  $('#btnVision').addEventListener('click', doVision);
  $('#desc').addEventListener('input', () => { autoGrow($('#desc')); saveLocal(); });
  $('#btnDescTranslate').addEventListener('click', () => doTranslate($('#desc').value, 'phrase', 'zh2en', 'desc'));

  // 块区：改原文 / 改译文
  $('#blocks').addEventListener('focusout', (e) => {
    const ta = e.target;
    if (!ta.classList || !ta.classList.contains('tgt')) return;
    const blockEl = ta.closest('.block');
    if (!blockEl) return;
    const i = +blockEl.dataset.i;
    clearTimeout(backTimers[i]);
    // 光标离开就立刻回写，不用等防抖
    setTimeout(() => backTranslate(i), 120);
  });

  $('#blocks').addEventListener('input', (e) => {
    const ta = e.target;
    const blockEl = ta.closest('.block');
    if (!blockEl) return;
    const i = +blockEl.dataset.i;
    if (!S.blocks[i]) return;
    if (ta.classList.contains('src')) {
      S.blocks[i].a = ta.value;
      autoGrow(ta);
      updateInfo();
      syncInputFromBlocks();
      scheduleSync(i);
    } else if (ta.classList.contains('tgt')) {
      S.blocks[i].b = ta.value;
      autoGrow(ta);
      updateInfo();
      scheduleBackSync(i);
    }
    saveLocal();
  });

  $('#blocks').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const blockEl = btn.closest('.block');
    const i = +blockEl.dataset.i;
    const act = btn.dataset.act;
    if (act === 'copy') {
      await copyText(S.blocks[i].b || '');
      toast('这块已复制');
    } else if (act === 'del') {
      S.blocks.splice(i, 1);
      renderBlocks();
      syncInputFromBlocks();
      saveLocal();
    } else if (act === 'up' && i > 0) {
      const t = S.blocks[i - 1];
      S.blocks[i - 1] = S.blocks[i];
      S.blocks[i] = t;
      renderBlocks();
      syncInputFromBlocks();
      saveLocal();
    } else if (act === 'down' && i < S.blocks.length - 1) {
      const t = S.blocks[i + 1];
      S.blocks[i + 1] = S.blocks[i];
      S.blocks[i] = t;
      renderBlocks();
      syncInputFromBlocks();
      saveLocal();
    } else if (act === 're') {
      retranslateBlock(i);
    }
  });

  $('#btnCopyAll').addEventListener('click', async () => {
    const t = S.blocks.map(b => (b.b || '').trim().replace(/[,，.。;；]$/, '')).filter(Boolean).join('\n');
    if (!t) return toast('没有内容');
    await copyText(t);
    toast('全部复制（换行分隔）');
  });
  $('#btnCopyJoin').addEventListener('click', async () => {
    const t = S.blocks.map(b => (b.b || '').trim().replace(/[,，.。;；]$/, '')).filter(Boolean).join(', ');
    if (!t) return toast('没有内容');
    await copyText(t);
    toast('全部复制（逗号串）');
  });
  $('#btnAdd').addEventListener('click', () => {
    S.blocks.push({ a: '', b: '' });
    renderBlocks();
    const last = document.querySelector('.block[data-i="' + (S.blocks.length - 1) + '"] .src');
    if (last) last.focus();
    saveLocal();
  });
  $('#btnClear').addEventListener('click', () => {
    if (S.blocks.length && !confirm('清空所有块？')) return;
    S.blocks = [];
    S.snapshots = [];
    renderBlocks();
    saveLocal();
  });

  // 自然语言修改（常驻左栏下半）
  $('#btnChatSend').addEventListener('click', sendChat);
  $('#btnUndo').addEventListener('click', undoRevise);
  $$('#chatMode button').forEach(b => b.addEventListener('click', () => {
    $$('#chatMode button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    S.chatMode = b.dataset.m;
    $('#chatInput').placeholder = S.chatMode === 'input'
      ? '说要把上面那段输入改成什么（也可以说「扩写得更详细」）'
      : '说要改哪一块提示词';
    $('#chatInput').focus();
  }));
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $('#chatInput').addEventListener('input', () => autoGrow($('#chatInput')));

  // 词典
  $('#btnDict').addEventListener('click', () => { $('#drawer').hidden = false; renderDict(); });
  $('#btnCloseDrawer').addEventListener('click', () => { $('#drawer').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('#drawer').hidden = true; }
  });
  $('#dictSearch').addEventListener('input', renderDict);
  $('#dictAll').addEventListener('change', (e) => {
    const all = e.target.checked;
    S.glossary.categories.forEach(c => { c.enabled = all; });
    renderDict();
    saveGlossary();
  });
  $('#dictCats').addEventListener('change', (e) => {
    const lab = e.target.closest('.dcat');
    if (!lab) return;
    const c = S.glossary.categories.find(x => x.id === lab.dataset.cat);
    if (c) c.enabled = e.target.checked;
    renderDict();
    saveGlossary();
  });
  $('#dictList').addEventListener('click', async (e) => {
    const it = e.target.closest('.ditem');
    if (!it) return;
    await copyText(it.dataset.en);
    it.classList.add('copied');
    setTimeout(() => it.classList.remove('copied'), 1200);
    toast('已复制：' + it.dataset.en);
  });
  $('#btnAddTerm').addEventListener('click', async () => {
    const zh = $('#newZh').value.trim();
    const en = $('#newEn').value.trim();
    if (!zh || !en) return toast('中文和英文都要填');
    if (S.glossary.entries.some(e => e.zh === zh)) return toast('这条已经有了');
    S.glossary.entries.push({ zh: zh, en: en, cat: $('#newCat').value });
    $('#newZh').value = '';
    $('#newEn').value = '';
    renderDict();
    await saveGlossary();
    toast('已加入词典');
  });

  $('#modelSel').addEventListener('change', (e) => switchModel(e.target.value));

  // 输出区：复制 / 拖动高度 / 收起
  $('#btnCopyZhOut').addEventListener('click', async () => {
    const t = $('#outZh').value.trim();
    if (!t) return toast('中文还没内容');
    await copyText(t);
    toast('中文已复制（' + t.split('\n').length + ' 段）');
  });
  $('#btnCopyEnOut').addEventListener('click', async () => {
    const t = $('#outEn').value.trim();
    if (!t) return toast('英文还没内容');
    await copyText(t);
    toast('英文已复制（' + t.split('\n').length + ' 段）');
  });
  $('#btnToggleOut').addEventListener('click', () => toggleOutput());
  (function initGrip() {
    const grip = $('#outGrip'), out = $('#output');    let dragging = false, startY = 0, startH = 0;
    grip.addEventListener('mousedown', (e) => {
      if (out.classList.contains('collapsed')) return;
      dragging = true; startY = e.clientY; startH = out.offsetHeight;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const h = Math.max(120, Math.min(window.innerHeight * 0.75, startH + (startY - e.clientY)));
      out.style.height = h + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      saveLocal();
    });
  })();

  // 左栏上下分栏拖拽
  (function initLeftGrip() {
    const grip = $('#leftGrip'), box = $('#chat'), pane = document.querySelector('.pane.left');
    if (!grip || !box || !pane) return;
    let dragging = false, startY = 0, startH = 0;
    grip.addEventListener('mousedown', (e) => {
      dragging = true; startY = e.clientY; startH = box.offsetHeight;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      chatH = clampChatH(startH + (startY - e.clientY), pane);
      box.style.flex = '0 0 ' + chatH + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      saveLocal();
    });
    grip.addEventListener('dblclick', () => {
      chatH = 0;
      box.style.flex = '';
      saveLocal();
      toast('已恢复默认比例');
    });
  })();

  $('#btnRestart').addEventListener('click', async () => {
    if (!confirm('重启本地 llama-server？（要重新加载模型，约 20–60 秒）')) return;
    try {
      await fetch('/api/restart', { method: 'POST' });
      toast('正在重启，稍等…', 3000);
      setTimeout(refreshStatus, 800);
    } catch (e) { toast('重启失败：' + e.message); }
  });

  $('#btnRelease').addEventListener('click', async () => {
    if (S.busy) { toast('等当前任务跑完再释放', 2500); return; }
    if (!confirm('释放显存？会停掉本地 llama-server，下次翻译时自动重新加载（约 20 秒）。')) return;
    const btn = $('#btnRelease');
    btn.disabled = true;
    try {
      const r = await fetch('/api/release', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) toast(j.error || '释放失败', 3000);
      else toast('显存已释放', 2500);
    } catch (e) {
      toast('释放失败：' + e.message, 3000);
    } finally {
      btn.disabled = false;
      refreshStatus();
    }
  });

  /* ---- 模型来源抽屉 ---- */
  $('#btnProvider').addEventListener('click', async () => {
    $('#pdrawer').hidden = false;
    await loadProviders();
  });
  $('#btnCloseProvider').addEventListener('click', () => { $('#pdrawer').hidden = true; });
  $('#pSel').addEventListener('change', (e) => fillProviderForm(e.target.value));
  $('#pModels').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (b) $('#pModel').value = b.dataset.m;
  });

  $('#pSave').addEventListener('click', async () => {
    const id = $('#pSel').value;
    if (id === 'local') return;
    const t = toast('保存中…', 6000);
    try {
      await saveProviderForm(id, { activate: true });
      $('#pHint').className = 'phint ok';
      $('#pHint').textContent = '已保存并使用「' + (currentProvider(id)?.name || id) + '」，本地显存已释放。';
      toast('已切到 ' + (currentProvider(id)?.name || id), 3000);
      await refreshStatus();
      await loadProviders();
    } catch (e) {
      $('#pHint').className = 'phint bad';
      $('#pHint').textContent = '保存失败：' + e.message;
      toast('保存失败：' + e.message, 4000);
    }
  });

  $('#pTest').addEventListener('click', async () => {
    const id = $('#pSel').value;
    if (id === 'local') return;
    const hint = $('#pHint');
    hint.className = 'phint';
    hint.textContent = '测试中…';
    try {
      await saveProviderForm(id);            // 先存，后端拿存的配置去测
      const r = await fetch('/api/providers/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const j = await r.json();
      if (j.ok) {
        hint.className = 'phint ok';
        hint.textContent = '连接正常' + (j.models ? '，列出 ' + j.models + ' 个模型' : '') + '（' + j.ms + ' ms）';
      } else {
        hint.className = 'phint bad';
        hint.textContent = j.reason || j.error || '测试失败';
      }
    } catch (e) {
      hint.className = 'phint bad';
      hint.textContent = '测试失败：' + e.message;
    }
  });

  $('#pRefresh').addEventListener('click', async () => {
    const id = $('#pSel').value;
    if (id === 'local') return;
    const hint = $('#pHint');
    hint.className = 'phint';
    hint.textContent = '正在拉模型列表…';
    try {
      await saveProviderForm(id);            // 先存地址和密钥，后端拿最新的去拉
      const r = await fetch('/api/providers/models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const j = await r.json();
      if (!j.ok) {
        hint.className = 'phint bad';
        hint.textContent = j.reason || '拉取失败';
        return;
      }
      const list = j.models || [];
      $('#pModels').innerHTML = list
        .map(m => '<button data-m="' + esc(m) + '">' + esc(m) + '</button>')
        .join('');
      const cur = $('#pModel').value.trim();
      if (!cur || !list.includes(cur)) {
        if (list.length) $('#pModel').value = list[0];
      }
      hint.className = 'phint ok';
      hint.textContent = '拉到 ' + list.length + ' 个模型，点标签换一个。';
    } catch (e) {
      hint.className = 'phint bad';
      hint.textContent = '拉取失败：' + e.message;
    }
  });

  $('#pLocal').addEventListener('click', async () => {
    try {
      const r = await fetch('/api/providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: 'local' })
      });
      if (!r.ok) throw new Error((await r.json()).error || '切换失败');
      toast('已切回本地模型，正在加载…', 3500);
      $('#pHint').className = 'phint';
      $('#pHint').textContent = '已切回本地，模型加载中（约 20 秒）。';
      await loadProviders();
      refreshStatus();
    } catch (e) {
      toast('切回本地失败：' + e.message, 3500);
    }
  });

  /* ---- 自定义系统提示词 + 对话 ---- */
  $('#btnSysLoad').addEventListener('click', loadPromptFile);
  $('#sysPick').addEventListener('change', loadPromptFile);
  $('#sysText').addEventListener('input', saveLocal);

  const pickC = () => $('#cFile').click();
  $('#cDrop').addEventListener('click', pickC);
  $('#cThumbs').addEventListener('click', (e) => {
    const b = e.target.closest('button.x');
    if (b) removeChatImage(Number(b.dataset.i));
  });
  $('#cFile').addEventListener('change', (e) => {
    // 必须先把 File 抓成数组再清 input.value —— 清空会让 FileList 变空
    const arr = Array.from(e.target.files || []);
    e.target.value = '';
    if (arr.length) addChatImages(arr);
  });
  ['dragenter', 'dragover'].forEach(ev => $('#cDrop').addEventListener(ev, (e) => {
    e.preventDefault(); $('#cDrop').classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => $('#cDrop').addEventListener(ev, (e) => {
    e.preventDefault(); $('#cDrop').classList.remove('over');
  }));
  $('#cDrop').addEventListener('drop', (e) => {
    const arr = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (arr.length) addChatImages(arr);
  });

  $('#btnChatClear').addEventListener('click', () => {
    if (!confirm('清空对话？（系统提示词保留）')) return;
    S.custom.messages = [];
    renderChatLog();
    saveLocal();
    toast('对话已清空', 1600);
  });
  $('#btnCSend').addEventListener('click', sendCustom);
  $('#cInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCustom();
    }
  });
}

// 左栏上下分栏：上面至少留够这一栏内容需要的高度，聊天区最矮 110px
function clampChatH(h, pane) {
  const need = activeTab() === 'image' ? 480 : 320;
  const max = Math.max(150, pane.clientHeight - need);
  return Math.max(110, Math.min(max, h));
}

function applyChatH() {
  const box = $('#chat'), pane = document.querySelector('.pane.left');
  if (!box || !pane) return;
  if (!chatH) { box.style.flex = ''; return; }
  chatH = clampChatH(chatH, pane);
  box.style.flex = '0 0 ' + chatH + 'px';
}

/* ------------------------------ 启动 ------------------------------ */
async function boot() {
  bind();
  restoreLocal();
  applyChatH();
  $('#zhCount').textContent = $('#zh').value.length + ' 字';
  $$('#gran button').forEach(b => b.classList.toggle('on', b.dataset.g === S.mode));
  $$('#dir button').forEach(b => b.classList.toggle('on', b.dataset.d === S.dir));
  updatePlaceholders();
  $$('#imgSize button').forEach(b => b.classList.toggle('on', +b.dataset.s === S.imgSize));
  $$('#imgMode button').forEach(b => b.classList.toggle('on', b.dataset.m === S.imgMode));

  try {
    const g = await (await fetch('/api/glossary')).json();
    S.glossary = g;
    const on = g.entries.filter(e => {
      const c = g.categories.find(x => x.id === e.cat);
      return c && c.enabled;
    }).length;
    $('#dictCount').textContent = on;
  } catch (_) { S.glossary = { categories: [], entries: [] }; }

  renderBlocks();
  loadPromptList();
  renderChatLog();
  renderChatThumbs();
  setTimeout(() => { autoGrow($('#desc')); autoGrow($('#chatInput')); }, 50);
  refreshStatus();
  setInterval(refreshStatus, 2500);
}

boot();
