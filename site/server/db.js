// PostgreSQL: подключение, схема, сидирование.
import pg from 'pg';
import { CATEGORIES, ORGANIZERS, generateSeries, generateOneOffs } from './seed.js';
import { VENUES } from './venues.js';
import { generateExtra, EXTRA_ORGANIZERS, EXTRA_SERIES } from './seed_extra.js';
import { SUB_AGE } from './seed_kids.js';

const { Pool } = pg;
export const DATABASE_URL = process.env.DATABASE_URL || 'postgres://aidaem:aidaem@localhost:5433/aidaem';
const needSsl = process.env.PGSSL === 'require' || /sslmode=require/.test(DATABASE_URL) || (/railway\.app|rlwy\.net/.test(DATABASE_URL) && !/\.internal/.test(DATABASE_URL));
export const pool = new Pool({ connectionString: DATABASE_URL, max: 8, ssl: needSsl ? { rejectUnauthorized: false } : undefined });
export const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categories (
  key text PRIMARY KEY, title text NOT NULL, emoji text, sort int DEFAULT 0
);
CREATE TABLE IF NOT EXISTS subcategories (
  key text PRIMARY KEY, category_key text NOT NULL REFERENCES categories(key),
  title text NOT NULL, emoji text, keywords text[] DEFAULT '{}', sort int DEFAULT 0
);
CREATE TABLE IF NOT EXISTS organizers (
  id serial PRIMARY KEY, slug text UNIQUE NOT NULL, name text UNIQUE NOT NULL,
  about text, website text, created_by uuid, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  id serial PRIMARY KEY, slug text UNIQUE NOT NULL, series_key text,
  title text NOT NULL, category_key text REFERENCES categories(key), subcategory_key text REFERENCES subcategories(key),
  emoji text, start_at timestamptz NOT NULL, duration_min int DEFAULT 120, price int DEFAULT 0, lang text DEFAULT 'ru',
  venue text, address text, district text, organizer_id int REFERENCES organizers(id),
  with_whom text[] DEFAULT '{}', solo boolean DEFAULT false, stol boolean DEFAULT false,
  registration_type text DEFAULT 'here', registration_label text, registration_url text,
  capacity int DEFAULT 50, going_base int DEFAULT 0, tags text[] DEFAULT '{}', description text,
  source text DEFAULT 'seed', created_by uuid, created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_start_idx ON events(start_at);
CREATE INDEX IF NOT EXISTS events_cat_idx ON events(category_key, subcategory_key);
CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY, name text, contact text, interests text[] DEFAULT '{}', theme text,
  created_at timestamptz DEFAULT now(), last_seen timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS registrations (
  id serial PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), event_id int NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact text, external boolean DEFAULT false, created_at timestamptz DEFAULT now(), UNIQUE(client_id, event_id)
);
CREATE TABLE IF NOT EXISTS follows (
  client_id uuid NOT NULL REFERENCES clients(id), organizer_id int NOT NULL REFERENCES organizers(id),
  created_at timestamptz DEFAULT now(), PRIMARY KEY (client_id, organizer_id)
);
CREATE TABLE IF NOT EXISTS digest_subscriptions (
  email text PRIMARY KEY, client_id uuid, created_at timestamptz DEFAULT now()
);
ALTER TABLE events ADD COLUMN IF NOT EXISTS lat double precision, ADD COLUMN IF NOT EXISTS lng double precision;
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS contact text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS cover uuid, ADD COLUMN IF NOT EXISTS photos uuid[] DEFAULT '{}', ADD COLUMN IF NOT EXISTS theme text, ADD COLUMN IF NOT EXISTS accent text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS kind text, ADD COLUMN IF NOT EXISTS meta jsonb DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS keywords text[] DEFAULT '{}';
ALTER TABLE events ADD COLUMN IF NOT EXISTS video_url text, ADD COLUMN IF NOT EXISTS promoted_until timestamptz, ADD COLUMN IF NOT EXISTS erid text,
  ADD COLUMN IF NOT EXISTS boost_terms text[] DEFAULT '{}', ADD COLUMN IF NOT EXISTS ai_tags jsonb DEFAULT '{}'::jsonb;
