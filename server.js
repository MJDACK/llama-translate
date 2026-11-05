'use strict';
/**
 * 提示词翻译台 —— llama.cpp 本地翻译 / 识图 工作台
 * 只依赖 Node 内置模块。负责：拉起 llama-server、切模型、中译英分块、识图。
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');

const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');
const LOGS = path.join(ROOT, 'logs');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const GLOSSARY_FILE = path.join(ROOT, 'glossary.json');

if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS, { recursive: true });

/* ------------------------------------------------------------------ */
/* 配置 & 词典                                                          */
/* ------------------------------------------------------------------ */
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
let glossary = JSON.parse(fs.readFileSync(GLOSSARY_FILE, 'utf8'));

// llama.cpp 在 Windows 上用窄字符 fopen，打不开含中文的路径。
// 目录名带非 ASCII 时，在本机建一个 ASCII 软链接绕过去（对用户透明）。
function asciiRoot() {
  if (!/[^\x20-\x7E]/.test(ROOT)) return ROOT;
  const base = process.env.LOCALAPPDATA || 'C:\\ProgramData';
  const link = path.join(base, 'llama-translate', 'root');
  try { fs.mkdirSync(path.dirname(link), { recursive: true }); } catch (_) { }
  let same = false;
  try { same = fs.realpathSync(link).toLowerCase() === fs.realpathSync(ROOT).toLowerCase(); } catch (_) { same = false; }
  if (!same) {
    try { if (fs.existsSync(link)) fs.rmdirSync(link); } catch (_) { }
    try { execSync(`cmd /c mklink /J "${link}" "${ROOT}"`, { windowsHide: true, stdio: 'ignore' }); } catch (_) { }
  }
  let ok = false;
  try { ok = fs.existsSync(path.join(link, 'server.js')); } catch (_) { ok = false; }
  if (ok) log('目录含中文，已用 ASCII 链接：' + link);
  return ok ? link : ROOT;
}

const BASE = asciiRoot();

// 配置里的路径可以是相对的（相对本目录），这样整个文件夹能搬走
const absPath = (p) => (p && !path.isAbsolute(p)) ? path.join(BASE, p) : p;
config.llamaDir = absPath(config.llamaDir);
for (const m of config.models || []) {
  m.model = absPath(m.model);
  if (m.mmproj) m.mmproj = absPath(m.mmproj);
}

const state = {
  status: 'boot',        // boot | loading | ready | error
  message: '启动中…',
  modelId: null,
  modelName: '',
  modelAlias: null,
  vision: false,
  attached: false,       // true = 用的是外部已经跑着的 llama-server
  port: null,
  hint: '',
  startedAt: 0
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */
function log(...a) { console.log('[app]', ...a); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readBody(req, limit = 48 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sseOpen(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  return {
    send(ev, data) {
      if (res.writableEnded) return;
      res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() { if (!res.writableEnded) res.end(); }
  };
}

const baseUrl = () => `http://127.0.0.1:${state.port}`;

/* ------------------------------------------------------------------ */
/* 模型来源：本地 llama.cpp / 各家 OpenAI 兼容 API                        */
/* ------------------------------------------------------------------ */
const PROVIDERS_FILE = path.join(ROOT, 'providers.json');

// 预置几家 OpenAI 兼容的服务，密钥留空，用户在界面里填。
// DeepSeek / 千问 / 其它 三条都走同一个千问 MaaS 网关（一把 key 通用），
// 分开放只是为了让模型清单别混在一起。清单可以「刷新模型」从 /models 直接拉。
const MAAS_BASE = 'https://maas.qianwenaiapi.com/compatible-mode/v1';

const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    vision: true          // deepseek-flash 实测吃图
  },
  {
    id: 'qwen',
    name: '千问 Qwen（MaaS）',
    baseURL: MAAS_BASE,
    models: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.6-flash'],
    vision: true
  },
  {
    id: 'maas-other',
    name: '其它 MaaS（GLM / Kimi / MiniMax）',
    baseURL: MAAS_BASE,
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5', 'MiniMax-M2.5'],
    vision: false
  },
  {
    id: 'moonshot', name: '月之暗面 Kimi（官方）', baseURL: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-8k'], vision: false
  },
  {
    id: 'siliconflow', name: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'], vision: false
  },
  {
    id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'], vision: true
  },
  {
    id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'], vision: true
  },
  {
    // 官方 OpenAI 兼容口就是 /v1/chat/completions（已探测：无 key 返回 401 authorized_error）。
    // 这家的 /v1/models 是 404，「刷新模型」拿不到列表，模型名手填。
    id: 'minimax', name: 'MiniMax（开放平台 · 国内）',
    baseURL: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M2', 'MiniMax-M2.5', 'MiniMax-Text-01'],
    vision: false
  },
  {
    // M Plan（订阅套餐）的 key 只走套餐额度，跟按量付费的 API key 不通用。
    // 官方给第三方工具的是 api.minimax.io：Anthropic 协议在 /anthropic，OpenAI 协议在 /v1。
    id: 'minimax-plan', name: 'MiniMax M Plan（订阅 · 海外）',
    baseURL: 'https://api.minimax.io/v1',
    models: ['MiniMax-M3.1-Flash'],
    vision: false
  },
  {
    id: 'custom', name: '自定义（OpenAI 兼容）', baseURL: 'http://127.0.0.1:1234/v1',
    models: [''], vision: false
  }
];

// providers.json: { active: 'local' | <id>, list: [{ id, name, baseURL, apiKey, model, vision }] }
let providers = { active: 'local', list: [] };

const PROVIDERS_SCHEMA = 8;   // 换了预置清单就 +1，旧的 providers.json 会自动升级（密钥保留）

function loadProviders() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8')); } catch (_) { }
  const fresh = !saved || (saved.v || 0) < PROVIDERS_SCHEMA;   // 旧格式：模型清单按新版来
  const savedList = (saved && Array.isArray(saved.list)) ? saved.list : [];
  // 同一个网关（同一 baseURL）填过的密钥，新拆出来的入口直接复用，不用再贴一次
  const sharedKey = (baseURL, own) => {
    if (own) return own;
    const hit = savedList.find(x => x && x.apiKey && x.baseURL === baseURL);
    return hit ? hit.apiKey : '';
  };
  const list = PROVIDER_PRESETS.map(preset => {
    const old = savedList.find(x => x && x.id === preset.id) || null;
    return {
      id: preset.id,
      name: preset.name,
      baseURL: (!fresh && old && old.baseURL) || preset.baseURL,
      apiKey: sharedKey(preset.baseURL, old && old.apiKey),   // 密钥无论新旧都保留
      model: (!fresh && old && old.model) || preset.models[0] || '',
      presetModels: preset.models,
      vision: (!fresh && old && typeof old.vision === 'boolean') ? old.vision : preset.vision,
      preset: true
    };
  });
  // 用户自己加的（id 不在预置里）
  for (const extra of savedList) {
    if (!extra || !extra.id || list.some(x => x.id === extra.id)) continue;
    list.push({
      id: extra.id, name: extra.name || extra.id, baseURL: extra.baseURL || '',
      apiKey: extra.apiKey || '', model: extra.model || '',
      presetModels: [], vision: !!extra.vision, preset: false
    });
  }
  const active = saved && saved.active ? saved.active : 'local';
  providers = { active: list.some(p => p.id === active) ? active : 'local', list };
  return providers;
}

function saveProviders() {
  const data = {
    v: PROVIDERS_SCHEMA,
    active: providers.active,
    list: providers.list.map(p => ({
      id: p.id, name: p.name, baseURL: p.baseURL, apiKey: p.apiKey, model: p.model, vision: !!p.vision
    }))
  };
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function providerById(id) { return providers.list.find(p => p.id === id) || null; }

// 当前生效的来源：'local' 走本地 llama-server，其它走远端 API
function activeProvider() {
  if (providers.active === 'local') return null;
  const p = providerById(providers.active);
  return p && p.baseURL && p.model ? p : null;
}

const isRemote = () => !!activeProvider();

// 拼端点 + 鉴权头。远端统一按 OpenAI 兼容格式
function llmEndpoint() {
  const p = activeProvider();
  if (!p) {
    return { url: `${baseUrl()}/v1/chat/completions`, headers: {}, local: true };
  }
  const base = p.baseURL.replace(/\/+$/, '');
  return {
    url: base.endsWith('/chat/completions') ? base : base + '/chat/completions',
    headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {},
    local: false
  };
}

// 网络层失败时 fetch 只给一句 "fetch failed"，把原因和地址补出来
function netFailMsg(ep, e) {
  const host = (() => { try { return new URL(ep.url).host; } catch (_) { return ep.url; } })();
  const code = e?.cause?.code || e?.cause?.errno || '';
  const name = providerById(providers.active)?.name || 'API';
  if (code) return `连不上 ${name}（${host}）：${code}`;
  return `连不上 ${name}（${host}）：${e.message}`;
}

// 远端 API 的 body 要求很严：必须带 model，多余字段会被判 422
// （DeepSeek 官方就是这样：missing field `model` / unexpected field）。
function llmPayload(extra) {
  const p = activeProvider();
  if (!p) {
    return { ...extra, chat_template_kwargs: { enable_thinking: false } };
  }
  const out = {
    model: p.model,
    messages: extra.messages,
    temperature: extra.temperature,
    top_p: extra.top_p,
    max_tokens: extra.max_tokens
  };
  if (extra.stream !== undefined) out.stream = extra.stream;
  // 这类模型会先吐一大段思考，把 max_tokens 吃光、正文为空（DeepSeek 上是
  // reasoning_content + finish=length；MiniMax-M3 更麻烦，思考直接塞进 content
  // 的 <think>…</think> 里）。
  //   deep=on  → 不传参数，用服务端默认（会思考，慢但细）
  //   deep=off → thinking:{type:'disabled'}
  const host = (() => { try { return new URL(p.baseURL).host.toLowerCase(); } catch (_) { return ''; } })();
  const thinks = /(^|\.)deepseek\.com$/.test(host) || host.endsWith('minimax.io') || host.endsWith('minimaxi.com');
  if (thinks && !extra.deep) {
    // 注意：只传 disabled。传 enabled 会被 MiniMax 判 400（invalid thinking），
    // 想让它思考就干脆不传这个字段，用服务端默认。
    out.thinking = { type: 'disabled' };
  }
  delete out.deep;
  return out;
}

loadProviders();

/* ------------------------------------------------------------------ */
/* llama-server 生命周期                                                */
/* ------------------------------------------------------------------ */
let child = null;
let stopping = false;

async function probe(port, timeout = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(`http://127.0.0.1:${port}/props`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function alive(port, timeout = 800) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.status === 200;
  } catch { return false; }
}

function modelById(id) { return config.models.find(m => m.id === id); }

function matchModelByPath(p) {
  if (!p) return null;
  const base = path.basename(p).toLowerCase();
  return config.models.find(m => path.basename(m.model).toLowerCase() === base) || null;
}

function killChild() {
  if (!child) return;
  const pid = child.pid;
  child = null;
  try { fs.unlinkSync(path.join(LOGS, 'child.pid')); } catch (_) { }
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (_) { }
}

/* 停掉当前子进程，并且等到端口真的空出来（Windows 上 taskkill 是异步的） */
async function stopChild(timeoutMs = 20000) {
  const proc = child;
  child = null;
  stopping = true;
  try { fs.unlinkSync(path.join(LOGS, 'child.pid')); } catch (_) { }
  if (proc && proc.exitCode === null) {
    try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }); } catch (_) { }
    const t0 = Date.now();
    while (proc.exitCode === null && Date.now() - t0 < timeoutMs) await sleep(120);
  }
  // 端口可能还被别的进程占着，等它彻底不再响应
  for (let i = 0; i < 50; i++) {
    if (!(await alive(config.port, 400))) break;
    await sleep(200);
  }
  stopping = false;
}

