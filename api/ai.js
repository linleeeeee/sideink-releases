// SideInk 免费 AI 中转（Vercel Edge Function，挂在 sideink.app/api/ai）
// 放 Vercel 是因为主站同域名在国内已验证可达；Cloudflare 免费版 IP 国内直连常被 GFW 重置。
// App 只知道这个 endpoint，不含任何 provider key。key 存 Vercel 环境变量。
// 主用 Groq（极快），失败自动切 Gemini 兜底。
//
// 需在 Vercel 项目里配 3 个环境变量：GROQ_API_KEY / GEMINI_API_KEY / APP_TOKEN

export const config = { runtime: 'edge' };

const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';
const GEMINI_MODEL = 'gemini-2.5-flash';

const DAILY_PER_INSTALL = 50;    // 每台设备每天免费次数（内存软限流，冷启动会重置）
const MAX_CHARS         = 8000;  // 单条输入长度上限

// 内存计数：{ day, map: install -> count }。Edge 冷启动/多实例会重置，属"速度垫"而非硬限流。
let _bucket = { day: '', map: new Map() };
function bump(install) {
  const day = new Date().toISOString().slice(0, 10);
  if (_bucket.day !== day) _bucket = { day, map: new Map() };
  const n = (_bucket.map.get(install) || 0) + 1;
  _bucket.map.set(install, n);
  return n;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
  if (req.method !== 'POST')   return cors(json({ error: 'method_not_allowed' }, 405));

  const APP_TOKEN = process.env.APP_TOKEN;
  if (APP_TOKEN && req.headers.get('x-sideink-app') !== APP_TOKEN) {
    return cors(json({ error: 'forbidden' }, 403));
  }

  let body;
  try { body = await req.json(); } catch { return cors(json({ error: 'bad_json' }, 400)); }
  const system  = String(body.system || '').slice(0, MAX_CHARS);
  const user    = String(body.user   || '').slice(0, MAX_CHARS);
  const install = String(body.install || 'anon').slice(0, 64).replace(/[^\w-]/g, '') || 'anon';
  if (!user) return cors(json({ error: 'empty_input' }, 400));

  if (bump(install) > DAILY_PER_INSTALL) {
    return cors(json({ error: 'quota_install', message: '今日免费 AI 次数已用完，明天再来，或在设置里填自己的 Key' }, 429));
  }

  let text = null, lastErr = null;
  try { text = await callGroq(system, user); }
  catch (e) {
    lastErr = e;
    try { text = await callGemini(system, user); }
    catch (e2) { lastErr = e2; }
  }
  if (text == null) {
    return cors(json({ error: 'upstream_unavailable', message: 'AI 暂时不可用，请稍后重试', detail: String(lastErr && lastErr.message || '') }, 502));
  }
  return cors(json({ text }));
}

async function callGroq(system, user) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('no groq key');
  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: GROQ_MODEL, temperature: 0.7,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error('groq ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  const t = d?.choices?.[0]?.message?.content;
  if (!t) throw new Error('groq empty');
  return t.trim();
}

async function callGemini(system, user) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no gemini key');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.7 },
    }),
  });
  if (!r.ok) throw new Error('gemini ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  const t = (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!t) throw new Error('gemini empty');
  return t.trim();
}

// —— 工具 ——
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, x-sideink-app');
  h.set('Access-Control-Max-Age', '86400');
  return new Response(resp.body, { status: resp.status, headers: h });
}