ALTER TABLE search_log ADD COLUMN IF NOT EXISTS filters jsonb DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS session_id uuid, ADD COLUMN IF NOT EXISTS mode text;
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz DEFAULT now());
-- Аналитика и маркетинг: сессии и действия клиентов
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY, client_id uuid, started_at timestamptz DEFAULT now(), last_seen timestamptz DEFAULT now(),
  ua text, device text, lang text, referrer text, landing text, utm jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS sessions_client_idx ON sessions(client_id, started_at);
CREATE TABLE IF NOT EXISTS client_events (
  id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), client_id uuid, session_id uuid, name text NOT NULL,
  props jsonb DEFAULT '{}'::jsonb, path text, source text DEFAULT 'web'
);
CREATE INDEX IF NOT EXISTS client_events_ts_idx ON client_events(ts);
CREATE INDEX IF NOT EXISTS client_events_name_idx ON client_events(name, ts);
CREATE INDEX IF NOT EXISTS client_events_client_idx ON client_events(client_id, ts);
-- Участие и отзывы
CREATE TABLE IF NOT EXISTS checkins (
  id serial PRIMARY KEY, event_id int NOT NULL REFERENCES events(id) ON DELETE CASCADE, client_id uuid NOT NULL REFERENCES clients(id),
  guest_confirmed_at timestamptz, organizer_confirmed_at timestamptz, method text, UNIQUE(event_id, client_id)
);
CREATE TABLE IF NOT EXISTS reviews (
  id serial PRIMARY KEY, event_id int NOT NULL REFERENCES events(id) ON DELETE CASCADE, organizer_id int REFERENCES organizers(id),
  client_id uuid NOT NULL REFERENCES clients(id), rating int NOT NULL CHECK (rating BETWEEN 1 AND 5), text text, created_at timestamptz DEFAULT now(), UNIQUE(event_id, client_id)
);
CREATE INDEX IF NOT EXISTS reviews_org_idx ON reviews(organizer_id);
CREATE TABLE IF NOT EXISTS peer_ratings (
  id serial PRIMARY KEY, event_id int NOT NULL REFERENCES events(id) ON DELETE CASCADE, from_client uuid NOT NULL, to_client uuid NOT NULL,
  value int NOT NULL CHECK (value IN (-1, 1)), created_at timestamptz DEFAULT now(), UNIQUE(event_id, from_client, to_client)
);
CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY, mime text NOT NULL, bytes bytea NOT NULL, size int NOT NULL, created_by uuid, created_at timestamptz DEFAULT now()
);
ALTER TABLE events ADD COLUMN IF NOT EXISTS cancelled boolean DEFAULT false;
ALTER TABLE files ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS kind text, ADD COLUMN IF NOT EXISTS logo uuid, ADD COLUMN IF NOT EXISTS cover uuid, ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS lat double precision, ADD COLUMN IF NOT EXISTS lng double precision, ADD COLUMN IF NOT EXISTS phone text, ADD COLUMN IF NOT EXISTS telegram text,
  ADD COLUMN IF NOT EXISTS vk text, ADD COLUMN IF NOT EXISTS hours text, ADD COLUMN IF NOT EXISTS verified boolean DEFAULT false, ADD COLUMN IF NOT EXISTS balance int DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS announcement jsonb, ADD COLUMN IF NOT EXISTS promoted_until timestamptz, ADD COLUMN IF NOT EXISTS erid text, ADD COLUMN IF NOT EXISTS invite_code text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS paused boolean DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS age smallint;
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS max text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS avatar uuid, ADD COLUMN IF NOT EXISTS about text, ADD COLUMN IF NOT EXISTS account_type text, ADD COLUMN IF NOT EXISTS registered_at timestamptz;
CREATE TABLE IF NOT EXISTS organizer_members (
  organizer_id int REFERENCES organizers(id) ON DELETE CASCADE, client_id uuid NOT NULL, role text DEFAULT 'manager', created_at timestamptz DEFAULT now(),
  PRIMARY KEY (organizer_id, client_id)
);
CREATE TABLE IF NOT EXISTS promotions (
  id serial PRIMARY KEY, organizer_id int REFERENCES organizers(id) ON DELETE CASCADE, target text NOT NULL, target_id text, type text NOT NULL,
  days int NOT NULL, price int NOT NULL, erid text, boost_terms text[], starts_at timestamptz DEFAULT now(), ends_at timestamptz, status text DEFAULT 'active',
  created_by uuid, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS search_log (
  id serial PRIMARY KEY, client_id uuid, query text, corrected text, results int, created_at timestamptz DEFAULT now()
);
`;

export async function migrate() {
  await q(SCHEMA);
}

export async function seedTaxonomy() {
  for (const c of CATEGORIES) {
    await q(`INSERT INTO categories(key,title,emoji,sort) VALUES($1,$2,$3,$4)
             ON CONFLICT (key) DO UPDATE SET title=EXCLUDED.title, emoji=EXCLUDED.emoji, sort=EXCLUDED.sort`, [c.key, c.title, c.emoji, c.sort]);
    let i = 0;
    for (const s of c.subs) {
      await q(`INSERT INTO subcategories(key,category_key,title,emoji,keywords,sort) VALUES($1,$2,$3,$4,$5,$6)
               ON CONFLICT (key) DO UPDATE SET category_key=EXCLUDED.category_key, title=EXCLUDED.title, emoji=EXCLUDED.emoji, keywords=EXCLUDED.keywords, sort=EXCLUDED.sort`,
        [s.key, c.key, s.title, s.emoji, s.kw, i++]);
    }
  }
}

export function slugify(s) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ә: 'a', ө: 'o', ү: 'u', ң: 'n', һ: 'h', җ: 'j', ñ: 'n' };
  return s.toLowerCase().split('').map(ch => map[ch] ?? ch).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'org';
}

export async function ensureOrganizer(name, extra = {}) {
  const meta = ORGANIZERS[name] || {};
  const slug = meta.slug || slugify(name);
  const r = await q(`INSERT INTO organizers(slug,name,about,created_by) VALUES($1,$2,$3,$4)
                     ON CONFLICT (name) DO UPDATE SET about=COALESCE(organizers.about, EXCLUDED.about) RETURNING id`,
    [slug, name, meta.about || extra.about || null, extra.created_by || null]);
  return r.rows[0].id;
}

async function insertEvent(e, organizerId, source = 'seed', createdBy = null) {
  const r = await q(`INSERT INTO events(slug,series_key,title,category_key,subcategory_key,emoji,start_at,duration_min,price,lang,venue,address,district,organizer_id,
      with_whom,solo,stol,registration_type,registration_label,registration_url,capacity,going_base,tags,description,source,created_by,lat,lng,cover,photos,theme,accent,kind,meta,keywords,video_url,promoted_until,erid,boost_terms,age)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40)
    ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [e.slug, e.series_key, e.title, e.category_key, e.subcategory_key, e.emoji, e.start_at, e.duration_min, e.price, e.lang, e.venue, e.address, e.district, organizerId,
      e.with_whom, e.solo, e.stol, e.registration_type, e.registration_label, e.registration_url, e.capacity, e.going_base, e.tags, e.description, source, createdBy,
      e.lat ?? VENUES[e.venue]?.[0] ?? null, e.lng ?? VENUES[e.venue]?.[1] ?? null, e.cover || null, e.photos || [], e.theme || null, e.accent || null, e.kind || null, JSON.stringify(e.meta || {}), e.keywords || [], e.video_url || null, e.promoted_until || null, e.erid || null, e.boost_terms || [], e.age ?? null]);
  return r.rows[0]?.id || null;
}
export { insertEvent };