/* 端口被占时：如果占着的是 llama-server（比如上次没收干净的），清掉它 */
function portOwnerPid(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      if (!line.includes(`:${port} `) && !line.trim().endsWith(`:${port}`)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (/^\d+$/.test(pid)) return parseInt(pid, 10);
    }
  } catch (_) { }
  return null;
}

function isLlamaProc(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', windowsHide: true });
    return out.toLowerCase().includes('llama-server');
  } catch (_) { return false; }
}

async function reclaimPort(port = config.port) {
  if (!(await alive(port, 500))) return true;
  const pid = portOwnerPid(port);
  if (!pid || !isLlamaProc(pid)) return false;
  log(`清掉占着 ${port} 的旧 llama-server pid=${pid}`);
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch (_) { }
  for (let i = 0; i < 50; i++) {
    if (!(await alive(port, 400))) return true;
    await sleep(200);
  }
  return false;
}

// 真去 bind 一下：有些程序（比如 GameViewerServer）只 bind 不 listen，
// HTTP 探测看不见它，但会让 llama-server 绑不上
function canBind(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function pickFreePort(from, count = 12) {
  for (let p = from; p < from + count; p++) {
    if (await canBind(p)) return p;
  }
  return null;
}

function tailLog(file, lines = 12) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return txt.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch (_) { return ''; }
}

// 等健康的同时盯着进程：它一退出就立刻失败，别干等 240 秒
async function waitHealthyOrDie(port, proc, logPath, timeoutMs, onTick) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode !== null) {
      const tail = tailLog(logPath);
      if (/couldn't bind HTTP server socket/.test(tail)) {
        const e = new Error('端口被占用');
        e.bindFail = true;
        return { ok: false, err: e, tail };
      }
      return { ok: false, err: new Error(`llama-server 退出（code ${proc.exitCode}）`), tail };
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.status === 200) return { ok: true };
    } catch (_) { }
    onTick && onTick(Math.round((Date.now() - t0) / 1000));
    await sleep(700);
  }
  return { ok: false, err: new Error('加载超时') };
}

