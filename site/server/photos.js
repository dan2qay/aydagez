// Базовые обложки из бесплатной библиотеки (LoremFlickr, снимки Flickr под CC) — по ключевому слову подкатегории.
// Загружаем один раз на серию, кладём в таблицу files, чтобы отдавать со своего сервера. Запускается фоном после старта.
import { q } from './db.js';
import { randomUUID } from 'node:crypto';

const KEYWORDS = {
  run: 'running,park', yoga: 'yoga', skate: 'ice,skating', team: 'football', walk: 'bicycle,city', climb: 'climbing,wall',
  quiz: 'pub,quiz', board: 'boardgame', chess: 'chess', mafia: 'cards,game',
  stol: 'dinner,friends', lang: 'conversation,cafe', dating: 'cafe,couple', networking: 'meeting,people', newcomers: 'friends,city',
  concert: 'concert', jazz: 'jazz', party: 'party,dj', classical: 'orchestra', market: 'vinyl,records',
  lecture: 'lecture', it: 'coding,laptop', book: 'books', workshop: 'pottery', theatre: 'theatre', standup: 'microphone,comedy', cinema: 'cinema', exhibition: 'art,gallery', tour: 'kazan,architecture',
};
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return Math.abs(h >>> 0); };

const UA = 'aydagez-seed/1.0 (+https://aydagez.ru; dev@aydagez.ru)';
async function fetchImage(url, timeoutMs = 12000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const mime = (r.headers.get('content-type') || '').split(';')[0];
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 5000 ? { buf, mime } : null;
  } catch { return null; } finally { clearTimeout(t); }
}
async function fetchJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}

// Источники по очереди: LoremFlickr (CC-снимки Flickr по слову) → Викисклад (CC, поиск по слову, превью 1200px)
// → Openverse (агрегатор CC) → Picsum (качественные фото без темы, последний запасной вариант).
const SOURCES = [
  async (kw, seed) => { const img = await fetchImage(`https://loremflickr.com/1200/750/${encodeURIComponent(kw)}?lock=${seed % 1000}`); return img && { ...img, source: 'loremflickr' }; },
  async (kw, seed) => {
    const words = kw.split(',').join(' ');
    const j = await fetchJson(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent('filetype:bitmap ' + words)}&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=1200&format=json`);
    const pages = Object.values(j?.query?.pages || {}).filter(p => /jpeg|png/.test(p.imageinfo?.[0]?.mime || '') && p.imageinfo[0].thumburl).sort((a, b) => a.index - b.index);
    if (!pages.length) return null;
    const p = pages[seed % pages.length]; const info = p.imageinfo[0];
    const img = await fetchImage(info.thumburl); if (!img) return null;
    const meta = info.extmetadata || {};
    return { ...img, source: `commons:${p.title} | ${(meta.LicenseShortName?.value || 'CC')} | ${(meta.Artist?.value || '').replace(/<[^>]+>/g, '').slice(0, 80)}` };
  },
  async (kw, seed) => {
    const j = await fetchJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(kw.split(',')[0])}&license_type=commercial&page_size=12&mature=false`);
    const list = (j?.results || []).filter(x => x.url); if (!list.length) return null;
    const x = list[seed % list.length];
    const img = await fetchImage(x.url) || await fetchImage(x.thumbnail); if (!img) return null;
    return { ...img, source: `openverse:${x.foreign_landing_url || x.id} | ${x.license} | ${x.creator || ''}`.slice(0, 200) };
  },
  async (kw, seed) => { const img = await fetchImage(`https://picsum.photos/seed/${encodeURIComponent(kw.split(',')[0] + '-' + seed)}/1200/750`); return img && { ...img, source: 'picsum' }; },
];
async function pickImage(kw, seed) {
  for (const src of SOURCES) { try { const img = await src(kw, seed); if (img) return img; } catch {} }
  return null;
}

// Заполняет обложки у событий без фото: группами по series_key (или по slug для разовых). Возвращает число загруженных картинок.
export async function ensurePhotos({ limit = 80, concurrency = 3 } = {}) {
  const { rows } = await q(`SELECT COALESCE(series_key, slug) AS grp, min(subcategory_key) AS sub, min(category_key) AS cat, count(*)::int AS n
    FROM events WHERE cover IS NULL AND cancelled = false AND start_at > now() - interval '1 day' GROUP BY 1 ORDER BY n DESC LIMIT $1`, [limit]);
  if (!rows.length) return 0;
  let done = 0, idx = 0;
  const worker = async () => {
    while (idx < rows.length) {
      const g = rows[idx++];
      const kw = KEYWORDS[g.sub] || { sport: 'sport', games: 'game', social: 'friends', music: 'music', knowledge: 'lecture', culture: 'theatre' }[g.cat] || 'city';
      const img = await pickImage(kw, hash(g.grp));
      if (!img) continue;
      const id = randomUUID();
      await q(`INSERT INTO files(id,mime,bytes,size,created_by,source) VALUES($1,$2,$3,$4,NULL,$5)`, [id, img.mime, img.buf, img.buf.length, img.source || null]);
      await q(`UPDATE events SET cover=$1 WHERE cover IS NULL AND COALESCE(series_key, slug)=$2`, [id, g.grp]);
      done++;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return done;
}
