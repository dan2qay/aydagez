// Рост и доверие: аналитика для маркетолога, навык Алисы, страницы событий для поисковиков и ИИ-ассистентов,
// вход через Яндекс ID и Google, правила площадки и жалобы.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const GROWTH_SQL = `
CREATE TABLE IF NOT EXISTS client_identities (
  provider text NOT NULL, subject text NOT NULL, client_id uuid NOT NULL, email text, name text, avatar_url text,
  created_at timestamptz DEFAULT now(), last_login timestamptz DEFAULT now(), PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS client_identities_client_idx ON client_identities(client_id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS avatar_url text, ADD COLUMN IF NOT EXISTS rules_accepted_at timestamptz, ADD COLUMN IF NOT EXISTS blocked boolean DEFAULT false;
CREATE TABLE IF NOT EXISTS reports (
  id serial PRIMARY KEY, event_id int REFERENCES events(id) ON DELETE CASCADE, organizer_id int, client_id uuid, reason text NOT NULL, comment text,
  status text DEFAULT 'open', created_at timestamptz DEFAULT now(), resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, created_at);
`;

// Клиент «Алиса»: все запросы навыка идут от одного служебного клиента, чтобы не плодить анонимов
export const ALICE_CLIENT = '00000000-0000-4000-8000-00000a11ce00';
const AI_REFERRERS = /alice\.yandex|dialogs\.yandex|ya\.ru\/alice|yandex\.ru\/alice|chatgpt\.com|chat\.openai|perplexity|gigachat|giga\.chat|deepseek|copilot\.microsoft|gemini\.google/i;
const AI_UTM = ['alice', 'yandex_alice', 'chatgpt', 'gpt', 'perplexity', 'gigachat', 'deepseek', 'copilot', 'gemini'];
const REASONS = { illegal: 'Запрещённое или незаконное мероприятие', fraud: 'Мошенничество или подозрительная оплата', adult: '18+ без маркировки или не для детей', wrong: 'Неверная информация: время, место, цена', spam: 'Спам или реклама без пометки', other: 'Другое' };

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseUrl = req => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0]}://${req.headers['x-forwarded-host'] || req.get('host')}`;
const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress || '') && !req.headers['x-forwarded-for'];
const cookieOpts = maxAge => `Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
const parseCookies = h => { const out = {}; for (const part of (h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return out; };

// ---------- Вход через Яндекс ID и Google (OAuth 2.0, код авторизации) ----------
const PROVIDERS = {
  yandex: {
    title: 'Яндекс ID', id: () => process.env.YANDEX_CLIENT_ID, secret: () => process.env.YANDEX_CLIENT_SECRET,
    authorize: (cid, redirect, state) => `https://oauth.yandex.ru/authorize?response_type=code&client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}&force_confirm=no`,
    async profile(code, redirect) {
      const tok = await (await fetch('https://oauth.yandex.ru/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.id(), client_secret: this.secret() }) })).json();
      if (!tok.access_token) throw new Error(tok.error_description || 'нет токена');
      const u = await (await fetch('https://login.yandex.ru/info?format=json', { headers: { Authorization: `OAuth ${tok.access_token}` } })).json();
      return { subject: String(u.id), email: u.default_email || null, name: u.real_name || u.display_name || u.login || null, avatar: u.default_avatar_id && !u.is_avatar_empty ? `https://avatars.yandex.net/get-yapic/${u.default_avatar_id}/islands-200` : null, phone: u.default_phone?.number || null };
    },
  },
  google: {
    title: 'Google', id: () => process.env.GOOGLE_CLIENT_ID, secret: () => process.env.GOOGLE_CLIENT_SECRET,
    authorize: (cid, redirect, state) => `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${encodeURIComponent(cid)}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent('openid email profile')}&state=${state}&prompt=select_account`,
    async profile(code, redirect) {
      const tok = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.id(), client_secret: this.secret(), redirect_uri: redirect }) })).json();
      if (!tok.access_token) throw new Error(tok.error_description || 'нет токена');
      const u = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
      return { subject: String(u.sub), email: u.email_verified ? u.email : null, name: u.name || null, avatar: u.picture || null, phone: null };
    },
  },
};
export const authProviders = () => Object.entries(PROVIDERS).map(([k, p]) => ({ key: k, title: p.title, enabled: !!(p.id() && p.secret()) })).concat([{ key: 'gosuslugi', title: 'Госуслуги', enabled: false, soon: true }]);