async function doLaunchModel(model) {
  state.status = 'loading';
  state.message = `启动 ${model.name}…`;
  state.modelId = model.id;
  state.vision = !!model.mmproj;
  state.attached = false;
  state.port = config.port;

  await stopChild();

  const exe = path.join(config.llamaDir, 'llama-server.exe');
  if (!fs.existsSync(exe)) throw new Error(`找不到 llama-server.exe：${exe}`);
  if (!fs.existsSync(model.model)) throw new Error(`找不到模型文件：${model.model}`);

  // 选一个真的能绑的端口（8085 可能被别的软件 bind 着，HTTP 探测看不出来）
  let port = config.port;
  if (!(await canBind(port))) {
    await reclaimPort(port);
    if (!(await canBind(port))) {
      const alt = await pickFreePort(port + 1);
      if (!alt) throw new Error(`端口 ${port} 往后 12 个都被占着，改 config.json 里的 port`);
      log(`端口 ${port} 被别的程序占着，改用 ${alt}`);
      port = alt;
    }
  }
  state.port = port;

  const argsFor = (p) => {
    const a = [
      '-m', model.model,
      '--host', '127.0.0.1',
      '--port', String(p),
      '-c', String(model.ctx || 8192),
      '-ngl', String(model.ngl ?? 99),
      '-np', '1',
      '--jinja',
      '-fa', 'on'
    ];
    if (model.mmproj) a.push('--mmproj', model.mmproj);
    return a;
  };

  const logPath = path.join(LOGS, `llama-${model.id}.log`);

  for (let attempt = 0; attempt < 2; attempt++) {
    const args = argsFor(port);
    const out = fs.createWriteStream(logPath, { flags: 'w' });
    const proc = spawn(exe, args, { cwd: config.llamaDir, windowsHide: true });
    child = proc;
    try { fs.writeFileSync(path.join(LOGS, 'child.pid'), String(proc.pid)); } catch (_) { }
    proc.stdout.pipe(out);
    proc.stderr.pipe(out);
    proc.on('error', err => {
      state.status = 'error';
      state.message = `启动 llama-server 失败：${err.message}`;
    });
    proc.on('exit', code => {
      if (child === proc) {
        child = null;
        try { fs.unlinkSync(path.join(LOGS, 'child.pid')); } catch (_) { }
        if (state.status === 'ready') {
          state.status = 'error';
          state.message = `llama-server 自己退出了（code ${code}），点 ↻ 重启`;
        }
      }
    });

    log(`spawn llama-server pid=${proc.pid} model=${model.id} port=${port}${attempt ? ' (重试)' : ''}`);
    const r = await waitHealthyOrDie(port, proc, logPath, 240000, s => {
      state.message = `加载 ${model.name}… ${s}s`;
    });
    if (r.ok) break;

    // 失败：先把这个进程收掉，再决定要不要重试
    await stopChild();
    if (r.err.bindFail && attempt === 0) {
      state.message = `端口 ${port} 被占用，换个端口重试…`;
      log('端口被占，换个端口重试一次');
      const alt = await pickFreePort(port + 1);
      if (alt) port = alt;
      await sleep(600);
      continue;
    }
    state.status = 'error';
    state.message = (r.err.message || '启动失败') + '，看 logs/' + path.basename(logPath);
    throw new Error(state.message + '\n' + (r.tail || ''));
  }

  const props = await probe(port);
  state.status = 'ready';
  state.modelAlias = props?.model_alias || path.basename(model.model);
  state.modelName = model.name;
  state.modelId = model.id;
  state.vision = !!props?.modalities?.vision;
  state.message = `${state.modelAlias} 就绪`;
  state.startedAt = Date.now();
  log('ready', state.modelAlias, 'vision=', state.vision);
  return state;
}

// 串行：并发点两次「重启/切模型」时，只按顺序跑，不会两个 llama-server 抢同一个端口
let launchChain = Promise.resolve();
function launchModel(model) {
  const run = launchChain.then(() => doLaunchModel(model));
  launchChain = run.catch(() => { });
  return run;
}

async function switchModel(id) {
  const m = modelById(id);
  if (!m) throw new Error('未知模型 ' + id);
  if (state.attached) {
    // 外部服务：不动它，只提示
    throw new Error('当前接的是外部 llama-server，不能在这里切换。请关掉外部服务后重启本程序。');
  }
  state.status = 'loading';
  state.message = `切换到 ${m.name}…`;
  return launchModel(m);
}