// Наполняет базу: таксономия, организаторы, расписание на 60 дней вперёд. Повторный запуск ничего не дублирует.
export async function ensureSeed({ reseed = false } = {}) {
  await seedTaxonomy();
  await q(`UPDATE organizers SET name='Айдагез', slug='aydagez' WHERE name='Айдаем' AND NOT EXISTS (SELECT 1 FROM organizers WHERE name='Айдагез')`);
  await q(`UPDATE events SET title=replace(title,'«Айдаем»','«Айдагез»'), slug=replace(slug,'aidaem-launch','aydagez-launch') WHERE title LIKE '%«Айдаем»%'`);
  for (const [venue, [lat, lng]] of Object.entries(VENUES)) await q(`UPDATE events SET lat=$1, lng=$2 WHERE venue=$3 AND lat IS NULL`, [lat, lng, venue]);
  // Тип организации для сидов по названию (один раз, только где не задан)
  await q(`UPDATE organizers SET kind = CASE
      WHEN name ILIKE '%кинотеатр%' OR name ILIKE 'киномакс%' OR name ILIKE '%кино%' THEN 'cinema'
      WHEN name ILIKE '%театр%' OR name ILIKE '%филармон%' OR name ILIKE 'moñ' THEN 'theatre'
      WHEN name ILIKE '%прокат%' OR name ILIKE '%sup%' OR name ILIKE '%вейк%' OR name ILIKE '%роллердром%' THEN 'rental'
      WHEN name ILIKE '%дирекция парков%' OR name ILIKE '%парк%' OR name ILIKE '%набережн%' THEN 'resort'
      WHEN name ILIKE '%музей%' OR name ILIKE '%эрмитаж%' OR name ILIKE '%галере%' OR name ILIKE 'смена' OR name ILIKE '%библиотек%' THEN 'museum'
      WHEN name ILIKE '%клуб%' OR name ILIKE '%бар%' OR name ILIKE '%werk%' OR name ILIKE '%нефть%' OR name ILIKE '%небо%' OR name ILIKE '%караоке%' OR name ILIKE '%гром%' THEN 'club'
      WHEN name ILIKE '%студи%' OR name ILIKE '%школ%' OR name ILIKE '%йог%' OR name ILIKE '%прана%' OR name ILIKE '%альянс%' THEN 'studio'
      WHEN name ILIKE '%ск «%' OR name ILIKE '%арена%' OR name ILIKE '%скалодром%' OR name ILIKE '%олимп%' THEN 'sport'
      ELSE 'community' END WHERE kind IS NULL`);
  await q(`UPDATE events SET category_key='fun', subcategory_key='anticafe' WHERE series_key='anticafe-day' AND subcategory_key<>'anticafe'`);
  await q(`UPDATE organizers SET kind='fun' WHERE kind IS NOT NULL AND kind<>'fun' AND (name ILIKE '%warpoint%' OR name ILIKE '%colizeum%' OR name ILIKE '%клаустрофоб%' OR name ILIKE '%батут%' OR name ILIKE '%лазертаг%' OR name ILIKE '%картинг%' OR name ILIKE '%боулинг%' OR name ILIKE '%замания%' OR name ILIKE '%кидбург%' OR name ILIKE '%цирк%' OR name ILIKE '%планетарий%' OR name ILIKE '%океанариум%' OR name ILIKE '%котокафе%' OR name ILIKE '%речфлот%' OR name ILIKE '%сити-тур%' OR name ILIKE '%верёвочный%')`);
  // Возрастная маркировка: у сидов — по шаблону серии, у остальных — по подкатегории; 16+ и 18+ не бывают «с детьми»
  await q(`UPDATE events SET category_key='kids', subcategory_key='kidstheatre' WHERE series_key='ekiyat' AND category_key<>'kids'`);
  for (const t of EXTRA_SERIES) if (t.age != null) await q(`UPDATE events SET age=$1 WHERE series_key=$2 AND age IS DISTINCT FROM $1`, [t.age, t.key]);
  await q(`UPDATE events SET age = CASE subcategory_key ${Object.entries(SUB_AGE).map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(' ')} ELSE 0 END WHERE age IS NULL`);
  await q(`UPDATE events SET with_whom = array_remove(with_whom, 'kids') WHERE age >= 16 AND 'kids' = ANY(with_whom)`);
  // С собаками: прогулки, пробежки, маркеты и пешие экскурсии на улице
  await q(`UPDATE events SET with_whom = array_append(with_whom, 'dogs'), tags = array_append(tags, 'можно с собакой')
           WHERE subcategory_key IN ('run', 'walk', 'market', 'tour') AND COALESCE(kind, '') NOT IN ('rental', 'sessions', 'groups') AND NOT ('dogs' = ANY(with_whom)) AND source = 'seed'`);
  await q(`UPDATE events SET with_whom = array_remove(with_whom, 'dogs'), tags = array_remove(tags, 'можно с собакой') WHERE kind IN ('rental', 'sessions', 'groups') AND 'dogs' = ANY(with_whom) AND source = 'seed'`);
  // Демо: у сеансов и проката одной серии разная занятость по часам (раньше все часы были одинаковыми)
  await q(`UPDATE events SET going_base = LEAST(capacity, floor(capacity * (abs(hashtext(slug)) % 100) / 100.0)::int) WHERE source = 'seed' AND kind IN ('rental', 'sessions', 'groups')`); // детерминированно: при каждом старте одинаково
  // Наши собственные форматы: запись в Telegram и MAX
  await q(`UPDATE organizers SET telegram = COALESCE(telegram, '@aydagez'), max = COALESCE(max, 'aydagez') WHERE slug = 'aydagez'`);
  if (reseed) await q(`DELETE FROM events WHERE source='seed'`);
  const today = new Date();
  const horizon = new Date(today); horizon.setDate(today.getDate() + 30);
  const { rows } = await q(`SELECT count(*)::int AS n FROM events WHERE source='seed' AND start_at > $1`, [horizon]);
  const firstRun = (await q(`SELECT count(*)::int AS n FROM events`)).rows[0].n === 0;
  // Дополнительные серии (seed_extra) досеиваются отдельно: смотрим, есть ли их события в будущем
  const extraKeys = EXTRA_SERIES.map(t => t.key);
  const have = new Set((await q(`SELECT DISTINCT series_key FROM events WHERE source='seed' AND series_key = ANY($1) AND start_at > $2`, [extraKeys, horizon])).rows.map(r => r.series_key));
  const needExtra = extraKeys.some(k => !have.has(k)); // появились новые серии — досеиваем (слуги уникальны, дублей не будет)
  if (rows[0].n >= 40 && !firstRun && !needExtra) return { inserted: 0 };
  const orgIds = {};
  for (const name of Object.keys(ORGANIZERS)) orgIds[name] = await ensureOrganizer(name);
  for (const [name, about] of Object.entries(EXTRA_ORGANIZERS)) orgIds[name] = await ensureOrganizer(name, { about });
  let inserted = 0;
  const list = (rows[0].n >= 40 && !firstRun ? [] : generateSeries(today)).concat(generateExtra(today), firstRun || reseed ? generateOneOffs(today) : []);
  for (const e of list) {
    const oid = orgIds[e.organizer] || (orgIds[e.organizer] = await ensureOrganizer(e.organizer));
    if (await insertEvent(e, oid)) inserted++;
  }
  return { inserted };
}
