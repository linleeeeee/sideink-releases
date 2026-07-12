// 后台读取反馈（Vercel Edge Function，挂在 sideink.app/api/admin-feedback）
// 需带 header  x-admin-token: <ADMIN_TOKEN>（在 Vercel 环境变量里配）。
// 供 admin.html 拉取列表用。

export const config = { runtime: 'edge' };

const LIST_KEY = 'feedback:list';

export default async function handler(req) {
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
  const token = req.headers.get('x-admin-token') || new URL(req.url).searchParams.get('token') || '';
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401);

  let raw;
  try { raw = await redis(['LRANGE', LIST_KEY, '0', '499']); }
  catch (e) { return json({ error: 'read_failed', message: String(e.message || '') }, 502); }

  const items = (raw || []).map(s => { try { return JSON.parse(s); } catch { return { text: String(s), ts: 0 }; } });
  return json({ count: items.length, items });
}

async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) throw new Error('upstash not configured');
  const r = await fetch(url.replace(/\/$/, ''), {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error('upstash ' + r.status);
  return (await r.json()).result;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