async function bootServer() {
  if (config.openBrowser !== false) { /* 浏览器在 listen 之后再开 */ }

  // 0) 上次选的是云端 API：不拉本地模型，一个字节显存都不占
  const rp = activeProvider();
  if (rp) {
    state.status = 'ready';
    state.remote = true;
    state.modelAlias = rp.model;
    state.modelName = `${rp.name} · ${rp.model}`;
    state.vision = !!rp.vision;
    state.message = `${rp.name} · ${rp.model}`;
    log('使用云端来源', rp.name, rp.model);
    return;
  }

  // 1) 优先接外部的（用户在 8080 手动起的）llama-server
  for (const p of [config.attachPort, config.port]) {
    if (!p) continue;
    const props = await probe(p);
    if (props && props.model_alias) {
      if (props.modalities?.vision) {
        state.port = p;
        state.attached = true;
        state.status = 'ready';
        state.modelAlias = props.model_alias;
        state.modelId = matchModelByPath(props.model_path)?.id || 'external';
        state.modelName = matchModelByPath(props.model_path)?.name || props.model_alias;
        state.vision = true;
        state.message = `${props.model_alias}（外部服务 :${p}）`;
        state.startedAt = Date.now();
        log('attached external server on', p, props.model_alias);
        return;
      } else if (p === config.attachPort) {
        state.hint = `:${p} 上的 llama-server 没有加载视觉模型（mmproj）`;
      }
    }
  }

  // 2) 自己拉一个
  const model = modelById(config.defaultModel) || config.models[0];
  try {
    await launchModel(model);
  } catch (e) {
    state.status = 'error';
    state.message = e.message;
    log('launch failed:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 文本切块                                                            */
/* ------------------------------------------------------------------ */
function splitByDelims(line, delims) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    cur += ch;
    if (delims.includes(ch)) { out.push(cur); cur = ''; }
  }
  if (cur.trim()) out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

function splitEnSentences(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    cur += ch;
    if ('.!?;'.includes(ch)) {
      const prev = line[i - 1] || '';
      const next = line[i + 1];
      if (ch === '.' && /\d/.test(prev) && /\d/.test(next || '')) continue; // 3.5 / v1.2 别切开
      if (next === undefined || /\s/.test(next)) { out.push(cur.trim()); cur = ''; }
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function splitUnits(text, mode = 'auto', maxUnits = 120, dir = 'zh2en') {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];
  const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const units = [];
  const en = dir === 'en2zh';

  for (const line of lines) {
    let parts;
    if (mode === 'sentence') {
      parts = en ? splitEnSentences(line) : splitByDelims(line, '。！？!?…；;');
    } else if (mode === 'phrase') {
      parts = en
        ? splitEnSentences(line).flatMap(s => splitByDelims(s, ',;'))
        : splitByDelims(line, '。！？!?…；;，,、');
    } else if (en) {
      const commas = (line.match(/[,;]/g) || []).length;
      const avg = line.length / (commas + 1);
      parts = (commas >= 2 && avg <= 32)
        ? splitEnSentences(line).flatMap(s => splitByDelims(s, ',;'))
        : splitEnSentences(line);
    } else {
      const commas = (line.match(/[，,、]/g) || []).length;
      const avg = line.length / (commas + 1);
      parts = (commas >= 2 && avg <= 16)
        ? splitByDelims(line, '。！？!?…；;，,、')
        : splitByDelims(line, '。！？!?…；;');
    }
    units.push(...parts);
  }

  return units.slice(0, maxUnits).filter(u => /[\u4e00-\u9fa5A-Za-z0-9]/.test(u));
}

/* ------------------------------------------------------------------ */
/* 词典匹配                                                            */
/* ------------------------------------------------------------------ */
function enabledCats() {
  const set = new Set();
  for (const c of glossary.categories || []) if (c.enabled) set.add(c.id);
  return set;
}

function matchGlossary(text, dir = 'zh2en') {
  const cats = enabledCats();
  const toZh = dir === 'en2zh';
  const hay = toZh ? String(text).toLowerCase() : String(text);
  const hits = [];
  const seen = new Set();
  for (const e of glossary.entries || []) {
    if (!e.zh || !e.en) continue;
    if (e.cat && !cats.has(e.cat)) continue;
    const key = toZh ? e.en.toLowerCase() : e.zh;
    if (hay.includes(key) && !seen.has(key)) {
      seen.add(key);
      hits.push(e);
    }
  }
  // 长词条优先，避免 “长发” 盖住更长的短语
  hits.sort((a, b) => (toZh ? b.en.length - a.en.length : b.zh.length - a.zh.length));
  return hits.slice(0, 40);
}

function glossaryBlock(hits, dir = 'zh2en') {
  if (!hits.length) return '';
  if (dir === 'en2zh') {
    const lines = hits.map(h => `${h.en} = ${h.zh}`).join('\n');
    return `【术语表｜必须使用以下中文写法】\n${lines}\n\n`;
  }
  const lines = hits.map(h => `${h.zh} = ${h.en}`).join('\n');
  return `【术语表｜必须使用以下英文写法】\n${lines}\n\n`;
}

// 输出里残留源语言的术语就替换掉（已经用了目标译法的不动，避免 "8K resolution resolution"）
function enforceGlossary(text, hits, dir = 'zh2en') {
  if (!text || !hits || !hits.length) return text;
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const toZh = dir === 'en2zh';
  let out = text;
  for (const h of hits) {
    if (toZh) {
      if (out.includes(h.zh)) continue;              // 已经是中文写法
      out = out.replace(new RegExp(esc(h.en), 'gi'), h.zh);
    } else {
      if (!out.includes(h.zh)) continue;
      if (new RegExp(esc(h.en), 'i').test(out)) continue;
      out = out.split(h.zh).join(h.en);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 提示词                                                              */
/* ------------------------------------------------------------------ */
function sysTranslate(mode, dir = 'zh2en') {
  if (dir === 'en2zh') {
    const tagLine = mode === 'phrase'
      ? '本次是【画面标签】模式：每条译成可直接放进提示词的中文短语，简洁、不带句号。'
      : '本次是【句子】模式：每条译成自然通顺的中文句子。';
    return `你是一个英文→中文的翻译引擎，服务对象是 AI 绘画 / 影像提示词。

规则：
1. 只输出译文行，不要解释、不要前言后语、不要引号、不要 Markdown 代码块。
2. 输入是带编号的英文片段；输出必须保持同样的编号、每行一条，条数与顺序和输入完全一致。
3. 不合并、不拆分、不省略、不增补条目。哪怕一条只有两三个词，也要单独占一行。
4. 若提供了术语表，必须优先采用术语表里的中文写法。
5. 保留原文的意象、细节、数量、颜色、方位、材质、光线与镜头信息，不美化也不删减。
6. 中文要通顺、像人话，避免翻译腔；句中不要夹英文单词（专有名词除外）。
7. ${tagLine}

输出示例：
1. 一个穿红裙的女孩站在石桥上
2. 赛博朋克色调，电影级打光`;
  }

  const tagLine = mode === 'phrase'
    ? '本次是【画面标签】模式：每条译成可直接放进提示词的名词短语或动名词短语，简洁、不带句号。'
    : '本次是【句子】模式：每条译成自然、完整的英文句子。';
  return `你是一个中文→英文的翻译引擎，服务对象是 AI 绘画 / 影像提示词。

规则：
1. 只输出译文行，不要解释、不要前言后语、不要引号、不要 Markdown 代码块。
2. 输入是带编号的中文片段；输出必须保持同样的编号、每行一条，条数与顺序和输入完全一致。
3. 不合并、不拆分、不省略、不增补条目。哪怕一条只有两三个字，也要单独占一行。
4. 若提供了术语表，必须优先采用术语表里的英文写法。
5. 保留原文的意象、细节、数量、颜色、方位、材质、光线与镜头信息，不美化也不删减。
6. 英文不要出现中文字符；专有名词可保留原文，如人名、品牌名。
7. ${tagLine}

输出示例：
1. a girl in a red dress standing on a stone bridge
2. cyberpunk color grading, cinematic lighting`;
}

const SYS_VISION = (limit) => `你是一个图像分析助手，专门为 AI 绘画提示词服务。

看图后用中文客观描述这张图，覆盖这些方面（有就写，没有就跳过）：
主体与动作、外貌与服饰、场景与环境、光线与色调、镜头与构图、画风与质感。

要求：
1. 不要评价、不要客套、不要分点标题，用连贯的短句写一段话。
2. 只描述看得见的东西，不要猜测看不见的信息。
3. 不超过 ${limit} 字。`;

const SYS_VISION_EN = `You are a prompt engineer for AI art. Look at the image and write ready-to-use English prompt fragments describing: subject and action, appearance and clothing, scene and environment, lighting and color, camera and composition, art style and texture.
Output 6-10 numbered lines, each a short comma-friendly noun phrase or gerund phrase, no full sentences, no explanations, English only.`;

/* ------------------------------------------------------------------ */
/* 调 llama-server                                                     */
/* ------------------------------------------------------------------ */

// 模型可能被「释放显存」停掉了，也可能自己挂了。发请求前先确认它在，
// 不在就用上次的模型重新拉起来（同一时间只会拉一次）。
let ensuring = null;
function ensureReady() {
  if (isRemote()) return Promise.resolve();
  if (state.attached) return Promise.resolve();
  if (state.status === 'ready' && state.port) return Promise.resolve();
  if (ensuring) return ensuring;

  const m = modelById(state.modelId || config.defaultModel) || config.models[0];
  state.status = 'loading';
  state.message = `加载 ${m.name}…`;
  log('ensureReady: 重新拉起模型', m.id);
  ensuring = launchModel(m).finally(() => { ensuring = null; });
  return ensuring;
}

async function llamaStream(messages, opts, onDelta, signal) {
  await ensureReady();
  const payload = llmPayload({
    messages,
    stream: true,
    temperature: opts.temperature ?? config.gen.temperature,
    top_p: opts.top_p ?? config.gen.top_p,
    repeat_penalty: opts.repeat_penalty ?? config.gen.repeat_penalty,
    max_tokens: opts.max_tokens ?? config.gen.max_tokens,
    deep: !!opts.deep
  });
  const ep = llmEndpoint();
  let r;
  try {
    r = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ep.headers },
      body: JSON.stringify(payload),
      signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(netFailMsg(ep, e));
  }
  if (!r.ok) throw new Error(`${ep.local ? 'llama-server' : providerById(providers.active)?.name || 'API'} ${r.status}: ${(await r.text()).slice(0, 300)}`);

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  let rawAll = '';       // 模型原始输出（可能含 <think>…</think>）
  llamaStream.finish = '';
  llamaStream.reasoning = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch (_) { continue; }
      const ch = j.choices?.[0];
      const d = ch?.delta?.content;
      if (ch?.delta?.reasoning_content) llamaStream.reasoning += ch.delta.reasoning_content;
      if (ch?.finish_reason) llamaStream.finish = ch.finish_reason;
      if (d) {
        rawAll += d;
        // MiniMax-M3 这类模型会把思考直接写进 content 的 <think>…</think> 里，
        // 原样透出去就是「只有思考、没有答案」。这里边流边剥。
        const vis = stripThink(rawAll);
        if (vis.length > full.length) {
          const add = vis.slice(full.length);
          full = vis;
          onDelta && onDelta(add, full);
        }
      }
    }
  }
  return full;
}

// 去掉 <think>…</think>（含未闭合的尾巴）和开头孤零零的 <｜end▁of▁thinking｜>
function stripThink(s) {
  let out = String(s || '');
  out = out.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const open = out.search(/<think(?:ing)?>/i);
  if (open >= 0) out = out.slice(0, open);
  out = out.replace(/^\s*<\/think(?:ing)?>\s*/i, '');
  return out;
}

async function llamaOnce(messages, opts = {}) {
  await ensureReady();
  const payload = llmPayload({
    messages,
    stream: false,
    temperature: opts.temperature ?? config.gen.temperature,
    top_p: opts.top_p ?? config.gen.top_p,
    repeat_penalty: opts.repeat_penalty ?? config.gen.repeat_penalty,
    max_tokens: opts.max_tokens ?? config.gen.max_tokens,
    deep: !!opts.deep
  });
  const ep = llmEndpoint();
  let r;
  try {
    r = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ep.headers },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    throw new Error(netFailMsg(ep, e));
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${ep.local ? 'llama-server' : providerById(providers.active)?.name || 'API'} ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.choices?.[0]?.message?.content || '';
}

/* ------------------------------------------------------------------ */
/* 行解析                                                              */
/* ------------------------------------------------------------------ */
function cleanLine(s) {
  let t = String(s || '').trim();
  t = t.replace(/^[-•*]\s*/, '');
  t = t.replace(/\*\*/g, '');
  t = t.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '');
  t = t.replace(/\s+#+\s*$/, '');
  return t.trim();
}

function parseNumbered(line) {
  const m = line.match(/^\s{0,4}(\d{1,3})\s*[.．、:：)\]］]\s*(.+)$/);
  if (!m) return null;
  const text = cleanLine(m[2]);
  if (!text) return null;
  return { n: parseInt(m[1], 10), text };
}

/* ------------------------------------------------------------------ */
/* 翻译主流程                                                          */
/* ------------------------------------------------------------------ */
function unitsPrompt(units, mode, hits, dir) {
  const list = units.map((u, i) => `${i + 1}. ${u}`).join('\n');
  return `${glossaryBlock(hits, dir)}【待翻译】共 ${units.length} 条：\n${list}`;
}

async function repairMissing(units, blocks, hits, mode, dir) {
  const missing = [];
  for (let i = 0; i < units.length; i++) if (!blocks[i] || !blocks[i].trim()) missing.push(i + 1);
  if (!missing.length) return;
  const list = missing.map(n => `${n}. ${units[n - 1]}`).join('\n');
  try {
    const out = await llamaOnce([
      { role: 'system', content: sysTranslate(mode, dir) },
      { role: 'user', content: `${glossaryBlock(hits, dir)}【待翻译】共 ${missing.length} 条（编号沿用原序号）：\n${list}` }
    ], { max_tokens: Math.min(2048, 120 * missing.length + 128) });
    for (const line of out.split(/\n+/)) {
      const p = parseNumbered(line);
      if (p && p.n >= 1 && p.n <= units.length) blocks[p.n - 1] = p.text;
    }
  } catch (e) {
    log('repair failed', e.message);
  }
}

async function handleTranslate(req, res, body) {
  const text = String(body.text || '');
  const dir = body.direction === 'en2zh' ? 'en2zh' : 'zh2en';
  const mode = body.mode === 'phrase' ? 'phrase' : (body.mode === 'sentence' ? 'sentence' : 'auto');
  const units = splitUnits(text, mode, body.maxUnits || 120, dir);
  const io = sseOpen(res);
  if (!units.length) { io.send('error', { message: '没有可翻译的内容' }); io.end(); return; }

  const hits = matchGlossary(text, dir);
  const blocks = new Array(units.length).fill('');
  const finished = new Set();

  io.send('start', {
    units,
    mode,
    direction: dir,
    glossary: hits.map(h => ({ zh: h.zh, en: h.en })),
    model: isRemote() ? `${activeProvider().name} · ${activeProvider().model}` : state.modelAlias
  });

  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

  let buf = '';
  const emitLine = (n, text) => {
    if (n < 1 || n > units.length) return;
    blocks[n - 1] = text;
    io.send('line', { n, text });
  };

  try {
    const sys = sysTranslate(mode, dir);
    const user = unitsPrompt(units, mode, hits, dir);
    await llamaStream(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { max_tokens: Math.min(4096, units.length * 70 + 160) },
      (delta, full) => {
        buf += delta;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const p = parseNumbered(line);
          if (p) { emitLine(p.n, p.text); finished.add(p.n); }
        }
        // 正在成形的半行，实时回显
        const p = parseNumbered(buf);
        if (p && !finished.has(p.n)) io.send('line', { n: p.n, text: p.text });
      },
      ctrl.signal
    );
    // 收尾：最后一行没换行的情况
    if (buf.trim()) {
      const p = parseNumbered(buf);
      if (p) emitLine(p.n, p.text);
    }
  } catch (e) {
    if (e.name === 'AbortError') { io.end(); return; }
    log('translate error', e.message);
    io.send('error', { message: e.message });
    io.end();
    return;
  }

  await repairMissing(units, blocks, hits, mode, dir);
  for (let i = 0; i < units.length; i++) {
    blocks[i] = enforceGlossary(blocks[i] || '', hits, dir);
    io.send('line', { n: i + 1, text: blocks[i] });
  }
  io.send('done', { units, blocks, mode, direction: dir, missing: blocks.filter(b => !b).length });
  io.end();
}

