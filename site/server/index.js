// Айдагез — сервер: статика, API, PostgreSQL, поиск.
process.env.TZ = process.env.TZ || 'Europe/Moscow'; // Казань живёт по московскому времени

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { q, migrate, ensureSeed, ensureOrganizer, insertEvent, slugify, DATABASE_URL } from './db.js';
import { search, buildDoc, buildVocab, buildIdf, tokenize, stem, normalize } from './search.js';
import { diversifyByDay, rankList, isPromoted } from './rank.js';
import { ORG_KINDS, PROMO_PRODUCTS, DEMO_BALANCE } from './orgkinds.js';
import { ACTIVITIES, ACT_GROUPS, detectActs, buildFacets, actsInText } from './facets.js';
import { DISTRICTS } from './districts.js';
import { randomBytes } from 'node:crypto';
import { tagEvent, parseQuery, parseQuerySmart, tagEventSmart, matchScore, TAG_VERSION, looksLikePhrase } from './ai.js';
import { llmInfo, llmEnabled } from './llm.js';
import { ensurePhotos } from './photos.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isoDate } from './seed.js';
import { mountGrowth, GROWTH_SQL, authProviders } from './growth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use('/vendor/inter', express.static(path.join(__dirname, '..', 'node_modules', '@fontsource', 'inter'), { maxAge: '30d', immutable: true }));
app.use('/vendor/marked', express.static(path.join(__dirname, '..', 'node_modules', 'marked', 'lib'), { maxAge: '30d', immutable: true }));
app.use('/vendor/dompurify', express.static(path.join(__dirname, '..', 'node_modules', 'dompurify', 'dist'), { maxAge: '30d', immutable: true }));
app.use('/vendor/qrcode', express.static(path.join(__dirname, '..', 'node_modules', 'qrcode-generator'), { maxAge: '30d', immutable: true }));
app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist'), { maxAge: '30d', immutable: true }));
// Интерфейс всегда перепроверяется у сервера: после обновления файлов браузер получает свежие версии.
app.use(express.static(PUBLIC, { etag: true, maxAge: 0, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));

// ---------- Клиент по cookie ----------
const UUID_RE = /^[0-9a-f-]{36}$/i;
function parseCookies(h) { const out = {}; for (const part of (h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return out; }
app.use(async (req, res, next) => {
  try {
    let id = parseCookies(req.headers.cookie).aid;
    let fresh = false;
    if (!id || !UUID_RE.test(id)) { id = randomUUID(); fresh = true; }
    const r = await q(`INSERT INTO clients(id) VALUES($1) ON CONFLICT (id) DO UPDATE SET last_seen=now() RETURNING id`, [id]);
    req.clientId = r.rows[0].id;
    if (fresh) res.setHeader('Set-Cookie', `aid=${id}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
    next();
  } catch (e) { next(e); }
});

// ---------- Аналитика: сессия и журнал действий ----------
const SESSION_RE = /^[0-9a-f-]{36}$/i;
app.use((req, res, next) => { const sid = req.headers['x-session-id']; req.sessionId = typeof sid === 'string' && SESSION_RE.test(sid) ? sid : null; next(); });
function logEvent(req, name, props = {}) {
  q(`INSERT INTO client_events(client_id, session_id, name, props, path, source) VALUES($1,$2,$3,$4,$5,'server')`, [req.clientId, req.sessionId, name, JSON.stringify(props), req.headers['x-path'] || null]).catch(() => {});
}
app.post('/api/track', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sid = typeof b.session === 'string' && SESSION_RE.test(b.session) ? b.session : null;
    if (sid) {
      const ua = String(req.headers['user-agent'] || '').slice(0, 300);
      const device = /Mobile|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
      await q(`INSERT INTO sessions(id, client_id, ua, device, lang, referrer, landing, utm) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (id) DO UPDATE SET last_seen=now()`, [sid, req.clientId, ua, device, String(b.lang || '').slice(0, 10), String(b.referrer || '').slice(0, 500), String(b.landing || '').slice(0, 500), JSON.stringify(b.utm || {})]);
    }
    const items = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
    for (const it of items) {
      if (!it || typeof it.name !== 'string') continue;
      await q(`INSERT INTO client_events(ts, client_id, session_id, name, props, path, source) VALUES(COALESCE($1, now()),$2,$3,$4,$5,$6,'web')`,
        [it.ts ? new Date(it.ts) : null, req.clientId, sid, it.name.slice(0, 60), JSON.stringify(it.props || {}), String(it.path || '').slice(0, 200)]);
    }
    res.status(204).end();
  } catch (e) { next(e); }
});

// ---------- Данные событий с кэшем ----------
const EVENT_SQL = `
  SELECT e.*, o.name AS organizer_name, o.slug AS organizer_slug, o.kind AS organizer_kind, o.logo AS organizer_logo, o.verified AS organizer_verified, o.promoted_until AS org_promoted_until, o.erid AS org_erid, s.title AS sub_title, s.emoji AS sub_emoji, s.keywords AS sub_keywords,
         c.title AS cat_title, c.emoji AS cat_emoji,
         (SELECT count(*) FROM registrations r WHERE r.event_id = e.id)::int AS reg_count,
         (SELECT round(avg(rv.rating)::numeric, 1)::float FROM reviews rv WHERE rv.organizer_id = e.organizer_id) AS org_rating,
         (SELECT count(*) FROM reviews rv WHERE rv.organizer_id = e.organizer_id)::int AS org_reviews
  FROM events e
  JOIN organizers o ON o.id = e.organizer_id
  LEFT JOIN subcategories s ON s.key = e.subcategory_key
  LEFT JOIN categories c ON c.key = e.category_key`;

function serialize(row, registeredIds = new Set()) {
  return {
    id: row.id, slug: row.slug, title: row.title, category: row.category_key, catTitle: row.cat_title, catEmoji: row.cat_emoji,
    sub: row.subcategory_key, subTitle: row.sub_title, subEmoji: row.sub_emoji, subKeywords: row.sub_keywords || [],
    emoji: row.emoji, start: row.start_at.toISOString(), date: isoDate(row.start_at), duration: row.duration_min, price: row.price, lang: row.lang,
    venue: row.venue, address: row.address, district: row.district,
    organizer: { id: row.organizer_id, name: row.organizer_name, slug: row.organizer_slug, kind: row.organizer_kind || null, logo: row.organizer_logo ? `/api/files/${row.organizer_logo}` : null, verified: !!row.organizer_verified },
    orgPromoted: !!(row.org_promoted_until && new Date(row.org_promoted_until) > new Date()), paused: !!row.paused,
    with: row.with_whom || [], solo: row.solo, stol: row.stol, age: row.age ?? 0,
    registration: { type: row.registration_type, label: row.registration_label, url: row.registration_url },
    capacity: row.capacity, going: row.going_base + row.reg_count, tags: row.tags || [], description: row.description,
    registered: registeredIds.has(row.id), source: row.source, lat: row.lat, lng: row.lng,
    seriesKey: row.series_key, cancelled: !!row.cancelled, createdBy: row.created_by || null, regCount: row.reg_count,
    kind: row.kind || null, meta: row.meta || {}, keywords: row.keywords || [], videoUrl: row.video_url || null,
    promotedUntil: row.promoted_until ? new Date(row.promoted_until).toISOString() : null, promoted: !!(row.promoted_until && new Date(row.promoted_until) > new Date()) || !!(row.org_promoted_until && new Date(row.org_promoted_until) > new Date()), erid: row.erid || row.org_erid || null, boostTerms: row.boost_terms || [],
    aiTags: row.ai_tags || {}, orgRating: row.org_rating || null, orgReviews: row.org_reviews || 0,
    cover: row.cover ? `/api/files/${row.cover}` : null, coverId: row.cover || null, photos: (row.photos || []).map(id => `/api/files/${id}`), photoIds: row.photos || [], theme: row.theme || null, accent: row.accent || null,
  };
}

let cache = { at: 0, events: [], docs: [], vocab: new Map() };
export function invalidate() { cache.at = 0; }
async function getUpcoming() {
  if (Date.now() - cache.at < 20000) return cache;
  const { rows } = await q(`${EVENT_SQL}
    WHERE e.cancelled = false AND e.paused = false AND e.start_at + (e.duration_min || ' minutes')::interval > now() AND e.start_at < now() + interval '75 days'
    ORDER BY e.start_at`);
  const events = rows.map(r => serialize(r));
  for (const e of events) e.acts = detectActs(e);
  const docs = events.map(buildDoc);
  buildIdf(docs);
  cache = { at: Date.now(), events, docs, vocab: buildVocab(events), suggestIndex: buildSuggestIndex(events) };
  return cache;
}
// Сигналы ранжирования из журнала: по какому запросу что выбирали (клики после поиска) и записи за 7 дней. Обновляются раз в 5 минут.
let signals = { at: 0, clicks: new Map(), popularity: new Map(), popularQueries: [] };
async function getSignals() {
  if (Date.now() - signals.at < 300000) return signals;
  const clicks = new Map(), popularity = new Map();
  try {
    const { rows } = await q(`SELECT lower(s.props->>'q') AS qq, COALESCE(e.series_key, '#' || e.id) AS key, count(*)::int AS n
      FROM client_events s JOIN client_events c ON c.session_id = s.session_id AND c.name = 'card_click' AND c.ts > s.ts AND c.ts < s.ts + interval '10 minutes'
      JOIN events e ON (c.props->>'event_id') ~ '^[0-9]+$' AND e.id = (c.props->>'event_id')::int
      WHERE s.name = 'search_submit' AND s.ts > now() - interval '60 days' AND coalesce(s.props->>'q', '') <> '' GROUP BY 1, 2`);
    for (const r of rows) { const k = normalize(r.qq); if (!clicks.has(k)) clicks.set(k, new Map()); clicks.get(k).set(r.key, r.n); }
    const pop = await q(`SELECT COALESCE(e.series_key, '#' || e.id) AS key, count(*)::int AS n FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.created_at > now() - interval '7 days' GROUP BY 1`);
    for (const r of pop.rows) popularity.set(r.key, r.n);
    const pq = await q(`SELECT query, count(*)::int AS n FROM search_log WHERE created_at > now() - interval '30 days' AND results > 0 AND length(query) BETWEEN 3 AND 60 GROUP BY 1 ORDER BY 2 DESC LIMIT 300`);
    signals = { at: Date.now(), clicks, popularity, popularQueries: pq.rows.map(r => ({ q: r.query, n: r.n })) };
  } catch (e) { console.warn('[rank] сигналы недоступны:', e.message); signals.at = Date.now(); }
  return signals;
}
// Индекс подсказок: названия серий и событий, организации, разделы
function buildSuggestIndex(events) {
  const titles = new Map(), orgs = new Map();
  for (const e of events) {
    const k = e.title; const t = titles.get(k) || { title: k, slug: e.slug, n: 0, next: e.date, emoji: e.emoji, orgSlug: e.organizer.slug, series: e.seriesKey };
    t.n++; if (e.date < t.next) { t.next = e.date; t.slug = e.slug; } titles.set(k, t);
    const o = orgs.get(e.organizer.slug) || { name: e.organizer.name, slug: e.organizer.slug, kind: e.organizer.kind, logo: e.organizer.logo, n: 0 }; o.n++; orgs.set(e.organizer.slug, o);
  }
  return { titles: [...titles.values()], orgs: [...orgs.values()] };
}
async function registeredSet(clientId) {
  const { rows } = await q(`SELECT event_id FROM registrations WHERE client_id=$1`, [clientId]);
  return new Set(rows.map(r => r.event_id));
}

// Настроение: «спокойное» и «активное» — наборы подкатегорий для тех, кто не знает, чего хочет.
const MOOD = {
  calm: new Set(['yoga', 'chess', 'board', 'lang', 'book', 'lecture', 'workshop', 'jazz', 'classical', 'market', 'theatre', 'cinema', 'exhibition', 'tour', 'stol', 'anticafe', 'circus', 'boat']),
  active: new Set(['run', 'skate', 'team', 'climb', 'walk', 'quiz', 'mafia', 'party', 'concert', 'standup', 'dating', 'networking', 'newcomers', 'it', 'vr', 'quest', 'park', 'bowling', 'kidsclub']),
};

// ---------- API ----------
app.get('/api/taxonomy', async (req, res) => {
  const cats = (await q(`SELECT key,title,emoji FROM categories ORDER BY sort`)).rows;
  const subs = (await q(`SELECT key,category_key,title,emoji FROM subcategories ORDER BY sort`)).rows;
  res.json({ categories: cats.map(c => ({ ...c, subs: subs.filter(s => s.category_key === c.key).map(({ key, title, emoji }) => ({ key, title, emoji })) })), activities: ACTIVITIES.map(({ key, cat, title, emoji, group }) => ({ key, cat, title, emoji, group: group || null })), groups: ACT_GROUPS, districts: DISTRICTS.map(({ key, label, hint, center }) => ({ key, label, hint, center: !!center })) });
});

app.get('/api/events', async (req, res, next) => {
  try {
    const { events, docs, vocab } = await getUpcoming();
    const regs = await registeredSet(req.clientId);
    const { q: query = '', cat, sub, with: withWhom, budget, from, to, mood, ai, sort } = req.query;
    let pool = events;
    let corrected = null;
    let scores = null;
    let aiInfo = null, aiScores = null, fallbackAi = false;
    // ИИ-режим: ai=1 — всегда, ai=0 — никогда, иначе (auto) сам включается для фраз («хочу…», «куда…», 4+ слов).
    const aiParam = String(ai ?? 'auto');
    const useAi = !!query.trim() && aiParam !== '0' && (aiParam === '1' || looksLikePhrase(query));
    const parsed = useAi ? (req.query.fast === '1' ? parseQuery(query) : await parseQuerySmart(query)) : null; // fast=1 — навык Алисы: ответ за 3 секунды, без модели
    // Жёсткие признаки — из правил; догадки модели (soft) только ранжируют, но не отсекают: «сегодня» не должно превращаться в «D&D сегодня»
    const sf = parsed?.soft || {};
    const tagSignal = !!parsed && !!((!sf.audience && parsed.audience.length) || (!sf.vibe && parsed.vibe.length) || (!sf.setting && parsed.setting.length) || (!sf.activity && parsed.activity.length) || (!sf.intensity && parsed.intensity) || parsed.price || parsed.times.length);
    const hasSignal = tagSignal || (!!parsed && !!(parsed.weekdays.length || parsed.when || parsed.dates || parsed.districts?.length || parsed.hour || parsed.pmax != null || parsed.pmin != null || parsed.kidAge != null || parsed.exclude?.activity?.length || parsed.exclude?.audience?.length || parsed.exclude?.times?.length));
    // Условия из фразы, которые отсекают жёстко: даты, цена, исключения («без детей», «кроме кино», «не вечером»)
    const hardCut = list => {
      const ex = parsed.exclude || {};
      if (parsed.pmax != null) list = list.filter(e => e.price <= parsed.pmax);
      if (parsed.pmin != null) list = list.filter(e => e.price >= parsed.pmin);
      if (ex.activity?.length) list = list.filter(e => !ex.activity.some(a => (e.acts || []).includes(a) || (e.aiTags?.activity || []).includes(a)));
      if (ex.audience?.includes('kids')) list = list.filter(e => e.category !== 'kids' && e.sub !== 'kidsclub');
      if (ex.times?.length) list = list.filter(e => !ex.times.includes(e.aiTags?.time));
      return list;
    };
    if (parsed && hasSignal) {
      // Разбираем фразу в признаки, считаем совпадение с тегами события; остаток слов — подсказка, а не фильтр
      aiScores = new Map();
      const textHits = parsed.rest.length ? search(parsed.rest.join(' '), docs, vocab).hits : new Map();
      for (const e of pool) {
        let sc = matchScore(parsed, e.aiTags, e);
        if (textHits.has(e.id)) sc = Math.min(1, sc + 0.25);
        if (sc > 0) aiScores.set(e.id, sc);
      }
      // Только «когда/где/во сколько» без признаков события — берём всю ленту и сужаем условиями (и словами, если они есть)
      const hardWords = parsed.restHard || parsed.rest; const hardHits = hardWords.length ? search(hardWords.join(' '), docs, vocab).hits : new Map();
      let found = tagSignal ? pool.filter(e => (aiScores.get(e.id) || 0) >= 0.6) : (hardWords.length ? pool.filter(e => hardHits.has(e.id)) : pool);
      if (!sf.audience && parsed.audience.includes('kids')) found = found.filter(e => e.with.includes('kids') && e.age < 16);
      if (parsed.kidAge != null) found = found.filter(e => e.age <= parsed.kidAge); // «с ребёнком 5 лет» — без 6+ и старше
      if (parsed.price === 'free') found = found.filter(e => e.price === 0);
      if (parsed.weekdays.length) found = found.filter(e => parsed.weekdays.includes(new Date(e.date + 'T12:00:00').getDay()));
      const dr = parsed.dates ? { from: parsed.dates.from, to: parsed.dates.to } : parsed.when ? dateRangeFor(parsed.when) : null;
      if (dr) found = found.filter(e => e.date >= dr.from && e.date <= dr.to);
      found = hardCut(found);
      if (parsed.districts?.length) found = found.filter(e => parsed.districts.includes(e.district));
      if (parsed.hour) { const mm = e => { const d = new Date(e.start); return d.getHours() * 60 + d.getMinutes(); }; found = found.filter(e => (mm(e) >= parsed.hour.from && mm(e) <= parsed.hour.to) || (e.kind === 'open' && String(e.meta?.open_from || '00:00') <= `${String(Math.floor(parsed.hour.to / 60)).padStart(2, '0')}:00` && String(e.meta?.open_to || '23:59') >= `${String(Math.floor(parsed.hour.from / 60)).padStart(2, '0')}:00`)); }
      let fallback = false;
      if (!found.length) { fallbackAi = true; // по смыслу пусто — показываем по словам, чтобы лента не была пустой
        const negWords = new Set((parsed.segments || []).filter(x => x.neg).flatMap(x => x.text.split(' ')));
        const fbQuery = query.split(/\s+/).filter(w => !negWords.has(w.toLowerCase().replace(/ё/g, 'е'))).join(' '); // «кроме кино» — не искать «кино»
        const r = search(fbQuery, docs, vocab); scores = r.hits; corrected = r.corrected; aiScores = null; fallback = true;
        found = pool.filter(e => scores.has(e.id));
        if (!found.length && !tagSignal) found = pool; // только условия («сегодня, без кино») — вся лента, суженная ими ниже
        if (dr) found = found.filter(e => e.date >= dr.from && e.date <= dr.to); // даты и район из фразы — жёсткие даже при откате на слова
        if (parsed.districts?.length) found = found.filter(e => parsed.districts.includes(e.district));
        found = hardCut(found);
        if (parsed.times.length) found = found.filter(e => parsed.times.some(t => t === 'weekend' ? true : e.aiTags?.time === t || (e.kind === 'open' && t === openCovers(e)))); // «вечером» не должно превращаться в 10 утра
      }
      pool = found;
      aiInfo = { parsed: { audience: parsed.audience, vibe: parsed.vibe, setting: parsed.setting, activity: parsed.activity, intensity: parsed.intensity, price: parsed.price, times: parsed.times, weekdays: parsed.weekdays }, human: parsed.human, fallback, source: parsed.source || 'rules', pending: !!parsed.pending, ungroup: !!(parsed.hour || parsed.times.length), when: parsed.when || null, dates: parsed.dates ? { from: parsed.dates.from, to: parsed.dates.to } : parsed.when ? dateRangeFor(parsed.when) : null, districts: parsed.districts || [], words: parsed.restHard || [], segments: parsed.segments || [] };
    } else if (query.trim()) {
      const r = search(query, docs, vocab);
      corrected = r.corrected; scores = r.hits;
      pool = pool.filter(e => scores.has(e.id));
    }
    // Конкретное занятие в запросе («лазертаг», «волейбол», «картинг») — показываем только его, ничего похожего
    const qActs = query.trim() ? actsInText(query).filter(a => !(parsed?.exclude?.activity || []).includes(a)) : []; // «кроме кино» — не повод оставлять только кино
    if (qActs.length) pool = pool.filter(e => (e.acts || []).some(a => qActs.includes(a)));
    if (mood && MOOD[mood]) pool = pool.filter(e => MOOD[mood].has(e.sub));
    if (withWhom === 'kids') pool = pool.filter(e => e.with.includes('kids') && e.age < 16);
    else if (withWhom) pool = pool.filter(e => e.with.includes(withWhom));
    const ageMax = req.query.age !== undefined && req.query.age !== '' ? Number(req.query.age) : null;
    if (ageMax !== null && !Number.isNaN(ageMax)) pool = pool.filter(e => e.age <= ageMax);
    const tod = String(req.query.tod || '').split(',').filter(x => ['morning', 'day', 'evening', 'night'].includes(x));
    if (tod.length) pool = pool.filter(e => tod.includes(e.aiTags?.time) || (e.kind === 'open' && tod.includes(openCovers(e)))); // время суток: по тегу или по часам работы
    const noise = String(req.query.noise || '');
    if (noise === 'loud' || noise === 'quiet') pool = pool.filter(e => (e.aiTags?.noise || 'mid') === noise || (e.aiTags?.noise || 'mid') === 'mid' && noise === 'quiet' && e.kind === 'open');
    // Сводка для панели фильтров считается до фильтров по разделам и цене, но в выбранных датах — как у Airbnb
    const inRange = e => (!from || e.date >= from) && (!to || e.date <= to);
    const facets = req.query.facets === '1' ? buildFacets(pool.filter(inRange)) : null;
    if (cat) { const set = new Set(String(cat).split(',').filter(Boolean)); pool = pool.filter(e => set.has(e.category)); }
    const subs = String(sub || '').split(',').filter(Boolean); if (subs.length) pool = pool.filter(e => subs.includes(e.sub));
    const acts = String(req.query.act || '').split(',').filter(Boolean); if (acts.length) pool = pool.filter(e => (e.acts || []).some(a => acts.includes(a)));
    const dists = String(req.query.district || '').split(',').filter(Boolean); if (dists.length) pool = pool.filter(e => dists.includes(e.district));
    const pmin = req.query.pmin !== undefined && req.query.pmin !== '' ? Number(req.query.pmin) : null;
    const pmaxRaw = req.query.pmax !== undefined && req.query.pmax !== '' ? req.query.pmax : (budget !== undefined && budget !== '' && budget !== 'any' ? budget : null);
    const pmax = pmaxRaw !== null ? Number(pmaxRaw) : null;
    if (pmin !== null && !Number.isNaN(pmin)) pool = pool.filter(e => e.price >= pmin);
    if (pmax !== null && !Number.isNaN(pmax)) pool = pool.filter(e => e.price <= pmax);
    const days = {}, seen = new Set();
    for (const e of pool) { const k = e.seriesKey && SLOTTED.has(e.kind) ? `${e.date}:${e.seriesKey}` : `${e.date}:${e.id}`; if (seen.has(k)) continue; seen.add(k); days[e.date] = (days[e.date] || 0) + 1; }
    let list = pool;
    if (from) list = list.filter(e => e.date >= from);
    if (to) list = list.filter(e => e.date <= to);
    list = list.map(e => ({ ...e, registered: regs.has(e.id), score: scores ? scores.get(e.id) : undefined, aiScore: aiScores ? aiScores.get(e.id) : undefined }));
    const tokens = query.trim() ? tokenize(query).map(stem) : [];
    const sig = await getSignals();
    const interests = (await q(`SELECT interests FROM clients WHERE id=$1`, [req.clientId])).rows[0]?.interests || [];
    list = sort === 'time' ? list : rankList(list, { now: new Date(), hits: scores, tokens, aiScores, clicks: sig.clicks.get(normalize(query)) || null, popularity: sig.popularity, interests });
    if (sort !== 'time' && parsed && !fallbackAi && (parsed.activity.includes('sport') || !parsed.activity.length) && !qActs.length) list = diversifyByDay(list, e => (e.acts || [])[0] || e.sub); // общий запрос («спортом», «с семьёй») — разные виды рядом
    if (query.trim()) q(`INSERT INTO search_log(client_id, session_id, query, corrected, results, mode, filters) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [req.clientId, req.sessionId || null, query.slice(0, 200), corrected, list.length, aiInfo ? 'ai' : 'text', JSON.stringify({ cat, sub, mood, with: withWhom, budget, from, to, ai_source: aiInfo?.source || null, fallback: !!aiInfo?.fallback })]).catch(() => {});
    const limit = Number(req.query.limit) || 0; if (limit > 0) list = list.slice(0, Math.min(limit, 200)); // навык Алисы и виджеты берут только начало выдачи
    res.json({ events: list, days, corrected, facets, ungroup: tod.length > 0 || !!(aiInfo && aiInfo.ungroup), total: pool.length, range: { from: from || null, to: to || null }, ai: aiInfo });
  } catch (e) { next(e); }
});

// Диапазон дат по слову из фразы: сегодня, завтра, послезавтра, выходные, неделя (по Казани)
function dateRangeFor(when) {
  const t = isoDate(new Date()); const d0 = new Date(t + 'T12:00:00'); const add = n => isoDate(new Date(d0.getTime() + n * 864e5));
  if (when === 'today') return { from: t, to: t };
  if (when === 'tomorrow') return { from: add(1), to: add(1) };
  if (when === 'dayafter') return { from: add(2), to: add(2) };
  if (when === 'week') { const dow = d0.getDay(); return { from: t, to: add(dow === 0 ? 0 : 7 - dow) }; }
  if (when === 'weekend') { const dow = d0.getDay(); const sat = dow === 0 ? -1 : 6 - dow; return { from: add(Math.max(0, sat)), to: add(sat + 1) }; }
  return null;
}
// Какое время суток покрывает площадка со свободным посещением (по часам работы)
function openCovers(e) { const to = String(e.meta?.open_to || ''); return to >= '21:00' ? 'evening' : to >= '17:00' ? 'day' : 'morning'; }

// Подсказки как в поисковике: разделы, организации, названия, популярные запросы — по префиксу, пока гость печатает
app.get('/api/suggest', async (req, res, next) => {
  try {
    const raw = normalize(String(req.query.q || '')).slice(0, 60);
    if (raw.length < 2) return res.json({ items: [] });
    const { suggestIndex, events } = await getUpcoming();
    const sig = await getSignals();
    const words = tokenize(raw); const last = words[words.length - 1] || raw; const lastStem = stem(last);
    const matchText = t => { const n = normalize(t); return n.startsWith(raw) ? 3 : n.includes(' ' + raw) ? 2 : tokenize(n).some(w => w.startsWith(last) || stem(w) === lastStem) ? 1 : 0; };
    const items = [];
    const cats = (await q(`SELECT c.key, c.title, c.emoji, NULL AS cat FROM categories c UNION ALL SELECT s.key, s.title, s.emoji, s.category_key FROM subcategories s`)).rows;
    for (const c of cats) { const m = matchText(c.title); if (m) items.push({ type: 'category', label: c.title, emoji: c.emoji, q: c.title, score: 50 + m * 10, cat: c.cat || c.key, sub: c.cat ? c.key : null }); }
    for (const o of suggestIndex.orgs) { const m = matchText(o.name); if (m) items.push({ type: 'org', label: o.name, sub: `${ORG_KINDS[o.kind]?.title || 'Организатор'} · ${o.n} ${o.n === 1 ? 'событие' : o.n < 5 ? 'события' : 'событий'}`, href: `#/org/${o.slug}`, logo: o.logo, emoji: ORG_KINDS[o.kind]?.emoji || '🎪', score: 40 + m * 10 + Math.min(10, o.n) }); }
    for (const t of suggestIndex.titles) { const m = matchText(t.title); if (m) items.push({ type: 'event', label: t.title, sub: `${t.n > 1 ? t.n + ' дат' : 'ближайшее'} · ${t.next.slice(8)}.${t.next.slice(5, 7)}`, href: `#/event/${t.slug}`, emoji: t.emoji, score: 30 + m * 10 + Math.min(10, t.n) }); }
    for (const pq of sig.popularQueries) { const n = normalize(pq.q); if (n !== raw && n.startsWith(raw)) items.push({ type: 'query', label: pq.q, sub: 'популярный запрос', q: pq.q, emoji: '🔎', score: 45 + Math.min(15, pq.n) }); }
    items.sort((a, b) => b.score - a.score);
    const seen = new Set(); const out = [];
    for (const it of items) { const k = it.type + ':' + normalize(it.label); if (seen.has(k)) continue; seen.add(k); out.push(it); if (out.length >= 8) break; }
    res.json({ items: out, q: raw });
  } catch (e) { next(e); }
});
app.get('/api/events/:slug', async (req, res, next) => {
  try {
    const { rows } = await q(`${EVENT_SQL} WHERE e.slug=$1`, [req.params.slug]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const ev = serialize(rows[0], await registeredSet(req.clientId));
    if (ev.seriesKey) {
      const sib = await q(`SELECT e.id, e.slug, e.start_at, e.capacity, e.going_base + (SELECT count(*) FROM registrations r WHERE r.event_id=e.id)::int AS going
        FROM events e WHERE e.series_key=$1 AND e.cancelled=false AND e.start_at >= $2::date AND e.start_at < $2::date + interval '1 day' ORDER BY e.start_at`, [ev.seriesKey, ev.date]);
      ev.siblings = sib.rows.map(r => ({ id: r.id, slug: r.slug, start: r.start_at.toISOString(), capacity: r.capacity, going: r.going }));
    }
    res.json(ev);
  } catch (e) { next(e); }
});

app.post('/api/events/:id/register', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { contact = null, external = false } = req.body || {};
    const prof = (await q(`SELECT name, contact, account_type FROM clients WHERE id=$1`, [req.clientId])).rows[0] || {};
    if (process.env.REQUIRE_PROFILE !== '0' && (!prof.name || !(prof.contact || contact) || !prof.account_type)) return res.status(403).json({ error: 'profile_required', message: 'Чтобы записаться, представьтесь: имя, контакт и кто вы — человек или организация' });
    await q(`INSERT INTO registrations(client_id,event_id,contact,external) VALUES($1,$2,$3,$4)
             ON CONFLICT (client_id,event_id) DO UPDATE SET contact=COALESCE(EXCLUDED.contact, registrations.contact)`, [req.clientId, id, contact, !!external]);
    if (contact) await q(`UPDATE clients SET contact=COALESCE(contact,$2) WHERE id=$1`, [req.clientId, contact]);
    logEvent(req, 'register', { event_id: id, external: !!external });
    invalidate();
    const { rows } = await q(`${EVENT_SQL} WHERE e.id=$1`, [id]);
    res.json(serialize(rows[0], new Set([id])));
  } catch (e) { next(e); }
});
app.delete('/api/events/:id/register', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await q(`DELETE FROM registrations WHERE client_id=$1 AND event_id=$2`, [req.clientId, id]);
    logEvent(req, 'unregister', { event_id: id });
    invalidate();
    const { rows } = await q(`${EVENT_SQL} WHERE e.id=$1`, [id]);
    res.json(serialize(rows[0]));
  } catch (e) { next(e); }
});