export function mountGrowth(app, { q, EVENT_SQL, serialize, PUBLIC, PORT }) {
  // ---------- Вход через провайдеров ----------
  app.get('/auth/:provider', (req, res) => {
    const p = PROVIDERS[req.params.provider];
    if (!p) return res.status(404).send('Неизвестный способ входа');
    if (!p.id() || !p.secret()) return res.status(503).type('html').send(`<meta charset="utf-8"><p style="font-family:sans-serif">Вход через ${esc(p.title)} ещё не настроен: задайте ${req.params.provider.toUpperCase()}_CLIENT_ID и ${req.params.provider.toUpperCase()}_CLIENT_SECRET (см. README). <a href="/#/my">Вернуться</a></p>`);
    const state = randomBytes(16).toString('hex');
    const ret = typeof req.query.ret === 'string' && req.query.ret.startsWith('#/') ? req.query.ret.slice(0, 200) : '#/my';
    res.setHeader('Set-Cookie', [`oauth_state=${state}; ${cookieOpts(600)}`, `oauth_ret=${encodeURIComponent(ret)}; ${cookieOpts(600)}`]);
    res.redirect(p.authorize(p.id(), `${baseUrl(req)}/auth/${req.params.provider}/callback`, state));
  });
  app.get('/auth/:provider/callback', async (req, res) => {
    const key = req.params.provider, p = PROVIDERS[key];
    const ck = parseCookies(req.headers.cookie);
    const ret = ck.oauth_ret && ck.oauth_ret.startsWith('#/') ? ck.oauth_ret : '#/my';
    const fail = msg => res.redirect(`/?auth_error=${encodeURIComponent(msg)}${ret}`);
    try {
      if (!p || !req.query.code || !req.query.state || req.query.state !== ck.oauth_state) return fail('Вход прерван, попробуйте ещё раз');
      const u = await p.profile(String(req.query.code), `${baseUrl(req)}/auth/${key}/callback`);
      const known = (await q(`SELECT client_id FROM client_identities WHERE provider=$1 AND subject=$2`, [key, u.subject])).rows[0];
      let clientId = req.clientId;
      if (known && known.client_id !== req.clientId) {
        // Вход на новом устройстве: переносим записи анонимного браузера в найденный аккаунт и переключаем cookie
        const cur = (await q(`SELECT registered_at FROM clients WHERE id=$1`, [req.clientId])).rows[0];
        if (!cur?.registered_at) {
          await q(`INSERT INTO registrations(client_id,event_id,contact,external,created_at) SELECT $1,event_id,contact,external,created_at FROM registrations WHERE client_id=$2 ON CONFLICT DO NOTHING`, [known.client_id, req.clientId]);
          await q(`INSERT INTO follows(client_id,organizer_id) SELECT $1,organizer_id FROM follows WHERE client_id=$2 ON CONFLICT DO NOTHING`, [known.client_id, req.clientId]).catch(() => {});
        }
        clientId = known.client_id;
      }
      await q(`INSERT INTO client_identities(provider,subject,client_id,email,name,avatar_url) VALUES($1,$2,$3,$4,$5,$6)
               ON CONFLICT (provider,subject) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name, avatar_url=EXCLUDED.avatar_url, last_login=now()`, [key, u.subject, clientId, u.email, u.name, u.avatar]);
      await q(`UPDATE clients SET name=COALESCE(name,$2), contact=COALESCE(contact,$3), avatar_url=COALESCE(avatar_url,$4), account_type=COALESCE(account_type,'person'),
               registered_at=CASE WHEN registered_at IS NULL AND COALESCE(name,$2) IS NOT NULL AND COALESCE(contact,$3) IS NOT NULL THEN now() ELSE registered_at END, last_seen=now() WHERE id=$1`,
        [clientId, u.name, u.phone || u.email, u.avatar]);
      q(`INSERT INTO client_events(client_id, name, props, source) VALUES($1,'login',$2,'server')`, [clientId, JSON.stringify({ provider: key, new_device: clientId !== req.clientId })]).catch(() => {});
      res.setHeader('Set-Cookie', [`aid=${clientId}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`, `oauth_state=; ${cookieOpts(0)}`, `oauth_ret=; ${cookieOpts(0)}`]);
      res.redirect(`/?auth=${key}${ret}`);
    } catch (e) { console.warn('[auth]', key, e.message); fail('Не получилось войти, попробуйте ещё раз'); }
  });

  // ---------- Правила площадки и жалобы ----------
  app.post('/api/me/accept-rules', async (req, res, next) => {
    try { await q(`UPDATE clients SET rules_accepted_at=COALESCE(rules_accepted_at, now()) WHERE id=$1`, [req.clientId]); res.json({ ok: true }); } catch (e) { next(e); }
  });
  app.post('/api/events/:id/report', async (req, res, next) => {
    try {
      const id = Number(req.params.id); const reason = String(req.body?.reason || '');
      if (!REASONS[reason]) return res.status(400).json({ error: 'bad_reason' });
      const ev = (await q(`SELECT id, organizer_id FROM events WHERE id=$1`, [id])).rows[0];
      if (!ev) return res.status(404).json({ error: 'not_found' });
      const dup = (await q(`SELECT 1 FROM reports WHERE event_id=$1 AND client_id=$2 AND created_at > now() - interval '1 day'`, [id, req.clientId])).rows.length;
      if (!dup) await q(`INSERT INTO reports(event_id, organizer_id, client_id, reason, comment) VALUES($1,$2,$3,$4,$5)`, [id, ev.organizer_id, req.clientId, reason, String(req.body?.comment || '').slice(0, 1000) || null]);
      q(`INSERT INTO client_events(client_id, name, props, source) VALUES($1,'report',$2,'server')`, [req.clientId, JSON.stringify({ event_id: id, reason })]).catch(() => {});
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---------- Аналитика для маркетолога ----------
  const adminOk = req => process.env.ADMIN_TOKEN ? req.headers['x-admin-token'] === process.env.ADMIN_TOKEN : isLoopback(req);
  app.get('/api/admin/stats', async (req, res, next) => {
    try {
      if (!adminOk(req)) return res.status(401).json({ error: 'admin_only', message: process.env.ADMIN_TOKEN ? 'Нужен токен администратора' : 'Без ADMIN_TOKEN статистика открыта только на localhost' });
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
      const since = `now() - interval '${days} days'`;
      const one = async sql => (await q(sql)).rows[0];
      const all = async sql => (await q(sql)).rows;
      const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').replace(/[^a-z0-9.:-]/gi, '');
      // Переходы внутри сайта — не источник: считаем их прямым заходом
      const source = `COALESCE(NULLIF(s.utm->>'utm_source',''), CASE WHEN s.referrer IS NULL OR s.referrer='' OR s.referrer ILIKE '%://${host}%' THEN 'прямой заход' ELSE regexp_replace(s.referrer, '^https?://(www\\.)?([^/]+).*$', '\\2') END)`;
      const conv = `(SELECT count(DISTINCT ce.session_id) FROM client_events ce WHERE ce.session_id = ANY(array_agg(s.id)) AND ce.name='register')`;
      const totals = await one(`SELECT
          (SELECT count(*) FROM sessions WHERE started_at > ${since})::int AS sessions,
          (SELECT count(DISTINCT client_id) FROM sessions WHERE started_at > ${since})::int AS visitors,
          (SELECT count(*) FROM client_events WHERE ts > ${since} AND name='page_view')::int AS page_views,
          (SELECT count(*) FROM client_events WHERE ts > ${since} AND name='event_view')::int AS event_views,
          (SELECT count(*) FROM search_log WHERE created_at > ${since})::int AS searches,
          (SELECT count(*) FROM search_log WHERE created_at > ${since} AND mode='ai')::int AS ai_searches,
          (SELECT count(*) FROM search_log WHERE created_at > ${since} AND mode='ai' AND (filters->>'ai_source') LIKE 'llm:%')::int AS model_searches,
          (SELECT count(*) FROM search_log WHERE created_at > ${since} AND results = 0)::int AS zero_searches,
          (SELECT count(*) FROM client_events WHERE ts > ${since} AND name='register')::int AS registrations,
          (SELECT count(*) FROM clients WHERE registered_at > ${since})::int AS signups,
          (SELECT count(*) FROM client_events WHERE ts > ${since} AND name='login')::int AS oauth_logins,
          (SELECT count(*) FROM client_events WHERE ts > ${since} AND name='create_event')::int AS events_created,
          (SELECT count(*) FROM client_events WHERE ts > ${since} AND source='alice')::int AS alice_requests,
          (SELECT count(*) FROM reports WHERE status='open')::int AS open_reports`);
      const sources = await all(`SELECT ${source} AS source, count(*)::int AS sessions, count(DISTINCT s.client_id)::int AS visitors, ${conv}::int AS converted
          FROM sessions s WHERE s.started_at > ${since} AND s.client_id IS DISTINCT FROM '${ALICE_CLIENT}' GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
      const campaigns = await all(`SELECT s.utm->>'utm_source' AS source, s.utm->>'utm_medium' AS medium, s.utm->>'utm_campaign' AS campaign, count(*)::int AS sessions, ${conv}::int AS converted
          FROM sessions s WHERE s.started_at > ${since} AND s.utm ? 'utm_source' GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 20`);
      const aiAssist = await one(`SELECT count(*)::int AS sessions, ${conv}::int AS converted FROM sessions s WHERE s.started_at > ${since} AND (s.referrer ~* '${AI_REFERRERS.source}' OR lower(s.utm->>'utm_source') = ANY(ARRAY[${AI_UTM.map(x => `'${x}'`).join(',')}]))`);
      const landings = await all(`SELECT regexp_replace(regexp_replace(COALESCE(s.landing,''), '^https?://[^/]+', ''), '[?][^#]*', '') AS landing, count(*)::int AS sessions FROM sessions s WHERE s.started_at > ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);
      const devices = await all(`SELECT COALESCE(device,'?') AS device, count(*)::int AS sessions FROM sessions WHERE started_at > ${since} GROUP BY 1 ORDER BY 2 DESC`);
      const daily = await all(`SELECT to_char(d, 'DD.MM') AS day,
          (SELECT count(*) FROM sessions WHERE started_at >= d AND started_at < d + interval '1 day')::int AS sessions,
          (SELECT count(*) FROM search_log WHERE created_at >= d AND created_at < d + interval '1 day')::int AS searches,
          (SELECT count(*) FROM client_events WHERE name='register' AND ts >= d AND ts < d + interval '1 day')::int AS registrations
          FROM generate_series(date_trunc('day', ${since}), date_trunc('day', now()), interval '1 day') d ORDER BY d`);
      const topQueries = await all(`SELECT lower(query) AS query, count(*)::int AS n, round(avg(results))::int AS results, bool_or(mode='ai') AS ai FROM search_log WHERE created_at > ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
      const zeroQueries = await all(`SELECT lower(query) AS query, count(*)::int AS n FROM search_log WHERE created_at > ${since} AND results = 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);
      const funnel = await one(`SELECT count(DISTINCT session_id) FILTER (WHERE name='page_view')::int AS visited, count(DISTINCT session_id) FILTER (WHERE name IN ('search_submit','browse_pick','when_pick'))::int AS searched,
          count(DISTINCT session_id) FILTER (WHERE name='event_view')::int AS viewed, count(DISTINCT session_id) FILTER (WHERE name='register')::int AS registered FROM client_events WHERE ts > ${since}`);
      const reports = await all(`SELECT r.id, r.reason, r.comment, r.created_at, r.status, e.slug, e.title FROM reports r LEFT JOIN events e ON e.id=r.event_id WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 30`);
      res.json({ days, totals, sources, campaigns, aiAssist, landings, devices, daily, topQueries, zeroQueries, funnel, reports: reports.map(r => ({ ...r, reasonTitle: REASONS[r.reason] || r.reason })) });
    } catch (e) { next(e); }
  });
  app.post('/api/admin/reports/:id/resolve', async (req, res, next) => {
    try { if (!adminOk(req)) return res.status(401).json({ error: 'admin_only' }); await q(`UPDATE reports SET status=$2, resolved_at=now() WHERE id=$1`, [Number(req.params.id), req.body?.hide ? 'hidden' : 'resolved']); if (req.body?.hide) await q(`UPDATE events SET paused=true WHERE id=(SELECT event_id FROM reports WHERE id=$1)`, [Number(req.params.id)]); res.json({ ok: true }); } catch (e) { next(e); }
  });

  // ---------- Навык Алисы (Яндекс Диалоги): гость говорит фразу — получает три события со ссылками на запись ----------
  app.post('/api/alice', async (req, res) => {
    const body = req.body || {};
    const utter = String(body.request?.original_utterance || body.request?.command || '').trim();
    const reply = (text, buttons = []) => res.json({ version: body.version || '1.0', response: { text: text.slice(0, 1024), tts: text.replace(/[«»]/g, '').slice(0, 1024), buttons, end_session: false } });
    try {
      if (!utter || body.session?.new && /^(запусти|открой|включи|давай|алиса)/i.test(utter) && utter.split(/\s+/).length <= 4) return reply('Это Айдагез, афиша Казани. Скажите, куда хотите сходить: например, «с ребёнком в выходные» или «квиз с друзьями вечером».');
      const url = `http://127.0.0.1:${PORT}/api/events?when=any&ai=1&fast=1&limit=40&q=${encodeURIComponent(utter.slice(0, 200))}`;
      const data = await (await fetch(url, { headers: { Cookie: `aid=${ALICE_CLIENT}`, 'X-Path': 'alice' }, signal: AbortSignal.timeout(2600) })).json();
      const seen = new Set(), picks = [];
      // Лучшие по рангу из двух ближайших дней (реклама в голосовой ответ не попадает)
      const evs = (data.events || []).filter(e => !e.promoted);
      const near = new Set([...new Set(evs.map(e => e.date))].slice(0, 2));
      for (const e of evs.filter(x => near.has(x.date)).sort((a, b) => (b.rank || 0) - (a.rank || 0) || a.start.localeCompare(b.start))) { const k = e.seriesKey || e.id; if (seen.has(k)) continue; seen.add(k); picks.push(e); if (picks.length === 3) break; }
      q(`INSERT INTO client_events(client_id, name, props, source) VALUES($1,'alice_query',$2,'alice')`, [ALICE_CLIENT, JSON.stringify({ q: utter.slice(0, 200), results: picks.length })]).catch(() => {});
      if (!picks.length) return reply('Пока ничего не нашла. Попробуйте сказать иначе: например, «кино завтра вечером» или «бесплатно в выходные».');
      const fmt = e => { const d = new Date(e.start); return `${d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' })}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })}`; };
      const site = baseUrl(req);
      const text = `Нашла ${picks.length === 3 ? 'три варианта' : picks.length === 2 ? 'два варианта' : 'вариант'}: ` + picks.map((e, i) => `${i + 1}. «${e.title.replace(/[«»]/g, '')}», ${fmt(e)}, ${e.price ? e.price + ' ₽' : 'бесплатно'}`).join('. ') + '. Записаться можно по кнопке.';
      reply(text, picks.map(e => ({ title: e.title.replace(/[«»]/g, '').slice(0, 60), url: `${site}/e/${e.slug}?utm_source=alice&utm_medium=voice&utm_campaign=skill`, hide: false })));
    } catch (e) { console.warn('[alice]', e.message); reply('Не успела найти, спросите ещё раз чуть позже.'); }
  });

  // ---------- Страницы событий для поисковиков и ИИ-ассистентов: /e/:slug с разметкой schema.org ----------
  let tpl = null;
  const template = () => (tpl ??= readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'));
  app.get('/e/:slug', async (req, res, next) => {
    try {
      const row = (await q(`${EVENT_SQL} WHERE e.slug=$1`, [req.params.slug])).rows[0];
      if (!row) return res.redirect('/');
      const e = serialize(row), site = baseUrl(req), url = `${site}/e/${e.slug}`;
      const end = new Date(new Date(e.start).getTime() + e.duration * 60000).toISOString();
      const desc = String(e.description || '').replace(/[#*_>`\[\]()!]/g, '').replace(/\s+/g, ' ').slice(0, 220);
      const ld = { '@context': 'https://schema.org', '@type': 'Event', name: e.title, startDate: e.start, endDate: end, eventStatus: e.cancelled ? 'https://schema.org/EventCancelled' : 'https://schema.org/EventScheduled', eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        location: { '@type': 'Place', name: e.venue, address: { '@type': 'PostalAddress', streetAddress: e.address, addressLocality: 'Казань', addressRegion: 'Республика Татарстан', addressCountry: 'RU' }, ...(e.lat && e.lng ? { geo: { '@type': 'GeoCoordinates', latitude: e.lat, longitude: e.lng } } : {}) },
        image: e.cover ? [`${site}${e.cover}`] : undefined, description: desc, inLanguage: e.lang, typicalAgeRange: `${e.age || 0}-`,
        offers: { '@type': 'Offer', price: e.price, priceCurrency: 'RUB', availability: e.going >= e.capacity ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock', url },
        organizer: { '@type': 'Organization', name: e.organizer.name, url: `${site}/#/org/${e.organizer.slug}` } };
      const title = `${e.title} — ${new Date(e.start).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })} · Айдагез`;
      const head = `<title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="website"><meta property="og:title" content="${esc(e.title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}">${e.cover ? `<meta property="og:image" content="${esc(site + e.cover)}">` : ''}
  <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
  <script>if (!location.hash) history.replaceState(null, '', location.pathname.replace(/\\/e\\/.*/, '/') + location.search + '#/event/${encodeURIComponent(e.slug)}');</script>`;
      res.type('html').setHeader('Cache-Control', 'no-cache');
      res.send(template().replace(/<title>[\s\S]*?<\/title>/, head));
    } catch (err) { next(err); }
  });
  app.get('/sitemap.xml', async (req, res, next) => {
    try {
      const site = baseUrl(req);
      const rows = (await q(`SELECT DISTINCT ON (COALESCE(series_key, slug)) slug, start_at FROM events WHERE start_at > now() AND cancelled=false AND paused=false ORDER BY COALESCE(series_key, slug), start_at LIMIT 5000`)).rows;
      res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${site}/</loc><changefreq>daily</changefreq></url>\n${rows.map(r => `<url><loc>${site}/e/${esc(r.slug)}</loc><lastmod>${r.start_at.toISOString().slice(0, 10)}</lastmod></url>`).join('\n')}\n</urlset>`);
    } catch (e) { next(e); }
  });
  app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nSitemap: ${baseUrl(req)}/sitemap.xml\n`));
}
export { REASONS };
