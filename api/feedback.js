// SideInk 用户反馈收集（Vercel Edge Function，挂在 sideink.app/api/feedback）
// 客户端在便签写「@sideink 内容」回车 → POST 到这里 → 存进 Upstash Redis 列表。
// 后台页 sideink.app/admin.html 用 ADMIN_TOKEN 读取。
//
// 需在 Vercel 配环境变量：APP_TOKEN / UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN

export const config = { runtime: 'edge' };

const LIST_KEY  = 'feedback:list';
const KEEP       = 2000;   // 列表最多保留条数
const MAX_TEXT   = 2000;
const DAILY_PER_INSTALL = 20;   // 每台设备每天最多提交（内存软限流，防刷）

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
  const text = String(body.text || '').trim().slice(0, MAX_TEXT);
  if (!text) return cors(json({ error: 'empty' }, 400));
  const install = String(body.install || 'anon').slice(0, 64).replace(/[^\w-]/g, '') || 'anon';

  if (bump(install) > DAILY_PER_INSTALL) {
    return cors(json({ error: 'quota', message: '今天提交得有点多啦，明天再来～' }, 429));
  }

  const entry = JSON.stringify({
    text,
    install,
    version: String(body.version || '').slice(0, 20),
    platform: String(body.platform || '').slice(0, 40),
    ua: (req.headers.get('user-agent') || '').slice(0, 160),
    ip: req.headers.get('x-forwarded-for') || '',
    ts: Date.now(),
  });

  try {
    await redisPipeline([
      ['LPUSH', LIST_KEY, entry],
      ['LTRIM', LIST_KEY, '0', String(KEEP - 1)],
    ]);
  } catch (e) {
    return cors(json({ error: 'store_failed', message: String(e.message || '') }, 502));
  }
  return cors(json({ ok: true }));
}

async function redisPipeline(cmds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('upstash not configured');
  const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('upstash ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}

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
