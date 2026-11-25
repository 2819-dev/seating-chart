// Server logic. FILES (the bundled front-end) is prepended by build.mjs.
// Bindings: DB (D1), secret APP_PASSWORD.

const COOKIE = 'sp_auth';
const enc = new TextEncoder();

async function token(env) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.APP_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('seating-planner-session-v1'));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function getCookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
const SEC = {
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...SEC } });

function loginPage(error) {
  return new Response(FILES['/login.html'].body.replace('<!--ERR-->', error ? '<p class="err">Incorrect password. Please try again.</p>' : ''), {
    status: error ? 401 : 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/login' && req.method === 'POST') {
      const form = await req.formData();
      const pw = String(form.get('password') || '');
      if (!safeEqual(pw, env.APP_PASSWORD)) {
        await new Promise(r => setTimeout(r, 800)); // slow down guessing
        return loginPage(true);
      }
      return new Response(null, {
        status: 303,
        headers: { location: '/', 'set-cookie': `${COOKIE}=${await token(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`, ...SEC },
      });
    }
    if (path === '/logout') {
      return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, ...SEC } });
    }

    const authed = safeEqual(getCookie(req, COOKIE), await token(env));
    if (!authed) {
      if (path.startsWith('/api/')) return json({ error: 'unauthorized' }, 401);
      return loginPage(false);
    }

    if (path === '/api/state') {
      if (req.method === 'GET') {
        const row = await env.DB.prepare('SELECT v, updated_at FROM store WHERE k = ?').bind('state').first();
        return json({ state: row ? JSON.parse(row.v) : null, updatedAt: row ? row.updated_at : 0 });
      }
      if (req.method === 'PUT') {
        const body = await req.text();
        if (body.length > 5_000_000) return json({ error: 'too large' }, 413);
        let data;
        try { data = JSON.parse(body); } catch { return json({ error: 'bad json' }, 400); }
        if (!data || !Array.isArray(data.charts)) return json({ error: 'bad state' }, 400);
        const now = Date.now();
        await env.DB.prepare('INSERT INTO store (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
          .bind('state', JSON.stringify(data), now).run();
        return json({ ok: true, updatedAt: now });
      }
      return json({ error: 'method' }, 405);
    }

    const f = FILES[path === '/' ? '/index.html' : path];
    if (!f || path === '/login.html') return new Response('Not found', { status: 404, headers: SEC });
    return new Response(f.body, { headers: { 'content-type': f.type, 'cache-control': 'no-cache', ...SEC } });
  },
};