async function handleRetranslate(req, res, body) {
  const unit = String(body.unit || '').trim();
  const full = String(body.full || '').trim();
  const n = parseInt(body.n || '1', 10);
  if (!unit) return json(res, 400, { error: 'missing unit' });
  const dir = body.direction === 'en2zh' ? 'en2zh' : 'zh2en';
  const toZh = dir === 'en2zh';
  const mode = body.mode === 'phrase' ? 'phrase' : 'sentence';
  const hits = matchGlossary(full + '\n' + unit, dir);
  const prompt = `${glossaryBlock(hits, dir)}${full && full !== unit ? `【全文，仅供理解上下文】\n${full}\n\n` : ''}【只重译这一条】${n}. ${unit}

只输出一行，格式：${n}. <${toZh ? '中文' : '英文'}>`;
  try {
    const out = await llamaOnce([
      { role: 'system', content: sysTranslate(mode, dir) },
      { role: 'user', content: prompt }
    ], { max_tokens: 400, temperature: 0.35 });
    let text = '';
    for (const line of out.split(/\n+/)) {
      const p = parseNumbered(line);
      if (p) { text = p.text; break; }
      if (!text && cleanLine(line)) text = cleanLine(line);
    }
    json(res, 200, { text: enforceGlossary(text, hits, dir) });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

/* ------------------------------------------------------------------ */
/* 自然语言改提示词                                                     */
/* ------------------------------------------------------------------ */
function parseRevise(out) {
  const changes = [];
  let reply = '';
  const idx = out.search(/【\s*改动\s*】/);
  const head = idx >= 0 ? out.slice(0, idx) : '';
  const tail = idx >= 0 ? out.slice(idx).replace(/【\s*改动\s*】/, '') : out;
  reply = head.replace(/【\s*说明\s*】/g, '').trim().split(/\n+/).filter(Boolean).join(' ').trim();
  for (const line of tail.split(/\n+/)) {
    const p = parseNumbered(line);
    if (p) changes.push(p);
  }
  if (!changes.length) {
    for (const line of out.split(/\n+/)) {
      const p = parseNumbered(line);
      if (p) changes.push(p);
    }
  }
  return { reply, changes: changes.slice(0, 60) };
}

/* 自然语言改写「输入」原文（可以扩写，也可以改内容） */
function cleanRewrite(out) {
  let t = String(out || '').trim();
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
  const cut = t.search(/【\s*说明\s*】/);
  if (cut >= 0) t = t.slice(0, cut).trim();
  t = t.replace(/^(改写后[:：]?|修改后[:：]?)\s*/, '');
  t = t.replace(/^["“'‘]+|["”'’]+$/g, '');
  return t.trim();
}

async function handleRewriteInput(req, res, body) {
  const text = String(body.text || '').trim();
  const instruction = String(body.instruction || '').trim();
  const dir = body.direction === 'en2zh' ? 'en2zh' : 'zh2en';
  if (!text) return json(res, 400, { error: '输入是空的' });
  if (!instruction) return json(res, 400, { error: '没有修改要求' });

  const lang = dir === 'en2zh' ? '英文' : '中文';
  const sys = `你是 AI 绘画提示词的改写助手。用户给你一段${lang}描述和一条修改要求，你按要把它改写。

规则：
1. 只输出改写后的完整${lang}文本：不要解释、不要标题、不要编号、不要引号、不要 Markdown。
2. 只做用户要求的那部分改动，其余内容保持原样，不要顺手润色。
3. 如果要求是「扩充 / 更详细 / 丰富一点」，就补具体细节：外貌、动作、材质、光线、色彩、镜头、氛围，不要编造与原文冲突的东西。
4. 语言必须是${lang}，和输入一致。
5. 保持连贯的一段文字，不要分点、不要换行成列表。
6. 不要把改写过程说给我听。`;

  try {
    const t0 = Date.now();
    const out = await llamaOnce([
      { role: 'system', content: sys },
      { role: 'user', content: `【原文】\n${text}\n\n【修改要求】\n${instruction}` }
    ], { max_tokens: Math.min(2048, Math.max(600, Math.round(text.length * 1.6) + 300)), temperature: 0.5 });
    const rewritten = cleanRewrite(out);
    if (!rewritten) return json(res, 500, { error: '模型没给出结果' });
    json(res, 200, { text: rewritten, ms: Date.now() - t0 });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

async function handleRevise(req, res, body) {
  const dir = body.direction === 'en2zh' ? 'en2zh' : 'zh2en';
  const toZh = dir === 'en2zh';
  const blocks = Array.isArray(body.blocks) ? body.blocks.map(b => String(b || '')) : [];
  const instruction = String(body.instruction || '').trim();
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  if (!instruction) return json(res, 400, { error: '没有修改要求' });
  if (!blocks.length) return json(res, 400, { error: '还没有提示词块' });

  const targetName = toZh ? '中文' : '英文';
  const list = blocks.map((b, i) => `${i + 1}. ${b}`).join('\n');
  const histTxt = history.length ? `【之前的修改要求】\n${history.map(h => '- ' + h).join('\n')}\n\n` : '';

  const sys = `你是 AI 绘画提示词的编辑助手。用户用中文提出修改要求，你在给定的${targetName}提示词块上做修改。

输出格式（严格遵守）：
【说明】一句话中文，说清楚你改了什么
【改动】
编号. 修改后的完整${targetName}内容
（只写改过的块，一行一条）

规则：
1. 只输出真正改动过的块；没改的绝对不要输出。
2. 编号必须和输入对应；如果新增了块，接着用最大的编号往下排。
3. 每条必须是改完后完整的一句，不要只给差异片段。
4. 保持原有风格、语言和粒度，不要顺手润色没要求改的部分。
5. 如果这个要求不需要改任何块，就只输出【说明】那一行，不要输出【改动】。`;

  const user = `【当前提示词块（${targetName}）】\n${list}\n\n${histTxt}【这次的要求】\n${instruction}`;

  try {
    const t0 = Date.now();
    const out = await llamaOnce([
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ], { max_tokens: 1200, temperature: 0.4 });
    const parsed = parseRevise(out);
    for (const c of parsed.changes) c.text = enforceGlossary(c.text, matchGlossary(c.text, dir), dir);
    json(res, 200, {
      reply: parsed.reply || (parsed.changes.length ? `改了 ${parsed.changes.length} 块` : '没有改动'),
      changes: parsed.changes,
      ms: Date.now() - t0
    });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

/* 自然语言直接生成：先说需求生成一边，再翻成另一边，凑成中英成对的块 */
async function handleGenerate(req, res, body) {
  const instruction = String(body.instruction || '').trim();
  const extra = String(body.extra || '').trim();
  if (!instruction) return json(res, 400, { error: '说说你要什么' });

  const io = sseOpen(res);
  io.send('start', { mode: 'nl' });
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

  const genSys = `你是 AI 绘画 / 影像提示词生成器。用户用中文提需求，你按要求给出提示词。

规则：
1. 只输出结果，每行一条，行首写编号（1. 2. 3. …）。
2. 不要解释、不要标题、不要代码块、不要前后语。
3. 语言按用户要求；没指定就用英文。
4. 每条能独立使用，符合提示词写法（名词短语 / 动名词短语，逗号分隔细节）。
5. 数量按用户要求，没要求就 6–10 条。
6. 术语按用户说的风格来，别自作主张加没提到的元素。`;

  const user = extra ? `${instruction}\n\n【参考原文】\n${extra}` : instruction;

  try {
    // 第一步：按需求生成
    const gen = await llamaOnce(
      [{ role: 'system', content: genSys }, { role: 'user', content: user }],
      { max_tokens: 1500, temperature: 0.7 }
    );
    const lines = [];
    for (const line of gen.split(/\n+/)) {
      const p = parseNumbered(line);
      if (p) lines.push(p.text);
    }
    if (!lines.length) throw new Error('模型没给出可用的条目');

    // 哪边是中文
    const zhCnt = lines.filter(t => /[\u4e00-\u9fa5]/.test(t)).length;
    const genIsZh = zhCnt > lines.length / 2;

    // 先出块（另一边暂空），用户能马上看到
    lines.forEach((t, i) => io.send('line', genIsZh ? { n: i + 1, a: t, b: '' } : { n: i + 1, a: '', b: t }));

    // 第二步：翻到另一边
    const trDir = genIsZh ? 'zh2en' : 'en2zh';
    const list = lines.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const tr = await llamaOnce([
      { role: 'system', content: sysTranslate('phrase', trDir) },
      { role: 'user', content: `【待翻译】共 ${lines.length} 条：\n${list}` }
    ], { max_tokens: Math.min(3072, lines.length * 80 + 200), temperature: 0.3 });

    const other = [];
    for (const line of tr.split(/\n+/)) {
      const p = parseNumbered(line);
      if (p && p.n >= 1 && p.n <= lines.length) other[p.n - 1] = p.text;
    }

    const blocks = lines.map((t, i) => genIsZh
      ? { a: t, b: other[i] || '' }
      : { a: other[i] || '', b: t });
    blocks.forEach((b, i) => io.send('line', { n: i + 1, a: b.a, b: b.b }));
    io.send('done', { blocks, count: blocks.length });
    io.end();
  } catch (e) {
    if (e.name === 'AbortError') { io.end(); return; }
    io.send('error', { message: e.message });
    io.end();
  }
}

/* ------------------------------------------------------------------ */
/* 自定义系统提示词 + 对话                                              */
/* ------------------------------------------------------------------ */
function promptRoot() {
  const dir = config.promptDir || 'prompts';
  return path.isAbsolute(dir) ? dir : path.join(BASE, dir);
}

// 目录不存在就建一个，用户往里丢 .md 就能出现在下拉里
function ensurePromptRoot() {
  const root = promptRoot();
  try { if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true }); } catch (_) { }
  return root;
}

// 只允许读 promptRoot 里面的文件，挡住 ../ 之类
function safePromptPath(rel) {
  if (!rel || /[:\\]/.test(rel.replace(/^[a-zA-Z]:/, '')) && !rel) return null;
  const root = path.resolve(promptRoot());
  const full = path.resolve(root, rel);
  if (full === root) return null;
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

async function handleChat(req, res, body) {
  const system = String(body.system || '').trim();
  const history = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  // 图片：支持多张（images 数组），也兼容老的单张 image 字段
  const rawImgs = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
  const images = rawImgs
    .map(x => String(x || ''))
    .filter(x => x.startsWith('data:image/'))
    .slice(0, 8);           // 一次最多 8 张，太多了谁都吃不消
  if (!system) return json(res, 400, { error: '还没有系统提示词' });
  if (!history.length) return json(res, 400, { error: '没有内容' });

  const msgs = [];
  msgs.push({ role: 'system', content: system });
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const text = String(m.content || '');
    const isLastUser = i === history.length - 1 && m.role === 'user';
    if (isLastUser && images.length) {
      msgs.push({
        role: 'user',
        content: [{ type: 'text', text }].concat(
          images.map(url => ({ type: 'image_url', image_url: { url } }))
        )
      });
    } else {
      msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
    }
  }

  const io = sseOpen(res);
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
  io.send('start', {
    model: isRemote() ? `${activeProvider().name} · ${activeProvider().model}` : state.modelAlias,
    images: images.length
  });

  try {
    const deep = body.deep === true;
    const out = await llamaStream(msgs, {
      // 深度思考会先烧掉几千 token，额度给足，别又切成半截
      max_tokens: Math.min(16384, Number(body.maxTokens) || (deep ? 8000 : 3000)),
      temperature: Number(body.temperature) || 0.7,
      deep
    }, (delta, full) => io.send('delta', { text: full }), ctrl.signal);
    const clean = out.trim();
    if (!clean) {
      const fin = llamaStream.finish || '';
      const usedReasoning = (llamaStream.reasoning || '').length;
      if (fin === 'length' && usedReasoning) {
        io.send('error', {
          message: `模型把 ${body.maxTokens || 1600} 个 token 全花在「思考」上了（reasoning ${usedReasoning} 字），正文是空的。` +
            '换一个非思考模型，或者把这次的图/提示词减一减再试。'
        });
      } else {
        io.send('error', {
          message: '模型没有返回内容：可能系统提示词和这次的输入对不上，或者这家服务不支持多图/图片格式' +
            (fin ? `（finish_reason=${fin}）` : '')
        });
      }
      io.end();
      return;
    }
    io.send('done', { text: clean });
    io.end();
  } catch (e) {
    if (e.name === 'AbortError') { io.end(); return; }
    log('chat error', e.message);
    io.send('error', { message: e.message });
    io.end();
  }
}

async function handleVision(req, res, body) {
  const dataUrl = String(body.image || '');
  if (!dataUrl.startsWith('data:image/')) return json(res, 400, { error: '不是有效的图片' });
  const detail = Number(body.detail || 200);
  const english = !!body.english;
  const io = sseOpen(res);
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

  io.send('start', { model: isRemote() ? `${activeProvider().name} · ${activeProvider().model}` : state.modelAlias, english });
  try {
    const sys = english ? SYS_VISION_EN : SYS_VISION(detail);
    const ask = english
      ? 'Describe this image as AI-art prompt fragments, numbered.'
      : '请描述这张图。';
    const out = await llamaStream([
      { role: 'system', content: sys },
      {
        role: 'user', content: [
          { type: 'text', text: ask },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ], { max_tokens: english ? 512 : 700, temperature: 0.3 },
      (delta, full) => io.send('delta', { text: full }),
      ctrl.signal);
    const out2 = out.trim();
    const blocks = [];
    if (english) {
      for (const line of out2.split(/\n+/)) {
        const pnum = parseNumbered(line);
        if (pnum) blocks.push(pnum.text);
        else if (line.trim()) blocks.push(cleanLine(line));
      }
    }
    io.send('done', { text: out2, blocks });
    io.end();
  } catch (e) {
    if (e.name === 'AbortError') { io.end(); return; }
    log('vision error', e.message);
    io.send('error', { message: e.message });
    io.end();
  }
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(WEB)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    if (p === '/api/state') {
      const rp = activeProvider();
      // 用云端时，状态就是「就绪」，显示哪家 + 哪个模型
      if (rp) {
        return json(res, 200, {
          status: 'ready',
          message: `${rp.name} · ${rp.model}`,
          modelId: 'remote:' + rp.id,
          modelAlias: rp.model,
          modelName: `${rp.name} · ${rp.model}`,
          vision: !!rp.vision,
          attached: false,
          remote: true,
          port: 0,
          hint: '',
          models: config.models.map(m => ({ id: m.id, name: m.name, vision: !!m.mmproj, ctx: m.ctx })),
          defaultModel: config.defaultModel,
          provider: providers.active,
          providers: providers.list.map(x => ({ id: x.id, name: x.name, hasKey: !!x.apiKey, model: x.model, vision: x.vision }))
        });
      }
      // 外部服务掉线时如实反馈，别一直显示就绪
      if (state.status === 'ready' && state.port && !(await alive(state.port))) {
        state.status = 'error';
        state.vision = false;
        state.message = state.attached
          ? '外部 llama-server 掉线了，点「重启」用自带模型'
          : 'llama-server 没响应了，点「重启」';
      }
      return json(res, 200, {
        status: state.status, message: state.message, modelId: state.modelId,
        modelAlias: state.modelAlias, modelName: state.modelName, vision: state.vision, attached: state.attached,
        remote: false,
        port: state.port, hint: state.hint,
        models: config.models.map(m => ({ id: m.id, name: m.name, vision: !!m.mmproj, ctx: m.ctx })),
        defaultModel: config.defaultModel,
        // 模型来源：'local' 或某个 provider 的 id
        provider: providers.active,
        providers: providers.list.map(x => ({ id: x.id, name: x.name, hasKey: !!x.apiKey, model: x.model, vision: x.vision }))
      });
    }

    /* ------------------------- 模型来源（API 密钥） ------------------------- */
    if (p === '/api/providers' && req.method === 'GET') {
      return json(res, 200, {
        active: providers.active,
        list: providers.list.map(x => ({
          id: x.id, name: x.name, baseURL: x.baseURL, model: x.model,
          presetModels: x.presetModels || [], vision: x.vision, preset: x.preset,
          hasKey: !!x.apiKey, keyTail: x.apiKey ? x.apiKey.slice(-4) : ''
        }))
      });
    }

    if (p === '/api/providers' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');

      // 1) 保存某一家的设置
      if (body.id) {
        let pv = providerById(body.id);
        if (!pv && body.name) {              // 新加一条自定义
          pv = { id: body.id, name: body.name, baseURL: '', apiKey: '', model: '', presetModels: [], vision: false, preset: false };
          providers.list.push(pv);
        }
        if (!pv) return json(res, 404, { error: '未知来源' });
        if (typeof body.baseURL === 'string') pv.baseURL = body.baseURL.trim();
        if (typeof body.model === 'string') pv.model = body.model.trim();
        if (typeof body.name === 'string' && body.name.trim()) pv.name = body.name.trim();
        if (typeof body.apiKey === 'string') pv.apiKey = body.apiKey.trim();
        if (typeof body.vision === 'boolean') pv.vision = body.vision;
        saveProviders();
      }

      // 2) 切换来源
      if (typeof body.active === 'string') {
        const want = body.active;
        if (want !== 'local') {
          const pv = providerById(want);
          if (!pv) return json(res, 404, { error: '未知来源' });
          if (!pv.baseURL || !pv.model) return json(res, 400, { error: '这个来源还没配置地址和模型' });
          if (!pv.apiKey) return json(res, 400, { error: '还没填 API 密钥，填好并测试通过再切过去' });
        }
        providers.active = want;
        saveProviders();
        log('来源切换 ->', want);
        if (want === 'local') {
          // 回到本地：把模型拉起来（失败也让前端能看到错误）
          const m = modelById(state.modelId || config.defaultModel) || config.models[0];
          launchModel(m).catch(e => { state.status = 'error'; state.message = e.message; });
        } else {
          // 用云就不该继续占着显存
          if (child) {
            state.status = 'released';
            state.message = '已切到云端，本地模型已释放';
            await stopChild();
          }
        }
      }
      return json(res, 200, { ok: true, active: providers.active });
    }

    if (p === '/api/providers/models' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const pv = providerById(body.id);
      if (!pv) return json(res, 404, { error: '未知来源' });
      const base = String(pv.baseURL || '').replace(/\/+$/, '');
      if (!base) return json(res, 400, { error: '先填 API 地址' });
      const headers = {};
      if (pv.apiKey) headers.Authorization = `Bearer ${pv.apiKey}`;
      try {
        const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15000) });
        if (!r.ok) {
          const why = r.status === 404
            ? "这家不提供 /models 列表（MiniMax 就是这样），模型名直接在输入框里手填"
            : `取模型列表失败（${r.status}）`;
          return json(res, 200, { ok: false, reason: why, status: r.status });
        }
        const j = await r.json();
        const ids = (Array.isArray(j?.data) ? j.data : []).map(x => x && x.id).filter(Boolean).sort();
        if (ids.length) {
          pv.presetModels = ids;      // 只改内存里的快捷标签，落盘由前端保存时带走
          log('拉到模型列表', pv.id, ids.length, '个');
        }
        return json(res, 200, { ok: true, models: ids });
      } catch (e) {
        return json(res, 200, { ok: false, reason: '连不上：' + e.message });
      }
    }

    if (p === '/api/providers/test' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const pv = providerById(body.id);
      if (!pv) return json(res, 404, { error: '未知来源' });
      const base = String(pv.baseURL || '').replace(/\/+$/, '');
      if (!base) return json(res, 400, { error: '先填 API 地址' });
      const headers = { 'Content-Type': 'application/json' };
      if (pv.apiKey) headers.Authorization = `Bearer ${pv.apiKey}`;
      const t0 = Date.now();
      try {
        // 先试 /models（便宜、快）；有的服务不实现，就退化成一次 1 token 的对话
        let modelsOk = false, modelsCount = 0;
        try {
          const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(12000) });
          if (r.ok) {
            const j = await r.json();
            modelsCount = Array.isArray(j?.data) ? j.data.length : 0;
            modelsOk = true;
          } else if (r.status === 401 || r.status === 403) {
            return json(res, 200, { ok: false, reason: '鉴权失败（' + r.status + '）：密钥不对或没有这家服务的权限' });
          }
        } catch (_) { }

        if (!modelsOk) {
          const r = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: pv.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
            signal: AbortSignal.timeout(20000)
          });
          if (!r.ok) {
            const txt = (await r.text()).slice(0, 200);
            return json(res, 200, { ok: false, reason: `对话测试失败（${r.status}）：${txt}` });
          }
        }
        return json(res, 200, { ok: true, ms: Date.now() - t0, models: modelsCount });
      } catch (e) {
        return json(res, 200, { ok: false, reason: '连不上：' + e.message });
      }
    }

    if (p === '/api/model' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (isRemote()) return json(res, 409, { error: '当前用云端模型，切回本地才能换本地模型' });
      if (state.attached) return json(res, 409, { error: '外部服务，无法切换模型' });
      if (!modelById(body.id)) return json(res, 400, { error: '未知模型' });
      json(res, 202, { ok: true });
      switchModel(body.id).catch(e => { log('switch fail', e.message); });
      return;
    }

    if (p === '/api/glossary' && req.method === 'GET') {
      return json(res, 200, glossary);
    }

    if (p === '/api/glossary' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.entries && Array.isArray(body.entries)) glossary.entries = body.entries;
      if (body.categories && Array.isArray(body.categories)) {
        // 只接受 enabled 的更新，名字以本地为准
        for (const c of body.categories) {
          const local = (glossary.categories || []).find(x => x.id === c.id);
          if (local && typeof c.enabled === 'boolean') local.enabled = c.enabled;
        }
      }
      fs.writeFileSync(GLOSSARY_FILE, JSON.stringify(glossary, null, 2), 'utf8');
      return json(res, 200, { ok: true, count: glossary.entries.length });
    }

    if (p === '/api/translate' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      return handleTranslate(req, res, body);
    }

    if (p === '/api/retranslate' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      return handleRetranslate(req, res, body);
    }

    if (p === '/api/revise' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      return handleRevise(req, res, body);
    }

    if (p === '/api/rewrite' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      return handleRewriteInput(req, res, body);
    }

    if (p === '/api/generate' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      return handleGenerate(req, res, body);
    }

    if (p === '/api/vision' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      return handleVision(req, res, body);
    }

    /* ---------------- 自定义系统提示词 + 对话（可带图） ---------------- */
    if (p === '/api/prompts' && req.method === 'GET') {
      const root = ensurePromptRoot();
      if (!fs.existsSync(root)) return json(res, 200, { root, list: [], rel: path.relative(BASE, root) });
      const list = [];
      (function walk(dir) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) { walk(full); continue; }
          if (!/\.(md|txt)$/i.test(ent.name)) continue;
          const st = fs.statSync(full);
          list.push({
            rel: path.relative(root, full).replace(/\\/g, '/'),
            name: ent.name.replace(/\.(md|txt)$/i, ''),
            size: st.size
          });
        }
      })(root);
      list.sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
      return json(res, 200, { root, rel: path.relative(BASE, root).replace(/\\/g, '/'), list });
    }

    if (p === '/api/prompts/read' && req.method === 'GET') {
      const rel = String(u.searchParams.get('path') || '');
      const full = safePromptPath(rel);
      if (!full) return json(res, 400, { error: '路径不合法' });
      if (!fs.existsSync(full)) return json(res, 404, { error: '文件不存在' });
      const text = fs.readFileSync(full, 'utf8');
      return json(res, 200, { rel, text, size: text.length });
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      return handleChat(req, res, body);
    }

    if (p === '/api/release' && req.method === 'POST') {
      if (isRemote()) {
        return json(res, 409, { error: '当前用云端模型，本地根本没占显存' });
      }
      if (state.attached) {
        return json(res, 409, { error: `当前接的是外部 llama-server（:${state.port}），本程序停不了它` });
      }
      if (state.status === 'loading') {
        return json(res, 409, { error: '正在加载模型，等它加载完再释放' });
      }
      const wasReady = state.status === 'ready';
      state.status = 'released';
      state.message = wasReady ? '模型已释放，显存已归还' : '模型已停止';
      state.vision = false;
      state.startedAt = 0;
      log('release: 停掉 llama-server，释放显存');
      await stopChild();
      return json(res, 200, { ok: true, message: state.message });
    }

    if (p === '/api/restart' && req.method === 'POST') {
      if (isRemote()) return json(res, 409, { error: '当前用云端模型，先把来源切回本地' });
      const m = modelById(state.modelId || config.defaultModel) || config.models[0];
      state.attached = false;
      json(res, 202, { ok: true });
      launchModel(m).catch(e => { state.status = 'error'; state.message = e.message; log('restart fail', e.message); });
      return;
    }

    if (p === '/api/logs') {
      const f = u.searchParams.get('file') || '';
      const safe = path.join(LOGS, path.basename(f));
      if (!fs.existsSync(safe)) return json(res, 404, { error: 'no log' });
      const txt = fs.readFileSync(safe, 'utf8');
      return json(res, 200, { text: txt.slice(-4000) });
    }

    if (p === '/api/shutdown' && req.method === 'POST') {
      json(res, 200, { ok: true });
      setTimeout(() => { log('收到关闭指令'); killChild(); process.exit(0); }, 150);
      return;
    }

    return serveStatic(req, res, p);
  } catch (e) {
    log('request error', e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
// 允许用环境变量临时换端口（同一台机器开第二个实例做测试用）
const APP_PORT = Number(process.env.APP_PORT) || config.appPort;
const OPEN_BROWSER = process.env.NO_BROWSER ? false : config.openBrowser !== false;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const url = `http://127.0.0.1:${APP_PORT}`;
    log(`端口 ${APP_PORT} 已有实例在跑：${url}`);
    setTimeout(() => process.exit(0), 300);
  } else {
    log('server error', e.message);
    process.exit(1);
  }
});

server.listen(APP_PORT, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${APP_PORT}`;
  log(`UI  ${url}`);
  if (OPEN_BROWSER) {
    setTimeout(() => {
      try { spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true }).unref(); } catch (_) { }
    }, 600);
  }
  await bootServer();
});

process.on('SIGINT', () => { log('SIGINT, 退出'); killChild(); process.exit(0); });
process.on('SIGBREAK', () => { log('SIGBREAK, 退出'); killChild(); process.exit(0); });
process.on('exit', () => killChild());