function orgPublic(o) {
  const promoted = !!(o.promoted_until && new Date(o.promoted_until) > new Date());
  const ann = o.announcement && typeof o.announcement === 'object' ? o.announcement : null;
  const annActive = ann && ann.title && (!ann.until || ann.until >= isoDate(new Date())) && (!ann.from || ann.from <= isoDate(new Date()));
  return { id: o.id, slug: o.slug, name: o.name, kind: o.kind || null, kindTitle: ORG_KINDS[o.kind]?.title || null, about: o.about, website: o.website, contact: o.contact, phone: o.phone, telegram: o.telegram, vk: o.vk,
    address: o.address, lat: o.lat, lng: o.lng, hours: o.hours, verified: !!o.verified, logo: o.logo ? `/api/files/${o.logo}` : null, logoId: o.logo || null, cover: o.cover ? `/api/files/${o.cover}` : null, coverId: o.cover || null,
    announcement: annActive ? ann : null, promoted, erid: o.erid || null, createdAt: o.created_at };
}
async function orgStats(id) {
  const base = (await q(`SELECT count(DISTINCT e.id) FILTER (WHERE e.start_at > now())::int AS upcoming, count(DISTINCT e.series_key) FILTER (WHERE e.series_key IS NOT NULL AND e.start_at > now())::int AS series,
      (SELECT count(*) FROM registrations r JOIN events x ON x.id=r.event_id WHERE x.organizer_id=$1)::int AS registrations,
      (SELECT count(*) FROM checkins ck JOIN events x ON x.id=ck.event_id WHERE x.organizer_id=$1 AND ck.guest_confirmed_at IS NOT NULL AND ck.organizer_confirmed_at IS NOT NULL)::int AS checkins,
      (SELECT count(*) FROM follows WHERE organizer_id=$1)::int AS followers,
      (SELECT round(avg(rating)::numeric,1)::float FROM reviews WHERE organizer_id=$1) AS rating, (SELECT count(*) FROM reviews WHERE organizer_id=$1)::int AS reviews
    FROM events e WHERE e.organizer_id=$1 AND e.cancelled=false`, [id])).rows[0];
  return base;
}
app.get('/api/organizers/:slug', async (req, res, next) => {
  try {
    const o = (await q(`SELECT * FROM organizers WHERE slug=$1`, [req.params.slug])).rows[0];
    if (!o) return res.status(404).json({ error: 'not_found' });
    const regs = await registeredSet(req.clientId);
    const { rows } = await q(`${EVENT_SQL} WHERE e.organizer_id=$1 AND e.cancelled = false AND e.paused = false AND e.start_at + (e.duration_min || ' minutes')::interval > now() ORDER BY e.start_at`, [o.id]);
    const followed = (await q(`SELECT 1 FROM follows WHERE client_id=$1 AND organizer_id=$2`, [req.clientId, o.id])).rows.length > 0;
    const stats = await orgStats(o.id);
    const reviews = (await q(`SELECT rv.rating, rv.text, rv.created_at, c.name, e.title FROM reviews rv JOIN clients c ON c.id=rv.client_id JOIN events e ON e.id=rv.event_id WHERE rv.organizer_id=$1 ORDER BY rv.created_at DESC LIMIT 20`, [o.id])).rows
      .map(r => ({ rating: r.rating, text: r.text, at: r.created_at, name: r.name ? r.name.split(' ')[0] : 'Гость', event: r.title }));
    const events = rows.map(r => serialize(r, regs));
    const photos = [...new Set(events.flatMap(e => [e.cover, ...e.photos]).filter(Boolean))].slice(0, 12);
    const isMember = await ownsOrganizer(req.clientId, o.id);
    logEvent(req, 'org_view', { organizer_id: o.id });
    res.json({ organizer: { ...orgPublic(o), followers: stats.followers, rating: stats.rating, reviews: stats.reviews, checkins: stats.checkins }, followed, isMember, events, reviewsList: reviews, photos });
  } catch (e) { next(e); }
});
app.post('/api/organizers/:id/follow', async (req, res, next) => {
  try { await q(`INSERT INTO follows(client_id,organizer_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [req.clientId, Number(req.params.id)]); logEvent(req, 'follow', { organizer_id: Number(req.params.id) }); res.json({ followed: true }); } catch (e) { next(e); }
});
app.delete('/api/organizers/:id/follow', async (req, res, next) => {
  try { await q(`DELETE FROM follows WHERE client_id=$1 AND organizer_id=$2`, [req.clientId, Number(req.params.id)]); res.json({ followed: false }); } catch (e) { next(e); }
});

app.get('/api/me', async (req, res, next) => {
  try {
    const row = (await q(`SELECT id,name,contact,interests,theme,created_at,avatar,avatar_url,about,account_type,registered_at,rules_accepted_at FROM clients WHERE id=$1`, [req.clientId])).rows[0];
    const identities = (await q(`SELECT provider, email FROM client_identities WHERE client_id=$1`, [req.clientId])).rows;
    const me = { ...row, identities, rulesAccepted: !!row.rules_accepted_at, avatar: row.avatar ? `/api/files/${row.avatar}` : row.avatar_url || null, avatarId: row.avatar || null, accountType: row.account_type || null, registered: !!(row.name && row.contact && row.account_type) };
    delete me.account_type;
    const regs = (await q(`${EVENT_SQL} WHERE e.id IN (SELECT event_id FROM registrations WHERE client_id=$1) AND e.start_at + (e.duration_min || ' minutes')::interval > now() ORDER BY e.start_at`, [req.clientId])).rows;
    const follows = (await q(`SELECT o.id,o.slug,o.name FROM follows f JOIN organizers o ON o.id=f.organizer_id WHERE f.client_id=$1 ORDER BY o.name`, [req.clientId])).rows;
    const digest = (await q(`SELECT email FROM digest_subscriptions WHERE client_id=$1 LIMIT 1`, [req.clientId])).rows[0]?.email || null;
    const past = (await q(`${EVENT_SQL} WHERE e.id IN (SELECT event_id FROM registrations WHERE client_id=$1) AND e.start_at + (e.duration_min || ' minutes')::interval <= now() AND e.start_at > now() - interval '90 days' ORDER BY e.start_at DESC`, [req.clientId])).rows;
    const orgCount = (await q(`SELECT count(*)::int AS n FROM organizers o WHERE o.created_by=$1 OR EXISTS (SELECT 1 FROM events e WHERE e.organizer_id=o.id AND e.created_by=$1)`, [req.clientId])).rows[0].n;
    const att = (await q(`SELECT ck.event_id, ck.guest_confirmed_at, ck.organizer_confirmed_at, (SELECT rating FROM reviews rv WHERE rv.event_id=ck.event_id AND rv.client_id=ck.client_id) AS my_rating FROM checkins ck WHERE ck.client_id=$1`, [req.clientId])).rows;
    const attMap = Object.fromEntries(att.map(a => [a.event_id, { guest: !!a.guest_confirmed_at, organizer: !!a.organizer_confirmed_at, rating: a.my_rating }]));
    const withAtt = r => ({ ...serialize(r, new Set([r.id])), attendance: attMap[r.id] || { guest: false, organizer: false, rating: null } });
    res.json({ ...me, registrations: regs.map(withAtt), past: past.map(withAtt), follows, digest, isOrganizer: orgCount > 0 });
  } catch (e) { next(e); }
});
app.patch('/api/me', async (req, res, next) => {
  try {
    const { name, contact, interests, theme, about, account_type: at, avatar, accept_rules } = req.body || {};
    if (accept_rules) await q(`UPDATE clients SET rules_accepted_at=COALESCE(rules_accepted_at, now()) WHERE id=$1`, [req.clientId]);
    const accountType = ['person', 'org'].includes(at) ? at : null;
    const me = (await q(`UPDATE clients SET name=COALESCE($2,name), contact=COALESCE($3,contact), interests=COALESCE($4,interests), theme=COALESCE($5,theme), about=COALESCE($6,about), account_type=COALESCE($7,account_type),
                         avatar=CASE WHEN $8::text = 'null' THEN NULL WHEN $8::text IS NULL THEN avatar ELSE $8::uuid END,
                         registered_at=CASE WHEN registered_at IS NULL AND COALESCE($2,name) IS NOT NULL AND COALESCE($3,contact) IS NOT NULL AND COALESCE($7,account_type) IS NOT NULL THEN now() ELSE registered_at END, last_seen=now()
                         WHERE id=$1 RETURNING id,name,contact,interests,theme,about,account_type,avatar,registered_at`,
      [req.clientId, name ?? null, contact ?? null, Array.isArray(interests) ? interests : null, theme ?? null, about != null ? String(about).slice(0, 600) : null, accountType, avatar === null ? 'null' : UUID.test(String(avatar || '')) ? avatar : null])).rows[0];
    if (me.registered_at && name) logEvent(req, 'profile_update', { type: me.account_type });
    res.json({ ...me, avatar: me.avatar ? `/api/files/${me.avatar}` : null, avatarId: me.avatar || null, accountType: me.account_type, registered: !!(me.name && me.contact && me.account_type) });
  } catch (e) { next(e); }
});

app.post('/api/digest', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'bad_email' });
    await q(`INSERT INTO digest_subscriptions(email,client_id) VALUES($1,$2) ON CONFLICT (email) DO UPDATE SET client_id=EXCLUDED.client_id`, [email, req.clientId]);
    res.json({ ok: true, email });
  } catch (e) { next(e); }
});

// ---------- Создание событий: разовые, регулярные (серии) и почасовые слоты ----------
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plusDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function expandDates(first, rec) {
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  if (!rec || !rec.freq || rec.freq === 'none') return [start];
  let until = rec.until && /^\d{4}-\d{2}-\d{2}$/.test(rec.until) ? new Date(rec.until + 'T00:00:00') : plusDays(start, 56);
  const cap = plusDays(start, 183); if (until > cap) until = cap; if (until < start) until = start;
  const wd = Array.isArray(rec.weekdays) && rec.weekdays.length ? rec.weekdays.map(Number).filter(n => n >= 0 && n <= 6) : [start.getDay()];
  const out = [];
  for (let d = new Date(start); d <= until; d = plusDays(d, 1)) {
    const weeks = Math.floor((d - start) / 864e5 / 7);
    if (rec.freq === 'daily') out.push(new Date(d));
    else if (rec.freq === 'weekly' && wd.includes(d.getDay())) out.push(new Date(d));
    else if (rec.freq === 'biweekly' && wd.includes(d.getDay()) && weeks % 2 === 0) out.push(new Date(d));
    else if (rec.freq === 'monthly' && d.getDate() === start.getDate()) out.push(new Date(d));
    if (out.length >= 366) break;
  }
  return out.length ? out : [start];
}

app.post('/api/events', async (req, res, next) => {
  try {
    const b = req.body || {};
    const need = ['title', 'cat', 'date', 'venue', 'organizer', 'lang'];
    for (const k of need) if (!String(b[k] || '').trim()) return res.status(400).json({ error: `missing_${k}` });
    const prof = (await q(`SELECT name, contact, account_type, rules_accepted_at, blocked FROM clients WHERE id=$1`, [req.clientId])).rows[0] || {};
    if (prof.blocked) return res.status(403).json({ error: 'blocked', message: 'Публикация недоступна: аккаунт заблокирован за нарушение правил площадки.' });
    if (!b.rules_ok && !prof.rules_accepted_at) return res.status(400).json({ error: 'rules_required', message: 'Подтвердите, что событие соответствует правилам площадки.' });
    if (b.rules_ok && !prof.rules_accepted_at) await q(`UPDATE clients SET rules_accepted_at=now() WHERE id=$1`, [req.clientId]);
    if (process.env.REQUIRE_PROFILE !== '0' && (!prof.name || !prof.contact || !prof.account_type)) return res.status(403).json({ error: 'profile_required', message: 'Чтобы создавать события, представьтесь в профиле: имя, контакт и тип аккаунта' });
    const bigKind = ['sessions', 'rental', 'groups', 'open'].includes(b.kind);
    const bigSize = Math.max(1, Number(b.capacity) || 50) > 30 || (Array.isArray(b.times) && b.times.length > 1);
    if (process.env.REQUIRE_PROFILE !== '0' && prof.account_type !== 'org' && (bigKind || bigSize)) return res.status(403).json({ error: 'org_required', message: 'Сеансы, прокат, группы, свободное посещение и события больше 30 человек создают организации. Переключите тип аккаунта на «Организация» в профиле — это бесплатно.' });
    const times = [...new Set((Array.isArray(b.times) && b.times.length ? b.times : [b.time]).map(t => String(t || '').trim()).filter(t => /^\d{1,2}:\d{2}$/.test(t)))].sort();
    if (!times.length) return res.status(400).json({ error: 'missing_time' });
    const [y, m, d] = String(b.date).split('-').map(Number);
    const firstDay = new Date(y, m - 1, d);
    if (Number.isNaN(firstDay.getTime())) return res.status(400).json({ error: 'bad_date' });
    const cat = (await q(`SELECT key,emoji FROM categories WHERE key=$1`, [b.cat])).rows[0];
    if (!cat) return res.status(400).json({ error: 'bad_cat' });
    const sub = b.sub ? (await q(`SELECT key,emoji FROM subcategories WHERE key=$1 AND category_key=$2`, [b.sub, b.cat])).rows[0] : null;
    const price = Math.max(0, Number(b.price) || 0);
    const age = [0, 6, 12, 16, 18].includes(Number(b.age)) ? Number(b.age) : 0;
    const withList = (Array.isArray(b.with) && b.with.length ? b.with : ['solo', 'duo', 'friends']).filter(w => !(age >= 16 && w === 'kids'));
    const tags = [];
    if (price === 0) tags.push('бесплатно');
    if (withList.includes('solo')) tags.push('можно одному');
    if (b.lang === 'tt') tags.push('на татарском');
    if (b.lang === 'en') tags.push('на английском');
    if (b.pushkin) tags.push('Пушкинская карта');
    const organizerId = await ensureOrganizer(String(b.organizer).trim(), { created_by: req.clientId, about: b.organizerAbout || null });
    const external = b.registration?.type === 'external' && b.registration?.url;
    const slugBase = slugify(String(b.title)).slice(0, 40) || 'event'; // латинский транслит: ссылки без кириллицы
    const stamp = Date.now().toString(36);
    const dates = expandDates(firstDay, b.recurrence);
    const isSeries = dates.length > 1 || times.length > 1;
    const seriesKey = isSeries ? `u-${slugBase}-${stamp}` : null;
    const kind = KINDS.includes(b.kind) ? b.kind : (isSeries ? 'regular' : 'single');
    const meta = cleanMeta(b.meta);
    const keywords = cleanKeywords(b.keywords);
    const video_url = cleanVideo(b.video_url);
    let created = 0, firstId = null;
    outer: for (const day of dates) {
      for (const t of times) {
        const [hh, mm] = t.split(':').map(Number);
        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm);
        const row = {
          slug: `${slugBase}-${stamp}-${dayKey(day)}-${pad(hh)}${pad(mm)}`, series_key: seriesKey, title: String(b.title).trim().slice(0, 120), category_key: cat.key, subcategory_key: sub?.key || null,
          emoji: sub?.emoji || cat.emoji, start_at: start, duration_min: Math.min(1440, Math.max(15, Number(b.duration) || 120)), price, lang: ['ru', 'tt', 'en'].includes(b.lang) ? b.lang : 'ru',
          venue: String(b.venue).trim(), address: String(b.address || 'адрес уточняется').trim(), district: String(b.district || 'Вахитовский'),
          with_whom: withList, solo: withList.includes('solo'), stol: false,
          registration_type: external ? 'external' : 'here', registration_label: external ? 'по ссылке организатора' : null, registration_url: external ? String(b.registration.url) : null,
          capacity: Math.max(1, Number(b.capacity) || 50), going_base: 0, tags, description: String(b.description || 'Описание появится позже.').slice(0, 4000),
          lat: Number.isFinite(Number(b.lat)) && b.lat !== '' && b.lat != null ? Number(b.lat) : null, lng: Number.isFinite(Number(b.lng)) && b.lng !== '' && b.lng != null ? Number(b.lng) : null,
          ...cleanDesign(b), kind, meta, keywords, video_url, age,
        };
        const id = await insertEvent(row, organizerId, 'user', req.clientId);
        if (id) { created++; if (!firstId) firstId = id; }
        if (created >= 1200) break outer;
      }
    }
    invalidate();
    const { rows } = await q(`${EVENT_SQL} WHERE e.id=$1`, [firstId]);
    const first = serialize(rows[0]);
    // Обогащение тегами «сильной моделью» (сейчас — правила; точка замены на LLM в ai.js)
    // Теги правилами — сразу (ответ не ждёт модель); модель дорабатывает разметку в фоне и перезаписывает её
    const tagSql = seriesKey ? `UPDATE events SET ai_tags=($1::jsonb - 'time') || jsonb_build_object('time', ${TIME_BY_START}) WHERE series_key=$2` : `UPDATE events SET ai_tags=$1 WHERE id=$2`; // время суток у каждого сеанса своё
    try { const tags = tagEvent(first); await q(tagSql, [JSON.stringify(tags), seriesKey || firstId]); first.aiTags = tags; } catch (err) { console.warn('[ai] теги не записаны:', err.message); }
    if (llmEnabled()) tagEventSmart(first).then(t => t?.model ? q(tagSql, [JSON.stringify(t), seriesKey || firstId]).then(invalidate) : null).catch(err => console.warn('[ai] модель не разметила событие:', err.message));
    logEvent(req, 'create_event', { event_id: firstId, kind, created, series: seriesKey });
    res.status(201).json({ created, seriesKey, first, organizerId });
  } catch (e) { next(e); }
});

// ---------- Фото и оформление страницы события ----------
const THEME_KEYS = ['minimal', 'night', 'sunset', 'forest', 'ocean', 'candy', 'paper', 'neon'];
const KINDS = ['single', 'regular', 'sessions', 'rental', 'groups', 'open'];
// Время суток по началу события (по Казани) — для серий, где теги общие, а сеансы в разное время
const TIME_BY_START = "CASE WHEN EXTRACT(HOUR FROM start_at AT TIME ZONE 'Europe/Moscow') >= 22 OR EXTRACT(HOUR FROM start_at AT TIME ZONE 'Europe/Moscow') < 6 THEN 'night' WHEN EXTRACT(HOUR FROM start_at AT TIME ZONE 'Europe/Moscow') < 12 THEN 'morning' WHEN EXTRACT(HOUR FROM start_at AT TIME ZONE 'Europe/Moscow') < 17 THEN 'day' ELSE 'evening' END";
const SLOTTED = new Set(['sessions', 'rental', 'groups']);
function cleanMeta(m) {
  if (!m || typeof m !== 'object') return {};
  const out = {};
  for (const k of ['units', 'group_size', 'groups', 'step', 'seats']) { const v = Number(m[k]); if (Number.isFinite(v) && v > 0) out[k] = Math.round(v); }
  for (const k of ['open_from', 'open_to']) if (typeof m[k] === 'string' && /^\d{1,2}:\d{2}$/.test(m[k])) out[k] = m[k];
  if (typeof m.unit_name === 'string') out.unit_name = m.unit_name.slice(0, 40);
  return out;
}
function cleanVideo(v) {
  if (!v) return null;
  const u = String(v).trim().slice(0, 300);
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|rutube\.ru|vk\.com|vkvideo\.ru|vk\.video)\//i.test(u) ? u : null;
}
function cleanKeywords(k) {
  const arr = Array.isArray(k) ? k : typeof k === 'string' ? k.split(/[,;\n]/) : [];
  return [...new Set(arr.map(x => String(x).trim().toLowerCase()).filter(x => x.length >= 2 && x.length <= 40))].slice(0, 20);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function cleanDesign(b) {
  const out = {};
  if (b.cover === null || b.cover === '') out.cover = null; else if (typeof b.cover === 'string' && UUID.test(b.cover)) out.cover = b.cover;
  if (Array.isArray(b.photos)) out.photos = b.photos.filter(x => typeof x === 'string' && UUID.test(x)).slice(0, 6);
  if (b.theme === null || b.theme === '') out.theme = null; else if (typeof b.theme === 'string' && THEME_KEYS.includes(b.theme)) out.theme = b.theme;
  if (b.accent === null || b.accent === '') out.accent = null; else if (typeof b.accent === 'string' && /^#[0-9a-f]{6}$/i.test(b.accent)) out.accent = b.accent.toLowerCase();
  return out;
}
app.post('/api/upload', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '6mb' }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'no_image', message: 'Пришлите JPEG, PNG или WebP до 6 МБ' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    const id = randomUUID();
    await q(`INSERT INTO files(id,mime,bytes,size,created_by) VALUES($1,$2,$3,$4,$5)`, [id, mime, req.body, req.body.length, req.clientId]);
    res.status(201).json({ id, url: `/api/files/${id}`, size: req.body.length });
  } catch (e) { next(e); }
});
app.get('/api/files/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).end();
    const f = (await q(`SELECT mime, bytes FROM files WHERE id=$1`, [req.params.id])).rows[0];
    if (!f) return res.status(404).end();
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(f.bytes);
  } catch (e) { next(e); }
});
app.patch('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ev = (await q(`SELECT id, series_key, created_by FROM events WHERE id=$1`, [id])).rows[0];
    if (!ev || ev.created_by !== req.clientId) return res.status(403).json({ error: 'forbidden' });
    const b = req.body || {};
    const d = cleanDesign(b);
    const sets = [], vals = [];
    const add = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
    if ('cover' in d) add('cover', d.cover);
    if ('photos' in d) add('photos', d.photos);
    if ('theme' in d) add('theme', d.theme);
    if ('accent' in d) add('accent', d.accent);
    if (typeof b.title === 'string' && b.title.trim()) add('title', b.title.trim().slice(0, 120));
    if (typeof b.description === 'string') add('description', b.description.slice(0, 4000));
    if (b.keywords !== undefined) add('keywords', cleanKeywords(b.keywords));
    if (b.video_url !== undefined) add('video_url', cleanVideo(b.video_url));
    if (b.capacity != null && Number(b.capacity) >= 1) add('capacity', Math.round(Number(b.capacity)));
    if (b.price != null && Number(b.price) >= 0) add('price', Math.round(Number(b.price)));
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    const wholeSeries = String(req.query.series) === '1' && ev.series_key;
    vals.push(req.clientId);
    const where = wholeSeries ? `series_key=$${vals.length + 1} AND created_by=$${vals.length} AND start_at > now()` : `id=$${vals.length + 1} AND created_by=$${vals.length}`;
    vals.push(wholeSeries ? ev.series_key : id);
    const r = await q(`UPDATE events SET ${sets.join(', ')} WHERE ${where} RETURNING id`, vals);
    invalidate();
    const { rows } = await q(`${EVENT_SQL} WHERE e.id=$1`, [id]);
    res.json({ updated: r.rows.length, event: serialize(rows[0]) });
  } catch (e) { next(e); }
});

// ---------- Участие: QR гостя, сканирование организатором, ручное подтверждение ----------
let checkinSecret = null;
async function getSecret() {
  if (checkinSecret) return checkinSecret;
  if (process.env.CHECKIN_SECRET) return (checkinSecret = process.env.CHECKIN_SECRET);
  const r = await q(`SELECT value FROM settings WHERE key='checkin_secret'`);
  if (r.rows.length) return (checkinSecret = r.rows[0].value);
  const v = randomUUID() + randomUUID();
  await q(`INSERT INTO settings(key,value) VALUES('checkin_secret',$1) ON CONFLICT (key) DO NOTHING`, [v]);
  return (checkinSecret = (await q(`SELECT value FROM settings WHERE key='checkin_secret'`)).rows[0].value);
}
const b64u = buf => Buffer.from(buf).toString('base64url');
async function signToken(eventId, clientId, exp) {
  const body = `${eventId}.${clientId}.${exp}`;
  const mac = createHmac('sha256', await getSecret()).update(body).digest();
  return `${b64u(body)}.${b64u(mac)}`;
}
async function verifyToken(token) {
  const [bodyB, macB] = String(token || '').split('.');
  if (!bodyB || !macB) return null;
  const body = Buffer.from(bodyB, 'base64url').toString();
  const mac = createHmac('sha256', await getSecret()).update(body).digest();
  const given = Buffer.from(macB, 'base64url');
  if (given.length !== mac.length || !timingSafeEqual(given, mac)) return null;
  const [eventId, clientId, exp] = body.split('.');
  if (Number(exp) < Date.now()) return null;
  return { eventId: Number(eventId), clientId };
}
function attendanceWindow(row) { // с трёх часов до начала до суток после конца
  const start = new Date(row.start_at).getTime(), end = start + row.duration_min * 60000;
  return { open: Date.now() >= start - 3 * 3600e3 && Date.now() <= end + 24 * 3600e3, ended: Date.now() >= end };
}
app.get('/api/events/:id/qr', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ev = (await q(`SELECT id, title, start_at, duration_min FROM events WHERE id=$1 AND cancelled=false`, [id])).rows[0];
    if (!ev) return res.status(404).json({ error: 'not_found' });
    const reg = (await q(`SELECT 1 FROM registrations WHERE event_id=$1 AND client_id=$2`, [id, req.clientId])).rows.length;
    if (!reg) return res.status(403).json({ error: 'not_registered', message: 'QR доступен только записавшимся' });
    const w = attendanceWindow(ev);
    if (!w.open) return res.status(400).json({ error: 'closed', message: 'QR появится за 3 часа до начала' });
    const exp = new Date(ev.start_at).getTime() + ev.duration_min * 60000 + 24 * 3600e3;
    const token = await signToken(id, req.clientId, exp);
    res.json({ token, url: `${req.protocol}://${req.get('host')}/#/checkin/${token}`, expires: new Date(exp).toISOString() });
  } catch (e) { next(e); }
});
app.post('/api/checkin/:token', async (req, res, next) => {
  try {
    const t = await verifyToken(req.params.token);
    if (!t) return res.status(400).json({ error: 'bad_token', message: 'QR недействителен или устарел' });
    const ev = (await q(`SELECT e.id, e.title, e.organizer_id, e.created_by, e.start_at, e.duration_min FROM events e WHERE e.id=$1`, [t.eventId])).rows[0];
    if (!ev) return res.status(404).json({ error: 'not_found' });
    const owner = ev.created_by === req.clientId || await ownsOrganizer(req.clientId, ev.organizer_id);
    if (!owner) return res.status(403).json({ error: 'not_organizer', message: 'Сканировать QR может только организатор этого события' });
    const guest = (await q(`SELECT name, contact FROM clients WHERE id=$1`, [t.clientId])).rows[0];
    await q(`INSERT INTO checkins(event_id, client_id, guest_confirmed_at, organizer_confirmed_at, method) VALUES($1,$2,now(),now(),'qr')
             ON CONFLICT (event_id, client_id) DO UPDATE SET guest_confirmed_at=COALESCE(checkins.guest_confirmed_at, now()), organizer_confirmed_at=now(), method='qr'`, [ev.id, t.clientId]);
    logEvent(req, 'checkin', { event_id: ev.id, guest: t.clientId, method: 'qr' });
    res.json({ ok: true, event: { id: ev.id, title: ev.title }, guest: { name: guest?.name || 'Гость', contact: guest?.contact || null } });
  } catch (e) { next(e); }
});
// Ручное подтверждение организатором из списка гостей
app.post('/api/events/:id/checkins', async (req, res, next) => {
  try {
    const id = Number(req.params.id); const clientId = String(req.body?.client_id || '');
    const ev = (await q(`SELECT organizer_id, created_by FROM events WHERE id=$1`, [id])).rows[0];
    if (!ev || !(ev.created_by === req.clientId || await ownsOrganizer(req.clientId, ev.organizer_id))) return res.status(403).json({ error: 'forbidden' });
    if (!UUID.test(clientId)) return res.status(400).json({ error: 'bad_client' });
    await q(`INSERT INTO checkins(event_id, client_id, organizer_confirmed_at, method) VALUES($1,$2,now(),'manual')
             ON CONFLICT (event_id, client_id) DO UPDATE SET organizer_confirmed_at=now(), method=COALESCE(checkins.method,'manual')`, [id, clientId]);
    logEvent(req, 'checkin', { event_id: id, guest: clientId, method: 'manual' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// Гость сам подтверждает, что был (вторая половина двойного подтверждения)
app.post('/api/events/:id/attended', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ev = (await q(`SELECT start_at, duration_min FROM events WHERE id=$1`, [id])).rows[0];
    if (!ev) return res.status(404).json({ error: 'not_found' });
    const reg = (await q(`SELECT 1 FROM registrations WHERE event_id=$1 AND client_id=$2`, [id, req.clientId])).rows.length;
    if (!reg) return res.status(403).json({ error: 'not_registered' });
    if (!attendanceWindow(ev).open && !attendanceWindow(ev).ended) return res.status(400).json({ error: 'too_early' });
    await q(`INSERT INTO checkins(event_id, client_id, guest_confirmed_at, method) VALUES($1,$2,now(),'self') ON CONFLICT (event_id, client_id) DO UPDATE SET guest_confirmed_at=now()`, [id, req.clientId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// Отзыв: только после события и только при двойном подтверждении
app.post('/api/events/:id/review', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ev = (await q(`SELECT organizer_id, start_at, duration_min FROM events WHERE id=$1`, [id])).rows[0];
    if (!ev) return res.status(404).json({ error: 'not_found' });
    if (!attendanceWindow(ev).ended) return res.status(400).json({ error: 'not_ended', message: 'Отзыв можно оставить после события' });
    const ck = (await q(`SELECT guest_confirmed_at, organizer_confirmed_at FROM checkins WHERE event_id=$1 AND client_id=$2`, [id, req.clientId])).rows[0];
    if (!ck || !ck.guest_confirmed_at || !ck.organizer_confirmed_at) return res.status(403).json({ error: 'not_confirmed', message: 'Нужно подтверждение участия с обеих сторон' });
    const rating = Math.round(Number(req.body?.rating)); const text = String(req.body?.text || '').trim().slice(0, 1500);
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'bad_rating' });
    await q(`INSERT INTO reviews(event_id, organizer_id, client_id, rating, text) VALUES($1,$2,$3,$4,$5) ON CONFLICT (event_id, client_id) DO UPDATE SET rating=EXCLUDED.rating, text=EXCLUDED.text, created_at=now()`, [id, ev.organizer_id, req.clientId, rating, text || null]);
    invalidate(); logEvent(req, 'review', { event_id: id, rating });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// Другие подтверждённые участники (видно только участнику с подтверждением) и приватная оценка «встретиться снова»
app.get('/api/events/:id/peers', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const me = (await q(`SELECT 1 FROM checkins WHERE event_id=$1 AND client_id=$2 AND guest_confirmed_at IS NOT NULL AND organizer_confirmed_at IS NOT NULL`, [id, req.clientId])).rows.length;
    if (!me) return res.status(403).json({ error: 'not_confirmed' });
    const peers = (await q(`SELECT c.id, c.name, (SELECT value FROM peer_ratings p WHERE p.event_id=ck.event_id AND p.from_client=$2 AND p.to_client=c.id) AS my
      FROM checkins ck JOIN clients c ON c.id=ck.client_id WHERE ck.event_id=$1 AND ck.client_id<>$2 AND ck.guest_confirmed_at IS NOT NULL AND ck.organizer_confirmed_at IS NOT NULL ORDER BY c.name`, [id, req.clientId])).rows;
    res.json({ peers: peers.map((p, i) => ({ id: p.id, name: p.name ? p.name.split(' ')[0] : `Участник ${i + 1}`, my: p.my || 0 })) });
  } catch (e) { next(e); }
});
app.post('/api/events/:id/peers/:client', async (req, res, next) => {
  try {
    const id = Number(req.params.id); const to = String(req.params.client); const value = Number(req.body?.value) === -1 ? -1 : 1;
    if (!UUID.test(to) || to === req.clientId) return res.status(400).json({ error: 'bad_peer' });
    const me = (await q(`SELECT 1 FROM checkins WHERE event_id=$1 AND client_id=$2 AND guest_confirmed_at IS NOT NULL AND organizer_confirmed_at IS NOT NULL`, [id, req.clientId])).rows.length;
    if (!me) return res.status(403).json({ error: 'not_confirmed' });
    await q(`INSERT INTO peer_ratings(event_id, from_client, to_client, value) VALUES($1,$2,$3,$4) ON CONFLICT (event_id, from_client, to_client) DO UPDATE SET value=EXCLUDED.value, created_at=now()`, [id, req.clientId, to, value]);
    const mutual = (await q(`SELECT 1 FROM peer_ratings WHERE event_id=$1 AND from_client=$2 AND to_client=$3 AND value=1`, [id, to, req.clientId])).rows.length > 0 && value === 1;
    res.json({ ok: true, mutual });
  } catch (e) { next(e); }
});

// ---------- ИИ-поиск: разбор фразы (для демонстрации организаторам) ----------
app.get('/api/ai/parse', async (req, res) => {
  const qq = String(req.query.q || '').slice(0, 300);
  res.json({ query: qq, parsed: await parseQuerySmart(qq), rules: parseQuery(qq), llm: llmInfo() });
});
app.get('/api/ai/tags/:slug', async (req, res, next) => {
  try {
    const { rows } = await q(`${EVENT_SQL} WHERE e.slug=$1`, [req.params.slug]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const e = serialize(rows[0]);
    res.json({ stored: e.aiTags, computed: tagEvent(e) });
  } catch (e) { next(e); }
});

// ---------- Кабинет организатора ----------
async function ownsOrganizer(clientId, organizerId) {
  const r = await q(`SELECT 1 FROM organizers o WHERE o.id=$2 AND (o.created_by=$1 OR EXISTS (SELECT 1 FROM events e WHERE e.organizer_id=o.id AND e.created_by=$1) OR EXISTS (SELECT 1 FROM organizer_members m WHERE m.organizer_id=o.id AND m.client_id=$1)) LIMIT 1`, [clientId, organizerId]);
  return r.rows.length > 0;
}
const cleanStr = (v, n) => v == null ? null : String(v).trim().slice(0, n) || null;
// Кабинет: организации, где клиент — создатель, автор событий или участник команды
app.get('/api/cabinet', async (req, res, next) => {
  try {
    const orgs = (await q(`SELECT o.* FROM organizers o WHERE o.created_by=$1 OR EXISTS (SELECT 1 FROM events e WHERE e.organizer_id=o.id AND e.created_by=$1) OR EXISTS (SELECT 1 FROM organizer_members m WHERE m.organizer_id=o.id AND m.client_id=$1) ORDER BY o.name`, [req.clientId]).catch(() => ({ rows: [] }))).rows;
    const out = [];
    for (const o of orgs) {
      const events = (await q(`${EVENT_SQL} WHERE e.organizer_id=$1 AND e.cancelled=false AND e.start_at + (e.duration_min || ' minutes')::interval > now() ORDER BY e.start_at LIMIT 400`, [o.id])).rows.map(r => serialize(r));
      const past = (await q(`${EVENT_SQL} WHERE e.organizer_id=$1 AND e.cancelled=false AND e.start_at + (e.duration_min || ' minutes')::interval <= now() AND e.start_at > now() - interval '30 days' ORDER BY e.start_at DESC LIMIT 100`, [o.id])).rows.map(r => serialize(r));
      const stats = await orgStats(o.id);
      const act = (await q(`SELECT
          count(*) FILTER (WHERE ce.name='event_view' AND ce.ts > now() - interval '7 days')::int AS views7,
          count(*) FILTER (WHERE ce.name='event_view' AND ce.ts > now() - interval '30 days')::int AS views30,
          count(*) FILTER (WHERE ce.name='card_click' AND ce.ts > now() - interval '7 days')::int AS clicks7,
          count(*) FILTER (WHERE ce.name='card_click' AND ce.ts > now() - interval '30 days')::int AS clicks30
        FROM client_events ce JOIN events e ON (ce.props->>'event_id') ~ '^[0-9]+$' AND e.id=(ce.props->>'event_id')::int WHERE e.organizer_id=$1 AND ce.ts > now() - interval '30 days'`, [o.id])).rows[0];
      const regs = (await q(`SELECT count(*) FILTER (WHERE r.created_at > now() - interval '7 days')::int AS regs7, count(*) FILTER (WHERE r.created_at > now() - interval '30 days')::int AS regs30 FROM registrations r JOIN events e ON e.id=r.event_id WHERE e.organizer_id=$1`, [o.id])).rows[0];
      const orgViews = (await q(`SELECT count(*)::int AS n FROM client_events WHERE name='org_view' AND (props->>'organizer_id')::int=$1 AND ts > now() - interval '30 days'`, [o.id]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
      const daily = (await q(`SELECT d::date AS day,
          (SELECT count(*) FROM client_events ce JOIN events e ON (ce.props->>'event_id') ~ '^[0-9]+$' AND e.id=(ce.props->>'event_id')::int WHERE e.organizer_id=$1 AND ce.name IN ('event_view','card_click') AND ce.ts::date = d::date)::int AS views,
          (SELECT count(*) FROM registrations r JOIN events e ON e.id=r.event_id WHERE e.organizer_id=$1 AND r.created_at::date = d::date)::int AS regs
        FROM generate_series(now()::date - 13, now()::date, interval '1 day') d ORDER BY 1`, [o.id])).rows.map(r => ({ day: isoDate(r.day), views: r.views, regs: r.regs }));
      const perEvent = (await q(`SELECT e.id, count(*) FILTER (WHERE ce.name='event_view')::int AS views, count(*) FILTER (WHERE ce.name='card_click')::int AS clicks FROM client_events ce JOIN events e ON (ce.props->>'event_id') ~ '^[0-9]+$' AND e.id=(ce.props->>'event_id')::int WHERE e.organizer_id=$1 AND ce.ts > now() - interval '30 days' GROUP BY e.id`, [o.id])).rows;
      const counters = Object.fromEntries(perEvent.map(r => [r.id, { views: r.views, clicks: r.clicks }]));
      const promotions = (await q(`SELECT * FROM promotions WHERE organizer_id=$1 ORDER BY created_at DESC LIMIT 30`, [o.id])).rows.map(pr => ({ id: pr.id, target: pr.target, targetId: pr.target_id, type: pr.type, days: pr.days, price: pr.price, erid: pr.erid, boostTerms: pr.boost_terms || [], startsAt: pr.starts_at, endsAt: pr.ends_at, status: pr.ends_at && new Date(pr.ends_at) < new Date() ? 'ended' : pr.status }));
      const members = (await q(`SELECT m.client_id, m.role, m.created_at, c.name FROM organizer_members m LEFT JOIN clients c ON c.id=m.client_id WHERE m.organizer_id=$1 ORDER BY m.created_at`, [o.id])).rows.map(m => ({ clientId: m.client_id, role: m.role, name: m.name || 'Без имени', me: m.client_id === req.clientId }));
      out.push({ organizer: { ...orgPublic(o), mine: o.created_by === req.clientId, balance: o.balance ?? DEMO_BALANCE, inviteCode: o.created_by === req.clientId ? o.invite_code : null, followers: stats.followers, rating: stats.rating, reviews: stats.reviews, promotedUntil: o.promoted_until },
        stats: { ...stats, ...act, ...regs, orgViews30: orgViews }, daily, counters, events: events.map(e => ({ ...e, mine: e.createdBy === req.clientId, counters: counters[e.id] || { views: 0, clicks: 0 } })), past, promotions, members });
    }
    res.json({ organizers: out, kinds: ORG_KINDS, products: PROMO_PRODUCTS });
  } catch (e) { next(e); }
});
// Создать организацию без события (как карточку продавца)
app.post('/api/organizers', async (req, res, next) => {
  try {
    const name = cleanStr(req.body?.name, 80); if (!name) return res.status(400).json({ error: 'missing_name' });
    const kind = ORG_KINDS[req.body?.kind] ? req.body.kind : 'community';
    const exists = (await q(`SELECT id, created_by FROM organizers WHERE lower(name)=lower($1)`, [name])).rows[0];
    if (exists && exists.created_by && exists.created_by !== req.clientId) return res.status(409).json({ error: 'taken', message: 'Организация с таким названием уже есть. Попросите владельца код приглашения.' });
    const id = exists ? exists.id : await ensureOrganizer(name, { created_by: req.clientId, about: cleanStr(req.body?.about, 4000) });
    await q(`UPDATE organizers SET kind=$2, created_by=COALESCE(created_by,$3), balance=COALESCE(balance,$4) WHERE id=$1`, [id, kind, req.clientId, DEMO_BALANCE]);
    logEvent(req, 'org_create', { organizer_id: id, kind });
    const o = (await q(`SELECT * FROM organizers WHERE id=$1`, [id])).rows[0];
    res.status(201).json(orgPublic(o));
  } catch (e) { next(e); }
});
app.patch('/api/organizers/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await ownsOrganizer(req.clientId, id))) return res.status(403).json({ error: 'forbidden' });
    const b = req.body || {};
    const fields = { about: cleanStr(b.about, 4000), website: cleanStr(b.website, 200), contact: cleanStr(b.contact, 200), phone: cleanStr(b.phone, 40), telegram: cleanStr(b.telegram, 80), vk: cleanStr(b.vk, 120), address: cleanStr(b.address, 200), hours: cleanStr(b.hours, 200),
      kind: ORG_KINDS[b.kind] ? b.kind : undefined, lat: Number.isFinite(Number(b.lat)) && b.lat !== null && b.lat !== '' ? Number(b.lat) : undefined, lng: Number.isFinite(Number(b.lng)) && b.lng !== null && b.lng !== '' ? Number(b.lng) : undefined,
      logo: b.logo === null ? null : UUID.test(String(b.logo || '')) ? b.logo : undefined, cover: b.cover === null ? null : UUID.test(String(b.cover || '')) ? b.cover : undefined };
    if (b.announcement === null) fields.announcement = null;
    else if (b.announcement && typeof b.announcement === 'object') fields.announcement = JSON.stringify({ title: cleanStr(b.announcement.title, 120), text: cleanStr(b.announcement.text, 600), from: cleanStr(b.announcement.from, 10), until: cleanStr(b.announcement.until, 10) });
    const sets = [], vals = [id];
    for (const [k, v] of Object.entries(fields)) { if (v === undefined) continue; if (!(k in b)) continue; vals.push(v); sets.push(`${k}=$${vals.length}`); }
    if (sets.length) await q(`UPDATE organizers SET ${sets.join(', ')} WHERE id=$1`, vals);
    invalidate();
    const o = (await q(`SELECT * FROM organizers WHERE id=$1`, [id])).rows[0];
    res.json(orgPublic(o));
  } catch (e) { next(e); }
});
// Команда: владелец выдаёт код, коллеги вступают по коду
app.post('/api/organizers/:id/invite', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const o = (await q(`SELECT created_by, invite_code FROM organizers WHERE id=$1`, [id])).rows[0];
    if (!o || o.created_by !== req.clientId) return res.status(403).json({ error: 'forbidden', message: 'Код выдаёт владелец организации' });
    const code = req.body?.rotate || !o.invite_code ? randomBytes(4).toString('hex') : o.invite_code;
    await q(`UPDATE organizers SET invite_code=$2 WHERE id=$1`, [id, code]);
    res.json({ code });
  } catch (e) { next(e); }
});
app.post('/api/organizers/join', async (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim().toLowerCase();
    if (!/^[a-f0-9]{8}$/.test(code)) return res.status(400).json({ error: 'bad_code', message: 'Код — 8 символов из приглашения' });
    const o = (await q(`SELECT id, name, slug FROM organizers WHERE invite_code=$1`, [code])).rows[0];
    if (!o) return res.status(404).json({ error: 'not_found', message: 'Код не подошёл' });
    await q(`INSERT INTO organizer_members(organizer_id, client_id, role) VALUES($1,$2,'manager') ON CONFLICT DO NOTHING`, [o.id, req.clientId]);
    logEvent(req, 'org_join', { organizer_id: o.id });
    res.json({ ok: true, organizer: { id: o.id, name: o.name, slug: o.slug } });
  } catch (e) { next(e); }
});
app.delete('/api/organizers/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const o = (await q(`SELECT created_by, name FROM organizers WHERE id=$1`, [id])).rows[0];
    if (!o || o.created_by !== req.clientId) return res.status(403).json({ error: 'forbidden', message: 'Удалить организацию может только владелец' });
    await q(`DELETE FROM promotions WHERE organizer_id=$1`, [id]);
    await q(`DELETE FROM organizer_members WHERE organizer_id=$1`, [id]);
    await q(`DELETE FROM follows WHERE organizer_id=$1`, [id]);
    await q(`DELETE FROM reviews WHERE organizer_id=$1`, [id]);
    await q(`DELETE FROM events WHERE organizer_id=$1`, [id]);
    await q(`DELETE FROM organizers WHERE id=$1`, [id]);
    invalidate(); logEvent(req, 'org_delete', { organizer_id: id, name: o.name });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.delete('/api/organizers/:id/members/:client', async (req, res, next) => {
  try {
    const id = Number(req.params.id); const client = String(req.params.client);
    const o = (await q(`SELECT created_by FROM organizers WHERE id=$1`, [id])).rows[0];
    if (!o || (o.created_by !== req.clientId && client !== req.clientId)) return res.status(403).json({ error: 'forbidden' });
    await q(`DELETE FROM organizer_members WHERE organizer_id=$1 AND client_id=$2`, [id, client]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// Продвижение: списываем с демо-баланса, ставим метки; реклама требует erid из ОРД
app.post('/api/organizers/:id/promote', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!(await ownsOrganizer(req.clientId, id))) return res.status(403).json({ error: 'forbidden' });
    const { type, targetId, erid } = req.body || {};
    const prod = PROMO_PRODUCTS[type]; if (!prod) return res.status(400).json({ error: 'bad_type' });
    const days = Math.max(1, Math.min(60, Math.round(Number(req.body?.days) || 7)));
    const price = prod.price * days;
    const terms = [...new Set((Array.isArray(req.body?.boostTerms) ? req.body.boostTerms : String(req.body?.boostTerms || '').split(/[,;\n]/)).map(x => String(x).trim().toLowerCase()).filter(x => x.length >= 2 && x.length <= 30))].slice(0, 5);
    if (type !== 'boost' && !/^[A-Za-z0-9]{6,40}$/.test(String(erid || ''))) return res.status(400).json({ error: 'erid_required', message: 'Для рекламы нужен erid — токен маркировки из ОРД (например, 2VtzqxABC123)' });
    if (type === 'boost' && !terms.length) return res.status(400).json({ error: 'terms_required', message: 'Укажите хотя бы одно слово' });
    const org = (await q(`SELECT balance FROM organizers WHERE id=$1`, [id])).rows[0];
    const balance = org.balance ?? DEMO_BALANCE;
    if (balance < price) return res.status(402).json({ error: 'no_balance', message: `Недостаточно средств: нужно ${price} ₽, на демо-балансе ${balance} ₽` });
    const until = `now() + interval '${days} days'`;
    if (type === 'event') { const r = await q(`UPDATE events SET promoted_until=GREATEST(COALESCE(promoted_until, now()), now()) + interval '${days} days', erid=$3 WHERE id=$1 AND organizer_id=$2 RETURNING id`, [Number(targetId), id, erid]); if (!r.rowCount) return res.status(404).json({ error: 'not_found' }); }
    else if (type === 'series') { const r = await q(`UPDATE events SET promoted_until=GREATEST(COALESCE(promoted_until, now()), now()) + interval '${days} days', erid=$3 WHERE series_key=$1 AND organizer_id=$2 AND start_at > now() RETURNING id`, [String(targetId), id, erid]); if (!r.rowCount) return res.status(404).json({ error: 'not_found' }); }
    else if (type === 'org') await q(`UPDATE organizers SET promoted_until=GREATEST(COALESCE(promoted_until, now()), now()) + interval '${days} days', erid=$2 WHERE id=$1`, [id, erid]);
    else if (type === 'boost') { const r = await q(`UPDATE events SET boost_terms=$3 WHERE organizer_id=$2 AND (series_key=$1 OR id::text=$1) AND start_at > now() RETURNING id`, [String(targetId), id, terms]); if (!r.rowCount) return res.status(404).json({ error: 'not_found' }); }
    await q(`UPDATE organizers SET balance=$2 WHERE id=$1`, [id, balance - price]);
    const pr = (await q(`INSERT INTO promotions(organizer_id, target, target_id, type, days, price, erid, boost_terms, ends_at, created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,${until},$9) RETURNING *`, [id, type === 'org' ? 'org' : type === 'series' || (type === 'boost' && !/^\d+$/.test(String(targetId))) ? 'series' : 'event', String(targetId || id), type, days, price, type === 'boost' ? null : erid, type === 'boost' ? terms : null, req.clientId])).rows[0];
    invalidate(); logEvent(req, 'promote', { organizer_id: id, type, days, price });
    res.status(201).json({ ok: true, balance: balance - price, promotion: { id: pr.id, type, days, price, endsAt: pr.ends_at } });
  } catch (e) { next(e); }
});
app.delete('/api/promotions/:id', async (req, res, next) => {
  try {
    const pr = (await q(`SELECT * FROM promotions WHERE id=$1`, [Number(req.params.id)])).rows[0];
    if (!pr || !(await ownsOrganizer(req.clientId, pr.organizer_id))) return res.status(403).json({ error: 'forbidden' });
    if (pr.type === 'org') await q(`UPDATE organizers SET promoted_until=now() WHERE id=$1`, [pr.organizer_id]);
    else if (pr.type === 'boost') await q(`UPDATE events SET boost_terms='{}' WHERE organizer_id=$1 AND (series_key=$2 OR id::text=$2)`, [pr.organizer_id, pr.target_id]);
    else await q(`UPDATE events SET promoted_until=now() WHERE organizer_id=$1 AND (series_key=$2 OR id::text=$2)`, [pr.organizer_id, pr.target_id]);
    await q(`UPDATE promotions SET status='cancelled', ends_at=now() WHERE id=$1`, [pr.id]);
    invalidate();
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// Пауза объявления: скрыто из поиска, записи сохраняются
app.post('/api/events/:id/pause', async (req, res, next) => {
  try {
    const id = Number(req.params.id); const paused = req.body?.paused !== false; const series = req.query.series === '1';
    const ev = (await q(`SELECT organizer_id, created_by, series_key FROM events WHERE id=$1`, [id])).rows[0];
    if (!ev || !(ev.created_by === req.clientId || await ownsOrganizer(req.clientId, ev.organizer_id))) return res.status(403).json({ error: 'forbidden' });
    const r = series && ev.series_key ? await q(`UPDATE events SET paused=$2 WHERE series_key=$1 AND start_at > now() RETURNING id`, [ev.series_key, paused]) : await q(`UPDATE events SET paused=$2 WHERE id=$1 RETURNING id`, [id, paused]);
    invalidate(); logEvent(req, paused ? 'pause' : 'unpause', { event_id: id, series: series ? ev.series_key : null, n: r.rowCount });
    res.json({ ok: true, paused, affected: r.rowCount });
  } catch (e) { next(e); }
});
app.get('/api/events/:id/guests', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const ev = (await q(`SELECT organizer_id, created_by FROM events WHERE id=$1`, [id])).rows[0];
    if (!ev) return res.status(404).json({ error: 'not_found' });
    if (ev.created_by !== req.clientId && !(await ownsOrganizer(req.clientId, ev.organizer_id))) return res.status(403).json({ error: 'forbidden' });
    const guests = (await q(`SELECT c.id AS client_id, c.name, COALESCE(r.contact, c.contact) AS contact, r.created_at, r.external, ck.guest_confirmed_at, ck.organizer_confirmed_at FROM registrations r JOIN clients c ON c.id=r.client_id LEFT JOIN checkins ck ON ck.event_id=r.event_id AND ck.client_id=r.client_id WHERE r.event_id=$1 ORDER BY r.created_at`, [id])).rows;
    res.json({ guests: guests.map((g, i) => ({ clientId: g.client_id, name: g.name || `Гость ${i + 1}`, contact: g.contact || null, at: g.created_at, external: g.external, guestConfirmed: !!g.guest_confirmed_at, organizerConfirmed: !!g.organizer_confirmed_at })) });
  } catch (e) { next(e); }
});
app.delete('/api/events/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const r = await q(`UPDATE events SET cancelled=true WHERE id=$1 AND created_by=$2 RETURNING id`, [id, req.clientId]);
    if (!r.rows.length) return res.status(403).json({ error: 'forbidden' });
    invalidate();
    res.json({ cancelled: 1 });
  } catch (e) { next(e); }
});
app.delete('/api/series/:key', async (req, res, next) => {
  try {
    const r = await q(`UPDATE events SET cancelled=true WHERE series_key=$1 AND created_by=$2 AND start_at > now() RETURNING id`, [req.params.key, req.clientId]);
    invalidate();
    res.json({ cancelled: r.rows.length });
  } catch (e) { next(e); }
});

mountGrowth(app, { q, EVENT_SQL, serialize, PUBLIC, PORT });
app.get('/api/config', (req, res) => {
  res.json({ city: 'Казань', brand: 'Айдагез', yandexMapsKey: process.env.YANDEX_MAPS_KEY || '', orgKinds: ORG_KINDS, promoProducts: PROMO_PRODUCTS, demoBalance: DEMO_BALANCE, authProviders: authProviders() });
});

app.get('/api/health', async (req, res) => {
  const n = (await q(`SELECT count(*)::int AS n FROM events`)).rows[0].n;
  res.json({ ok: true, events: n, db: DATABASE_URL.replace(/:\/\/.*@/, '://***@'), llm: llmInfo() });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'server_error', message: err.message });
});

// ---------- Запуск ----------
const reseed = process.argv.includes('--reseed');
try {
  await migrate();
  await q(GROWTH_SQL);
  const { inserted } = await ensureSeed({ reseed });
  console.log(`[db] ${DATABASE_URL.replace(/:\/\/.*@/, '://***@')} — готово, добавлено событий: ${inserted}`);
  app.listen(PORT, () => console.log(`[web] http://localhost:${PORT}`));
  // Фоновое обогащение: базовые обложки и ИИ-теги для событий без них
  setTimeout(async () => {
    try {
      let n = 0;
      for (let pass = 0; pass < 30; pass++) { // порциями, пока не останется событий со старой версией разметки
        const { rows } = await q(`${EVENT_SQL} WHERE (e.ai_tags = '{}'::jsonb OR COALESCE((e.ai_tags->>'v')::int, 0) < ${TAG_VERSION}) AND e.start_at > now() - interval '1 day' LIMIT 1000`);
        if (!rows.length) break;
        for (const r of rows) { const e = serialize(r); await q(`UPDATE events SET ai_tags=$1 WHERE id=$2`, [JSON.stringify(tagEvent(e)), e.id]); n++; }
        invalidate();
      }
      if (n) console.log(`[ai] тегов записано: ${n}`);
    } catch (err) { console.warn('[ai] ошибка тегирования:', err.message); }
    if (llmEnabled() && process.env.LLM_RETAG !== '0') {
      try {
        const groups = (await q(`SELECT COALESCE(series_key, slug) AS grp, min(id) AS id FROM events WHERE start_at > now() AND cancelled = false AND (ai_tags->>'model') IS NULL GROUP BY 1 ORDER BY 2 LIMIT 400`)).rows;
        let n = 0;
        for (const g of groups) {
          const { rows } = await q(`${EVENT_SQL} WHERE e.id=$1`, [g.id]); if (!rows.length) continue;
          const tags = await tagEventSmart(serialize(rows[0])); if (!tags.model) continue;
          await q(`UPDATE events SET ai_tags=($1::jsonb - 'time') || jsonb_build_object('time', ${TIME_BY_START}) WHERE COALESCE(series_key, slug)=$2`, [JSON.stringify(tags), g.grp]); n++;
        }
        if (n) { console.log(`[ai] серий размечено моделью ${llmInfo().strong}: ${n}`); invalidate(); }
      } catch (err) { console.warn('[ai] ошибка разметки моделью:', err.message); }
    }
    if (process.env.SEED_PHOTOS !== '0') {
      try { let total = 0; for (let pass = 0; pass < 6; pass++) { const n = await ensurePhotos({ limit: 120 }); total += n; if (n) invalidate(); if (n < 100) break; } if (total) console.log(`[photos] загружено обложек: ${total}`); } catch (err) { console.warn('[photos] ошибка:', err.message); }
    }
  }, 1500);
} catch (e) {
  console.error('[db] не удалось подключиться к PostgreSQL:', e.message);
  console.error('      запустите базу: docker compose up -d  (или задайте DATABASE_URL)');
  process.exit(1);
}
