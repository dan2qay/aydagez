/* Айдагез v0.7 — клиент: пошаговый подбор (что → что именно → когда → результаты), поиск, события, организаторы, профиль. */
(function () {
  'use strict';

  // ---------- Утилиты ----------
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) { if (c === null || c === undefined || c === false) continue; n.append(c instanceof Node ? c : document.createTextNode(String(c))); }
    return n;
  };
  const api = async (path, opts = {}) => {
    const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (!r.ok) throw Object.assign(new Error('api'), { status: r.status, body: await r.json().catch(() => ({})) });
    return r.json();
  };
  const pad2 = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return f[2]; if (b > 1 && b < 5) return f[1]; if (b === 1) return f[0]; return f[2]; };
  const fmtPrice = p => p === 0 ? 'Бесплатно' : `${p.toLocaleString('ru-RU')} ₽`;
  const TZ = 'Europe/Moscow'; // время Казани независимо от зоны браузера
  const fmtTime = d => new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(d);
  const partsIn = d => { const o = {}; for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)) o[p.type] = p.value; return o; };
  const fmtLong = d => cap(d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));
  const fmtDM = d => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const WD_PL = ['воскресеньям', 'понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам'];
  const LANGS = { ru: 'На русском', tt: 'На татарском', en: 'На английском' };
  const WITH = [['solo', 'Один'], ['duo', 'Вдвоём'], ['friends', 'С друзьями'], ['kids', 'С детьми'], ['dogs', 'С собакой']];
  const BUDGET = [['0', 'Бесплатно'], ['500', 'До 500 ₽'], ['1500', 'До 1 500 ₽']];
  const CAT_GRAD = { kids: 'linear-gradient(135deg,#fb7185,#f59e0b)', fun: 'linear-gradient(135deg,#f43f5e,#8b5cf6)', sport: 'linear-gradient(135deg,#0ea5e9,#22c55e)', games: 'linear-gradient(135deg,#f59e0b,#ef4444)', social: 'linear-gradient(135deg,#8b5cf6,#ec4899)', music: 'linear-gradient(135deg,#4f46e5,#06b6d4)', knowledge: 'linear-gradient(135deg,#f97316,#facc15)', culture: 'linear-gradient(135deg,#e11d48,#7c3aed)' };
  const MOODS = [
    { key: 'calm', emoji: '🧘', title: 'Что-то спокойное', desc: 'лекции, кино, театр, настолки, джаз, выставки' },
    { key: 'active', emoji: '⚡', title: 'Что-то активное', desc: 'пробежки, квизы, вечеринки, стендап, знакомства' },
    { key: 'open', emoji: '✨', title: 'Я открыт возможностям', desc: 'покажем всё, что есть в городе' },
  ];
  const store = { get(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch { return f; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
  const today = (() => { const p = partsIn(new Date()); return new Date(Number(p.year), Number(p.month) - 1, Number(p.day)); })();
  const weekend = () => { const dow = today.getDay(); const sat = dow === 0 ? today : addDays(today, (6 - dow) % 7); const sun = dow === 0 ? today : addDays(sat, 1); return [sat, sun]; };

  // ---------- Журнал действий: сессия, UTM, пакетная отправка ----------
  const track = (() => {
    let sid = null; try { sid = sessionStorage.getItem('aid_sid'); if (!sid) { sid = crypto.randomUUID(); sessionStorage.setItem('aid_sid', sid); } } catch { sid = crypto.randomUUID(); }
    const utm = {}; try { for (const [k, v] of new URL(location.href).searchParams) if (/^utm_|^ref$|^promo$/.test(k)) utm[k] = v.slice(0, 100); } catch {}
    let queue = [], timer = null, first = true;
    const flush = (beacon = false) => {
      if (!queue.length && !first) return;
      const body = JSON.stringify({ session: sid, events: queue.splice(0, 50), lang: navigator.language, referrer: first ? document.referrer : undefined, landing: first ? location.href.slice(0, 500) : undefined, utm: first ? utm : undefined });
      first = false;
      if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
      else fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Id': sid }, body, credentials: 'same-origin', keepalive: true }).catch(() => {});
    };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
    const fn = (name, props = {}) => { queue.push({ name, props, path: location.hash || '#/', ts: new Date().toISOString() }); clearTimeout(timer); timer = setTimeout(() => flush(false), 2500); if (queue.length >= 20) flush(false); };
    fn.sid = sid;
    return fn;
  })();
  const _fetch = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => { if (typeof url === 'string' && url.startsWith('/api/') && !url.startsWith('/api/track')) { opts.headers = Object.assign({}, opts.headers || {}, { 'X-Session-Id': track.sid, 'X-Path': location.hash || '#/' }); } return _fetch(url, opts); };

  let toastTimer;
  const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); };

  // ---------- Состояние ----------
  let taxonomy = [];
  let me = null;
  let facets = null; // счётчики по категориям, подкатегориям и настроению на две недели
  const saved = store.get('aidaem_flow', {});
  const S = {
    screen: saved.screen === 'search' ? 'what' : (saved.screen || 'what'),            // what | sub | mood | when | results
    q: saved.q || '', cat: saved.cat || null, sub: saved.sub || null, mood: saved.mood || null,
    when: saved.when || 'today', date: saved.date || iso(today), from: saved.from || null, to: saved.to || null, // today | tomorrow | week | weekend | date | range | any
    withWhom: saved.withWhom || '', budget: saved.budget || '', cats: Array.isArray(saved.cats) ? saved.cats : [], via: saved.via || 'flow', ai: !!saved.ai, aiOff: !!saved.aiOff, tod: saved.tod || '', noise: saved.noise || '', subs: Array.isArray(saved.subs) ? saved.subs : [], acts: Array.isArray(saved.acts) ? saved.acts : [], districts: Array.isArray(saved.districts) ? saved.districts : [], kidAge: saved.kidAge ?? '', pmin: saved.pmin ?? '', pmax: saved.pmax ?? (saved.budget !== undefined && saved.budget !== '' ? saved.budget : ''),
    calOpen: false, calY: today.getFullYear(), calM: today.getMonth(),
    days: {},
  };
  const persist = () => store.set('aidaem_flow', { screen: S.screen, q: S.q, cat: S.cat, sub: S.sub, mood: S.mood, when: S.when, date: S.date, from: S.from, to: S.to, withWhom: S.withWhom, kidAge: S.kidAge, budget: S.budget, cats: S.cats, via: S.via, ai: S.ai, aiOff: S.aiOff, tod: S.tod, noise: S.noise, subs: S.subs, acts: S.acts, pmin: S.pmin, pmax: S.pmax, districts: S.districts });
  const catOf = k => taxonomy.find(c => c.key === k);
  const subOf = (c, k) => catOf(c)?.subs.find(s => s.key === k);
  const moodOf = k => MOODS.find(m => m.key === k);

  function range() {
    if (S.when === 'today') return [iso(today), iso(today)];
    if (S.when === 'tomorrow') { const t = addDays(today, 1); return [iso(t), iso(t)]; }
    if (S.when === 'weekend') { const [a, b] = weekend(); return [iso(a), iso(b)]; }
    if (S.when === 'week') { const dow = today.getDay(); return [iso(today), iso(addDays(today, dow === 0 ? 0 : 7 - dow))]; }
    if (S.when === 'date') return [S.date, S.date];
    if (S.when === 'range' && S.from && S.to) return [S.from, S.to];
    return [iso(today), iso(addDays(today, 45))];
  }
  function whenTitle() {
    const [a, b] = range(); const A = parseIso(a), B = parseIso(b);
    if (S.when === 'today') return `Сегодня, ${fmtDM(A)}`;
    if (S.when === 'tomorrow') return `Завтра, ${fmtDM(A)}`;
    if (S.when === 'weekend') return a === b ? `Выходные · ${fmtDM(A)}` : `Выходные · ${A.getDate()}–${fmtDM(B)}`;
    if (S.when === 'week') return a === b ? `На этой неделе · ${fmtDM(A)}` : `На этой неделе · ${A.getDate()}–${fmtDM(B)}`;
    if (S.when === 'date') return fmtLong(A);
    if (S.when === 'range') return A.getMonth() === B.getMonth() ? `${A.getDate()}–${fmtDM(B)}` : `${fmtDM(A)} – ${fmtDM(B)}`;
    return 'Все ближайшие дни';
  }
  function whatTitle() {
    const parts = [];
    if (S.q) parts.push((S.ai ? '✨ ' : '') + `«${S.q}»`);
    if (S.cats.length) parts.push(S.cats.map(k => catOf(k)).filter(Boolean).map(c => `${c.emoji} ${c.title}`).join(', '));
    else if (S.cat && catOf(S.cat)) parts.push(`${catOf(S.cat).emoji} ${catOf(S.cat).title}${S.sub && subOf(S.cat, S.sub) ? ' · ' + subOf(S.cat, S.sub).title : ''}`);
    if (S.mood && moodOf(S.mood)) parts.push(`${moodOf(S.mood).emoji} ${moodOf(S.mood).title}`);
    if (S.subs.length) parts.push(S.subs.map(k => { for (const c of taxonomy) { const sb = c.subs.find(x => x.key === k); if (sb) return sb.title; } return k; }).join(', '));
    if (S.acts.length) parts.push(S.acts.map(k => actOf(k)?.title || k).join(', '));
    if (S.districts.length) parts.push('📍 ' + S.districts.map(distLabel).join(', '));
    for (const f of FILTERS) { if (f.key === 'budget') continue; const o = f.opts.find(x => x[0] === S[f.key]); if (o) parts.push(`${o[1]} ${o[2]}`); }
    if (S.pmin !== '' || S.pmax !== '') parts.push(priceLabel(S.pmin, S.pmax));
    return parts.join(' · ') || '✨ Всё подряд';
  }

  // ---------- Шапка ----------
  function renderMe() {
    const n = me?.registrations?.length || 0;
    const b = $('#me-count'); b.textContent = n; b.hidden = !n;
    const tb = $('#tab-count'); if (tb) { tb.textContent = n; tb.hidden = !n; }
    const nc = $('#nav-cabinet'); if (nc) nc.hidden = !me?.isOrganizer;
    const av = $('#me-avatar');
    if (me?.avatar) { av.innerHTML = ''; av.append(el('img', { src: me.avatar, alt: '' })); av.classList.add('filled'); }
    else if (me?.name) { av.textContent = me.name.trim().charAt(0).toUpperCase(); av.classList.add('filled'); }
  }
  function initTheme() { if (!document.documentElement.getAttribute('data-theme')) document.documentElement.setAttribute('data-theme', 'light'); }
  function setTheme(t) { document.documentElement.setAttribute('data-theme', t); store.set('aidaem_theme', t); api('/api/me', { method: 'PATCH', body: { theme: t } }).catch(() => {}); }
  // ---------- Выпадающие фильтры: в строке поиска и (на телефоне) над лентой ----------
  const CHEVRON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  const FILTERS = [
    { key: 'withWhom', title: 'С кем идёте', any: 'С кем угодно', opts: [['solo', '🙋', 'Один'], ['duo', '👫', 'Вдвоём'], ['friends', '🎉', 'С друзьями'], ['kids', '🧒', 'С детьми'], ['dogs', '🐕', 'С собакой']] },
    { key: 'budget', title: 'Бюджет на человека', any: 'Любой бюджет', custom: true, opts: [['0', '🆓', 'Бесплатно'], ['500', '💳', 'До 500 ₽'], ['1500', '💳', 'До 1 500 ₽'], ['3000', '💳', 'До 3 000 ₽']] },
    { key: 'tod', title: 'Время суток', any: 'Любое время', opts: [['morning', '🌅', 'Утром'], ['day', '☀️', 'Днём'], ['evening', '🌆', 'Вечером'], ['night', '🌙', 'Ночью']] },
    { key: 'noise', title: 'Атмосфера', any: 'Атмосфера', opts: [['quiet', '🤫', 'Тихо, спокойно'], ['loud', '🔊', 'Шумно, музыка']] },
  ];
  let openDd = null;
  function closeDd() { if (openDd) { openDd.classList.remove('open'); openDd.querySelector('.dd-menu')?.remove(); openDd = null; } }
  document.addEventListener('pointerdown', ev => { if (openDd && !openDd.contains(ev.target)) closeDd(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeDd(); });
  function dropdown(f) {
    const val = S[f.key];
    const cur = f.opts.find(o => o[0] === val) || (f.custom && val !== '' && val != null ? ['', '💳', `До ${Number(val).toLocaleString('ru-RU')} ₽`] : null);
    const dd = el('div', { class: 'dd' });
    const btn = el('button', { type: 'button', class: 'dd-btn' + (cur ? ' on' : ''), 'aria-haspopup': 'listbox' }, cur ? `${cur[1]} ${cur[2]}` : f.any, el('span', { html: CHEVRON }));
    btn.addEventListener('click', () => {
      if (openDd === dd) return closeDd();
      closeDd(); openDd = dd; dd.classList.add('open');
      const item = (v, ic, label) => el('button', { type: 'button', class: 'dd-item' + (val === v ? ' on' : ''), role: 'option', onclick: () => setFilter(f.key, v) }, el('span', { class: 'chk' }, val === v ? '✓' : ''), el('span', { class: 'ic' }, ic), label);
      const custom = f.custom ? (() => { const inp = el('input', { class: 'dd-num', type: 'number', min: 0, step: 50, placeholder: 'своя сумма', value: cur && !f.opts.some(o => o[0] === val) ? val : '' }); const ok = () => { const n = Math.max(0, Math.round(Number(inp.value))); if (Number.isFinite(n) && inp.value !== '') setFilter(f.key, String(n)); }; inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') ok(); }); return el('div', { class: 'dd-custom' }, el('span', {}, 'до'), inp, el('span', {}, '₽'), el('button', { type: 'button', class: 'btn btn-ink btn-sm', onclick: ok }, 'Ок')); })() : null;
      dd.append(el('div', { class: 'dd-menu', role: 'listbox' }, el('div', { class: 'dd-title' }, f.title), item('', '✨', f.any), f.opts.map(o => item(o[0], o[1], o[2])), custom));
    });
    dd.append(btn);
    return dd;
  }
  // Фильтр только запоминается; поиск запускает кнопка «Найти» (пожелание: не искать после каждого выбора)
  function setFilter(key, v) { S[key] = v; S.filtersDirty = true; persist(); closeDd(); renderFilters(); track('filter', { key, value: v }); }
  function applyFilters() { S.filtersDirty = false; renderFilters(); if (H.feed?.isConnected) fetchFeed(); else { S.via = 'search'; go('when'); } }
  function renderFilters() {
    const n = activeFilterCount(S);
    for (const host of document.querySelectorAll('[data-filters]')) {
      host.innerHTML = '';
      host.append(el('button', { type: 'button', class: 'dd-btn filters-btn' + (n ? ' on' : ''), onclick: () => filtersModal() }, el('span', { html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>' }), 'Фильтры', n ? el('span', { class: 'n' }, n) : null));
      if (S.filtersDirty && host.classList.contains('feed-filters')) host.append(el('button', { type: 'button', class: 'btn btn-ink btn-sm apply-filters', onclick: applyFilters }, 'Найти'));
    }
  }
  const actOf = k => (taxonomy.activities || []).find(a => a.key === k);
  const distLabel = k => (taxonomy.districts || []).find(d => d.key === k)?.label || k;
  const priceLabel = (a, b) => { const A = a === '' || a == null ? null : Number(a), B = b === '' || b == null ? null : Number(b); if (A === null && B === null) return 'Любая цена'; if (B === 0) return '🆓 Бесплатно'; if (A === null) return `до ${B.toLocaleString('ru-RU')} ₽`; if (B === null) return `от ${A.toLocaleString('ru-RU')} ₽`; return `${A.toLocaleString('ru-RU')}–${B.toLocaleString('ru-RU')} ₽`; };
  // ---------- Панель фильтров (как у Airbnb/Авито): категории и виды, цена с гистограммой, с кем, когда, время, атмосфера ----------
  function filtersPanel(draft, { onChange, inline = false } = {}) {
    const box = el('div', { class: 'fp' + (inline ? ' inline' : '') });
    let facets = null;
    const sec = (title, body, hint) => el('section', { class: 'fp-sec' }, el('h3', {}, title, hint ? el('span', { class: 'meta' }, ` · ${hint}`) : null), body);
    const chip = (on, label, fn, count) => el('button', { type: 'button', class: 'pill' + (on ? ' on' : ''), onclick: fn }, label, count != null ? el('span', { class: 'n' }, ` ${count}`) : null);
    const change = () => { if (onChange) onChange(); paint(); };
    const catsBox = el('div', {}), priceBox = el('div', {});
    const paintCats = () => {
      catsBox.innerHTML = '';
      catsBox.append(el('div', { class: 'pills' }, taxonomy.map(c => chip(draft.cats.includes(c.key), `${c.emoji} ${c.title}`, () => { draft.cats = draft.cats.includes(c.key) ? draft.cats.filter(k => k !== c.key) : [...draft.cats, c.key]; draft.cat = null; draft.sub = null; const keep = new Set(taxonomy.filter(x => draft.cats.includes(x.key)).flatMap(x => x.subs.map(sb => sb.key))); draft.subs = draft.subs.filter(k => keep.has(k)); draft.acts = draft.acts.filter(k => draft.cats.includes(actOf(k)?.cat)); change(); }, facets?.cats?.[c.key]))));
      for (const c of taxonomy.filter(x => draft.cats.includes(x.key))) {
        const acts = (taxonomy.activities || []).filter(a => a.cat === c.key);
        const groups = taxonomy.groups || {};
        const rows = el('div', { class: 'fp-sub' }, el('div', { class: 'fp-sub-title' }, `${c.emoji} ${c.title}: что именно`));
        const pills = el('div', { class: 'pills small' });
        for (const [gk, g] of Object.entries(groups)) if (g.keys.every(k => acts.some(a => a.key === k))) pills.append(chip(g.keys.every(k => draft.acts.includes(k)), g.title, () => { const all = g.keys.every(k => draft.acts.includes(k)); draft.acts = all ? draft.acts.filter(k => !g.keys.includes(k)) : [...new Set([...draft.acts, ...g.keys])]; change(); }, g.keys.reduce((a, k) => a + (facets?.acts?.[k] || 0), 0) || null));
        for (const a of acts) pills.append(chip(draft.acts.includes(a.key), `${a.emoji} ${a.title}`, () => { draft.acts = draft.acts.includes(a.key) ? draft.acts.filter(k => k !== a.key) : [...draft.acts, a.key]; change(); }, facets?.acts?.[a.key] ?? null));
        for (const sb of c.subs.filter(sb => !acts.some(a => a.key === sb.key) && !(sb.key === 'team' && groups.ball))) pills.append(chip(draft.subs.includes(sb.key), `${sb.emoji} ${sb.title}`, () => { draft.subs = draft.subs.includes(sb.key) ? draft.subs.filter(k => k !== sb.key) : [...draft.subs, sb.key]; change(); }, facets?.subs?.[sb.key] ?? null));
        rows.append(pills); catsBox.append(rows);
      }
    };
    const paintPrice = () => {
      priceBox.innerHTML = '';
      const pr = facets?.price || { max: 3000, bins: [], free: 0 }; const max = pr.max || 3000; const maxN = Math.max(1, ...pr.bins.map(b => b.n));
      const lo = el('input', { type: 'range', min: 0, max, step: 50, value: draft.pmin === '' ? 0 : Math.min(Number(draft.pmin), max), 'aria-label': 'Цена от' });
      const hi = el('input', { type: 'range', min: 0, max, step: 50, value: draft.pmax === '' ? max : Math.min(Number(draft.pmax), max), 'aria-label': 'Цена до' });
      const bars = el('div', { class: 'hist' }); const lbl = el('div', { class: 'price-lbl' }); const inMin = el('input', { class: 'input price-in', type: 'number', min: 0, step: 50, placeholder: '0' }); const inMax = el('input', { class: 'input price-in', type: 'number', min: 0, step: 50, placeholder: `${max}+` });
      const vals = () => { let a = Number(lo.value), b = Number(hi.value); if (a > b) [a, b] = [b, a]; return [a, b]; };
      const show = () => { const [a, b] = vals(); lbl.textContent = `${a === 0 ? 'от 0 ₽' : 'от ' + a + ' ₽'} до ${b >= max ? max + ' ₽ и дороже' : b + ' ₽'}`; inMin.value = a || ''; inMax.value = b >= max ? '' : b; bars.innerHTML = ''; for (const bn of pr.bins) bars.append(el('i', { class: bn.to > a && bn.from < (b >= max ? Infinity : b + 1) ? 'on' : '', style: `height:${Math.max(4, Math.round(bn.n / maxN * 100))}%`, title: `${bn.from}–${bn.to} ₽: ${bn.n}` })); };
      const commit = () => { const [a, b] = vals(); draft.pmin = a === 0 ? '' : a; draft.pmax = b >= max ? '' : b; if (onChange) onChange(); paintPrice(); };
      lo.addEventListener('input', show); hi.addEventListener('input', show); lo.addEventListener('change', commit); hi.addEventListener('change', commit);
      inMin.addEventListener('change', () => { lo.value = Math.min(max, Math.max(0, Number(inMin.value) || 0)); commit(); }); inMax.addEventListener('change', () => { hi.value = inMax.value === '' ? max : Math.min(max, Math.max(0, Number(inMax.value) || 0)); commit(); });
      show();
      priceBox.append(bars, el('div', { class: 'dual' }, lo, hi), lbl, el('div', { class: 'price-inputs' }, el('label', {}, 'от', inMin), el('label', {}, 'до', inMax), chip(draft.pmax === 0 || draft.pmax === '0', '🆓 Только бесплатно', () => { if (draft.pmax === 0 || draft.pmax === '0') { draft.pmax = ''; } else { draft.pmin = ''; draft.pmax = 0; } if (onChange) onChange(); paintPrice(); }, pr.free || null)));
    };
    const single = (key, opts, labelFn) => el('div', { class: 'pills' }, opts.map(o => chip(draft[key] === o[0], labelFn(o), () => { draft[key] = draft[key] === o[0] ? '' : o[0]; change(); }, null)));
    const whenRow = el('div', {});
    const paintWhen = () => { whenRow.innerHTML = ''; whenRow.append(el('div', { class: 'pills' }, [['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['weekend', 'Выходные'], ['week', 'На неделе'], ['any', 'Все дни']].map(([k, t]) => chip(draft.when === k, t, () => { draft.when = k; change(); }, null)), ['date', 'range'].includes(draft.when) ? chip(true, whenTitleOf(draft), () => { draft.when = 'any'; change(); }, null) : null, el('button', { type: 'button', class: 'pill', onclick: () => calendarSheet(draft, () => change()) }, '📅 Даты'))); };
    const moodRow = el('div', {});
    const paintMood = () => { moodRow.innerHTML = ''; moodRow.append(el('div', { class: 'pills' }, MOODS.filter(m => m.key !== 'open').map(m => chip(draft.mood === m.key, `${m.emoji} ${m.title}`, () => { draft.mood = draft.mood === m.key ? null : m.key; change(); }, null)))); };
    const withRow = el('div', {}), todRow = el('div', {}), noiseRow = el('div', {}), distRow = el('div', {});
    const paintDist = () => { distRow.innerHTML = ''; distRow.append(el('div', { class: 'pills' }, (taxonomy.districts || []).map(d => chip(draft.districts.includes(d.key), (d.center ? '🏛️ ' : '📍 ') + d.label, () => { draft.districts = draft.districts.includes(d.key) ? draft.districts.filter(k => k !== d.key) : [...draft.districts, d.key]; change(); }, facets?.districts?.[d.key] ?? null)), (taxonomy.districts || []).length ? chip(draft.districts.length === (taxonomy.districts || []).filter(d => !d.center).length && draft.districts.length > 0, '🌆 Не в центре', () => { const outs = (taxonomy.districts || []).filter(d => !d.center).map(d => d.key); const all = outs.every(k => draft.districts.includes(k)); draft.districts = all ? [] : outs; change(); }, null) : null)); };
    const paint = () => { paintCats(); paintWhen(); paintMood(); paintDist(); withRow.innerHTML = ''; withRow.append(single('withWhom', FILTERS[0].opts, o => `${o[1]} ${o[2]}`)); if (draft.withWhom === 'kids') withRow.append(el('div', { class: 'sub-row' }, el('span', { class: 'hints-label' }, 'Возраст ребёнка:'), el('div', { class: 'pills' }, [['', 'Любой'], [0, 'до 6 лет'], [6, '6–11 лет'], [12, '12–15 лет']].map(([v, t]) => chip(String(draft.kidAge ?? '') === String(v), t, () => { draft.kidAge = v; change(); }, null))))); todRow.innerHTML = ''; todRow.append(single('tod', FILTERS[2].opts, o => `${o[1]} ${o[2]}`)); noiseRow.innerHTML = ''; noiseRow.append(single('noise', FILTERS[3].opts, o => `${o[1]} ${o[2]}`)); };
    paint(); paintPrice();
    box.append(sec('Что интересно', catsBox, 'можно несколько'), sec('Цена за человека', priceBox, 'сколько событий по цене'), sec('Когда', whenRow), sec('Где', distRow, 'районы города: центр или ближе к дому'), sec('С кем идёте', withRow), sec('Время суток', todRow), sec('Атмосфера', noiseRow, 'шумно — музыка и танцы, тихо — поговорить'), sec('Настроение', moodRow));
    return { el: box, setFacets: f => { facets = f; paintCats(); paintPrice(); paintDist(); } };
  }
  const whenTitleOf = st => { const keep = { when: S.when, date: S.date, from: S.from, to: S.to }; Object.assign(S, { when: st.when, date: st.date, from: st.from, to: st.to }); const t = whenTitle(); Object.assign(S, keep); return t; };
  function filtersModal() {
    const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; };
    const draft = { q: S.q, ai: S.ai, aiOff: S.aiOff, cat: S.cat, sub: S.sub, cats: [...S.cats], subs: [...S.subs], acts: [...S.acts], districts: [...S.districts], mood: S.mood, withWhom: S.withWhom, kidAge: S.kidAge, pmin: S.pmin, pmax: S.pmax, tod: S.tod, noise: S.noise, when: S.when, date: S.date, from: S.from, to: S.to };
    const countBtn = el('button', { type: 'button', class: 'btn btn-primary btn-lg' }, 'Показать события');
    let timer = null;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(async () => { const keep = { when: S.when, date: S.date, from: S.from, to: S.to }; Object.assign(S, { when: draft.when, date: draft.date, from: draft.from, to: draft.to }); const [from, to] = range(); Object.assign(S, keep); try { const d = await api(`/api/events?${params(from, to, draft)}&facets=1`); panel.setFacets(d.facets); const n = d.events.length; countBtn.textContent = n ? `Показать ${n} ${plural(n, ['событие', 'события', 'событий'])}` : 'Ничего не нашли — ослабьте условия'; countBtn.disabled = !n; } catch {} }, 200); };
    const panel = filtersPanel(draft, { onChange: refresh });
    countBtn.addEventListener('click', () => { for (const k of FILTER_KEYS) S[k] = draft[k]; S.cat = draft.cat; S.sub = draft.sub; S.filtersDirty = false; S.budget = ''; persist(); close(); renderFilters(); track('filters_apply', { n: activeFilterCount(S) }); if (H.feed?.isConnected) { renderQuick(); if (H.cal?.isConnected) H.cal.replaceWith(freshCal()); fetchFeed(); } else { S.via = 'search'; if (location.hash && location.hash !== '#/') location.hash = '#/'; go('when'); } });
    const reset = () => { Object.assign(draft, { cats: [], subs: [], acts: [], districts: [], mood: null, withWhom: '', kidAge: '', pmin: '', pmax: '', tod: '', noise: '', when: 'any', cat: null, sub: null }); panel.el.replaceWith((panel = filtersPanel(draft, { onChange: refresh })).el); refresh(); };
    rootM.append(el('div', { class: 'modal-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'modal modal-wide filters-modal' }, el('div', { class: 'fm-head' }, el('h2', {}, 'Фильтры'), el('button', { type: 'button', class: 'icon-btn', onclick: close }, '✕')),
        el('div', { class: 'fm-body' }, panel.el),
        el('div', { class: 'fm-foot' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: reset }, 'Сбросить всё'), countBtn))));
    refresh();
  }


  // ---------- Нижняя панель: «Поиск» открывает экран поиска внутри приложения ----------
  function initMobile() {
    $('#search-open').addEventListener('click', () => go('search'));
    document.querySelector('.tab[data-tab="home"]').addEventListener('click', ev => { if ((location.hash || '#/') === '#/') { ev.preventDefault(); go('what'); } });
  }
  function updateTabbar() {
    const h = location.hash || '#/';
    const key = h === '#/my' ? 'my' : h.startsWith('#/cabinet') || h.startsWith('#/new') ? 'cab' : (h === '#/' ? 'home' : (h.startsWith('#/event') || h.startsWith('#/org') ? 'home' : ''));
    for (const t of document.querySelectorAll('.tabbar .tab')) t.classList.toggle('on', t.dataset.tab === key);
  }

  // Подсказки под строкой поиска: разделы, организации, названия, популярные запросы. Стрелки и Enter — выбор.
  const SG_KIND = { category: 'раздел', org: 'организация', event: 'событие', query: 'запрос' };
  const hlText = (text, qq) => { const i = text.toLowerCase().indexOf(qq.toLowerCase()); return i < 0 ? escHtml(text) : escHtml(text.slice(0, i)) + '<b>' + escHtml(text.slice(i, i + qq.length)) + '</b>' + escHtml(text.slice(i + qq.length)); };
  function attachSuggest(input, container, onPick) {
    const box = el('div', { class: 'suggest', hidden: true, role: 'listbox' });
    container.append(box);
    let items = [], active = -1, timer = null, lastQ = '';
    const close = () => { box.hidden = true; box.innerHTML = ''; items = []; active = -1; };
    const render = () => {
      box.innerHTML = ''; if (!items.length) return close();
      items.forEach((it, i) => box.append(el('button', { type: 'button', class: 'sg-item' + (i === active ? ' on' : ''), role: 'option', onmousedown: ev => ev.preventDefault(), onclick: () => pick(it) },
        it.logo ? el('img', { class: 'sg-logo', src: it.logo, alt: '' }) : el('span', { class: 'sg-ico' }, it.emoji || '🔎'),
        el('span', { class: 'sg-body' }, el('span', { class: 'sg-label', html: hlText(it.label, lastQ) }), it.sub ? el('span', { class: 'sg-sub' }, it.sub) : null),
        el('span', { class: 'sg-kind' }, SG_KIND[it.type] || ''))));
      box.hidden = false;
    };
    const pick = it => {
      close(); track('suggest_pick', { type: it.type, label: it.label });
      if (it.href) { location.hash = it.href; return; }
      input.value = it.q || it.label; $('#nav-q').value = input.value; input.focus(); // подставляем текст, искать будет сама кнопка «Найти»
    };
    input.addEventListener('input', () => {
      const v = input.value.trim(); clearTimeout(timer); if (v.length < 2) return close();
      timer = setTimeout(async () => { try { const d = await api(`/api/suggest?q=${encodeURIComponent(v)}`); if (input.value.trim() !== v) return; lastQ = v; items = d.items; active = -1; render(); } catch { close(); } }, 120);
    });
    input.addEventListener('keydown', ev => {
      if (box.hidden) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); active = (active + 1) % items.length; render(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
      else if (ev.key === 'Enter' && active >= 0) { ev.preventDefault(); pick(items[active]); }
      else if (ev.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    return box;
  }
  function initNavSearch() {
    renderFilters();
    const f = $('#nav-search'), i = $('#nav-q');
    i.value = S.q; livePlaceholder(i); attachSuggest(i, f, v => setQuery(v));
    f.addEventListener('submit', ev => { ev.preventDefault(); setQuery(i.value); });
    $('.logo').addEventListener('click', ev => { ev.preventDefault(); restart(); });
  }
  // «Найти» всегда ведёт к ленте: текст и все выбранные условия применяются вместе
  function setQuery(q, ai = false) {
    S.q = (q || '').trim(); S.ai = !!ai && !!S.q; S.aiOff = false; S.filtersDirty = false; track('search_submit', { q: S.q, ai: S.ai, with: S.withWhom, budget: S.budget });
    $('#nav-q').value = S.q;
    S.via = 'search';
    if (S.q) { S.cat = null; S.sub = null; }
    if (!['date', 'range', 'today', 'tomorrow', 'week', 'weekend'].includes(S.when) || S.q.split(/\s+/).length >= 3 || /сегодня|завтра|послезавтра|выходн|уикенд|на неделе|недели/i.test(S.q)) S.when = 'any'; // фраза сама задаёт время и день — показываем все дни
    go('when');
  }
  function restart() {
    S.q = ''; S.cat = null; S.sub = null; S.mood = null; S.cats = []; S.via = 'flow'; S.when = 'any'; S.withWhom = ''; S.kidAge = ''; S.budget = ''; S.tod = ''; S.noise = ''; S.subs = []; S.acts = []; S.districts = []; S.pmin = ''; S.pmax = ''; S.calOpen = false;
    $('#nav-q').value = '';
    renderFilters(); // сброс фильтров виден и в шапке
    go('what');
  }

  // ---------- Пошаговый подбор ----------
  const H = {};
  function syncNavSearch() { const f = $('#nav-search'); if (f) f.hidden = false; } // строка поиска всегда сверху, не прыгает
  function go(screen) {
    if (screen === 'search') { S.screen = 'what'; persist(); filtersModal(); return; }
    S.screen = screen; persist(); syncNavSearch(); track('screen', { screen, cat: S.cat, sub: S.sub, mood: S.mood, when: S.when });
    if (location.hash !== '#/' && location.hash !== '') { location.hash = '#/'; return; }
    renderScreen(); updateTabbar();
  }
  function renderHome() {
    const root = $('#app'); root.innerHTML = '';
    H.stage = el('div', { class: 'stage wrap' });
    root.append(H.stage);
    loadFacets();
    renderScreen();
  }
  async function loadFacets() {
    if (facets) return;
    try {
      const d = await api(`/api/events?from=${iso(today)}&to=${iso(addDays(today, 14))}`);
      const f = { cat: {}, sub: {}, with: {}, withSub: {}, mood: { calm: 0, active: 0, open: d.events.length } };
      for (const e of d.events) { f.cat[e.category] = (f.cat[e.category] || 0) + 1; f.sub[e.sub] = (f.sub[e.sub] || 0) + 1; for (const w of e.with || []) { f.with[w] = (f.with[w] || 0) + 1; (f.withSub[w] ||= {})[e.sub] = (f.withSub[w][e.sub] || 0) + 1; } }
      const [calm, active] = await Promise.all(['calm', 'active'].map(m => api(`/api/events?from=${iso(today)}&to=${iso(addDays(today, 14))}&mood=${m}`)));
      f.mood.calm = calm.events.length; f.mood.active = active.events.length;
      facets = f;
      if (['what', 'sub', 'mood'].includes(S.screen)) updateCounts();
    } catch { facets = null; }
  }
  const cnt = n => n ? `${n} ${plural(n, ['событие', 'события', 'событий'])} за 2 недели` : 'пока ничего';
  function updateCounts() { // только цифры под плитками
    if (!H.stage) return;
    for (const n of H.stage.querySelectorAll('[data-count]')) n.textContent = (n.dataset.short ? cntShort : cnt)(countOf(n.dataset.count));
  }

  // Меняем только содержимое сцены, остальная страница не трогается
  const showPlaceholder = root => root.append(el('div', { class: 'wrap page ph' }, el('div', { class: 'skeleton short', style: 'max-width:420px;height:40px;margin-bottom:16px' }), el('div', { class: 'skeleton' })));
  const clearPlaceholder = () => { const n = document.querySelector('#app .ph'); if (n) n.remove(); };
  function renderScreen() {
    if (!H.stage) return;
    H.stage.innerHTML = '';
    const panel = el('div', { class: 'screen' });
    H.stage.append(panel);
    ({ sub: screenSub, mood: screenMood, search: screenSearch }[S.screen] || screenFeed)(panel); // главная = лента событий; категории открываются из строки поиска
    if (S.screen !== H.lastScreen) window.scrollTo(0, 0); H.lastScreen = S.screen; // мгновенно и только при смене экрана: плавная прокрутка выглядела как дёрганье
  }
  function stepper(active) {
    const items = [['what', 'Что'], ['when', 'Когда'], ['results', 'Выбрать']];
    const idx = items.findIndex(i => i[0] === active);
    return el('div', { class: 'stepper' }, items.map(([k, t], i) => [el('span', { class: 'stp' + (i < idx ? ' done' : i === idx ? ' on' : '') }, el('span', { class: 'n' }, i < idx ? '✓' : i + 1), t), i < items.length - 1 ? el('span', { class: 'sep' }) : null]));
  }
  const backBtn = (label, onclick) => el('button', { type: 'button', class: 'back', onclick }, '← ', label);
  const ghost = (emoji, title, desc, onclick) => el('button', { type: 'button', class: 'opt-ghost', onclick }, el('span', { class: 'opt-ico ghost' }, emoji), el('span', { class: 'opt-body' }, el('b', {}, title), el('small', {}, desc)), el('span', { class: 'arrow' }, '→'));

  // Примеры фраз для строки поиска: каждые 7 секунд набирается новый, во всех строках поиска одновременно.
  // Пока человек печатает или поле в фокусе, подсказка не меняется.
  const EXAMPLES = ['хочу сходить познакомиться с девушкой', 'хотим с подружками сходить попеть песни', 'прогуляться с ребёнком в выходные', 'куда пойти одному вечером, спокойно', 'лазертаг с друзьями в субботу', 'что-то бесплатное сегодня', 'кино с ребёнком днём', 'квиз в четверг в 7 вечера', 'йога утром в центре', 'покататься на сапах', 'спектакль для детей в воскресенье', 'стендап до 1000 рублей', 'настолки с незнакомыми людьми', 'романтический вечер вдвоём', 'куда сходить с коллегами после работы', 'боулинг на следующих выходных', 'что-нибудь кроме кино завтра вечером', 'мастер-класс для ребёнка 6 лет'];
  const ROTATE_MS = 7000;
  let exIdx = Math.floor(Math.random() * EXAMPLES.length);
  const exInputs = new Set();
  const currentExample = () => EXAMPLES[exIdx];
  const randomExample = currentExample;
  function typeInto(input, text) {
    clearInterval(input._typing);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { input.placeholder = text; return; }
    let i = 0;
    input._typing = setInterval(() => {
      if (!input.isConnected || input.value) { clearInterval(input._typing); input.placeholder = text; return; }
      i++; input.placeholder = text.slice(0, i) + (i < text.length ? '|' : '');
      if (i >= text.length) clearInterval(input._typing);
    }, 38);
  }
  setInterval(() => {
    for (const inp of [...exInputs]) if (!inp.isConnected) exInputs.delete(inp);
    const idle = [...exInputs].filter(inp => !inp.value && document.activeElement !== inp);
    if (!idle.length || document.hidden) return;
    exIdx = (exIdx + 1) % EXAMPLES.length;
    for (const inp of idle) typeInto(inp, currentExample());
  }, ROTATE_MS);
  function livePlaceholder(input) {
    exInputs.add(input);
    if (input.value) input.placeholder = currentExample(); else typeInto(input, currentExample());
    return input;
  }
  // Подборки «с кем» и разделы по интересам: плитки как в Spotify — нажал, под рядом раскрылись блоки «Все» + уточнения
  const COLLECTIONS = [
    { key: 'kids', emoji: '👨‍👩‍👧', title: 'С детьми', desc: 'спектакли, мастер-классы, кружки, цирк, батуты', grad: 'linear-gradient(135deg,#fb7185,#f59e0b)', subs: ['kidstheatre', 'kidsclass', 'kidsedu', 'kidssport', 'kidsshow', 'kidscinema', 'circus', 'kidsclub', 'park', 'boat', 'skate', 'tour'] },
    { key: 'friends', emoji: '🧑‍🤝‍🧑', title: 'С друзьями', desc: 'квизы, VR, квесты, боулинг, вечеринки', grad: 'linear-gradient(135deg,#a855f7,#3b82f6)', subs: ['quiz', 'vr', 'quest', 'bowling', 'park', 'team', 'mafia', 'party', 'concert', 'standup', 'board', 'boat'] },
    { key: 'duo', emoji: '💞', title: 'Вдвоём', desc: 'кино, джаз, театр, теплоход, мастер-классы', grad: 'linear-gradient(135deg,#ec4899,#f43f5e)', subs: ['cinema', 'theatre', 'jazz', 'boat', 'tour', 'exhibition', 'workshop', 'classical', 'quest', 'bowling', 'skate', 'circus'] },
    { key: 'dogs', emoji: '🐕', title: 'С собакой', desc: 'прогулки, пробежки, маркеты, экскурсии', grad: 'linear-gradient(135deg,#a3e635,#16a34a)', subs: ['walk', 'run', 'tour', 'market', 'park', 'boat'] },
    { key: 'solo', emoji: '🙋', title: 'Одному', desc: 'пробежки, лекции, настолки, новые люди', grad: 'linear-gradient(135deg,#14b8a6,#0ea5e9)', subs: ['run', 'yoga', 'lecture', 'book', 'lang', 'stol', 'newcomers', 'board', 'exhibition', 'anticafe', 'climb', 'cinema'] },
  ];
  const WITH_LABEL = { dogs: '🐕 С собакой', kids: '👨‍👩‍👧 С детьми', friends: '🧑‍🤝‍🧑 С друзьями', duo: '💞 Вдвоём', solo: '🙋 Одному', tourist: '🧳 Гостям города' };
  const subAny = k => { for (const c of taxonomy) { const s = c.subs.find(x => x.key === k); if (s) return { ...s, cat: c.key }; } return null; };
  const cntShort = n => n ? `${n} ${plural(n, ['событие', 'события', 'событий'])}` : 'пока ничего';
  function browseGrid() {
    const grid = el('div', { class: 'opts browse' });
    const tiles = [
      ...COLLECTIONS.map(c => ({ kind: 'with', ...c })),
      ...taxonomy.map(c => ({ kind: 'cat', key: c.key, emoji: c.emoji, title: c.title, desc: c.subs.slice(0, 4).map(s => s.title.toLowerCase()).join(', '), grad: CAT_GRAD[c.key] || CAT_GRAD.culture })),
    ];
    const pick = (t, sub) => {
      S.q = ''; $('#nav-q').value = ''; S.mood = null; S.cats = []; S.subs = []; S.via = 'flow'; S.when = 'any';
      if (t.kind === 'with') { S.withWhom = t.key; S.cat = sub ? sub.cat : null; S.sub = sub ? sub.key : null; }
      else { S.withWhom = ''; S.cat = t.key; S.sub = sub ? sub.key : null; }
      track('browse_pick', { tile: t.key, sub: sub?.key || null });
      persist(); go('when');
    };
    const block = (emoji, title, countKey, grad, onclick) => el('button', { type: 'button', class: 'opt sm', onclick },
      el('span', { class: 'opt-ico', style: `background:${grad}` }, emoji),
      el('span', { class: 'opt-body' }, el('b', {}, title), el('small', { 'data-count': countKey, 'data-short': '1' }, facets ? cntShort(countOf(countKey)) : '')));
    const expandFor = t => {
      const subs = t.kind === 'with' ? t.subs.map(subAny).filter(Boolean) : (catOf(t.key)?.subs || []).map(s => ({ ...s, cat: t.key }));
      const blocks = [block(t.emoji, t.kind === 'with' ? `Все: ${t.title.toLowerCase()}` : `Всё: ${t.title.toLowerCase()}`, `${t.kind}:${t.key}`, t.grad, () => pick(t, null))];
      for (const s of subs) blocks.push(block(s.emoji, s.title, t.kind === 'with' ? `withsub:${t.key}:${s.key}` : `sub:${s.key}`, CAT_GRAD[s.cat] || t.grad, () => pick(t, s)));
      return el('div', { class: 'opt-expand' }, el('div', { class: 'opt-expand-grid' }, blocks));
    };
    const paint = () => {
      grid.innerHTML = '';
      for (const t of tiles) {
        const open = S.openTile === t.key;
        grid.append(el('button', { type: 'button', class: 'opt tile' + (open ? ' on' : ''), 'aria-expanded': String(open), onclick: () => { S.openTile = open ? null : t.key; paint(); if (!open) setTimeout(() => grid.querySelector('.opt-expand')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30); } },
          el('span', { class: 'opt-ico', style: `background:${t.grad}` }, t.emoji),
          el('span', { class: 'opt-body' }, el('b', {}, t.title), el('small', {}, t.desc)),
          el('span', { class: 'opt-n', 'data-count': `${t.kind}:${t.key}` }, facets ? cnt(countOf(`${t.kind}:${t.key}`)) : ''),
          el('span', { class: 'chev' }, open ? '▴' : '▾')));
        if (open) grid.append(expandFor(t));
      }
    };
    paint();
    return grid;
  }
  function countOf(key) { // 'cat:sport' | 'sub:run' | 'with:kids' | 'withsub:kids:tour'
    if (!facets) return 0;
    const [kind, a, b] = key.split(':');
    if (kind === 'withsub') return facets.withSub?.[a]?.[b] || 0;
    return facets[kind]?.[a] || 0;
  }
  function screenWhat(p) {
    // 1. Поиск — первая точка входа
    const q = livePlaceholder(el('input', { type: 'search', placeholder: 'Кино, пробежка, квиз, английский…', value: S.q, 'aria-label': 'Поиск событий', enterkeyhint: 'search', autocomplete: 'off' }));

    const heroForm = el('form', { class: 'hero-search', role: 'search', onsubmit: ev => { ev.preventDefault(); setQuery(q.value); } },
        el('span', { class: 'ico', html: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' }),
        q,
        el('button', { type: 'submit', class: 'go' }, el('span', {}, 'Найти'), ' →'));
    attachSuggest(q, heroForm, v => setQuery(v));
    const hero = el('section', { class: 'hero' },
      el('h1', { class: 'hero-title' }, 'Куда сходить в Казани?'),
      heroForm,
      (() => { const row = el('div', { class: 'hints when-row' }); const paint = () => { row.innerHTML = ''; row.append(el('span', { class: 'hints-label' }, 'Когда:'), ...[['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['weekend', 'Выходные'], ['week', 'На неделе'], ['any', 'Все дни']].map(([k, t]) => el('button', { type: 'button', class: 'chip' + (S.when === k ? ' on' : ''), onclick: () => { S.when = k; persist(); paint(); track('when_pick', { when: k, where: 'home' }); } }, t)), el('button', { type: 'button', class: 'chip chip-link', onclick: () => filtersModal() }, `⚙️ Фильтры${activeFilterCount(S) ? ' · ' + activeFilterCount(S) : ''}`)); }; paint(); return row; })());

    // 2. С кем и что: плитки раскрываются списком блоков (как жанры в Spotify)
    const cats = el('section', { class: 'entry-block' },
      el('div', { class: 'entry-head' }, el('h2', {}, 'Знаем, чем вам заняться'), el('p', { class: 'meta' }, 'Выберите, с кем идёте или что любите, — покажем варианты. А можно просто написать своими словами в строке поиска сверху.')),
      browseGrid(),
      ghost('✨', 'Подобрать по настроению', 'Спокойно, активно или сюрприз — три варианта за 10 секунд', () => go('mood')));

    // 3. Организаторам
    const promo = el('section', { class: 'org-promo' },
      el('div', { class: 'org-promo-text' },
        el('span', { class: 'org-promo-kicker' }, 'Организаторам'),
        el('h2', {}, 'Проводите квиз, клуб, пробежку или концерт? Добавьте событие'),
        el('p', {}, 'Бесплатно и навсегда, ИП не нужен. Страница события, запись гостей в один клик, напоминания, отчёт о новых гостях.'),
        el('ul', { class: 'org-promo-list' }, ['Публикация за 2 минуты', 'Напоминания гостям за 24 часа', 'Видно, сколько новых людей пришло через нас'].map(t => el('li', {}, '✓ ', t)))),
      el('div', { class: 'org-promo-cta' },
        el('a', { class: 'btn btn-primary btn-lg', href: '#/new' }, '+ Добавить событие'),
        el('span', { class: 'org-promo-note' }, 'Без договора и комиссии')));

    p.append(hero, cats, promo);
    if (!S.q && matchMedia('(min-width: 901px)').matches) setTimeout(() => q.focus({ preventScroll: true }), 50);
  }
  function screenSub(p) {
    const c = catOf(S.cat);
    if (!c) return screenWhat(p);
    p.append(backBtn('Другой интерес', () => go('what')), stepper('what'),
      el('h1', { class: 'q-title' }, `${c.emoji} ${c.title}: что именно?`),
      el('p', { class: 'q-sub' }, 'Можно не уточнять и смотреть всю категорию.'),
      el('div', { class: 'opts' }, c.subs.map(s => el('button', { type: 'button', class: 'opt', onclick: () => { S.sub = s.key; S.when = 'any'; go('when'); } },
        el('span', { class: 'opt-ico', style: `background:${CAT_GRAD[c.key]}` }, s.emoji),
        el('span', { class: 'opt-body' }, el('b', {}, s.title)),
        el('span', { class: 'opt-n', 'data-count': `sub:${s.key}` }, facets ? cnt(facets.sub[s.key] || 0) : '')))),
      ghost(c.emoji, `Всё из раздела «${c.title}»`, 'Покажите всё сразу — выберу в ленте', () => { S.sub = null; S.when = 'any'; go('when'); }));
  }
  function screenMood(p) {
    p.append(backBtn('К интересам', () => go('what')), stepper('what'),
      el('h1', { class: 'q-title' }, 'Какое настроение?'),
      el('p', { class: 'q-sub' }, 'Подберём форматы под него, а дальше выберем день.'),
      el('div', { class: 'opts moods' }, MOODS.map(m => el('button', { type: 'button', class: 'opt mood ' + m.key, onclick: () => { S.mood = m.key === 'open' ? null : m.key; S.cat = null; S.sub = null; S.cats = []; S.via = 'flow'; S.q = ''; $('#nav-q').value = ''; S.when = 'any'; go('when'); } },
        el('span', { class: 'opt-ico big' }, m.emoji),
        el('span', { class: 'opt-body' }, el('b', {}, m.title), el('small', {}, m.desc)),
        el('span', { class: 'opt-n', 'data-count': `mood:${m.key}` }, facets ? cnt(facets.mood[m.key]) : '')))));
  }
  // Единый месячный календарь для всего сайта. В ленте: счётчики событий, тап — день, зажать и провести — период.
  // В формах (opts.pick): выбор одной даты, без счётчиков, с границами min/max; тот же вид, те же жесты.
  function calendar(onPick, onRange, opts = {}) {
    const pick = !!opts.pick;
    const selK = pick ? (opts.sel || null) : null;
    const baseD = pick ? (selK ? parseIso(selK) : today) : null;
    const viewY = opts.y ?? (pick ? baseD.getFullYear() : S.calY), viewM = opts.m ?? (pick ? baseD.getMonth() : S.calM);
    const first = new Date(viewY, viewM, 1);
    const [ra, rb] = pick ? [selK, selK] : (S.when !== 'any' ? range() : [null, null]);
    const minK = pick ? (opts.min === null ? null : (opts.min || iso(today))) : iso(today);
    const maxK = pick ? (opts.max || null) : null;
    const canRange = !pick && !!onRange;
    const grid = el('div', { class: 'cal-grid' });
    for (const w of ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']) grid.append(el('div', { class: 'cal-wd' }, w));
    const start = addDays(first, -((first.getDay() + 6) % 7));
    const days = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i), k = iso(d), n = !pick && S.days ? (S.days[k] || 0) : 0, past = (minK && k < minK) || (maxK && k > maxK);
      const on = ra && k >= ra && k <= rb;
      const b = el('button', { type: 'button', 'data-k': k, class: ['cal-day', d.getMonth() !== viewM && 'other', past && 'past', k === iso(today) && 'today', d.getDay() % 6 === 0 && 'we', on && (ra === rb || k === ra || k === rb ? 'on' : 'range')].filter(Boolean).join(' ') },
        el('span', { class: 'd' }, d.getDate()),
        n && !past ? (n <= 3 ? el('span', { class: 'dots' }, Array.from({ length: n }, () => el('i'))) : el('span', { class: 'c' }, n)) : el('span', { class: 'dots' }));
      if (!past) days.push(b);
      grid.append(b);
    }
    // Жест: мышь — зажать и протянуть; палец — удержать 350 мс, потом вести (только там, где нужен период)
    let drag = null;
    const paint = () => {
      if (!drag) return;
      const [a, b] = [drag.start, drag.cur].sort();
      for (const d of days) { const k = d.dataset.k; const inside = k >= a && k <= b; d.classList.toggle('sel', inside && drag.active); d.classList.toggle('sel-edge', drag.active && (k === a || k === b)); }
    };
    const clearPaint = () => { for (const d of days) d.classList.remove('sel', 'sel-edge'); };
    if (canRange) {
      grid.addEventListener('pointerdown', ev => {
        const b = ev.target.closest('.cal-day'); if (!b || b.classList.contains('past') || !b.dataset.k) return;
        drag = { start: b.dataset.k, cur: b.dataset.k, active: ev.pointerType === 'mouse', moved: false, x: ev.clientX, y: ev.clientY, id: ev.pointerId };
        if (!drag.active) drag.timer = setTimeout(() => { if (drag && !drag.moved) { drag.active = true; navigator.vibrate?.(12); grid.classList.add('dragging'); paint(); } }, 350);
      });
      grid.addEventListener('pointermove', ev => {
        if (!drag) return;
        if (!drag.active) { if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 8) { clearTimeout(drag.timer); drag = null; } return; }
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.cal-day');
        if (over?.dataset.k && !over.classList.contains('past') && over.dataset.k !== drag.cur) { drag.cur = over.dataset.k; paint(); }
      });
      grid.addEventListener('touchmove', ev => { if (drag?.active) ev.preventDefault(); }, { passive: false });
      grid.addEventListener('contextmenu', ev => { if (drag) ev.preventDefault(); });
      const finish = ev => {
        if (!drag) return;
        clearTimeout(drag.timer);
        const d = drag; drag = null; grid.classList.remove('dragging'); clearPaint();
        if (d.active && d.cur !== d.start) { const [a, b] = [d.start, d.cur].sort(); store.set('aidaem_cal_hint', true); onRange(a, b); return; }
        if (d.active) { onPick(d.start); return; } // долгое удержание без движения — как тап
        if (ev.type === 'pointerup' && ev.pointerType !== 'mouse') onPick(d.start); // обычный тап пальцем
      };
      grid.addEventListener('pointerup', finish);
      grid.addEventListener('pointercancel', () => { if (drag) clearTimeout(drag.timer); drag = null; grid.classList.remove('dragging'); clearPaint(); });
    }
    grid.addEventListener('click', ev => { if (!canRange || ev.pointerType === 'mouse' || ev.detail === 0) { const b = ev.target.closest('.cal-day'); if (b?.dataset.k && !b.classList.contains('past') && !drag) onPick(b.dataset.k); } });

    const minD = minK ? parseIso(minK) : new Date(today.getFullYear() - 1, 0, 1);
    const minM = new Date(minD.getFullYear(), minD.getMonth(), 1);
    const maxM = maxK ? (d => new Date(d.getFullYear(), d.getMonth(), 1))(parseIso(maxK)) : null;
    let root;
    const nav = dir => {
      const d = new Date(viewY, viewM + dir, 1); if (d < minM || (maxM && d > maxM)) return;
      if (pick) { root.replaceWith(calendar(onPick, onRange, { ...opts, y: d.getFullYear(), m: d.getMonth() })); return; }
      S.calY = d.getFullYear(); S.calM = d.getMonth(); H.cal.replaceWith(calendar(onPick, onRange));
    };
    root = el('div', { class: 'cal' + (pick ? ' cal-pick' : '') },
      el('div', { class: 'cal-head' },
        el('button', { type: 'button', class: 'icon-btn', disabled: first <= minM, onclick: () => nav(-1) }, '‹'),
        el('span', { class: 'month' }, cap(first.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', ''))),
        el('button', { type: 'button', class: 'icon-btn', disabled: !!(maxM && first >= maxM), onclick: () => nav(1) }, '›')),
      grid,
      canRange ? el('div', { class: 'cal-foot' }, matchMedia('(pointer: coarse)').matches ? 'Тап — день. Зажмите и проведите — период.' : 'Клик — день. Зажмите мышь и протяните — период.') : null);
    if (!pick) { H.cal = root; if (!store.get('aidaem_cal_hint', false)) root.append(calHint()); }
    return root;
  }
  // Поле даты в формах: кнопка в стиле обычного поля, по тапу — тот же календарь листом. У элемента есть .value (ISO) как у input[type=date]
  const fmtDateBtn = d => cap(d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' }));
  function dateField(v, o = {}) {
    let val = v || '';
    const btn = el('button', { type: 'button', class: 'input date-btn' });
    const paint = () => { btn.classList.toggle('empty', !val); btn.innerHTML = ''; btn.append(el('span', {}, val ? fmtDateBtn(parseIso(val)) : (o.placeholder || 'Выберите дату')), el('span', { class: 'ico' }, '📅')); };
    Object.defineProperty(btn, 'value', { get: () => val, set: x => { val = x || ''; paint(); } });
    btn.onclick = () => {
      const host = el('div', { class: 'modal-bg sheet-bg date-bg', style: 'z-index:70' }); host.addEventListener('click', ev => { if (ev.target === host) host.remove(); });
      const done = k => { val = k || ''; paint(); host.remove(); o.onchange?.(); };
      const minK = o.min === null ? null : (o.min || iso(today));
      const quick = [['Сегодня', iso(today)], ['Завтра', iso(addDays(today, 1))]].filter(([, k]) => (!minK || k >= minK) && (!o.max || k <= o.max));
      host.append(el('div', { class: 'date-sheet' }, el('div', { class: 'sheet-grip' }), el('div', { class: 'sheet-head' }, el('b', {}, o.title || 'Выберите дату'), el('button', { type: 'button', class: 'icon-btn', onclick: () => host.remove() }, '✕')),
        calendar(done, null, { pick: true, sel: val, min: o.min, max: o.max }),
        el('div', { class: 'pills', style: 'margin-top:10px' }, quick.map(([t, k]) => el('button', { type: 'button', class: 'pill' + (val === k ? ' on' : ''), onclick: () => done(k) }, t)), o.allowEmpty ? el('button', { type: 'button', class: 'pill', onclick: () => done('') }, 'Очистить') : null)));
      document.body.append(host);
    };
    paint(); return btn;
  }
  // Подсказка про жест — показывается один раз
  function calHint() {
    const coarse = matchMedia('(pointer: coarse)').matches;
    const box = el('div', { class: 'cal-hint' },
      el('div', { class: 'cal-hint-demo' }, el('span', { class: 'cell' }, '24'), el('span', { class: 'cell' }, '25'), el('span', { class: 'cell' }, '26'), el('span', { class: 'cell' }, '27'), el('span', { class: 'finger' }, coarse ? '👆' : '🖱️')),
      el('div', { class: 'cal-hint-text' }, el('b', {}, 'Выберите сразу несколько дней'), coarse ? 'Зажмите день и, не отпуская, проведите пальцем до нужной даты.' : 'Зажмите кнопку мыши на дне и протяните до нужной даты.'),
      el('button', { type: 'button', class: 'btn btn-ink btn-sm', onclick: () => { store.set('aidaem_cal_hint', true); box.remove(); } }, 'Понятно'));
    return box;
  }

  // ---------- Экран «Когда?»: лента событий как у Luma + календарь ----------
  function screenFeed(p) {
    H.feed = el('div', { class: 'feed' });
    H.calCol = el('aside', { class: 'feed-side' });
    H.quick = el('div', { class: 'feed-quick' }); // периоды и кнопки рисуются сюда для совместимости; на экране их заменяет лента дней
    // Строка поиска сверху: запрос (уже без опечаток) можно поправить, фильтры — внутри строки
    const hasPick = !!(S.cat || S.cats.length || S.withWhom || S.mood || S.subs.length || S.acts.length);
    const fq = (H.fq = el('input', { type: 'search', value: S.q, placeholder: hasPick ? `${whatTitle().replace(/^✨ /, '')} — уточните словами` : '', 'aria-label': 'Поиск событий', enterkeyhint: 'search', autocomplete: 'off' }));
    if (!hasPick) livePlaceholder(fq); // без выбранного раздела — примеры запросов, как в шапке
    const form = el('form', { class: 'hero-search feed-search', role: 'search', onsubmit: ev => { ev.preventDefault(); fq.blur(); setQuery(fq.value); } },
      el('span', { class: 'ico', html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' }),
      fq, el('div', { class: 'search-filters', 'data-filters': true }), el('button', { type: 'submit', class: 'go', 'aria-label': 'Найти' }, '→'));
    attachSuggest(fq, form, v => setQuery(v));
    // Категории: показываются, когда человек нажал на строку поиска и ещё ничего не ввёл
    H.browse = el('div', { class: 'browse-panel', hidden: true },
      el('div', { class: 'entry-head' }, el('h2', {}, 'Знаем, чем вам заняться'), el('p', { class: 'meta' }, 'Выберите, с кем идёте или что любите, — или напишите своими словами.'), el('button', { type: 'button', class: 'icon-btn bp-close', 'aria-label': 'Закрыть', onclick: () => hideBrowse() }, '✕')),
      browseGrid(), ghost('✨', 'Подобрать по настроению', 'Спокойно, активно или сюрприз — три варианта за 10 секунд', () => { hideBrowse(); go('mood'); }));
    for (const inp of [fq, $('#nav-q')]) wireBrowse(inp);
    const calBtn = el('button', { type: 'button', class: 'day-pill cal-btn', title: 'Выбрать день или период', 'aria-label': 'Календарь', onclick: () => calendarSheet() }, el('span', { class: 'cal-ico', html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>' }), el('span', {}, 'даты'));
    p.append(form, el('div', { class: 'feed-layout' }, el('div', { class: 'feed-main' }, H.browse, el('div', { class: 'strip-row' }, calBtn, (H.strip = el('div', { class: 'day-strip feed-strip' }))), H.feed), H.calCol));
    renderQuick(); renderSide();
    fetchFeed();
  }
  function showBrowse() { if (H.browse?.isConnected) { H.browse.hidden = false; document.body.classList.add('browse-open'); } }
  function hideBrowse() { if (H.browse) H.browse.hidden = true; document.body.classList.remove('browse-open'); }
  function wireBrowse(inp) {
    if (!inp || inp._browse) return; inp._browse = true;
    inp.addEventListener('focus', () => { if (!inp.value.trim()) showBrowse(); });
    inp.addEventListener('click', () => { if (!inp.value.trim()) showBrowse(); });
    inp.addEventListener('input', () => { if (inp.value.trim()) hideBrowse(); else showBrowse(); });
    inp.addEventListener('keydown', ev => { if (ev.key === 'Escape') { hideBrowse(); inp.blur(); } });
  }
  document.addEventListener('pointerdown', ev => { if (!H.browse || H.browse.hidden) return; if (ev.target.closest('.browse-panel, .feed-search, #nav-search, .modal-bg')) return; hideBrowse(); });
  const freshCal = () => calendar(k => pickWhen('date', k), (a, b) => pickRange(a, b));
  function pickWhen(key, date) { S.when = key; if (date) S.date = date; persist(); renderQuick(); if (H.cal?.isConnected) H.cal.replaceWith(freshCal()); fetchFeed(); }
  function pickRange(a, b) { S.when = 'range'; S.from = a; S.to = b; persist(); renderQuick(); if (H.cal?.isConnected) H.cal.replaceWith(freshCal()); fetchFeed(); toast(`Период: ${whenTitle()}`); }
  function renderQuick() {
    H.quick.innerHTML = '';
    const mk = (key, label) => el('button', { type: 'button', class: 'pill' + (S.when === key ? ' on' : ''), onclick: () => pickWhen(key) }, label);
    H.quick.append(mk('any', 'Все дни'), mk('today', 'Сегодня'), mk('tomorrow', 'Завтра'), mk('week', 'На этой неделе'), mk('weekend', 'Выходные'));
    if (S.when === 'date' || S.when === 'range') H.quick.append(el('span', { class: 'pill on' }, S.when === 'date' ? fmtDM(parseIso(S.date)) : whenTitle(), el('button', { type: 'button', class: 'pill-x', title: 'Все дни', onclick: () => pickWhen('any') }, '✕')));
    H.quick.append(el('button', { type: 'button', class: 'pill side-toggle', onclick: () => calendarSheet() }, '📅 Даты'));
    H.quick.append(el('button', { type: 'button', class: 'pill side-toggle' + (S.calOpen ? ' on' : ''), onclick: ev => { S.calOpen = !S.calOpen; H.calCol.classList.toggle('open', S.calOpen); ev.currentTarget.classList.toggle('on', S.calOpen); setTimeout(() => H.map?.invalidate(), 60); } }, '🗺️ Карта'));
    H.quick.append(el('div', { class: 'feed-filters', 'data-filters': true }));
    renderFilters();
  }
  // Лента ближайших дней (телефон): число событий в день, тап — выбрать день
  function paintStrip() {
    if (!H.strip?.isConnected) return;
    H.strip.innerHTML = '';
    const sel = S.when === 'today' ? iso(today) : S.when === 'tomorrow' ? iso(addDays(today, 1)) : S.when === 'date' ? S.date : null;
    const total = S.allCount ?? Object.values(S.days || {}).reduce((a, b) => a + b, 0);
    H.strip.append(el('button', { type: 'button', class: 'day-pill' + (S.when === 'any' ? ' on' : ''), onclick: () => pickWhen('any') }, el('b', {}, 'Все'), el('span', {}, total ? String(total) : '—')));
    for (let i = 0; i < 14; i++) {
      const d = addDays(today, i), k = iso(d), n = S.days?.[k] || 0;
      H.strip.append(el('button', { type: 'button', class: 'day-pill' + (sel === k ? ' on' : '') + (d.getDay() % 6 === 0 ? ' we' : '') + (!n && sel !== k ? ' zero' : ''), title: n ? `${n} ${plural(n, ['событие', 'события', 'событий'])}` : 'В этот день по запросу ничего нет', onclick: () => pickWhen(i === 0 ? 'today' : i === 1 ? 'tomorrow' : 'date', k) },
        el('b', {}, i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : `${WD[d.getDay()]} ${d.getDate()}`), el('span', {}, n ? `${n}` : '—')));
    }
    if (S.when === 'range' || S.when === 'week' || S.when === 'weekend') H.strip.append(el('button', { type: 'button', class: 'day-pill on', onclick: () => calendarSheet() }, el('b', {}, whenTitle().split(' · ')[0]), el('span', {}, 'период')));
    H.strip.append(el('button', { type: 'button', class: 'day-pill tool only-phone' + (S.calOpen ? ' on' : ''), title: 'Карта', onclick: ev => { S.calOpen = !S.calOpen; H.calCol.classList.toggle('open', S.calOpen); ev.currentTarget.classList.toggle('on', S.calOpen); if (S.calOpen) { H.calCol.scrollIntoView({ block: 'start', behavior: 'smooth' }); setTimeout(() => H.map?.invalidate(), 60); } } }, el('b', {}, '🗺️'), el('span', {}, 'карта')));
  }
  // Месячный календарь листом снизу: выбрать день или период жестом, потом лист закрывается
  function calendarSheet(draft = null, after = null) {
    const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; };
    const host = draft ? el('div', { class: 'modal-bg sheet-bg', style: 'z-index:60' }) : null;
    const cal = draft ? calendar(k => { draft.when = 'date'; draft.date = k; host.remove(); after?.(); }, (a, b) => { draft.when = 'range'; draft.from = a; draft.to = b; host.remove(); after?.(); }) : calendar(k => { pickWhen('date', k); close(); }, (a, b) => { pickRange(a, b); close(); });
    if (draft) { host.addEventListener('click', ev => { if (ev.target === host) host.remove(); }); host.append(el('div', { class: 'sheet' }, el('div', { class: 'sheet-grip' }), el('div', { class: 'sheet-head' }, el('b', {}, 'Выберите день или период'), el('button', { type: 'button', class: 'icon-btn', onclick: () => host.remove() }, '✕')), cal)); document.body.append(host); return; }
    rootM.append(el('div', { class: 'modal-bg sheet-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'sheet' }, el('div', { class: 'sheet-grip' }), el('div', { class: 'sheet-head' }, el('b', {}, 'Выберите день или период'), el('button', { type: 'button', class: 'icon-btn', onclick: close }, '✕')),
        el('div', { class: 'meta', style: 'margin-bottom:8px' }, 'Зажмите день и проведите до нужной даты, чтобы выбрать период.'), cal,
        el('div', { class: 'pills', style: 'margin-top:10px' }, [['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['weekend', 'Выходные'], ['week', 'На неделе'], ['any', 'Все дни']].map(([k, t]) => el('button', { type: 'button', class: 'pill' + (S.when === k ? ' on' : ''), onclick: () => { pickWhen(k); close(); } }, t))))));
  }
  function renderSide() {
    H.calCol.innerHTML = '';
    H.calCol.classList.toggle('open', S.calOpen);
    H.mapHead = el('div', { class: 'side-map-head' }, 'Карта');
    if (!H.mapEl) H.mapEl = el('div', { class: 'map' });
    H.calCol.append(el('div', { class: 'side-map' }, H.mapHead, H.mapEl),
      el('p', { class: 'side-hint' }, 'На карте — события выбранного дня. День или период выбираются в ленте дней над выдачей.'));
    requestAnimationFrame(armMap);
  }
  // ---------- Карта событий выбранного дня: Яндекс Карты, запасной вариант — Leaflet ----------
  const KAZAN = [55.79, 49.12];
  const escHtml = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let config = null;
  async function loadConfig() { if (!config) { try { config = await api('/api/config'); } catch { config = {}; } } return config; }
  let ymapsPromise = null;
  function loadYmaps(key) {
    if (window.ymaps?.Map) return Promise.resolve(window.ymaps);
    if (ymapsPromise) return ymapsPromise;
    ymapsPromise = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = `https://api-maps.yandex.ru/2.1/?lang=ru_RU${key ? '&apikey=' + encodeURIComponent(key) : ''}`;
      const timer = setTimeout(() => reject(new Error('timeout')), 9000);
      sc.onload = () => { if (!window.ymaps) return reject(new Error('no ymaps')); window.ymaps.ready(() => { clearTimeout(timer); window.ymaps.Map ? resolve(window.ymaps) : reject(new Error('no Map')); }); };
      sc.onerror = () => { clearTimeout(timer); reject(new Error('load')); };
      document.head.append(sc);
    });
    ymapsPromise.catch(() => { ymapsPromise = null; });
    return ymapsPromise;
  }
  // Единый интерфейс для двух картографических движков
  function yandexAdapter(ymaps, elMap) {
    const map = new ymaps.Map(elMap, { center: KAZAN, zoom: 12, controls: ['zoomControl'] }, { suppressMapOpenBlock: true, yandexMapDisablePoiInteractivity: true });
    const layout = ymaps.templateLayoutFactory.createClass('<div class="ypin"><div class="pin" style="background:$[properties.grad]"><span>$[properties.emoji]</span></div></div>');
    const group = new ymaps.GeoObjectCollection();
    map.geoObjects.add(group);
    return {
      kind: 'yandex',
      clear() { group.removeAll(); },
      add(e, html) {
        group.add(new ymaps.Placemark([e.lat, e.lng], { grad: CAT_GRAD[e.category], emoji: e.emoji, balloonContent: `<div class="ybal">${html}</div>` },
          { iconLayout: layout, iconShape: { type: 'Circle', coordinates: [0, -17], radius: 18 }, hideIconOnBalloonOpen: false, balloonOffset: [0, -30] }));
      },
      fit(pts) {
        if (!pts.length) return map.setCenter(KAZAN, 12);
        if (pts.length === 1) return map.setCenter(pts[0], 15);
        const lats = pts.map(p => p[0]), lngs = pts.map(p => p[1]);
        map.setBounds([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]], { checkZoomRange: true, zoomMargin: 36 }).then(() => { if (map.getZoom() > 15) map.setZoom(15); });
      },
      invalidate() { map.container.fitToViewport(); },
      destroy() { map.destroy(); },
    };
  }
  function leafletAdapter(elMap) {
    const map = L.map(elMap, { scrollWheelZoom: false, zoomControl: true }).setView(KAZAN, 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
    const group = L.layerGroup().addTo(map);
    return {
      kind: 'leaflet',
      clear() { group.clearLayers(); },
      add(e, html) {
        group.addLayer(L.marker([e.lat, e.lng], { icon: L.divIcon({ className: 'pin-wrap', html: `<div class="pin" style="background:${CAT_GRAD[e.category]}"><span>${e.emoji}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -32] }) }).bindPopup(`<div class="pop">${html}</div>`));
      },
      fit(pts) { map.invalidateSize(); if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 }); else map.setView(KAZAN, 12); },
      invalidate() { map.invalidateSize(); },
      destroy() { map.remove(); },
    };
  }
  // Слабое устройство: мало памяти/ядер, экономия трафика или «меньше анимации» — карту грузим только по кнопке
  const LITE = (navigator.deviceMemory && navigator.deviceMemory <= 4) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || !!navigator.connection?.saveData || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (LITE) document.documentElement.classList.add('lite');
  function armMap() {
    const elMap = H.mapEl; if (!elMap) return;
    if (H.map) { H.map.invalidate(); return; }
    const start = () => { elMap.innerHTML = ''; elMap.classList.remove('map-idle'); initMap(); };
    if (LITE && !H.mapWanted) {
      elMap.classList.add('map-idle'); elMap.innerHTML = '';
      elMap.append(el('button', { type: 'button', class: 'btn btn-outline btn-sm map-show', onclick: () => { H.mapWanted = true; start(); } }, '🗺️ Показать карту'),
        el('div', { class: 'help' }, 'Карту не грузим заранее, чтобы не тормозить телефон'));
      return;
    }
    // Инициализация только когда блок реально виден (на телефоне календарь и карта свёрнуты)
    if (H.mapObs) H.mapObs.disconnect();
    H.mapObs = new IntersectionObserver(entries => { if (entries.some(x => x.isIntersecting && x.boundingClientRect.width > 0)) { H.mapObs.disconnect(); H.mapObs = null; start(); } }, { rootMargin: '200px' });
    H.mapObs.observe(elMap);
  }
  async function initMap() {
    const elMap = H.mapEl;
    if (!elMap?.isConnected || H.map || H.mapLoading) return;
    H.mapLoading = true;
    const cfg = await loadConfig();
    let adapter = null;
    try { adapter = yandexAdapter(await loadYmaps(cfg.yandexMapsKey), elMap); }
    catch (err) { console.warn('Яндекс Карты недоступны, показываем OpenStreetMap:', err.message); if (window.L && elMap.isConnected) adapter = leafletAdapter(elMap); }
    H.mapLoading = false;
    if (!adapter || !elMap.isConnected) return;
    H.map = adapter;
    if (H.pendingMap) { updateMap(H.pendingMap); H.pendingMap = null; }
  }
  function updateMap(list) {
    if (!H.map) { H.pendingMap = list; if (H.mapHead) { H.mapHead.innerHTML = ''; const n = (S.when === 'any' ? list.filter(e => e.date === list[0]?.date) : list).filter(e => e.lat != null).length; H.mapHead.append(el('span', {}, `На карте: ${whenTitle()}`), el('span', { class: 'n' }, `${n} ${plural(n, ['точка', 'точки', 'точек'])}`)); } return; }
    let subset = list, label = whenTitle();
    if (S.when === 'any') { // без выбранного дня показываем ближайший день с событиями
      const k = list[0]?.date; subset = k ? list.filter(e => e.date === k) : [];
      label = k ? (k === iso(today) ? 'Сегодня, ' : k === iso(addDays(today, 1)) ? 'Завтра, ' : '') + fmtDM(parseIso(k)) : 'ближайшие дни';
    }
    H.map.clear();
    const pts = [];
    for (const e of subset) {
      if (e.lat == null || e.lng == null) continue;
      const t = new Date(e.start);
      H.map.add(e, `<div class="pop-t">${escHtml(e.title)}</div><div class="pop-s">${fmtTime(t)} · ${escHtml(e.venue)} · ${fmtPrice(e.price)}</div><a class="pop-a" href="#/event/${e.slug}">Открыть →</a>`);
      pts.push([e.lat, e.lng]);
    }
    const noPt = subset.length - pts.length;
    H.mapHead.innerHTML = '';
    H.mapHead.append(el('span', {}, `На карте: ${label}`), el('span', { class: 'n' }, `${pts.length} ${plural(pts.length, ['точка', 'точки', 'точек'])}${noPt ? ` · ${noPt} без адреса` : ''}`));
    H.map.invalidate();
    H.map.fit(pts);
  }
  function params(from, to, st = S) {
    const p = new URLSearchParams({ from, to });
    if (st.q) { p.set('q', st.q); p.set('ai', st.aiOff ? '0' : st.ai ? '1' : 'auto'); } if (st.cats.length) p.set('cat', st.cats.join(',')); else if (st.cat) p.set('cat', st.cat);
    if (st.subs?.length) p.set('sub', st.subs.join(',')); else if (st.sub) p.set('sub', st.sub); if (st.acts?.length) p.set('act', st.acts.join(',')); if (st.districts?.length) p.set('district', st.districts.join(',')); if (st.mood) p.set('mood', st.mood);
    if (st.withWhom) p.set('with', st.withWhom); if (st.withWhom === 'kids' && st.kidAge !== '' && st.kidAge != null) p.set('age', st.kidAge); if (st.pmin !== '' && st.pmin != null) p.set('pmin', st.pmin); if (st.pmax !== '' && st.pmax != null) p.set('pmax', st.pmax); if (st.tod) p.set('tod', st.tod); if (st.noise) p.set('noise', st.noise);
    return p;
  }
  const FILTER_KEYS = ['cats', 'subs', 'acts', 'districts', 'mood', 'withWhom', 'kidAge', 'pmin', 'pmax', 'tod', 'noise', 'when', 'date', 'from', 'to'];
  const activeFilterCount = st => (st.cats.length || st.cat ? 1 : 0) + (st.subs?.length ? 1 : 0) + (st.acts?.length ? 1 : 0) + (st.districts?.length ? 1 : 0) + (st.mood ? 1 : 0) + (st.withWhom ? 1 : 0) + ((st.pmin !== '' && st.pmin != null) || (st.pmax !== '' && st.pmax != null) ? 1 : 0) + (st.tod ? 1 : 0) + (st.noise ? 1 : 0);
  let reqId = 0;
  async function fetchFeed() {
    if (H.whatB?.isConnected) H.whatB.textContent = whatTitle(); // заголовок отражает текущие фильтры
    const id = ++reqId;
    H.feed.classList.add('loading');
    if (!H.feed.children.length) H.feed.append(el('div', { class: 'feed-skel' }, [1, 2, 3].map(() => el('div', { class: 'skeleton short' }))));
    const [from, to] = range();
    let data;
    try { data = await api(`/api/events?${params(from, to)}`); H.ungroup = false; } catch { if (id === reqId) { H.feed.classList.remove('loading'); H.feed.innerHTML = ''; H.feed.append(el('div', { class: 'empty' }, el('div', { class: 'e' }, '⚠️'), el('b', {}, 'Сервер недоступен.'), ' Проверьте, запущена ли база данных.')); } return; }
    if (id !== reqId || !H.feed.isConnected) return;
    S.days = data.days; S.allCount = new Set((data.events || []).map(e => e.seriesKey || e.id)).size; // для «Все»: разные события, как в заголовке
    if (data.ai?.when && data.ai.dates) { // фраза задала даты — показываем это в кнопках периода
      const w = data.ai.when === 'dayafter' ? 'date' : data.ai.when;
      const changed = S.when !== w || (w === 'date' && S.date !== data.ai.dates.from) || (w === 'range' && (S.from !== data.ai.dates.from || S.to !== data.ai.dates.to));
      if (changed) { S.when = w; if (w === 'date') S.date = data.ai.dates.from; if (w === 'range') { S.from = data.ai.dates.from; S.to = data.ai.dates.to; } persist(); renderQuick(); if (H.cal?.isConnected) H.cal.replaceWith(freshCal()); }
    }
    paintStrip();
    if (H.cal?.isConnected) H.cal.replaceWith(freshCal()); // обновляем только календарь
    renderFeed(data);
    updateMap(data.events);
  }
  // В режиме «Все дни» серия (фильм, квиз по вторникам, прокат) показывается один раз — в ближайший день, с пометкой «ещё N дат».
  // Иначе один фильм с сеансами на 60 дней займёт всю ленту.
  function collapseSeries(list) {
    H.moreDates = null;
    if (S.when !== 'any') return list;
    const dates = new Map();
    for (const e of list) if (e.seriesKey) { if (!dates.has(e.seriesKey)) dates.set(e.seriesKey, new Set()); dates.get(e.seriesKey).add(e.date); }
    const first = new Map([...dates].map(([k, d]) => [k, [...d].sort()[0]]));
    H.moreDates = new Map([...dates].filter(([, d]) => d.size > 1).map(([k, d]) => { const all = [...d].sort(); return [k, { n: all.length - 1, last: all[all.length - 1] }]; }));
    return list.filter(e => !e.seriesKey || first.get(e.seriesKey) === e.date);
  }
  function renderFeed(data) {
    H.feed.classList.remove('loading');
    H.feed.innerHTML = '';
    const box = el('div', { class: 'swap' });
    const list = data.events, n = list.length;
    const shown = S.when === 'any' ? new Set(list.map(e => e.seriesKey || 'e' + e.id)).size : [...new Set(list.map(e => e.seriesKey && SLOTTED.has(e.kind) ? `${e.date}:${e.seriesKey}` : String(e.id)))].length;
    box.append(el('div', { class: 'feed-title' }, el('h2', {}, whenTitle()), el('span', { class: 'meta' }, `${shown} ${plural(shown, ['событие', 'события', 'событий'])}`)));
    const shownQ = data.ai?.fixed || data.corrected || null; // опечатки исправлены — показываем исправленный запрос там, где его можно поправить
    if (shownQ && S.q && shownQ !== S.q) { S.q = shownQ; persist(); }
    if (H.fq?.isConnected && S.q) H.fq.value = S.q;
    if ($('#nav-q') && S.q) $('#nav-q').value = S.q;
    if (n >= 4) {
      const picked = [], subs = new Set(), orgs = new Set();
      const base = list.filter(e => !e.promoted); // реклама в подбор не попадает никогда
      const pool = S.withWhom === 'solo' ? base.filter(e => e.stol).concat(base.filter(e => !e.stol)) : base;
      for (const e of pool) { if (subs.has(e.sub) || orgs.has(e.organizer.id)) continue; picked.push(e); subs.add(e.sub); orgs.add(e.organizer.id); if (picked.length === 3) break; }
      for (const e of pool) { if (picked.length === 3) break; if (!picked.includes(e) && !orgs.has(e.organizer.id)) { picked.push(e); orgs.add(e.organizer.id); } }
      if (picked.length === 3) box.append(el('div', { class: 'picks' }, el('div', { class: 'picks-head' }, el('h3', {}, '⚡ Три варианта за 10 секунд'), el('span', { class: 'meta' }, 'разные форматы, без рекламы')), el('div', { class: 'grid picks-grid' }, picked.map(card))));
    }
    if (!n) {
      box.append(el('div', { class: 'empty' }, el('div', { class: 'e' }, '🫥'), el('b', {}, S.q ? 'Ничего не нашли по этому запросу.' : 'В этот день ничего не нашли.'), el('div', {}, 'Ниже — ближайшее по вашему выбору.'),
        el('div', {}, el('button', { type: 'button', class: 'btn btn-outline', onclick: () => pickWhen('any') }, 'Показать все дни'))));
      if (data.total) { const holder = el('div', {}); box.append(holder); api(`/api/events?${params(iso(today), iso(addDays(today, 45)))}`).then(d => holder.append(timeline(d.events.slice(0, 15)))).catch(() => {}); }
    } else box.append(timeline(collapseSeries(list)));
    H.feed.append(box);
  }
  // Лента как у Luma: вертикальная линия, точка у каждого дня, компактные карточки
  function timeline(list, pageCards = 40) {
    const wrap = el('div', { class: 'timeline' });
    const map = new Map();
    for (const e of list) { if (!map.has(e.date)) map.set(e.date, []); map.get(e.date).push(e); }
    const days = [...map].map(([k, items]) => [k, groupSlots(items)]);
    let i = 0;
    const more = el('div', { class: 'tl-more' });
    const renderChunk = () => { // порция дней: пока не наберётся ~pageCards карточек, дальше кнопка «Показать ещё»
      let n = 0;
      while (i < days.length && (n === 0 || n + days[i][1].length <= pageCards)) {
        const [k, groupsOfDay] = days[i++]; n += groupsOfDay.length;
        const d = parseIso(k);
        const rel = k === iso(today) ? 'Сегодня' : k === iso(addDays(today, 1)) ? 'Завтра' : cap(d.toLocaleDateString('ru-RU', { weekday: 'long' }));
        more.before(el('section', { class: 'tl-day' },
          el('div', { class: 'tl-head' }, el('span', { class: 'tl-dot' }), el('b', {}, fmtDM(d)), el('span', { class: 'tl-wd' }, rel)),
          el('div', { class: 'tl-items' }, groupsOfDay.map(g => g.length > 1 ? slotCard(g) : fcard(g[0])))));
      }
      more.innerHTML = '';
      if (i < days.length) { const left = days.slice(i).reduce((a, [, g]) => a + g.length, 0); more.append(el('button', { type: 'button', class: 'btn btn-outline', onclick: renderChunk }, `Показать ещё · ${left} ${plural(left, ['карточка', 'карточки', 'карточек'])} в ${days.length - i} ${plural(days.length - i, ['дне', 'днях', 'днях'])}`)); }
    };
    wrap.append(more); renderChunk();
    return wrap;
  }
  const SLOTTED = new Set(['sessions', 'rental', 'groups']);
  const KIND_LABEL = { sessions: 'Сеансы', rental: 'Прокат по часам', groups: 'Сеансы с группами', open: 'Свободное посещение', regular: 'Регулярное занятие', single: 'Событие' };
  function groupSlots(items) {
    if (H.ungroup) return items.map(e => [e]); // в запросе есть время — показываем сеансы поштучно
    const out = [], bySeries = new Map();
    for (const e of items) {
      if (e.seriesKey && SLOTTED.has(e.kind)) { if (!bySeries.has(e.seriesKey)) { const g = []; bySeries.set(e.seriesKey, g); out.push(g); } bySeries.get(e.seriesKey).push(e); }
      else out.push([e]);
    }
    for (const g of out) g.sort((a, b) => a.start.localeCompare(b.start)); // сеансы в карточке — по времени, а не по рейтингу
    return out;
  }
  function slotCard(g) {
    const e0 = g[0], free = g.filter(e => e.going < e.capacity);
    const first = new Date(e0.start), last = g[g.length - 1], lastEnd = new Date(new Date(last.start).getTime() + last.duration * 60000);
    const minP = Math.min(...g.map(e => e.price));
    const target = (free[0] || e0).slug;
    const unit = e0.kind === 'rental' ? (e0.meta?.unit_name ? `${e0.meta.unit_name}: ` : '') : '';
    const open = ev => { if (ev.target.closest('a')) return; track('card_click', { event_id: e0.id, slots: g.length }); location.hash = `#/event/${target}`; };
    return el('div', { class: 'fcard slot-card', role: 'link', tabindex: 0, onclick: open, onkeydown: ev => { if (ev.key === 'Enter') open(ev); } },
      el('div', { class: 'fcard-body' },
        el('div', { class: 'fcard-time' }, `${fmtTime(first)}–${fmtTime(lastEnd)}`, el('span', { class: 'sep' }, '·'), `${g.length} ${plural(g.length, ['сеанс', 'сеанса', 'сеансов'])}`, el('span', { class: 'sep' }, '·'), KIND_LABEL[e0.kind] || e0.subTitle || e0.catTitle),
        el('a', { class: 'fcard-title', href: `#/event/${target}` }, e0.title),
        el('div', { class: 'fcard-org' }, el('span', { class: 'mini-avatar' }, e0.organizer.name.replace(/^[«"]/, '').charAt(0)), e0.organizer.name),
        el('div', { class: 'fcard-place' }, '📍 ', e0.venue, el('span', { class: 'muted' }, ` · ${e0.district}`)),
        el('div', { class: 'slot-times' }, g.slice(0, 8).map(e => el('a', { class: 'tp' + (e.going >= e.capacity ? ' full' : ''), href: `#/event/${e.slug}`, title: e.going >= e.capacity ? 'Занято' : `Свободно ${e.capacity - e.going}` }, fmtTime(new Date(e.start)))), g.length > 8 ? el('a', { class: 'tp more', href: `#/event/${target}` }, `+${g.length - 8}`) : null),
        el('div', { class: 'fcard-foot' }, el('span', { class: 'tag ' + (minP === 0 ? 'free' : 'price') }, minP === 0 ? 'Бесплатно' : `от ${fmtPrice(minP)}`), ageTag(e0), el('span', { class: 'tag' }, `${unit}свободно на ${free.length} из ${g.length}`), moreDates(e0))),
      el('a', { class: 'fcard-cover' + (e0.cover ? ' has-img' : ''), href: `#/event/${target}`, style: e0.cover ? `background-image:url(${e0.cover})` : `background:${CAT_GRAD[e0.category]}` }, el('span', {}, e0.emoji)));
  }
  const timeLabel = e => e.kind === 'open' && e.meta?.open_from && e.meta?.open_to ? `${e.meta.open_from}–${e.meta.open_to}` : fmtTime(new Date(e.start));
  function fcard(e) {
    const t = new Date(e.start);
    return el('a', { class: 'fcard' + (e.promoted ? ' is-promo' : ''), href: `#/event/${e.slug}`, onclick: () => track('card_click', { event_id: e.id, promoted: !!e.promoted, reasons: e.reasons }) },
      el('div', { class: 'fcard-body' },
        el('div', { class: 'fcard-time' }, e.promoted ? el('span', { class: 'ad-badge', title: `Реклама · erid ${e.erid || ''}` }, 'Реклама') : null, e.reasons?.includes('boost') ? el('span', { class: 'ad-badge soft' }, 'Продвижение') : null, timeLabel(e), el('span', { class: 'sep' }, '·'), e.kind === 'open' ? 'открыто' : (e.subTitle || e.catTitle), e.orgRating ? el('span', { class: 'rating-mini', title: `${e.orgReviews} отзывов` }, ` ★ ${e.orgRating}`) : null),
        el('div', { class: 'fcard-title' }, e.title),
        el('div', { class: 'fcard-org' }, el('span', { class: 'mini-avatar' }, e.organizer.name.replace(/^[«"]/, '').charAt(0)), e.organizer.name),
        el('div', { class: 'fcard-place' }, '📍 ', e.venue, el('span', { class: 'muted' }, ` · ${distLabel(e.district)}`)),
        el('div', { class: 'fcard-foot' }, el('span', { class: 'tag ' + (e.price === 0 ? 'free' : 'price') }, fmtPrice(e.price)), ageTag(e), e.tags.filter(x => x !== 'бесплатно').slice(0, 2).map(tagEl), moreDates(e), e.registered ? el('span', { class: 'tag going' }, '✓ Иду') : null)),
      el('div', { class: 'fcard-cover' + (e.cover ? ' has-img' : ''), style: e.cover ? `background-image:url(${e.cover})` : `background:${CAT_GRAD[e.category]}` }, el('span', {}, e.emoji)));
  }
  function groups(list) { return timeline(list); }
  const ageTag = e => el('span', { class: 'tag age' + (e.age >= 16 ? ' adult' : ''), title: 'Возрастная маркировка' }, `${e.age || 0}+`);
  const moreDates = e => { const m = H.moreDates?.get(e.seriesKey); return m ? el('span', { class: 'tag more' }, `ещё ${m.n} ${plural(m.n, ['дата', 'даты', 'дат'])} до ${fmtDM(parseIso(m.last))}`) : null; };
  const tagEl = t => el('span', { class: 'tag ' + (t === 'можно с собакой' ? 'dog' : t === 'можно одному' ? 'solo' : t.startsWith('на ') ? 'lang' : t === 'Пушкинская карта' ? 'pushkin' : t === 'бесплатно' ? 'free' : '') }, t);
  function card(e) {
    const d = parseIso(e.date), t = new Date(e.start);
    return el('a', { class: 'card' + (e.promoted ? ' is-promo' : ''), href: `#/event/${e.slug}`, onclick: () => track('card_click', { event_id: e.id, promoted: !!e.promoted }) },
      el('div', { class: 'cover ' + e.category + (e.cover ? ' has-img' : ''), style: e.cover ? `background-image:url(${e.cover})` : null },
        el('span', { class: 'date' }, WD[d.getDay()].toUpperCase(), el('b', {}, d.getDate())),
        el('span', { class: 'price' + (e.price === 0 ? ' free' : '') }, fmtPrice(e.price)),
        e.registered ? el('span', { class: 'mine' }, '✓ Иду') : null,
        e.promoted ? el('span', { class: 'mine ad' }, 'Реклама') : null,
        el('span', { class: 'e' }, e.emoji)),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-time' }, `${timeLabel(e)} · ${e.subTitle || e.catTitle} · ${e.age || 0}+`),
        el('div', { class: 'card-title' }, e.title),
        el('div', { class: 'card-place' }, `${e.venue} · ${distLabel(e.district)}`),
        el('div', { class: 'card-foot' },
          el('span', { class: 'org' }, el('span', { class: 'mini-avatar' }, e.organizer.name.replace(/^[«"]/, '').charAt(0)), el('b', {}, e.organizer.name)),
          el('span', { class: 'tags' }, e.tags.filter(t => t !== 'бесплатно').slice(0, 1).map(tagEl)))));
  }

  // ---------- Страница события ----------
  async function renderEvent(slug) {
    const root = $('#app'); root.innerHTML = ''; const rid = routeId;
    showPlaceholder(root); // пока грузим — заглушка той же высоты, чтобы подвал не прыгал
    let e;
    try { e = await api(`/api/events/${encodeURIComponent(slug)}`); if (rid !== routeId) return; } catch { if (rid !== routeId) return; root.append(el('div', { class: 'wrap page' }, el('a', { class: 'back', href: '#/' }, '← Назад'), el('div', { class: 'empty' }, el('div', { class: 'e' }, '🤷'), 'Такого события нет или оно уже прошло.'))); return; }
    clearPlaceholder();
    const d = parseIso(e.date), t = new Date(e.start), end = new Date(t.getTime() + e.duration * 60000);
    const dur = e.duration >= 60 ? `${Math.floor(e.duration / 60)} ч${e.duration % 60 ? ` ${e.duration % 60} мин` : ''}` : `${e.duration} мин`;
    const fact = (ico, tt, s) => el('div', { class: 'fact' }, el('span', { class: 'ico' }, ico), el('div', {}, el('div', { class: 't' }, tt), el('div', { class: 's' }, s)));
    const regCard = el('div', { class: 'register' });
    const th = themeStyle(e);
    root.append(el('div', { class: th.cls, style: th.style }, el('div', { class: 'wrap page page-narrow' },
      el('a', { class: 'back', href: '#/' }, '← Назад к подбору'),
      el('div', { class: 'banner' + (e.cover ? ' has-img' : ''), style: e.cover ? `background-image:url(${e.cover})` : `background:${CAT_GRAD[e.category]}` }, el('div', { class: 'crumbs-b' }, el('span', {}, `${e.catEmoji} ${e.catTitle}`), e.subTitle ? el('span', {}, e.subTitle) : null), el('span', { class: 'e' }, e.emoji)),
      el('div', { class: 'event-head' }, el('h1', {}, e.title),
        el('div', { class: 'by' }, el('span', { class: 'mini-avatar' }, e.organizer.name.replace(/^[«"]/, '').charAt(0)), 'Организатор: ', el('a', { href: `#/org/${e.organizer.slug}` }, e.organizer.name), e.orgRating ? el('span', { class: 'rating-mini' }, ` ★ ${e.orgRating} · ${e.orgReviews} ${plural(e.orgReviews, ['отзыв', 'отзыва', 'отзывов'])}`) : null, e.promoted ? el('span', { class: 'ad-badge', title: `erid ${e.erid || ''}` }, 'Реклама') : null)),
      el('div', { class: 'two-col' },
        el('div', {},
          e.kind === 'rental' && e.siblings?.length ? busyTimeline(e) : e.siblings?.length > 1 ? timesPick(e) : null,
          el('div', { class: 'facts' },
            fact('🗓️', fmtLong(d), `${fmtTime(t)}–${fmtTime(end)} · ${dur}`),
            fact('📍', e.venue, `${e.address} · ${e.district} район`),
            fact('💳', fmtPrice(e.price) + (e.price ? ' за человека' : ''), e.price ? 'Итоговая цена, со всеми сборами' : 'Платить ничего не нужно'),
            fact(e.age >= 16 ? '🔞' : e.with.includes('kids') ? '🧒' : '🏷️', `${e.age || 0}+`, e.age >= 16 ? 'Только для взрослых, детей не пустят' : e.with.includes('kids') ? 'Можно с детьми' : 'Возрастная маркировка'),
            fact('🗣️', LANGS[e.lang], e.lang === 'tt' ? 'Будут подсказки на русском' : e.lang === 'en' ? 'Уровень от B1' : 'Язык события'),
            fact('🎟️', e.registration.type === 'here' ? 'Запись у нас, в один клик' : `Билеты ${e.registration.label}`, e.registration.type === 'here' ? 'Напомним за 24 часа, одно сообщение' : 'Переход на страницу покупки')),
          el('div', { class: 'tagline' }, e.tags.map(tagEl)),
          el('div', { class: 'section' }, el('h3', {}, 'О событии'), renderMarkdown(e.description)),
          el('div', { class: 'report-link' }, el('button', { type: 'button', class: 'step-link', onclick: () => reportModal(e) }, '⚑ Пожаловаться на событие')),
          e.videoUrl && videoEmbed(e.videoUrl) ? el('div', { class: 'section' }, el('h3', {}, 'Видео'), el('div', { class: 'video-wrap' }, el('iframe', { src: videoEmbed(e.videoUrl), allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture', allowfullscreen: true, loading: 'lazy', referrerpolicy: 'strict-origin-when-cross-origin' }))) : null,
          e.photos?.length ? el('div', { class: 'section' }, el('h3', {}, 'Фото'), gallery(e.photos)) : null,
          e.stol ? el('div', { class: 'section' }, el('div', { class: 'note' }, 'ℹ️', el('span', {}, el('b', {}, 'Это наш формат. '), 'Состав стола подбираем мы, адрес ресторана пришлём за сутки. Только 18+, публичное место, ведущий.'))) : null),
        regCard))));
    fillRegister(regCard, e);
    renderCta(e, regCard);
    track('event_view', { event_id: e.id, promoted: !!e.promoted });
    window.scrollTo({ top: 0 });
  }
  function renderCta(e, card) {
    $('#cta-bar')?.remove();
    const bar = el('div', { id: 'cta-bar', class: 'cta-bar' });
    const refreshBar = () => {
      bar.innerHTML = '';
      if (e.registered) bar.append(el('div', { class: 'cta-info' }, el('b', {}, '✅ Вы записаны'), el('small', {}, fmtTime(new Date(e.start)) + ' · ' + e.venue)), el('button', { type: 'button', class: 'btn btn-outline', onclick: () => downloadIcs([e], e.slug) }, '📅 В календарь'));
      else bar.append(el('div', { class: 'cta-info' }, el('b', {}, fmtPrice(e.price)), el('small', {}, e.registration.type === 'here' ? 'Запись в один клик' : `Билеты ${e.registration.label}`)),
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => { const b = card.querySelector('.btn-primary'); if (b) b.click(); } }, e.registration.type === 'here' ? (e.stol ? 'Забронировать' : 'Записаться') : 'Купить ↗'));
    };
    refreshBar();
    bar.refresh = refreshBar;
    document.body.append(bar);
  }
  // Прокат: шкала дня как в планировщике Teams — каждый час виден занятым, частично занятым или свободным
  function busyTimeline(e) {
    const hm = iso => { const p = partsIn(new Date(iso)); return Number(p.hour) * 60 + Number(p.minute); }; // по казанскому времени, как подписи сеансов
    const slots = [...e.siblings].sort((a, b) => a.start.localeCompare(b.start));
    const step = e.duration || 60;
    const from = Math.min(...slots.map(s => hm(s.start))), to = Math.max(...slots.map(s => hm(s.start) + step));
    const span = Math.max(60, to - from), pct = m => ((m - from) / span * 100).toFixed(3) + '%';
    const unit = e.meta?.unit_name || 'мест';
    const track = el('div', { class: 'bt-track' });
    for (let m = Math.ceil(from / 60) * 60; m <= to; m += 60) track.append(el('span', { class: 'bt-tick', style: `left:${pct(m)}` }, el('i', {}, `${String(Math.floor(m / 60)).padStart(2, '0')}:00`)));
    for (const sb of slots) {
      const st = hm(sb.start), busy = Math.min(sb.going, sb.capacity), free = sb.capacity - busy, share = busy / sb.capacity;
      const cls = free === 0 ? 'full' : share >= 0.6 ? 'busy' : 'free';
      track.append(el('a', { class: `bt-slot ${cls}` + (sb.id === e.id ? ' on' : ''), href: `#/event/${sb.slug}`, style: `left:${pct(st)};width:calc(${(step / span * 100).toFixed(3)}% - 3px)`, title: `${fmtTime(new Date(sb.start))} — занято ${busy} из ${sb.capacity}` },
        el('i', { class: 'bt-fill', style: `height:${Math.round(share * 100)}%` }),
        el('b', {}, fmtTime(new Date(sb.start))), el('small', {}, free === 0 ? 'занято' : `${free} своб.`)));
    }
    const cur = slots.find(sb => sb.id === e.id);
    return el('div', { class: 'busy-timeline' },
      el('div', { class: 'tp-label' }, 'Занятость по часам', el('span', { class: 'meta' }, ` · ${fmtDM(parseIso(e.date))} · ${e.capacity} ${unit}`)),
      el('div', { class: 'bt-scroll' }, track),
      el('div', { class: 'bt-legend' }, el('span', { class: 'free' }, 'свободно'), el('span', { class: 'busy' }, 'почти занято'), el('span', { class: 'full' }, 'занято'), cur ? el('span', { class: 'meta' }, `выбрано ${fmtTime(new Date(cur.start))}: свободно ${cur.capacity - Math.min(cur.going, cur.capacity)} из ${cur.capacity}`) : null));
  }
  function timesPick(e) {
    const label = e.kind === 'rental' ? 'Выберите час' : e.kind === 'groups' ? 'Выберите сеанс' : 'Выберите сеанс';
    return el('div', { class: 'times-pick' },
      el('div', { class: 'tp-label' }, label, el('span', { class: 'meta' }, ` · ${fmtDM(parseIso(e.date))}`)),
      el('div', { class: 'tp-row' }, e.siblings.map(sb => { const full = sb.going >= sb.capacity; return el('a', { class: 'tp' + (sb.id === e.id ? ' on' : '') + (full ? ' full' : ''), href: `#/event/${sb.slug}` }, fmtTime(new Date(sb.start)), el('small', {}, full ? 'занято' : `свободно ${sb.capacity - sb.going}`)); })));
  }
  function goingLine(e, left) {
    const m = e.meta || {};
    if (e.stol) return `Идут ${e.going} из 6`;
    if (e.kind === 'rental') return `Свободно ${left} из ${e.capacity}${m.unit_name ? ` · ${m.unit_name}` : ''} на этот час`;
    if (e.kind === 'groups') return `Группа до ${m.group_size || e.capacity}${m.groups > 1 ? ` · ${m.groups} группы параллельно` : ''} · свободно ${left} из ${e.capacity}`;
    if (e.kind === 'sessions') return `Мест: свободно ${left} из ${e.capacity}`;
    if (e.kind === 'open') return `Открыто ${m.open_from || fmtTime(new Date(e.start))}–${m.open_to || fmtTime(new Date(new Date(e.start).getTime() + e.duration * 60000))} · собираются ${e.going}`;
    return `Идут ${e.going} ${plural(e.going, ['человек', 'человека', 'человек'])}${left < 20 ? ` · осталось ${left} ${plural(left, ['место', 'места', 'мест'])}` : ''}`;
  }
  function ctaLabel(e) {
    if (e.stol) return 'Забронировать место · депозит 300 ₽';
    if (e.kind === 'rental') return e.price ? `Забронировать · ${fmtPrice(e.price)}` : 'Забронировать бесплатно';
    if (e.kind === 'sessions') return e.price ? `Занять место · ${fmtPrice(e.price)}` : 'Занять место';
    if (e.kind === 'groups') return e.price ? `Записаться в группу · ${fmtPrice(e.price)}` : 'Записаться в группу';
    if (e.kind === 'open') return 'Пойду';
    return e.price ? `Записаться · ${fmtPrice(e.price)}` : 'Записаться бесплатно';
  }
  function fillRegister(card, e) {
    card.innerHTML = '';
    const left = Math.max(0, e.capacity - e.going);
    card.append(el('div', { class: 'price' }, fmtPrice(e.price), e.price ? el('small', {}, 'за человека') : null));
    card.append(el('div', { class: 'going' }, goingLine(e, left)));
    const bar = el('i'); card.append(el('div', { class: 'meter' }, bar)); requestAnimationFrame(() => { bar.style.width = `${Math.min(100, Math.round(e.going / e.capacity * 100))}%`; });
    const stack = el('div', { class: 'stack' }); card.append(stack);
    const refresh = async (method, body) => { try { const upd = await api(`/api/events/${e.id}/register`, { method, body }); Object.assign(e, upd); await loadMe(); fillRegister(card, e); $('#cta-bar')?.refresh?.(); return true; } catch (err) { if (err.body?.error === 'profile_required') return profileModal({ gate: 'Чтобы записаться, представьтесь', onDone: () => refresh(method, body) }); toast(err.body?.message || 'Не получилось, попробуйте ещё раз'); } };
    if (e.registered) {
      card.insertBefore(el('div', { class: 'done' }, '✅ Вы записаны' + (e.stol ? ', депозит ждём' : '')), stack);
      stack.append(
        el('button', { type: 'button', class: 'btn btn-outline btn-block', onclick: () => downloadIcs([e], e.slug) }, '📅 Добавить в календарь'),
        el('button', { type: 'button', class: 'btn btn-outline btn-block', onclick: () => { navigator.clipboard?.writeText(shareUrl(e)); toast('Ссылка скопирована'); } }, '🔗 Позвать друга'),
        el('button', { type: 'button', class: 'btn btn-outline btn-block', onclick: () => showQr(e) }, '🎫 Мой QR для входа'),
        el('button', { type: 'button', class: 'btn btn-ghost btn-danger btn-block', onclick: () => refresh('DELETE') }, 'Не приду'));
      if (!me?.contact) {
        const inp = el('input', { placeholder: 'Email или телефон для напоминания' });
        stack.append(el('div', {}, el('div', { class: 'fine', style: 'margin:0 0 8px' }, 'Куда прислать напоминание за 24 часа? Одно сообщение, без рекламы.'), inp,
          el('button', { type: 'button', class: 'btn btn-ink btn-block', style: 'margin-top:8px', onclick: () => { if (inp.value.trim()) refresh('POST', { contact: inp.value.trim() }).then(r => r && toast('Напомним за 24 часа')); } }, '🔔 Напомнить')));
      } else stack.append(el('div', { class: 'fine' }, `Напоминание придёт за 24 часа: ${me.contact}`));
    } else if (e.registration.type === 'here' && (e.meta?.tg || e.meta?.max || e.organizer.telegram || e.organizer.max)) {
      // Запись у организатора в мессенджере: пока без CRM — переходим к нему в чат, а событие добавляем в «Записи» с напоминанием
      const tg = e.meta?.tg || e.organizer.telegram, mx = e.meta?.max || e.organizer.max;
      const go = (url, label) => { refresh('POST', { external: true }).catch(() => {}); track('messenger_click', { event_id: e.id, via: label }); openOut(url); };
      if (tg) stack.append(el('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block', onclick: () => go(tgLink(tg), 'telegram') }, '✈️ Записаться в Telegram'));
      if (mx) stack.append(el('button', { type: 'button', class: 'btn ' + (tg ? 'btn-outline' : 'btn-primary btn-lg') + ' btn-block', onclick: () => go(maxLink(mx), 'max') }, '💬 Записаться в MAX'));
      stack.append(el('div', { class: 'fine' }, 'Откроем чат с организатором — напишите, что хотите прийти. Событие появится в «Записях», напомним за 24 часа.'));
    } else if (e.registration.type === 'here') {
      stack.append(el('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block', onclick: () => refresh('POST', {}).then(r => r && toast('Готово! Вы в списке 🎉')) }, ctaLabel(e)));
      stack.append(el('div', { class: 'fine' }, e.stol ? 'Депозит засчитывается в цену. Отмена раньше чем за 48 часов — возврат 100%.' : e.price ? 'Оплата на месте или организатору. Запись бесплатна, отмена в один клик.' : 'Без регистрации на сайте. Отмена в один клик.'));
    } else {
      stack.append(el('a', { class: 'btn btn-primary btn-lg btn-block', href: e.registration.url, target: '_blank', rel: 'noopener' }, `Купить ${e.registration.label} ↗`));
      stack.append(el('button', { type: 'button', class: 'btn btn-outline btn-block', onclick: () => refresh('POST', { external: true }).then(r => r && toast('Добавили в ваши записи')) }, '🔔 Иду, напомни мне'));
      stack.append(el('div', { class: 'fine' }, 'Билет продаёт организатор или касса. У нас — напоминание и место в вашем списке.'));
    }
    const colors = ['#0ea5e9', '#f59e0b', '#8b5cf6', '#22c55e', '#ec4899'];
    if (e.going > 0) card.append(el('div', { class: 'avatars' }, el('span', { class: 'stackv' }, colors.slice(0, Math.min(5, e.going)).map((c, i) => el('span', { style: `background:${c}` }, String.fromCharCode(1040 + ((e.id + i * 7) % 32))))), el('span', {}, e.going > 5 ? `и ещё ${e.going - 5}` : 'уже идут')));
  }
  function downloadIcs(list, name) {
    const st = d => { const p = partsIn(d); return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}00`; };
    const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
    const v = list.map(e => { const d = new Date(e.start), end = new Date(d.getTime() + e.duration * 60000); return ['BEGIN:VEVENT', `UID:${e.slug}@aydagez.ru`, `DTSTART;TZID=Europe/Moscow:${st(d)}`, `DTEND;TZID=Europe/Moscow:${st(end)}`, `SUMMARY:${esc(e.title)}`, `LOCATION:${esc(e.venue + ', ' + e.address)}`, `DESCRIPTION:${esc(location.origin + '/#/event/' + e.slug)}`, 'BEGIN:VALARM', 'TRIGGER:-PT24H', 'ACTION:DISPLAY', `DESCRIPTION:${esc('Завтра: ' + e.title)}`, 'END:VALARM', 'END:VEVENT'].join('\r\n'); });
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Aydagez//RU', `X-WR-CALNAME:${esc(name)}`, ...v, 'END:VCALENDAR'].join('\r\n');
    const a = el('a', { href: URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })), download: `${name.replace(/[^\w\u0400-\u04FF-]+/g, '-')}.ics` }); document.body.append(a); a.click(); a.remove();
  }

  // ---------- Организатор ----------
  const tgLink = t => /^https?:/.test(t) ? t : 'https://t.me/' + String(t).replace(/^@/, '');
  const maxLink = t => /^https?:/.test(t) ? t : 'https://max.ru/' + String(t).replace(/^@/, '');
  // В мини-приложении Telegram ссылки на t.me открываются внутри Telegram, а не в браузере
  const openOut = url => { const tg = window.Telegram?.WebApp; if (tg && /t\.me\//.test(url)) tg.openTelegramLink(url); else if (tg) tg.openLink(url); else window.open(url, '_blank', 'noopener'); };
  const urlOf = u => /^https?:/.test(u) ? u : 'https://' + u;
  async function renderOrg(slug) {
    const root = $('#app'); root.innerHTML = ''; const rid = routeId;
    showPlaceholder(root); // пока грузим — заглушка той же высоты, чтобы подвал не прыгал
    let data;
    try { data = await api(`/api/organizers/${encodeURIComponent(slug)}`); if (rid !== routeId) return; } catch { if (rid !== routeId) return; root.append(el('div', { class: 'wrap page' }, el('a', { class: 'back', href: '#/' }, '← Назад'), el('div', { class: 'empty' }, 'Организатор не найден.'))); return; }
    clearPlaceholder();
    const { organizer: o, events: list } = data;
    const kinds = (await loadConfig()).orgKinds || {}; const kind = kinds[o.kind];
    let followed = data.followed;
    const cats = [...new Set(list.map(e => e.category))]; const grad = CAT_GRAD[cats[0]] || CAT_GRAD.social;
    const followBtn = el('button', { type: 'button' });
    const setFollow = () => { followBtn.textContent = followed ? '✓ Вы подписаны' : '+ Подписаться'; followBtn.className = 'btn ' + (followed ? 'btn-outline' : 'btn-primary'); };
    setFollow();
    followBtn.addEventListener('click', async () => { try { const r = await api(`/api/organizers/${o.id}/follow`, { method: followed ? 'DELETE' : 'POST' }); followed = r.followed; setFollow(); toast(followed ? 'Будем показывать новые события этой организации выше' : 'Подписка отменена'); loadMe(); } catch { toast('Не получилось'); } });
    const head = el('div', { class: 'orgp-head' },
      el('div', { class: 'orgp-cover', style: o.cover ? `background-image:url(${o.cover})` : `background:${grad}` }),
      el('div', { class: 'orgp-id' },
        o.logo ? el('img', { class: 'orgp-logo', src: o.logo, alt: '' }) : el('div', { class: 'orgp-logo letter', style: `background:${grad}` }, o.name.replace(/^[«"]/, '').charAt(0).toUpperCase()),
        el('div', { class: 'orgp-titles' },
          el('h1', {}, o.name, o.verified ? el('span', { class: 'verified', title: 'Проверенная организация' }, '✓') : null, o.promoted ? el('span', { class: 'ad-badge', title: `erid ${o.erid || ''}` }, 'Реклама') : null),
          el('div', { class: 'orgp-sub' }, [kind ? `${kind.emoji} ${kind.title}` : 'Организатор', o.rating ? `★ ${o.rating} · ${o.reviews} ${plural(o.reviews, ['отзыв', 'отзыва', 'отзывов'])}` : null, `${o.followers} ${plural(o.followers, ['подписчик', 'подписчика', 'подписчиков'])}`, o.checkins ? `${o.checkins} ${plural(o.checkins, ['подтверждённый визит', 'подтверждённых визита', 'подтверждённых визитов'])}` : null].filter(Boolean).join(' · ')))));
    const actions = el('div', { class: 'org-actions' }, followBtn,
      o.address ? el('a', { class: 'btn btn-outline', href: `https://yandex.ru/maps/?text=${encodeURIComponent('Казань, ' + o.address)}`, target: '_blank', rel: 'noopener' }, '🗺️ Маршрут') : null,
      o.telegram ? el('a', { class: 'btn btn-outline', href: tgLink(o.telegram), target: '_blank', rel: 'noopener' }, '✈️ Написать') : o.phone ? el('a', { class: 'btn btn-outline', href: `tel:${o.phone.replace(/[^\d+]/g, '')}` }, '📞 Позвонить') : null,
      o.website ? el('a', { class: 'btn btn-outline', href: urlOf(o.website), target: '_blank', rel: 'noopener' }, '🌐 Сайт') : null,
      list.length ? el('button', { type: 'button', class: 'btn btn-outline', onclick: () => downloadIcs(list, o.name) }, '📅 .ics') : null,
      el('button', { type: 'button', class: 'btn btn-outline', onclick: () => { navigator.clipboard?.writeText(location.href); toast('Ссылка скопирована'); } }, '🔗 Поделиться'),
      data.isMember ? el('a', { class: 'btn btn-ink', href: '#/cabinet', onclick: () => { cabState.org = o.id; } }, '⚙️ Управлять') : null);
    const a = o.announcement;
    const ann = a ? el('div', { class: 'announce' }, el('span', { class: 'e' }, '📣'), el('div', {}, el('b', {}, a.title), a.text ? el('div', {}, a.text) : null, (a.from || a.until) ? el('div', { class: 'meta' }, [a.from ? 'с ' + fmtDM(parseIso(a.from)) : '', a.until ? 'до ' + fmtDM(parseIso(a.until)) : ''].filter(Boolean).join(' ')) : null)) : null;
    const factList = [o.address && ['📍', o.address], o.hours && ['🕒', o.hours], o.phone && ['📞', o.phone], o.telegram && ['✈️', o.telegram], o.vk && ['💬', o.vk.replace(/^https?:\/\/(www\.)?/, '')], o.website && ['🌐', o.website.replace(/^https?:\/\/(www\.)?/, '')]].filter(Boolean);
    const facts = factList.length ? el('div', { class: 'orgp-facts' }, factList.map(([ic, t]) => el('span', { class: 'fact-chip' }, `${ic} ${t}`))) : null;
    const tabs = [['schedule', `Расписание · ${list.length}`], ['about', 'О месте'], ['reviews', `Отзывы · ${o.reviews || 0}`], ['photos', `Фото · ${data.photos.length}`]];
    let tab = 'schedule'; const tabBar = el('div', { class: 'org-tabs' }); const body = el('div', { class: 'org-body' });
    const paintTabs = () => { tabBar.innerHTML = ''; for (const [k, t] of tabs) tabBar.append(el('button', { type: 'button', class: 'org-tab' + (tab === k ? ' on' : ''), onclick: () => { tab = k; paintTabs(); paintBody(); track('org_tab', { tab: k }); } }, t)); };
    const paintBody = () => {
      body.innerHTML = '';
      if (tab === 'schedule') body.append(scheduleView(list));
      else if (tab === 'about') body.append(o.about ? renderMarkdown(o.about) : el('div', { class: 'empty' }, 'Описание пока не заполнено.'));
      else if (tab === 'reviews') body.append(reviewsView(data.reviewsList));
      else body.append(data.photos.length ? el('div', { class: 'orgp-photos' }, data.photos.map(u => el('button', { type: 'button', class: 'ph', style: `background-image:url(${u})`, onclick: () => lightbox(u) }))) : el('div', { class: 'empty' }, 'Фото пока нет.'));
    };
    paintTabs(); paintBody();
    root.append(el('div', { class: 'wrap page page-narrow' },
      el('a', { class: 'back', href: '#/' }, '← Назад к подбору'),
      head, actions, ann, facts, tabBar, body,
      o.slug === 'aydagez' || data.isMember ? null : el('div', { class: 'callout', style: 'margin-top:24px' }, el('span', { class: 'e' }, '🎁'), el('div', {}, el('b', {}, 'Это ваша организация? '), 'Заберите страницу: расписание, запись гостей, продвижение и статистика — бесплатно. ', el('a', { href: '#/cabinet', style: 'font-weight:600;text-decoration:underline' }, 'В кабинет →')))));
    window.scrollTo({ top: 0 });
  }
  function lightbox(u) { const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; }; rootM.append(el('div', { class: 'modal-bg', onclick: close }, el('img', { class: 'lightbox', src: u, alt: '' }))); }
  function reviewsView(list) {
    if (!list?.length) return el('div', { class: 'empty' }, 'Отзывов пока нет: их оставляют гости с подтверждённым участием.');
    return el('div', { class: 'reviews' }, list.map(r => el('div', { class: 'review' }, el('div', { class: 'review-head' }, el('b', {}, r.name), el('span', { class: 'stars-s' }, '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating)), el('span', { class: 'meta' }, new Date(r.at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }))), r.text ? el('div', {}, r.text) : null, el('div', { class: 'meta' }, r.event))));
  }
  // Расписание организации: лента дней с числом событий; сеансы одного фильма/спектакля — одной строкой с временем
  function scheduleView(list) {
    if (!list.length) return el('div', { class: 'empty' }, 'Ближайших событий пока нет.');
    const byDay = new Map(); for (const e of list) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
    const days = [...byDay.keys()].slice(0, 30);
    let day = days[0];
    const strip = el('div', { class: 'day-strip' }); const listBox = el('div', { class: 'show-list' });
    const paint = () => {
      strip.innerHTML = '';
      strip.append(el('button', { type: 'button', class: 'day-pill' + (day === 'all' ? ' on' : ''), onclick: () => { day = 'all'; paint(); } }, el('b', {}, 'Все дни'), el('span', {}, `${list.length}`)));
      for (const d of days) { const dt = parseIso(d); strip.append(el('button', { type: 'button', class: 'day-pill' + (day === d ? ' on' : '') + (dt.getDay() % 6 === 0 ? ' we' : ''), onclick: () => { day = d; paint(); } }, el('b', {}, d === iso(today) ? 'Сегодня' : d === iso(addDays(today, 1)) ? 'Завтра' : `${WD[dt.getDay()]} ${dt.getDate()}`), el('span', {}, `${byDay.get(d).length}`))); }
      listBox.innerHTML = '';
      if (day === 'all') { listBox.append(rows(list)); return; }
      const groups = new Map();
      for (const e of byDay.get(day)) { const k = e.seriesKey && SLOTTED.has(e.kind) ? e.seriesKey : 'e' + e.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
      for (const g of groups.values()) {
        const e0 = g[0]; const minP = Math.min(...g.map(e => e.price));
        listBox.append(el('div', { class: 'show-row' },
          el('a', { class: 'show-cover' + (e0.cover ? ' has-img' : ''), href: `#/event/${e0.slug}`, style: e0.cover ? `background-image:url(${e0.cover})` : `background:${CAT_GRAD[e0.category]}` }, e0.cover ? '' : e0.emoji),
          el('div', { class: 'show-body' }, el('a', { class: 'show-title', href: `#/event/${e0.slug}` }, e0.title, e0.promoted ? el('span', { class: 'ad-badge' }, 'Реклама') : null),
            el('div', { class: 'meta' }, `${e0.subTitle || e0.catTitle} · ${e0.duration} мин · ${e0.venue}`),
            el('div', { class: 'slot-times' }, g.map(e => el('a', { class: 'tp' + (e.going >= e.capacity ? ' full' : ''), href: `#/event/${e.slug}`, title: e.going >= e.capacity ? 'Мест нет' : `Свободно ${e.capacity - e.going}` }, fmtTime(new Date(e.start)))))),
          el('div', { class: 'show-price' }, el('span', { class: 'tag ' + (minP === 0 ? 'free' : 'price') }, minP === 0 ? 'Бесплатно' : (g.length > 1 && g.some(e => e.price !== minP) ? 'от ' : '') + fmtPrice(minP)))));
      }
    };
    paint();
    return el('div', {}, strip, listBox);
  }
  function rows(list) {
    const frag = document.createDocumentFragment();
    const map = new Map();
    for (const e of list) { if (!map.has(e.date)) map.set(e.date, []); map.get(e.date).push(e); }
    for (const [k, items] of map) {
      const d = parseIso(k);
      frag.append(el('div', { class: 'group' }, el('div', { class: 'group-title' }, k === iso(today) ? `Сегодня, ${fmtDM(d)}` : k === iso(addDays(today, 1)) ? `Завтра, ${fmtDM(d)}` : fmtLong(d)),
        items.map(e => { const t = new Date(e.start); return el('a', { class: 'row-link', href: `#/event/${e.slug}` }, el('span', { class: 'time' }, timeLabel(e)), el('span', { class: 'e', style: `background:${CAT_GRAD[e.category]}` }, e.emoji), el('span', {}, el('div', { class: 't' }, e.title), el('div', { class: 's' }, `${e.venue} · ${distLabel(e.district)}`)), el('span', { class: 'p' }, fmtPrice(e.price), e.registered ? el('span', { class: 'tag free', style: 'margin-left:8px' }, '✓ Иду') : null)); })));
    }
    return frag;
  }

  // ---------- Кабинет пользователя ----------
  async function renderMy() {
    const root = $('#app'); root.innerHTML = ''; const rid = routeId;
    showPlaceholder(root); // пока грузим — заглушка той же высоты, чтобы подвал не прыгал
    await loadMe(); if (rid !== routeId) return;
    clearPlaceholder();
    const page = el('div', { class: 'wrap page page-narrow' }, el('a', { class: 'back', href: '#/' }, '← Назад к подбору'));
    page.append(el('div', { class: 'org-head' }, me?.avatar ? el('img', { class: 'org-avatar photo', src: me.avatar, alt: '' }) : el('div', { class: 'org-avatar', style: 'background:var(--ink);color:var(--on-ink)' }, me?.name ? me.name.trim().charAt(0).toUpperCase() : '🎒'),
      el('div', {}, el('h1', {}, me?.name ? me.name : 'Мои записи', me?.registered ? el('span', { class: 'tag ' + (me.accountType === 'org' ? 'pushkin' : 'solo'), style: 'margin-left:10px;vertical-align:middle' }, me.accountType === 'org' ? 'Организация' : 'Человек') : null),
        el('div', { class: 'sub' }, me?.registered ? [me.contact, me.about].filter(Boolean).join(' · ') : 'Представьтесь, чтобы записываться на события и получать напоминания. Без паролей: имя, контакт и фото.'))));
    page.append(el('div', { class: 'org-actions' }, el('button', { type: 'button', class: me?.registered ? 'btn btn-outline' : 'btn btn-primary', onclick: () => profileModal() }, me?.registered ? '✏️ Редактировать профиль' : '👤 Представиться'),
      me?.registered && me.accountType === 'person' ? el('a', { class: 'btn btn-outline', href: '#/new' }, '+ Собрать встречу') : null,
      me?.registered && me.accountType === 'person' ? el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => profileModal({ type: 'org' }) }, 'Стать организацией') : null,
      me?.registrations?.length ? el('button', { type: 'button', class: 'btn btn-outline', onclick: () => downloadIcs(me.registrations, 'Айдагез — мои записи') }, '📅 Все записи в календарь') : null,
      me?.isOrganizer ? el('a', { class: 'btn btn-ink', href: '#/cabinet' }, '🎪 Кабинет организатора') : null));
    if (!me?.registrations?.length) page.append(el('div', { class: 'empty' }, el('div', { class: 'e' }, '🗓️'), el('b', {}, 'Пока нет записей.'), el('div', {}, 'Найдите событие на главной и нажмите «Записаться».'), el('div', {}, el('a', { class: 'btn btn-primary', href: '#/' }, 'К подбору'))));
    else page.append(el('div', { class: 'section' }, el('h3', {}, 'Куда иду'), rows(me.registrations)));
    if (me?.past?.length) page.append(el('div', { class: 'section' }, el('h3', {}, 'Были за 90 дней'), el('p', { class: 'help', style: 'margin-bottom:10px' }, 'Отзыв открывается, когда участие подтвердили вы и организатор (QR на входе или отметка «Был»).'), pastRows(me.past)));
    if (me?.follows?.length) page.append(el('div', { class: 'section' }, el('h3', {}, 'Подписки'), el('div', { class: 'pills' }, me.follows.map(o => el('a', { class: 'pill', href: `#/org/${o.slug}` }, o.name)))));
    // Интересы: подсказка для подбора
    const my = new Set(me?.interests || []);
    const chips = el('div', { class: 'pills' }, taxonomy.map(c => el('button', { type: 'button', class: 'pill' + (my.has(c.key) ? ' on' : ''), onclick: async ev => {
      if (my.has(c.key)) my.delete(c.key); else my.add(c.key); ev.currentTarget.classList.toggle('on', my.has(c.key));
      try { await api('/api/me', { method: 'PATCH', body: { interests: [...my] } }); } catch {}
    } }, `${c.emoji} ${c.title}`)));
    { const cur = document.documentElement.getAttribute('data-theme') || 'light'; const box = el('div', { class: 'pills' });
      const paint = () => { box.innerHTML = ''; for (const [k, t] of [['light', '☀️ Светлая'], ['dark', '🌙 Тёмная']]) box.append(el('button', { type: 'button', class: 'pill' + ((document.documentElement.getAttribute('data-theme') || 'light') === k ? ' on' : ''), onclick: () => { setTheme(k); paint(); } }, t)); };
      paint(); page.append(el('div', { class: 'section' }, el('h3', {}, 'Настройки'), el('p', { class: 'help', style: 'margin-bottom:10px' }, 'Оформление сайта'), box)); void cur; }
    page.append(el('div', { class: 'section' }, el('h3', {}, 'Мои интересы'), el('p', { class: 'help', style: 'margin-bottom:10px' }, 'Отметьте, что вам близко — учтём в подборе.'), chips));
    if (!me?.isOrganizer) page.append(el('div', { class: 'callout', style: 'margin-top:24px' }, el('span', { class: 'e' }, '🎪'), el('div', {}, el('b', {}, 'Проводите события? '), el('a', { href: '#/new', style: 'font-weight:600;text-decoration:underline' }, 'Добавьте первое'), ' — и здесь появится кабинет организатора.')));
    root.append(page);
  }
  function pastRows(list) {
    return el('div', { class: 'cab-rows' }, list.map(e => {
      const a = e.attendance || {}; const both = a.guest && a.organizer;
      const status = both ? (a.rating ? `Ваша оценка ★ ${a.rating}` : 'Участие подтверждено') : a.organizer ? 'Организатор отметил вас — подтвердите' : a.guest ? 'Ждём отметку организатора' : 'Участие не подтверждено';
      const actions = el('div', { class: 'cab-actions' });
      if (!a.guest) actions.append(el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: async ev => { try { await api(`/api/events/${e.id}/attended`, { method: 'POST' }); toast('Спасибо, отметили'); renderMy(); } catch { toast('Не получилось'); } } }, 'Я был(а)'));
      if (both) actions.append(el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => reviewModal(e) }, a.rating ? 'Изменить отзыв' : '★ Оставить отзыв'), el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => peersModal(e) }, '👥 Кто был'));
      return el('div', { class: 'cab-row' }, el('div', { class: 'cab-when' }, el('b', {}, fmtDM(parseIso(e.date))), el('span', {}, fmtTime(new Date(e.start)))), el('div', { class: 'cab-main' }, el('a', { class: 'cab-title', href: `#/event/${e.slug}` }, e.title), el('div', { class: 'meta' }, `${e.organizer.name} · ${status}`)), el('div', {}), actions);
    }));
  }
  function reviewModal(e) {
    const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; };
    let rating = e.attendance?.rating || 0;
    const stars = el('div', { class: 'stars' }, [1, 2, 3, 4, 5].map(n => el('button', { type: 'button', class: 'star', onclick: () => { rating = n; paint(); } }, '★')));
    const paint = () => { for (const [i, b] of [...stars.children].entries()) b.classList.toggle('on', i < rating); };
    paint();
    const text = el('textarea', { class: 'input', style: 'height:110px;padding:12px 14px;margin-top:12px', placeholder: 'Что понравилось, что улучшить. Отзыв увидят другие гости на странице организатора.' });
    rootM.append(el('div', { class: 'modal-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'modal' }, el('h2', {}, 'Как прошло?'), el('p', {}, e.title), stars, text,
        el('div', { style: 'display:flex;gap:8px;margin-top:18px;justify-content:flex-end' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Отмена'),
          el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => { if (!rating) return toast('Поставьте оценку'); try { await api(`/api/events/${e.id}/review`, { method: 'POST', body: { rating, text: text.value } }); close(); toast('Спасибо за отзыв'); renderMy(); } catch (err) { toast(err.body?.message || 'Не получилось'); } } }, 'Отправить')))));
  }
  async function peersModal(e) {
    const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; };
    let data; try { data = await api(`/api/events/${e.id}/peers`); } catch { return toast('Список доступен после подтверждения участия'); }
    const list = el('div', { class: 'guest-list' });
    for (const pr of data.peers) {
      const btn = el('button', { type: 'button', class: 'btn btn-sm ' + (pr.my === 1 ? 'btn-ink' : 'btn-outline') }, pr.my === 1 ? '✓ Хочу встретиться снова' : '🤝 Встретиться снова');
      btn.addEventListener('click', async () => { try { const r = await api(`/api/events/${e.id}/peers/${pr.id}`, { method: 'POST', body: { value: pr.my === 1 ? -1 : 1 } }); pr.my = pr.my === 1 ? -1 : 1; btn.className = 'btn btn-sm ' + (pr.my === 1 ? 'btn-ink' : 'btn-outline'); btn.textContent = pr.my === 1 ? '✓ Хочу встретиться снова' : '🤝 Встретиться снова'; if (r.mutual) toast('Взаимно! Контактами обменяемся с согласия обоих'); } catch { toast('Не получилось'); } });
      list.append(el('div', { class: 'guest' }, el('span', { class: 'mini-avatar' }, pr.name.charAt(0)), el('b', {}, pr.name), el('span', {}), btn));
    }
    rootM.append(el('div', { class: 'modal-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'modal' }, el('h2', {}, 'Кто был рядом'), el('p', {}, 'Оценки участников приватные: их видит только система. При взаимном «встретиться снова» предложим обменяться контактами.'),
        data.peers.length ? list : el('div', { class: 'meta' }, 'Пока никто больше не подтвердил участие.'),
        el('div', { style: 'display:flex;justify-content:flex-end;margin-top:16px' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Закрыть')))));
  }
  // QR гостя: показывается с трёх часов до начала, организатор открывает камерой
  async function showQr(e) {
    const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; };
    let d; try { d = await api(`/api/events/${e.id}/qr`); } catch (err) { return toast(err.body?.message || 'QR появится за 3 часа до начала'); }
    const box = el('div', { class: 'qr-box' });
    try { const qr = window.qrcode(0, 'M'); qr.addData(d.url); qr.make(); box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch { box.textContent = d.url; }
    rootM.append(el('div', { class: 'modal-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'modal qr-modal' }, el('h2', {}, 'Покажите на входе'), el('p', {}, `${e.title} · ${fmtTime(new Date(e.start))}. Организатор наведёт камеру — участие подтвердится, и после события откроется отзыв.`), box,
        el('div', { class: 'help', style: 'margin-top:10px' }, me?.name ? `Гость: ${me.name}` : 'Подпишитесь в профиле, чтобы организатор видел имя'),
        el('div', { style: 'display:flex;justify-content:flex-end;margin-top:14px' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Закрыть')))));
  }
  async function renderCheckin(token) {
    const root = $('#app'); root.innerHTML = '';
    const page = el('div', { class: 'wrap page page-narrow' }, el('h1', { class: 'q-title' }, 'Подтверждение участия'));
    root.append(page);
    try {
      const r = await api(`/api/checkin/${encodeURIComponent(token)}`, { method: 'POST' });
      page.append(el('div', { class: 'checkin-ok' }, el('div', { class: 'e' }, '✅'), el('b', {}, `${r.guest.name} отмечен`), el('div', { class: 'meta' }, r.event.title), r.guest.contact ? el('div', { class: 'meta' }, r.guest.contact) : null),
        el('div', { class: 'org-actions' }, el('a', { class: 'btn btn-primary', href: '#/cabinet' }, 'В кабинет'), el('a', { class: 'btn btn-outline', href: `#/event/${r.event.id}` }, 'К событию')));
    } catch (err) {
      page.append(el('div', { class: 'empty' }, el('div', { class: 'e' }, '🚫'), el('b', {}, err.body?.message || 'Не удалось подтвердить'), el('div', { style: 'margin-top:10px' }, 'QR должен открыть организатор события со своего телефона, где он вошёл в кабинет.')));
    }
  }

  // ---------- Правила площадки ----------
  async function renderRules() {
    const root = $('#app'); root.innerHTML = ''; const rid = routeId;
    showPlaceholder(root);
    let text = '';
    try { text = await (await fetch('/legal/rules.md', { cache: 'no-cache' })).text(); } catch { text = 'Не удалось загрузить правила. Обновите страницу.'; }
    if (rid !== routeId) return; clearPlaceholder();
    const body = renderMarkdown(text); body.classList.add('legal');
    root.append(el('div', { class: 'wrap page page-narrow' }, el('a', { class: 'back', href: '#/' }, '← На главную'), body));
    window.scrollTo(0, 0);
  }

  // ---------- Аналитика для маркетолога ----------
  async function renderStats(days = 7) {
    const root = $('#app'); root.innerHTML = ''; const rid = routeId;
    showPlaceholder(root);
    let d;
    const token = store.get('aidaem_admin', '');
    try { d = await api(`/api/admin/stats?days=${days}`, { headers: token ? { 'X-Admin-Token': token } : {} }); }
    catch (err) {
      if (rid !== routeId) return; clearPlaceholder();
      const inp = el('input', { class: 'input', type: 'password', placeholder: 'Токен администратора', autocomplete: 'off' });
      root.append(el('div', { class: 'wrap page page-narrow' }, el('div', { class: 'gate' }, el('div', { class: 'e' }, '📊'), el('h1', {}, 'Аналитика'), el('p', {}, err.body?.message || 'Нужен доступ администратора.'),
        el('form', { class: 'gate-form', onsubmit: ev => { ev.preventDefault(); store.set('aidaem_admin', inp.value.trim()); renderStats(days); } }, inp, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Открыть')))));
      return;
    }
    if (rid !== routeId) return; clearPlaceholder();
    const t = d.totals, pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : '—';
    const tile = (k, v, sub) => el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v big' }, v), sub ? el('div', { class: 'meta' }, sub) : null);
    const bars = (rows, label, value, extra) => { const max = Math.max(1, ...rows.map(value)); return rows.length ? el('div', { class: 'hbars' }, rows.map(r => el('div', { class: 'bar-row' }, el('span', { class: 'bar-label', title: label(r) }, label(r)), el('span', { class: 'bar-track' }, el('i', { style: `width:${Math.max(2, value(r) / max * 100)}%` })), el('span', { class: 'bar-val' }, value(r), extra ? el('small', {}, extra(r)) : null)))) : el('div', { class: 'empty small' }, 'Пока нет данных за период'); };
    const block = (title, hint, body) => el('section', { class: 'section stats-block' }, el('h3', {}, title, hint ? el('span', { class: 'meta' }, ` · ${hint}`) : null), body);
    const f = d.funnel || {};
    root.append(el('div', { class: 'wrap page' },
      el('div', { class: 'cab-head' }, el('div', {}, el('h1', {}, 'Аналитика'), el('p', { class: 'lead' }, 'Откуда приходят гости, что ищут и сколько доходит до записи.')),
        el('div', { class: 'pills' }, [7, 30, 90].map(n => el('button', { type: 'button', class: 'pill' + (n === d.days ? ' on' : ''), onclick: () => renderStats(n) }, `${n} дней`)))),
      el('div', { class: 'stats stats-4' },
        tile('Визиты', t.sessions, `${t.visitors} уникальных`), tile('Поиски', t.searches, `ИИ-разбор: ${pct(t.ai_searches, t.searches)}, модель: ${pct(t.model_searches, t.ai_searches)}`),
        tile('Записи на события', t.registrations, `конверсия визита: ${pct(f.registered || 0, f.visited || 0)}`), tile('Новые аккаунты', t.signups, `через Яндекс/Google: ${t.oauth_logins}`),
        tile('Из ИИ-ассистентов', d.aiAssist?.sessions || 0, `записались: ${d.aiAssist?.converted || 0}`), tile('Запросы из Алисы', t.alice_requests, 'навык «Айдагез»'),
        tile('Поиски без результата', t.zero_searches, pct(t.zero_searches, t.searches) + ' от всех'), tile('Жалобы', t.open_reports, 'ждут проверки')),
      block('Воронка', 'сессии за период', bars([['Зашли', f.visited], ['Искали или выбирали', f.searched], ['Открыли событие', f.viewed], ['Записались', f.registered]].map(([k, v]) => ({ k, v: v || 0 })), r => r.k, r => r.v)),
      block('По дням', 'визиты · поиски · записи', bars(d.daily, r => r.day, r => r.sessions, r => ` · ${r.searches} · ${r.registrations}`)),
      el('div', { class: 'grid2 stats-cols' },
        block('Источники', 'utm_source или сайт-источник', bars(d.sources, r => r.source, r => r.sessions, r => r.converted ? ` · ${r.converted} записались` : '')),
        block('Кампании (UTM)', 'источник / канал / кампания', bars(d.campaigns, r => [r.source, r.medium, r.campaign].filter(Boolean).join(' / '), r => r.sessions, r => r.converted ? ` · ${r.converted}` : ''))),
      el('div', { class: 'grid2 stats-cols' },
        block('Частые запросы', '✨ — разобраны ИИ', bars(d.topQueries, r => (r.ai ? '✨ ' : '') + r.query, r => r.n, r => ` · ${r.results} рез.`)),
        block('Запросы без результата', 'что добавить в афишу', bars(d.zeroQueries, r => r.query, r => r.n))),
      el('div', { class: 'grid2 stats-cols' },
        block('Страницы входа', null, bars(d.landings, r => r.landing || '/', r => r.sessions)),
        block('Устройства', null, bars(d.devices, r => r.device === 'mobile' ? 'Телефон' : r.device === 'desktop' ? 'Компьютер' : r.device, r => r.sessions))),
      block('Жалобы', 'открытые', d.reports.length ? el('div', { class: 'report-list' }, d.reports.map(r => el('div', { class: 'report-row' },
        el('div', {}, el('b', {}, r.reasonTitle), el('div', { class: 'meta' }, r.title ? el('a', { href: `#/event/${r.slug}` }, r.title) : 'событие удалено', ' · ', new Date(r.created_at).toLocaleString('ru-RU')), r.comment ? el('div', { class: 'help' }, r.comment) : null),
        el('div', { class: 'report-actions' }, el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: async () => { await api(`/api/admin/reports/${r.id}/resolve`, { method: 'POST', headers: token ? { 'X-Admin-Token': token } : {}, body: {} }); renderStats(days); } }, 'Всё в порядке'),
          el('button', { type: 'button', class: 'btn btn-ghost btn-danger btn-sm', onclick: async () => { await api(`/api/admin/reports/${r.id}/resolve`, { method: 'POST', headers: token ? { 'X-Admin-Token': token } : {}, body: { hide: true } }); toast('Событие скрыто'); renderStats(days); } }, 'Скрыть событие'))))) : el('div', { class: 'empty small' }, 'Жалоб нет')),
      el('p', { class: 'help' }, 'Как размечать ссылки: ?utm_source=vk&utm_medium=post&utm_campaign=autumn. Ссылки из навыка Алисы приходят с utm_source=alice. Ссылка на событие для соцсетей и поисковиков: /e/<адрес события>.')));
    window.scrollTo(0, 0);
  }

  // ---------- Жалоба на событие ----------
  function reportModal(e) {
    const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; };
    const reasons = [['illegal', 'Запрещённое или незаконное мероприятие'], ['fraud', 'Мошенничество или подозрительная оплата'], ['adult', '18+ без маркировки или не для детей'], ['wrong', 'Неверная информация: время, место, цена'], ['spam', 'Спам или реклама без пометки'], ['other', 'Другое']];
    let reason = null;
    const list = el('div', { class: 'radio-list' }, reasons.map(([k, t]) => el('label', {}, el('input', { type: 'radio', name: 'reason', value: k, onchange: () => { reason = k; } }), t)));
    const comment = el('textarea', { class: 'input', style: 'height:80px;padding:12px 14px', maxlength: 1000, placeholder: 'Что не так? Необязательно' });
    rootM.append(el('div', { class: 'modal-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'modal' }, el('h2', {}, 'Пожаловаться на событие'), el('p', {}, 'Проверим в течение рабочего дня. Организатор не узнает, кто пожаловался.'),
        list, el('div', { class: 'field', style: 'margin-top:12px' }, comment),
        el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Отмена'),
          el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => { if (!reason) return toast('Выберите причину'); try { await api(`/api/events/${e.id}/report`, { method: 'POST', body: { reason, comment: comment.value.trim() } }); close(); toast('Спасибо, проверим'); } catch { toast('Не получилось отправить'); } } }, 'Отправить')))));
  }
  const shareUrl = e => `${location.origin}/e/${e.slug}`;
  // Кнопки входа через Яндекс ID, Google и Госуслуги (скоро)
  function authButtons() {
    const list = config?.authProviders || [{ key: 'yandex', title: 'Яндекс ID', enabled: false }, { key: 'google', title: 'Google', enabled: false }, { key: 'gosuslugi', title: 'Госуслуги', enabled: false, soon: true }];
    const ico = { yandex: '🟥', google: '🟦', gosuslugi: '🏛️' };
    return el('div', { class: 'auth-row' }, list.map(p => el('button', { type: 'button', class: 'btn btn-outline auth-btn' + (p.soon ? ' soon' : ''), disabled: !!p.soon, onclick: () => {
      if (!p.enabled) return toast(`Вход через ${p.title} заработает после подключения ключей приложения`);
      location.href = `/auth/${p.key}?ret=${encodeURIComponent(location.hash || '#/my')}`;
    } }, el('span', {}, ico[p.key] || '🔑'), p.soon ? `${p.title} · скоро` : p.title)));
  }
  function profileModal({ gate = null, onDone = null, type = null } = {}) {
    const rootM = $('#modal-root');
    const close = () => { rootM.innerHTML = ''; };
    const st = { avatar: me?.avatarId || null, avatarUrl: me?.avatar || null, type: type || me?.accountType || 'person' };
    const name = el('input', { class: 'input', value: me?.name || '' });
    const nameLabel = el('label', {}); const nameHelp = el('div', { class: 'help' });
    const contact = el('input', { class: 'input', placeholder: 'Телефон или email', value: me?.contact || '' });
    const about = el('textarea', { class: 'input', style: 'height:80px;padding:12px 14px', maxlength: 600 }, me?.about || '');
    const avatarThumb = el('div', { class: 'logo-thumb round' });
    const paintAv = () => { avatarThumb.style.backgroundImage = st.avatarUrl ? `url(${st.avatarUrl})` : ''; avatarThumb.textContent = st.avatarUrl ? '' : (name.value.trim().charAt(0).toUpperCase() || '🙂'); };
    name.addEventListener('input', paintAv);
    const paintName = () => {
      const org = st.type === 'org';
      nameLabel.textContent = org ? 'Название организации' : 'Имя';
      name.placeholder = org ? 'Например, «Кинотеатр Родина» или «Клуб настолок Единорог»' : 'Как вас зовут';
      nameHelp.textContent = org ? 'Не переживайте: название, описание и логотип можно поменять в личном кабинете.' : 'Имя увидит организатор в списке гостей.';
      about.placeholder = org ? 'Чем занимается организация' : 'Пара слов о себе: чем увлекаетесь, кого ищете в компанию';
    };
    const typeBox = el('div', { class: 'type-switch' });
    const paintType = () => { typeBox.innerHTML = ''; for (const [k, ic, t, d] of [['person', '🙂', 'Человек', 'Записываюсь на события, могу собрать небольшую встречу до 30 человек'], ['org', '🏷️', 'Организация', 'Кинотеатр, клуб, прокат, студия: сеансы, слоты, продвижение, команда']]) typeBox.append(el('button', { type: 'button', class: 'type-btn' + (st.type === k ? ' on' : ''), onclick: () => { st.type = k; paintType(); paintName(); } }, el('span', { class: 'e' }, ic), el('b', {}, t), el('small', {}, d))); };
    paintType(); paintName(); paintAv();
    const pick = el('label', { class: 'btn btn-outline btn-sm' }, '📷 Фото', el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async ev => { const file = ev.target.files[0]; if (!file) return; try { toast('Загружаем…'); const r = await uploadImage(file); st.avatar = r.id; st.avatarUrl = r.url; paintAv(); } catch { toast('Не удалось загрузить'); } } }));
    const full = !gate; // полный профиль редактируется в личном кабинете; при регистрации — только тип, имя и контакт
    rootM.append(el('div', { class: 'modal-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'modal' }, el('h2', {}, gate || (me?.registered ? 'Профиль' : 'Представьтесь')),
        el('p', {}, gate ? 'Это и есть регистрация, без паролей: кто вы, как называть и куда прислать напоминание. Фото и описание добавите в личном кабинете.' : 'Имя и фото покажем организатору в списке гостей, контакт — только для напоминаний.'),
        !me?.registered ? el('div', { class: 'field' }, el('label', {}, 'Быстрый вход'), authButtons(), el('div', { class: 'or-line' }, el('span', {}, 'или заполните сами'))) : null,
        el('div', { class: 'field' }, el('label', {}, 'Кто вы'), typeBox),
        full ? el('div', { class: 'pic-block', style: 'margin:6px 0 10px' }, avatarThumb, el('div', {}, pick, st.avatar ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { st.avatar = null; st.avatarUrl = null; paintAv(); } }, 'Убрать') : null)) : null,
        el('div', { class: 'field' }, nameLabel, name, nameHelp), el('div', { class: 'field' }, el('label', {}, 'Контакт'), contact, el('div', { class: 'help' }, 'Телефон или email: напоминание за 24 часа и QR на входе.')),
        full ? el('div', { class: 'field' }, el('label', {}, st.type === 'org' ? 'Об организации' : 'О себе'), about) : null,
        me?.rulesAccepted ? null : el('label', { class: 'toggle-check rules-check' }, (st.rules = el('input', { type: 'checkbox' })), el('span', {}, el('b', {}, 'Принимаю правила площадки'), el('small', {}, el('a', { href: '#/rules', target: '_blank' }, 'Прочитать правила'), ' · запрещённые мероприятия, возраст, расчёты'))),
        el('div', { class: 'modal-actions' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Отмена'),
          el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
            if (!name.value.trim()) return toast(st.type === 'org' ? 'Введите название организации' : 'Как к вам обращаться?');
            if (!contact.value.trim()) return toast('Нужен телефон или email');
            if (st.rules && !st.rules.checked) return toast('Отметьте, что принимаете правила площадки');
            try { const body = { name: name.value.trim(), contact: contact.value.trim(), account_type: st.type, accept_rules: !!st.rules?.checked }; if (full) { body.about = about.value.trim(); body.avatar = st.avatar === null ? null : st.avatar; } await api('/api/me', { method: 'PATCH', body }); await loadMe(); close(); toast('Сохранили'); if (onDone) onDone(); else if (location.hash === '#/my') renderMy(); else if (location.hash.startsWith('#/new')) route(); } catch (err) { toast(err.body?.message || 'Не получилось'); }
          } }, gate ? 'Готово' : 'Сохранить')))));
    name.focus();
  }

  // ---------- Создать предложение: сценарий → что и где → расписание → места → описание → оформление ----------
  const WDAYS = [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [0, 'Вс']];
  const SCENARIOS = [
    { key: 'single', emoji: '🎤', title: 'Разовое событие', desc: 'Концерт, лекция, квиз, вечеринка, встреча', hint: 'Одна дата и время' },
    { key: 'regular', emoji: '🔁', title: 'Регулярное занятие', desc: 'Клуб по средам, йога по выходным, тренировки', hint: 'Дни недели и время, серия создаётся сразу' },
    { key: 'sessions', emoji: '🎬', title: 'Сеансы', desc: 'Кино, театр, экскурсии, планетарий', hint: 'Несколько показов в день, места в зале', cat: 'culture', sub: 'cinema' },
    { key: 'rental', emoji: '🚲', title: 'Прокат по часам', desc: 'Велосипеды, сапы, коньки, корты, лодки', hint: 'N единиц; в каждый час занято столько-то', cat: 'sport', sub: 'walk' },
    { key: 'groups', emoji: '🏄', title: 'Сеансы с группами', desc: 'Вейк, картинг, квесты, мастер-классы', hint: 'Размер группы и сколько групп параллельно', cat: 'sport', sub: 'walk' },
    { key: 'open', emoji: '🏛️', title: 'Свободное посещение', desc: 'Каток, выставка, парк, антикафе', hint: 'Открыто с … до …, приходите когда удобно', cat: 'culture', sub: 'exhibition' },
  ];
  const UNIT_NAMES = [['велосипед', 'Велосипеды'], ['самокат', 'Самокаты'], ['сап', 'Сапы'], ['лодка', 'Лодки и катамараны'], ['коньки', 'Коньки'], ['корт', 'Корты'], ['дорожка', 'Дорожки'], ['место', 'Другое']];
  const timeToMin = t => { const [h, m] = String(t || '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
  const minToTime = n => `${pad2(Math.floor(n / 60) % 24)}:${pad2(n % 60)}`;
  function expandDatesClient(first, rec) {
    const start = parseIso(first); const out = [];
    if (!rec || rec.freq === 'none') return [start];
    let until = rec.until ? parseIso(rec.until) : addDays(start, 56); const cap = addDays(start, 183); if (until > cap) until = cap; if (until < start) until = start;
    const wd = rec.weekdays && rec.weekdays.length ? rec.weekdays : [start.getDay()];
    for (let d = new Date(start); d <= until; d = addDays(d, 1)) {
      const weeks = Math.floor((d - start) / 864e5 / 7);
      if (rec.freq === 'daily' || (rec.freq === 'weekly' && wd.includes(d.getDay())) || (rec.freq === 'biweekly' && wd.includes(d.getDay()) && weeks % 2 === 0) || (rec.freq === 'monthly' && d.getDate() === start.getDate())) out.push(new Date(d));
      if (out.length >= 366) break;
    }
    return out.length ? out : [start];
  }

  async function renderNew() {
    const root = $('#app'); root.innerHTML = '';
    if (me === null) await loadMe(); // прямой переход по ссылке: профиль ещё не загружен — не показывать «представьтесь» зря
    if (!me?.registered) {
      root.append(el('div', { class: 'wrap page page-narrow' }, el('a', { class: 'back', href: '#/' }, '← Назад'), el('div', { class: 'gate' }, el('div', { class: 'e' }, '👤'), el('h1', {}, 'Сначала представьтесь'), el('p', {}, 'Чтобы создавать события, нужны имя, контакт и тип аккаунта: человек собирает небольшие встречи (до 30 человек), организация ведёт сеансы, прокат, расписание и продвижение. Паролей нет.'), el('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: () => profileModal({ gate: 'Представьтесь', onDone: () => route() }) }, 'Представиться'))));
      return;
    }
    const isOrg = me.accountType === 'org';
    const f = {};
    const input = (n, a = {}) => (f[n] = el('input', { name: n, ...a }));
    const select = (n, opts, val) => (f[n] = el('select', { name: n }, opts.map(([v, t]) => el('option', { value: v, selected: String(v) === String(val) }, t))));
    const field = (label, node, req, help) => el('div', { class: 'field' }, el('label', {}, label, req === true ? el('i', {}, ' *') : req === 'opt' ? el('span', { class: 'opt-mark' }, ' · необязательно') : null), node, help ? el('div', { class: 'help' }, help) : null);
    const section = (num, title, sub, ...kids) => el('section', { class: 'nf-section' }, el('div', { class: 'nf-head' }, el('span', { class: 'nf-num' }, num), el('div', {}, el('h2', {}, title), sub ? el('p', {}, sub) : null)), ...kids);
    let kind = 'single';

    // ---- 2. Что и где
    const catSel = select('cat', taxonomy.map(c => [c.key, `${c.emoji} ${c.title}`]));
    const subSel = select('sub', []);
    const fillSubs = keep => { const v = keep ? subSel.value : ''; subSel.innerHTML = ''; subSel.append(el('option', { value: '' }, 'Без уточнения')); for (const sb of catOf(catSel.value)?.subs || []) subSel.append(el('option', { value: sb.key, selected: sb.key === v }, `${sb.emoji} ${sb.title}`)); };
    fillSubs();
    const design = designerFields({ title: () => f.title?.value || '', category: catSel.value, emoji: catOf(catSel.value)?.emoji });
    const syncDesign = () => design.setContext({ category: catSel.value, emoji: subSel.value ? subOf(catSel.value, subSel.value)?.emoji : catOf(catSel.value)?.emoji });
    catSel.addEventListener('change', () => { fillSubs(); syncDesign(); quality(); });
    subSel.addEventListener('change', () => { syncDesign(); quality(); });

    // ---- 1. Сценарий
    const scenBox = el('div', { class: 'scen-grid' });
    const paintScen = () => { for (const b of scenBox.children) b.classList.toggle('on', b.dataset.k === kind); };
    const ORG_ONLY = new Set(['sessions', 'rental', 'groups', 'open']);
    for (const sc of SCENARIOS) scenBox.append(el('button', { type: 'button', class: 'scen' + (!isOrg && ORG_ONLY.has(sc.key) ? ' locked' : ''), 'data-k': sc.key, title: !isOrg && ORG_ONLY.has(sc.key) ? 'Доступно организациям' : '', onclick: () => {
      if (!isOrg && ORG_ONLY.has(sc.key)) { toast('Такие форматы ведут организации'); return profileModal({ type: 'org', gate: 'Стать организацией', onDone: () => route() }); }
      kind = sc.key; paintScen();
      if (sc.cat) { catSel.value = sc.cat; fillSubs(); if (sc.sub) subSel.value = sc.sub; syncDesign(); }
      renderSchedule(); renderPlaces(); updateSummary(); quality();
    } }, el('span', { class: 'scen-emoji' }, sc.emoji), el('span', { class: 'scen-body' }, el('b', {}, sc.title), el('small', {}, sc.desc), el('em', {}, sc.hint), !isOrg && ORG_ONLY.has(sc.key) ? el('span', { class: 'scen-lock' }, '🔒 для организаций') : null)));

    // ---- 3. Расписание (зависит от сценария)
    const sched = el('div', { class: 'sched' });
    const sc = {}; // элементы расписания текущего сценария
    const wdChecks = defaults => { const box = el('div', { class: 'checks wd-checks' }, WDAYS.map(([v, t]) => el('label', {}, el('input', { type: 'checkbox', value: v, checked: defaults.includes(v), onchange: updateSummary }), t))); box.get = () => [...box.querySelectorAll('input:checked')].map(i => Number(i.value)); return box; };
    const timesList = initial => {
      const box = el('div', { class: 'times' });
      const add = v => { const row = el('div', { class: 'time-row' }, el('input', { type: 'time', value: v, required: true, onchange: updateSummary }), el('button', { type: 'button', class: 'icon-btn', title: 'Убрать', onclick: () => { if (box.children.length > 1) { row.remove(); updateSummary(); } } }, '✕')); box.append(row); };
      initial.forEach(add);
      const wrap = el('div', {}, box, el('div', { class: 'times-actions' }, el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { add('20:00'); updateSummary(); } }, '+ Ещё время')));
      wrap.get = () => [...box.querySelectorAll('input[type=time]')].map(i => i.value).filter(Boolean);
      return wrap;
    };
    const dateIn = (v, extra = {}) => dateField(v, { min: iso(today), onchange: updateSummary, ...extra });
    const timeIn = v => el('input', { type: 'time', value: v, required: true, onchange: updateSummary });
    const numSel = (opts, v) => el('select', { onchange: updateSummary }, opts.map(([x, t]) => el('option', { value: x, selected: String(x) === String(v) }, t)));
    function renderSchedule() {
      sched.innerHTML = '';
      for (const k of Object.keys(sc)) delete sc[k];
      const tomorrow = iso(addDays(today, 1));
      if (kind === 'single') {
        sc.date = dateIn(tomorrow); sc.time = timeIn('19:00'); sc.duration = numSel([[60, '1 час'], [90, '1,5 часа'], [120, '2 часа'], [180, '3 часа'], [240, '4 часа'], [360, '6 часов']], 120);
        sched.append(el('div', { class: 'grid3' }, field('Дата', sc.date, true), field('Начало', sc.time, true), field('Длительность', sc.duration)));
      } else if (kind === 'regular') {
        sc.date = dateIn(tomorrow); sc.until = dateIn(iso(addDays(today, 56)), { max: iso(addDays(today, 183)) }); sc.freq = numSel([['weekly', 'Каждую неделю'], ['biweekly', 'Раз в две недели'], ['monthly', 'Раз в месяц']], 'weekly');
        sc.wd = wdChecks([parseIso(tomorrow).getDay()]); sc.times = timesList(['19:00']); sc.duration = numSel([[45, '45 минут'], [60, '1 час'], [90, '1,5 часа'], [120, '2 часа'], [180, '3 часа']], 90);
        sched.append(el('div', { class: 'grid3' }, field('Первое занятие', sc.date, true), field('Повторять', sc.freq), field('До даты', sc.until)), field('Дни недели', sc.wd), field('Время занятий', sc.times, true, 'Несколько времён — если есть утренняя и вечерняя группы'), field('Длительность', sc.duration));
      } else if (kind === 'sessions') {
        sc.date = dateIn(tomorrow); sc.until = dateIn(iso(addDays(today, 14)), { max: iso(addDays(today, 183)) }); sc.wd = wdChecks([0, 1, 2, 3, 4, 5, 6]); sc.times = timesList(['14:00', '17:00', '20:30']); sc.duration = numSel([[60, '1 час'], [90, '1,5 часа'], [120, '2 часа'], [150, '2,5 часа'], [180, '3 часа']], 120);
        sched.append(el('div', { class: 'grid3' }, field('С даты', sc.date, true), field('По дату', sc.until, true), field('Длительность сеанса', sc.duration)), field('Дни показа', sc.wd), field('Сеансы в течение дня', sc.times, true, 'Каждый сеанс — отдельная запись с местами в зале'));
      } else if (kind === 'rental' || kind === 'groups') {
        sc.date = dateIn(iso(today)); sc.until = dateIn(iso(addDays(today, 30)), { max: iso(addDays(today, 183)) }); sc.wd = wdChecks([0, 1, 2, 3, 4, 5, 6]); sc.from = timeIn('10:00'); sc.to = timeIn('20:00');
        sc.step = numSel(kind === 'rental' ? [[30, '30 минут'], [60, '1 час'], [90, '1,5 часа'], [120, '2 часа'], [180, '3 часа']] : [[15, '15 минут'], [20, '20 минут'], [30, '30 минут'], [45, '45 минут'], [60, '1 час'], [90, '1,5 часа'], [120, '2 часа']], 60);
        sc.gap = numSel([[0, 'без перерыва'], [5, '5 минут'], [10, '10 минут'], [15, '15 минут'], [30, '30 минут']], 0);
        sched.append(el('div', { class: 'grid3' }, field('С даты', sc.date, true), field('По дату', sc.until, true), field('Дни работы', sc.wd)),
          el('div', { class: 'grid3' }, field('Открываемся', sc.from, true), field('Закрываемся', sc.to, true), field(kind === 'rental' ? 'Шаг брони' : 'Длительность сеанса', sc.step)),
          ...(kind === 'groups' ? [field('Перерыв между сеансами', sc.gap)] : []),
          el('div', { class: 'help' }, kind === 'rental' ? 'Получится сетка слотов: например, 10:00, 11:00 … 19:00 — в каждом слоте столько мест, сколько единиц в прокате.' : 'Получится сетка сеансов; в каждом столько мест, сколько человек во всех параллельных группах.'));
      } else if (kind === 'open') {
        sc.date = dateIn(iso(today)); sc.until = dateIn(iso(addDays(today, 30)), { max: iso(addDays(today, 183)) }); sc.wd = wdChecks([0, 1, 2, 3, 4, 5, 6]); sc.from = timeIn('10:00'); sc.to = timeIn('22:00');
        sched.append(el('div', { class: 'grid3' }, field('С даты', sc.date, true), field('По дату', sc.until, true), field('Дни работы', sc.wd)), el('div', { class: 'grid3' }, field('Открыто с', sc.from, true), field('до', sc.to, true)), el('div', { class: 'help' }, 'На каждый день появится одна карточка «открыто с … до …», гости отмечают «Пойду».'));
      }
    }
    function getSchedule() {
      const times = [], rec = { freq: 'none', weekdays: [], until: null };
      let duration = 120;
      if (kind === 'single') { times.push(sc.time.value); duration = Number(sc.duration.value); }
      else if (kind === 'regular') { times.push(...sc.times.get()); duration = Number(sc.duration.value); Object.assign(rec, { freq: sc.freq.value, weekdays: sc.wd.get(), until: sc.until.value }); }
      else if (kind === 'sessions') { times.push(...sc.times.get()); duration = Number(sc.duration.value); Object.assign(rec, { freq: 'weekly', weekdays: sc.wd.get(), until: sc.until.value }); }
      else if (kind === 'rental' || kind === 'groups') {
        const a = timeToMin(sc.from.value), b = timeToMin(sc.to.value), step = Number(sc.step.value), gap = kind === 'groups' ? Number(sc.gap.value) : 0;
        if (a != null && b != null) for (let t = a; t + step <= b && times.length < 48; t += step + gap) times.push(minToTime(t));
        duration = step; Object.assign(rec, { freq: 'weekly', weekdays: sc.wd.get(), until: sc.until.value });
      } else if (kind === 'open') {
        const a = timeToMin(sc.from.value), b = timeToMin(sc.to.value); times.push(sc.from.value); duration = a != null && b != null && b > a ? b - a : 480; Object.assign(rec, { freq: 'weekly', weekdays: sc.wd.get(), until: sc.until.value });
      }
      if (!rec.weekdays.length && rec.freq !== 'none' && rec.freq !== 'monthly') rec.weekdays = [0, 1, 2, 3, 4, 5, 6];
      return { date: sc.date.value, times: [...new Set(times.filter(Boolean))].sort(), recurrence: rec, duration };
    }

    // ---- 4. Цена и места (зависит от сценария)
    const places = el('div', { class: 'places' });
    const pl = {};
    function renderPlaces() {
      places.innerHTML = ''; for (const k of Object.keys(pl)) delete pl[k];
      pl.price = el('input', { type: 'number', min: 0, step: 50, value: 0, oninput: () => { updateSummary(); quality(); } });
      if (kind === 'rental') {
        pl.units = el('input', { type: 'number', min: 1, value: 5, oninput: updateSummary }); pl.unit = numSel(UNIT_NAMES, 'велосипед');
        places.append(el('div', { class: 'grid3' }, field('Что сдаёте', pl.unit), field('Сколько единиц', pl.units, true, 'Столько броней поместится в один час'), field('Цена за слот, ₽', pl.price, true, '0 — бесплатно')));
      } else if (kind === 'groups') {
        pl.groupSize = el('input', { type: 'number', min: 1, value: 6, oninput: updateSummary }); pl.groups = el('input', { type: 'number', min: 1, value: 1, oninput: updateSummary });
        places.append(el('div', { class: 'grid3' }, field('Человек в группе', pl.groupSize, true), field('Групп одновременно', pl.groups, true, 'Сколько инструкторов, катеров или трасс работают параллельно'), field('Цена за человека, ₽', pl.price, true)));
      } else if (kind === 'open') {
        pl.capacity = el('input', { type: 'number', min: 1, value: 300, oninput: updateSummary });
        places.append(el('div', { class: 'grid3' }, field('Вход, ₽', pl.price, true, '0 — бесплатно'), field('Посетителей одновременно', pl.capacity, false, 'Примерно, для ограничения записей')));
      } else {
        pl.capacity = el('input', { type: 'number', min: 1, value: kind === 'sessions' ? 100 : 30, oninput: updateSummary });
        places.append(el('div', { class: 'grid3' }, field(kind === 'sessions' ? 'Цена билета, ₽' : 'Цена за человека, ₽', pl.price, true, 'Итоговая, со всеми сборами. 0 — бесплатно'), field(kind === 'sessions' ? 'Мест в зале' : kind === 'regular' ? 'Мест на занятие' : 'Мест', pl.capacity, true)));
      }
    }
    function getPlaces() {
      const price = Math.max(0, Number(pl.price.value) || 0);
      if (kind === 'rental') return { price, capacity: Math.max(1, Number(pl.units.value) || 1), meta: { units: Number(pl.units.value) || 1, unit_name: pl.unit.value, open_from: sc.from.value, open_to: sc.to.value, step: Number(sc.step.value) } };
      if (kind === 'groups') { const g = Math.max(1, Number(pl.groupSize.value) || 1), n = Math.max(1, Number(pl.groups.value) || 1); return { price, capacity: g * n, meta: { group_size: g, groups: n, open_from: sc.from.value, open_to: sc.to.value, step: Number(sc.step.value) } }; }
      if (kind === 'open') return { price, capacity: Math.max(1, Number(pl.capacity.value) || 300), meta: { open_from: sc.from.value, open_to: sc.to.value } };
      return { price, capacity: Math.max(1, Number(pl.capacity.value) || 1), meta: kind === 'sessions' ? { seats: Number(pl.capacity.value) || 1 } : {} };
    }

    // ---- 5. Описание и ключевые слова, индикатор полноты
    const descEd = mdEditor('', 'Что будет, для кого, что взять с собой, как найти вход. Можно вставлять фото и заголовки — страница будет как лендинг.');
    const desc = descEd.ta; desc.addEventListener('input', quality);
    const video = el('input', { type: 'url', placeholder: 'Ссылка на видео: VK Видео, Rutube или YouTube' });
    const kw = el('input', { type: 'text', placeholder: 'через запятую: вейкборд, катер, новичкам, Казанка', oninput: quality });
    const qBar = el('div', { class: 'q-bar' }, el('i')); const qText = el('div', { class: 'q-text' }); const qTips = el('ul', { class: 'q-tips' });
    function quality() {
      const tips = []; let score = 0;
      const t = (f.title?.value || '').trim(), d = desc.value.trim(), k = kw.value.split(',').map(x => x.trim()).filter(Boolean);
      if (t.length >= 8) score += 15; else tips.push('Название от 8 символов');
      if (f.venue?.value.trim()) score += 10; else tips.push('Место');
      if (f.address?.value.trim()) score += 10; else tips.push('Адрес — покажем на карте');
      if (subSel.value) score += 10; else tips.push('Уточните подкатегорию');
      if (d.length >= 200) score += 25; else if (d.length >= 80) { score += 15; tips.push('Описание от 200 символов'); } else tips.push('Описание от 80 символов');
      if (k.length >= 3) score += 15; else tips.push('3+ ключевых слова, по которым вас ищут');
      if (design.get().cover) score += 10; else tips.push('Обложка');
      if (design.get().photos.length) score += 5;
      qBar.firstChild.style.width = `${score}%`; qBar.className = 'q-bar ' + (score >= 80 ? 'good' : score >= 50 ? 'ok' : 'low');
      qText.textContent = `Заполнено на ${score}% — ${score >= 80 ? 'карточку легко найти' : score >= 50 ? 'неплохо, но можно лучше' : 'в поиске будет ниже конкурентов'}`;
      qTips.innerHTML = ''; tips.slice(0, 4).forEach(x => qTips.append(el('li', {}, x)));
    }

    // ---- Итог
    const summary = el('div', { class: 'nf-summary' });
    function updateSummary() {
      try {
        const sch = getSchedule(); const dates = expandDatesClient(sch.date, sch.recurrence); const n = Math.min(1200, dates.length * sch.times.length); const pls = getPlaces();
        summary.innerHTML = '';
        summary.append(el('b', {}, n === 1 ? 'Будет создано 1 событие' : `Будет создано ${n} ${plural(n, ['событие', 'события', 'событий'])}`),
          el('span', {}, dates.length > 1 ? ` · ${dates.length} ${plural(dates.length, ['день', 'дня', 'дней'])}` : '', sch.times.length > 1 ? ` · ${sch.times.length} ${plural(sch.times.length, ['сеанс', 'сеанса', 'сеансов'])} в день` : '', ` · ${pls.capacity} ${plural(pls.capacity, ['место', 'места', 'мест'])} на сеанс`),
          ...(n >= 1200 ? [el('div', { class: 'help' }, 'Больше 1200 за раз не создаём — сократите период')] : []));
      } catch { summary.textContent = ''; }
    }

    renderSchedule(); renderPlaces(); paintScen();

    const form = el('form', { onsubmit: async ev => {
      ev.preventDefault();
      const v = n => (f[n]?.value || '').trim();
      const sch = getSchedule(); const pls = getPlaces();
      if (!sch.times.length) return toast('Укажите время');
      const body = { kind, title: v('title'), cat: catSel.value, sub: subSel.value || null, date: sch.date, times: sch.times, duration: sch.duration, recurrence: sch.recurrence,
        price: pls.price, capacity: pls.capacity, meta: { ...pls.meta, tg: v('tg') || undefined, max: v('maxh') || undefined }, keywords: kw.value, lang: f.lang.value, venue: v('venue'), address: v('address'), district: f.district.value, organizer: v('organizer') || me?.name || '',
        description: desc.value.trim(), video_url: video.value.trim() || null, age: Number(f.age.value), rules_ok: me?.rulesAccepted || !!f.rulesOk?.checked, with: WITH.map(([k]) => k).filter(k => f['w_' + k]?.checked), pushkin: f.pushkin.checked, registration: f.regExt.checked ? { type: 'external', url: v('url') } : { type: 'here' }, ...design.get() };
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Публикуем…';
      try { const r = await api('/api/events', { method: 'POST', body }); facets = null; await loadMe(); toast(r.created > 1 ? `Создано событий: ${r.created}` : 'Опубликовано 🎉'); location.hash = r.created > 1 ? '#/cabinet' : `#/event/${r.first.slug}`; }
      catch (err) { btn.disabled = false; btn.textContent = 'Опубликовать'; toast(err.body?.message || 'Проверьте обязательные поля'); }
    } },
      section('1', 'Что планируете?', 'От этого зависят вопросы ниже — как на Авито, где квартира и телефон заполняются по-разному.', scenBox),
      section('2', 'Главное', 'Четыре поля — и событие можно публиковать. Остальное заполните ниже или позже в кабинете.',
        field('Название', input('title', { required: true, maxlength: 120, placeholder: 'Например, «Прокат велосипедов на набережной» или «Шахматы по средам»', oninput: () => { design.paint(); quality(); } }), true),
        el('div', { class: 'grid2' }, field('Категория', catSel, true), field('Уточнение', subSel, 'opt', 'Помогает поиску')),
        (() => {
          const ageSel = select('age', [[0, '0+ · для всех'], [6, '6+'], [12, '12+'], [16, '16+'], [18, '18+ · только взрослые']], 0);
          const kidsBox = (f.w_kids = el('input', { type: 'checkbox' }));
          const kidsLbl = el('label', { class: 'toggle-check' }, kidsBox, el('span', {}, el('b', {}, '🧒 Можно с детьми'), el('small', {}, 'Покажем в подборках «С детьми»')));
          const dogsLbl = el('label', { class: 'toggle-check' }, (f.w_dogs = el('input', { type: 'checkbox' })), el('span', {}, el('b', {}, '🐕 Можно с собаками'), el('small', {}, 'Покажем по запросам «с собакой»')));
          const sync = () => { const adult = Number(ageSel.value) >= 16; kidsBox.disabled = adult; if (adult) kidsBox.checked = false; kidsLbl.classList.toggle('off', adult); };
          ageSel.addEventListener('change', sync); sync();
          return el('div', {}, el('div', { class: 'grid2' }, field('Возраст', ageSel, true, 'Маркировка по закону о защите детей'), field('С кем можно', el('div', { class: 'toggle-stack' }, kidsLbl, dogsLbl), 'opt')));
        })(),
        el('div', { class: 'grid2' }, field('Место', input('venue', { required: true, placeholder: 'Парк Горького, у главного входа', oninput: quality }), true), field('Адрес', input('address', { placeholder: 'ул. Николая Ершова, 1', oninput: quality }), 'opt', 'Покажем на карте'))),
      section('3', 'Когда', null, sched),
      section('4', 'Цена и места', null, places),
      el('details', { class: 'nf-more' }, el('summary', {}, el('b', {}, 'Подробнее — можно заполнить позже'), el('span', {}, 'Описание, фото и оформление, район, организатор, язык, запись по ссылке. Чем подробнее, тем выше в поиске.')),
        el('div', { class: 'nf-more-body' },
          field('Описание', descEd.el, 'opt', 'Лучше 200+ символов: что будет, для кого, как найти вход'),
          el('div', { class: 'grid2' }, field('Район', select('district', ['Вахитовский', 'Советский', 'Ново-Савиновский', 'Приволжский', 'Кировский', 'Московский', 'Авиастроительный'].map(d => [d, d])), 'opt'),
            field('Организатор', input('organizer', { value: me?.name || '', placeholder: 'Название клуба, студии или ваше имя' }), 'opt', 'По умолчанию — имя из профиля')),
          el('div', { class: 'grid2' }, field('Язык', select('lang', [['ru', 'Русский'], ['tt', 'Татарский'], ['en', 'Английский']]), 'opt'), field('Видео', video, 'opt', 'VK Видео, Rutube или YouTube')),
          field('Ключевые слова', kw, 'opt', 'Как вас ищут гости: «сап», «новичкам», «с детьми»'),
          el('div', { class: 'field' }, el('label', {}, 'Кому подходит', el('span', { class: 'opt-mark' }, ' · необязательно')), el('div', { class: 'checks' }, WITH.filter(([k]) => k !== 'kids' && k !== 'dogs').map(([k, t]) => el('label', {}, (f['w_' + k] = el('input', { type: 'checkbox', checked: true })), t)))),
          el('div', { class: 'field' }, el('label', {}, 'Метки и запись', el('span', { class: 'opt-mark' }, ' · необязательно')), el('div', { class: 'checks' }, el('label', {}, (f.pushkin = el('input', { type: 'checkbox' })), '🎫 Пушкинская карта'),
            el('label', {}, (f.regHere = el('input', { type: 'radio', name: 'reg', checked: true })), 'Запись у нас'), el('label', {}, (f.regExt = el('input', { type: 'radio', name: 'reg' })), 'Запись по ссылке')),
            input('url', { type: 'url', placeholder: 'https://… если запись по ссылке (Timepad, Qtickets, касса)', style: 'margin-top:10px' })),
          el('div', { class: 'grid2' }, field('Telegram для записи', input('tg', { placeholder: '@username' }), 'opt'), field('MAX для записи', input('maxh', { placeholder: 'ник в MAX' }), 'opt', 'Кнопка «Записаться» откроет чат с вами')),
          el('div', { class: 'field' }, el('label', {}, 'Оформление', el('span', { class: 'opt-mark' }, ' · необязательно')), design.el),
          el('div', { class: 'quality' }, qBar, qText, qTips))),
      el('div', { class: 'nf-publish' }, summary, me?.rulesAccepted ? null : el('label', { class: 'toggle-check rules-check' }, (f.rulesOk = el('input', { type: 'checkbox', required: true })), el('span', {}, el('b', {}, 'Событие соответствует правилам площадки'), el('small', {}, 'Законное, с верной ценой и возрастом. ', el('a', { href: '#/rules', target: '_blank' }, 'Правила')))), el('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, 'Опубликовать')),
      el('div', { class: 'help', style: 'text-align:center;margin-top:10px' }, 'Публикуя, вы соглашаетесь с правилами площадки. Всё сразу появится в подборе, управлять можно в кабинете.'));
    updateSummary(); quality();
    root.append(el('div', { class: 'wrap page' }, el('a', { class: 'back', href: me?.isOrganizer ? '#/cabinet' : '#/' }, me?.isOrganizer ? '← В кабинет' : '← Назад к подбору'),
      el('div', { class: 'form form-wide' }, el('h1', {}, 'Создать предложение'), el('p', { class: 'lead' }, 'Бесплатно и навсегда, ИП не нужен. Разовое событие, регулярное занятие, сеансы, прокат по часам, группы или свободное посещение — выберите сценарий, остальное подстроится.'), form)));
    window.scrollTo({ top: 0 });
  }

  // ---------- Кабинет организатора ----------
  function confirmModal(title, text, okLabel, onOk) {
    const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; };
    rootM.append(el('div', { class: 'modal-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'modal' }, el('h2', {}, title), el('p', {}, text),
        el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Отмена'),
          el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => { await onOk(); close(); } }, okLabel)))));
  }
  // ---------- Кабинет организатора: как кабинет продавца на Авито ----------
  const cabState = { org: null, tab: 'overview', sub: 'active' };
  const CAB_TABS = [['overview', '📊', 'Обзор'], ['events', '📋', 'Объявления'], ['promo', '🚀', 'Продвижение'], ['profile', '🏷️', 'Профиль'], ['team', '👥', 'Команда']];
  const money = n => `${Number(n || 0).toLocaleString('ru-RU')} ₽`;
  async function renderCabinet(params) {
    const root = $('#app'); root.innerHTML = ''; const rid = routeId;
    showPlaceholder(root); // пока грузим — заглушка той же высоты, чтобы подвал не прыгал
    if (params?.get('join')) { try { const r = await api('/api/organizers/join', { method: 'POST', body: { code: params.get('join') } }); toast(`Вы в команде «${r.organizer.name}»`); cabState.org = r.organizer.id; } catch (err) { toast(err.body?.message || 'Код не подошёл'); } location.hash = '#/cabinet'; return; }
    let data;
    try { data = await api('/api/cabinet'); if (rid !== routeId) return; } catch { if (rid !== routeId) return; root.append(el('div', { class: 'wrap page' }, el('div', { class: 'empty' }, 'Кабинет недоступен.'))); return; }
    clearPlaceholder();
    const kinds = data.kinds || {}, products = data.products || {}; _products = products;
    const page = el('div', { class: 'wrap page cab' });
    page.append(el('div', { class: 'cab-head' },
      el('div', {}, el('h1', {}, 'Кабинет организатора'), el('p', { class: 'lead' }, 'Страница организации, объявления, продвижение и статистика. Бесплатно и навсегда.')),
      el('div', { class: 'cab-head-actions' }, el('button', { type: 'button', class: 'btn btn-outline', onclick: () => joinModal() }, '🔑 Войти по коду'), el('button', { type: 'button', class: 'btn btn-primary', onclick: () => createOrgModal(kinds) }, '+ Организация'))));
    if (!data.organizers.length) {
      page.append(el('div', { class: 'cab-start' },
        el('button', { type: 'button', class: 'start-card', onclick: () => createOrgModal(kinds) }, el('span', { class: 'e' }, '🏷️'), el('b', {}, 'Создать организацию'), el('span', {}, 'Кинотеатр, театр, прокат, курорт, клуб, студия или сообщество. Страница с расписанием, которую находят в поиске.')),
        el('a', { class: 'start-card', href: '#/new' }, el('span', { class: 'e' }, '🎤'), el('b', {}, 'Сразу добавить событие'), el('span', {}, 'Организация создастся автоматически по названию в форме.')),
        el('button', { type: 'button', class: 'start-card', onclick: () => joinModal() }, el('span', { class: 'e' }, '🔑'), el('b', {}, 'У меня есть код приглашения'), el('span', {}, 'Коллега выдал код из раздела «Команда» — вы получите доступ к той же организации.'))));
      root.append(page); return;
    }
    const cur = data.organizers.find(x => x.organizer.id === cabState.org) || data.organizers[0]; cabState.org = cur.organizer.id;
    const o = cur.organizer; const kind = kinds[o.kind];
    const side = el('aside', { class: 'cab-side' });
    if (data.organizers.length > 1) side.append(el('div', { class: 'cab-orgs' }, data.organizers.map(x => el('button', { type: 'button', class: 'cab-org-btn' + (x.organizer.id === o.id ? ' on' : ''), onclick: () => { cabState.org = x.organizer.id; cabState.tab = 'overview'; renderCabinet(); } }, orgAvatar(x.organizer, x.events), el('span', { class: 'nm' }, x.organizer.name)))));
    side.append(el('div', { class: 'cab-cur' }, orgAvatar(o, cur.events), el('div', {}, el('b', {}, o.name), el('div', { class: 'meta' }, kind ? `${kind.emoji} ${kind.title}` : 'Тип не выбран'))));
    side.append(el('nav', { class: 'cab-nav' }, CAB_TABS.map(([k, ic, t]) => el('button', { type: 'button', class: 'cab-nav-btn' + (cabState.tab === k ? ' on' : ''), onclick: () => { cabState.tab = k; renderCabinet(); } }, el('span', { class: 'ic' }, ic), t, k === 'events' ? el('span', { class: 'n' }, cur.events.length) : k === 'promo' && cur.promotions.some(x => x.status === 'active') ? el('span', { class: 'n' }, cur.promotions.filter(x => x.status === 'active').length) : null))));
    side.append(el('a', { class: 'btn btn-primary btn-block', href: newHref(o, kind) }, `+ ${kind?.cta || 'Добавить событие'}`), el('a', { class: 'btn btn-outline btn-block', href: `#/org/${o.slug}`, style: 'margin-top:8px' }, 'Страница организации ↗'));
    const main = el('div', { class: 'cab-main' });
    const view = { overview: cabOverview, events: cabEvents, promo: cabPromo, profile: cabProfile, team: cabTeam }[cabState.tab] || cabOverview;
    main.append(view(cur, { kinds, products, all: data.organizers }));
    page.append(el('div', { class: 'cab-layout' }, side, main));
    root.append(page);
    window.scrollTo({ top: 0 });
  }
  const newHref = (o, kind) => `#/new?org=${encodeURIComponent(o.name)}${kind ? `&kind=${kind.scenario}` : ''}`;
  function orgAvatar(o, events = []) {
    return o.logo ? el('img', { class: 'org-mini-logo', src: o.logo, alt: '' }) : el('span', { class: 'org-mini-logo letter', style: `background:${CAT_GRAD[events[0]?.category] || CAT_GRAD.social}` }, o.name.replace(/^[«"]/, '').charAt(0).toUpperCase());
  }
  // --- Обзор: цифры, график за 14 дней, чек-лист заполненности, быстрые действия
  function cabOverview(cur, { kinds }) {
    const o = cur.organizer, st = cur.stats, kind = kinds[o.kind];
    const stat = (k, v, sub) => el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v big' }, v), sub ? el('div', { class: 'meta' }, sub) : null);
    const box = el('div', {});
    box.append(el('div', { class: 'stats stats-5' },
      stat('Просмотры за 7 дней', st.views7 + st.clicks7, `${st.views30 + st.clicks30} за 30 дней`),
      stat('Записей за 7 дней', st.regs7, `${st.regs30} за 30 дней · всего ${st.registrations}`),
      stat('Ближайших событий', st.upcoming, `${st.series} ${plural(st.series, ['серия', 'серии', 'серий'])}`),
      stat('Подписчики', st.followers, `${st.orgViews30} просмотров страницы`),
      stat('Рейтинг', st.rating ? `★ ${st.rating}` : '—', `${st.reviews} ${plural(st.reviews, ['отзыв', 'отзыва', 'отзывов'])} · ${st.checkins} визитов`)));
    box.append(el('div', { class: 'section' }, el('h3', {}, 'Интерес к вашим событиям за 14 дней'), barsChart(cur.daily)));
    const todo = [[!o.logo, 'Загрузите логотип — его видно в подсказках поиска и на странице', 'profile'], [!o.cover, 'Добавьте обложку страницы', 'profile'], [!o.about || o.about.length < 120, 'Расскажите о себе хотя бы в трёх предложениях: описание индексируется поиском', 'profile'], [!o.address, 'Укажите адрес — появится кнопка «Маршрут»', 'profile'], [!(o.phone || o.telegram || o.website), 'Добавьте контакт: телефон, Telegram или сайт', 'profile'], [!o.kind, 'Выберите тип организации — от него зависят подсказки и сценарии', 'profile'], [cur.events.length === 0, 'Добавьте первое событие или расписание', null], [!cur.events.some(e => e.cover), 'Загрузите фото к событиям: карточки с фото выбирают в 2 раза чаще', 'events']].filter(x => x[0]);
    if (todo.length) box.append(el('div', { class: 'section' }, el('h3', {}, `Что улучшить · ${todo.length}`), el('div', { class: 'todo' }, todo.map(([, t, tab]) => el('button', { type: 'button', class: 'todo-item', onclick: () => { if (tab) { cabState.tab = tab; renderCabinet(); } else location.hash = newHref(o, kind); } }, el('span', { class: 'dot' }), t, el('span', { class: 'arrow' }, '→'))))));
    const quick = el('div', { class: 'quick-grid' },
      el('a', { class: 'quick', href: newHref(o, kind) }, el('span', { class: 'e' }, kind?.emoji || '🎤'), el('b', {}, kind?.cta || 'Добавить событие'), el('span', {}, kind?.hint || 'Разовое, регулярное, сеансы, прокат')),
      el('button', { type: 'button', class: 'quick', onclick: () => { cabState.tab = 'profile'; cabState.focusAnnounce = true; renderCabinet(); } }, el('span', { class: 'e' }, '📣'), el('b', {}, kind?.season ? 'Объявить сезон' : 'Сделать объявление'), el('span', {}, 'Открытие сезона, новые часы, акция — баннер на странице и в поиске')),
      el('button', { type: 'button', class: 'quick', onclick: () => promoModal(cur, 'org') }, el('span', { class: 'e' }, '🚀'), el('b', {}, 'Продвинуть'), el('span', {}, `Демо-баланс ${money(o.balance)}: поднять событие, серию или всю организацию`)),
      el('button', { type: 'button', class: 'quick', onclick: () => { cabState.tab = 'team'; renderCabinet(); } }, el('span', { class: 'e' }, '👥'), el('b', {}, 'Пригласить коллегу'), el('span', {}, 'Администратор, кассир, SMM — по коду, без паролей')));
    box.append(el('div', { class: 'section' }, el('h3', {}, 'Быстрые действия'), quick));
    const top = cur.events.map(e => ({ e, n: e.counters.views + e.counters.clicks })).sort((a, b) => b.n - a.n).slice(0, 5).filter(x => x.n > 0);
    if (top.length) box.append(el('div', { class: 'section' }, el('h3', {}, 'Самые просматриваемые за 30 дней'), el('div', { class: 'cab-rows' }, top.map(({ e, n }) => el('div', { class: 'cab-row slim' }, el('div', { class: 'cab-main' }, el('a', { class: 'cab-title', href: `#/event/${e.slug}` }, e.title), el('div', { class: 'meta' }, `${fmtDM(parseIso(e.date))} ${fmtTime(new Date(e.start))} · ${e.venue}`)), el('div', { class: 'meta' }, `${n} просм. · ${e.regCount} зап.`))))));
    return box;
  }
  function barsChart(daily) {
    if (!daily?.length) return el('div', { class: 'meta' }, 'Данных пока нет');
    const max = Math.max(1, ...daily.map(d => d.views + d.regs));
    return el('div', { class: 'bars' }, daily.map(d => { const dt = parseIso(d.day); return el('div', { class: 'bar-col', title: `${fmtDM(dt)}: ${d.views} просмотров, ${d.regs} записей` }, el('div', { class: 'bar-stack' }, el('i', { class: 'b-regs', style: `height:${Math.round(d.regs / max * 100)}%` }), el('i', { class: 'b-views', style: `height:${Math.round(d.views / max * 100)}%` })), el('span', { class: 'bar-lbl' }, `${dt.getDate()}`)); }),
      el('div', { class: 'bar-legend' }, el('span', {}, el('i', { class: 'b-views' }), ' просмотры и клики'), el('span', {}, el('i', { class: 'b-regs' }), ' записи')));
  }
  // --- Объявления: активные / на паузе / прошедшие; серии одной карточкой
  function cabEvents(cur, { kinds, products }) {
    const o = cur.organizer, kind = kinds[o.kind];
    const box = el('div', {});
    const active = cur.events.filter(e => !e.paused), paused = cur.events.filter(e => e.paused), past = cur.past || [];
    const sub = cabState.sub || 'active';
    const tabs = el('div', { class: 'sub-tabs' }, [['active', `Активные · ${active.length}`], ['paused', `На паузе · ${paused.length}`], ['past', `Прошедшие · ${past.length}`]].map(([k, t]) => el('button', { type: 'button', class: 'sub-tab' + (sub === k ? ' on' : ''), onclick: () => { cabState.sub = k; renderCabinet(); } }, t)));
    box.append(el('div', { class: 'cab-toolbar' }, tabs, el('a', { class: 'btn btn-primary btn-sm', href: newHref(o, kind) }, `+ ${kind?.cta || 'Добавить'}`)));
    const list = sub === 'active' ? active : sub === 'paused' ? paused : past;
    if (!list.length) { box.append(el('div', { class: 'empty' }, sub === 'past' ? 'За последние 30 дней событий не было.' : sub === 'paused' ? 'Ничего не стоит на паузе.' : el('div', {}, el('b', {}, 'Объявлений пока нет.'), el('div', { style: 'margin-top:6px' }, kind?.hint || 'Добавьте первое событие или расписание.')))); return box; }
    const series = new Map(), singles = [];
    for (const e of list) { if (e.seriesKey) { if (!series.has(e.seriesKey)) series.set(e.seriesKey, []); series.get(e.seriesKey).push(e); } else singles.push(e); }
    const cards = el('div', { class: 'listing-list' });
    for (const [key, items] of series) cards.append(listingCard(cur, items, { seriesKey: key, past: sub === 'past', products }));
    for (const e of singles) cards.append(listingCard(cur, [e], { past: sub === 'past', products }));
    box.append(cards);
    return box;
  }
  function listingCard(cur, items, { seriesKey, past, products }) {
    const first = items[0]; const o = cur.organizer;
    const wds = [...new Set(items.map(e => parseIso(e.date).getDay()))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const times = [...new Set(items.map(e => fmtTime(new Date(e.start))))].sort();
    const perDay = Math.max(...[...items.reduce((m, e) => m.set(e.date, (m.get(e.date) || 0) + 1), new Map()).values()]);
    const views = items.reduce((a, e) => a + (e.counters?.views || 0), 0), clicks = items.reduce((a, e) => a + (e.counters?.clicks || 0), 0), regs = items.reduce((a, e) => a + e.regCount, 0), cap = items.reduce((a, e) => a + e.capacity, 0), going = items.reduce((a, e) => a + e.going, 0);
    const sched = seriesKey ? `${items.length} ${plural(items.length, ['дата', 'даты', 'дат'])} · по ${wds.map(d => WD_PL[d]).join(', ')} · ${perDay > 1 ? `${perDay} в день, ${times[0]}–${times[times.length - 1]}` : times.join(', ')} · до ${fmtDM(parseIso(items[items.length - 1].date))}` : `${fmtDM(parseIso(first.date))}, ${fmtTime(new Date(first.start))} · ${first.duration} мин`;
    const kindLbl = { single: 'Разовое', regular: 'Регулярное', sessions: 'Сеансы', rental: 'Прокат по часам', groups: 'Группы', open: 'Свободное посещение' }[first.kind] || 'Событие';
    const badges = el('div', { class: 'listing-badges' }, el('span', { class: 'tag' }, kindLbl), first.promoted ? el('span', { class: 'ad-badge' }, 'Реклама') : null, first.boostTerms?.length ? el('span', { class: 'ad-badge soft' }, `магниты: ${first.boostTerms.join(', ')}`) : null, first.paused ? el('span', { class: 'tag' }, '⏸ на паузе') : null, !first.cover ? el('span', { class: 'tag warn' }, 'без фото') : null);
    const guestsBox = el('div', { class: 'guests', hidden: true });
    const act = (label, fn, cls = 'btn-outline') => el('button', { type: 'button', class: 'btn btn-sm ' + cls, onclick: fn }, label);
    const refresh = () => renderCabinet();
    const actions = el('div', { class: 'listing-actions' });
    if (!past) actions.append(
      act(`👥 Гости · ${regs}`, async () => { if (!guestsBox.hidden) { guestsBox.hidden = true; return; } guestsBox.hidden = false; guestsBox.innerHTML = 'Загружаем…'; const target = items.find(e => e.regCount) || first; try { const g = await api(`/api/events/${target.id}/guests`); guestsBox.innerHTML = ''; guestsBox.append(el('div', { class: 'meta', style: 'margin-bottom:6px' }, `${fmtDM(parseIso(target.date))} ${fmtTime(new Date(target.start))}`), g.guests.length ? el('div', { class: 'guest-list' }, g.guests.map(x => el('div', { class: 'guest' }, el('span', { class: 'mini-avatar' }, x.name.charAt(0)), el('b', {}, x.name), el('span', { class: 'meta' }, x.contact || 'без контакта'), x.organizerConfirmed ? el('span', { class: 'tag free' }, x.guestConfirmed ? '✓ был, подтверждено' : '✓ отмечен') : el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: async ev => { try { await api(`/api/events/${target.id}/checkins`, { method: 'POST', body: { client_id: x.clientId } }); ev.currentTarget.replaceWith(el('span', { class: 'tag free' }, '✓ отмечен')); } catch { toast('Не получилось'); } } }, 'Был')))) : el('div', { class: 'meta' }, 'Записей через сайт пока нет.')); } catch { guestsBox.textContent = 'Список доступен владельцу события.'; } }),
      act('🎨 Оформить', () => designerModal(first, { series: !!seriesKey })),
      act('🚀 Продвинуть', () => promoModal(cur, seriesKey ? 'series' : 'event', seriesKey || String(first.id)), 'btn-ink'),
      act(first.paused ? '▶ Возобновить' : '⏸ Пауза', async () => { try { await api(`/api/events/${first.id}/pause${seriesKey ? '?series=1' : ''}`, { method: 'POST', body: { paused: !first.paused } }); toast(first.paused ? 'Снова в поиске' : 'Скрыто из поиска, записи сохранены'); refresh(); } catch { toast('Не получилось'); } }),
      el('a', { class: 'btn btn-sm btn-outline', href: `#/new?from=${encodeURIComponent(first.slug)}` }, '📋 Дублировать'),
      act('Отменить', () => confirmModal(seriesKey ? 'Отменить серию?' : 'Отменить событие?', seriesKey ? `Будут отменены все ${items.length} будущих событий серии. Записавшихся гостей мы уведомим.` : `«${first.title}», ${fmtDM(parseIso(first.date))}. Гостей уведомим.`, 'Отменить', async () => { await api(seriesKey ? `/api/series/${encodeURIComponent(seriesKey)}` : `/api/events/${first.id}`, { method: 'DELETE' }); toast('Отменено'); refresh(); }), 'btn-ghost btn-danger'));
    else actions.append(el('a', { class: 'btn btn-sm btn-outline', href: `#/new?from=${encodeURIComponent(first.slug)}` }, '🔁 Повторить'), el('a', { class: 'btn btn-sm btn-ghost', href: `#/event/${first.slug}` }, 'Открыть'));
    return el('div', { class: 'listing' + (first.paused ? ' is-paused' : '') },
      el('a', { class: 'listing-cover' + (first.cover ? ' has-img' : ''), href: `#/event/${first.slug}`, style: first.cover ? `background-image:url(${first.cover})` : `background:${CAT_GRAD[first.category]}` }, first.cover ? '' : first.emoji),
      el('div', { class: 'listing-body' },
        el('a', { class: 'listing-title', href: `#/event/${first.slug}` }, first.title), badges,
        el('div', { class: 'meta' }, sched), el('div', { class: 'meta' }, `${first.venue} · ${fmtPrice(first.price)}`),
        el('div', { class: 'listing-stats' }, el('span', {}, el('b', {}, views + clicks), ' просмотров за 30 дн.'), el('span', {}, el('b', {}, regs), ' записей'), cap ? el('span', {}, el('b', {}, `${Math.round(going / cap * 100)}%`), ' заполнено') : null),
        actions, guestsBox));
  }
  // --- Продвижение: демо-баланс, продукты, активные кампании
  function cabPromo(cur, { products }) {
    const o = cur.organizer;
    const box = el('div', {});
    box.append(el('div', { class: 'balance' }, el('div', {}, el('div', { class: 'k' }, 'Демо-баланс'), el('div', { class: 'v' }, money(o.balance))), el('div', { class: 'meta' }, 'Списания настоящие по логике, деньги — демо: пополнение появится вместе с оплатой. Реклама помечается «Реклама» и требует erid из ОРД, слова-магниты метки не требуют.')));
    box.append(el('div', { class: 'promo-grid' }, Object.entries(products).map(([k, pr]) => el('div', { class: 'promo-card' }, el('div', { class: 'promo-ico' }, { event: '📌', series: '🎬', org: '🏷️', boost: '🧲' }[k] || '🚀'), el('b', {}, pr.title), el('div', { class: 'meta' }, pr.desc), el('div', { class: 'promo-price' }, `${money(pr.price)} / день`), el('button', { type: 'button', class: 'btn btn-ink btn-sm', onclick: () => promoModal(cur, k) }, 'Подключить')))));
    box.append(el('div', { class: 'section' }, el('h3', {}, 'Как это работает'), el('ul', { class: 'how' },
      el('li', {}, el('b', {}, 'Кинотеатру и театру: '), 'продвигайте серию — все сеансы фильма или спектакля поднимутся в своих днях и по запросам «кино», «что посмотреть», а зрителю покажем ближайший сеанс.'),
      el('li', {}, el('b', {}, 'Прокату, вейк-парку, курорту: '), 'слова-магниты «сап, покататься, вейк, сноуборд» поднимают вас без метки «Реклама», а объявление о сезоне выводит страницу в поиске, даже если слоты ещё не открыты.'),
      el('li', {}, el('b', {}, 'Честность подбора: '), 'реклама никогда не попадает в «Три варианта», метка и erid показываются всегда, рейтинг и отзывы рекламой не меняются.'))));
    const act = cur.promotions.filter(x => x.status === 'active'), done = cur.promotions.filter(x => x.status !== 'active');
    const row = pr => el('div', { class: 'cab-row slim' }, el('div', { class: 'cab-main' }, el('b', {}, products[pr.type]?.title || pr.type), el('div', { class: 'meta' }, `${pr.target === 'org' ? 'вся организация' : pr.target === 'series' ? 'серия ' + pr.targetId : 'событие #' + pr.targetId} · ${pr.days} дн. · ${money(pr.price)}${pr.erid ? ' · erid ' + pr.erid : ''}${pr.boostTerms?.length ? ' · ' + pr.boostTerms.join(', ') : ''}`)), el('div', { class: 'meta' }, pr.status === 'active' ? `до ${fmtDM(new Date(pr.endsAt))}` : pr.status === 'cancelled' ? 'остановлено' : 'завершено'), pr.status === 'active' ? el('button', { type: 'button', class: 'btn btn-ghost btn-danger btn-sm', onclick: async () => { try { await api(`/api/promotions/${pr.id}`, { method: 'DELETE' }); toast('Остановлено'); renderCabinet(); } catch { toast('Не получилось'); } } }, 'Остановить') : el('span', {}));
    box.append(el('div', { class: 'section' }, el('h3', {}, `Кампании · ${act.length} активных`), act.length || done.length ? el('div', { class: 'cab-rows' }, ...act.map(row), ...done.slice(0, 10).map(row)) : el('div', { class: 'empty' }, 'Кампаний пока не было.')));
    return box;
  }
  function promoModal(cur, type, preselect) {
    const o = cur.organizer; const products = lastProducts();
    const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; };
    const typeSel = el('select', { class: 'input' }, Object.entries(products).map(([k, pr]) => el('option', { value: k, selected: k === type }, `${pr.title} — ${money(pr.price)}/день`)));
    const series = new Map(); for (const e of cur.events) if (e.seriesKey && !series.has(e.seriesKey)) series.set(e.seriesKey, e);
    const targetSel = el('select', { class: 'input' }, [...series].map(([k, e]) => el('option', { value: k, selected: k === preselect }, `Серия: ${e.title}`)), cur.events.filter(e => !e.seriesKey).map(e => el('option', { value: String(e.id), selected: String(e.id) === preselect }, `${fmtDM(parseIso(e.date))} ${fmtTime(new Date(e.start))} · ${e.title}`)));
    const days = el('input', { class: 'input', type: 'number', min: 1, max: 60, value: 7 });
    const quick = el('div', { class: 'pills' }, [3, 7, 14, 30].map(n => el('button', { type: 'button', class: 'pill', onclick: () => { days.value = n; paint(); } }, `${n} дн.`)));
    const erid = el('input', { class: 'input', placeholder: 'erid из ОРД, например 2VtzqxABC123', maxlength: 40 });
    const terms = el('input', { class: 'input', placeholder: 'до 5 слов через запятую: сап, покататься, набережная' });
    const total = el('div', { class: 'promo-total' });
    const eridRow = el('div', { class: 'field' }, el('label', {}, 'Маркировка рекламы'), erid, el('div', { class: 'help' }, 'Токен erid выдаёт оператор рекламных данных (ОРД) после регистрации креатива. Мы показываем его рядом с меткой «Реклама», как требует закон.'));
    const termsRow = el('div', { class: 'field' }, el('label', {}, 'Слова-магниты'), terms, el('div', { class: 'help' }, 'Когда гость пишет одно из слов, ваше событие поднимается. Без метки «Реклама».'));
    const targetRow = el('div', { class: 'field' }, el('label', {}, 'Что продвигаем'), targetSel);
    const paint = () => { const t = typeSel.value; const pr = products[t]; const d = Math.max(1, Math.min(60, Number(days.value) || 7)); total.textContent = `Итого: ${money(pr.price * d)} за ${d} дн. · на балансе ${money(o.balance)}`; total.classList.toggle('over', pr.price * d > o.balance); eridRow.hidden = t === 'boost'; termsRow.hidden = t !== 'boost'; targetRow.hidden = t === 'org'; };
    typeSel.addEventListener('change', paint); days.addEventListener('input', paint); paint();
    rootM.append(el('div', { class: 'modal-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'modal' }, el('h2', {}, '🚀 Продвижение'), el('p', {}, products[typeSel.value]?.desc || ''),
        el('div', { class: 'field' }, el('label', {}, 'Продукт'), typeSel), targetRow,
        el('div', { class: 'field' }, el('label', {}, 'Срок'), el('div', { class: 'grid2' }, days, quick)), eridRow, termsRow, total,
        el('div', { style: 'display:flex;gap:8px;margin-top:18px;justify-content:flex-end' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Отмена'),
          el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => { try { const r = await api(`/api/organizers/${o.id}/promote`, { method: 'POST', body: { type: typeSel.value, targetId: typeSel.value === 'org' ? null : targetSel.value, days: Number(days.value) || 7, erid: erid.value.trim(), boostTerms: terms.value } }); close(); toast(`Подключено, на балансе ${money(r.balance)}`); cabState.tab = 'promo'; renderCabinet(); } catch (err) { toast(err.body?.message || 'Не получилось'); } } }, 'Подключить')))));
  }
  let _products = null; const lastProducts = () => _products || (config?.promoProducts) || {};
  // --- Профиль организации: тип, логотип, обложка, описание, контакты, объявление
  function cabProfile(cur, { kinds }) {
    const o = cur.organizer;
    const f = {};
    const inp = (k, ph, attrs = {}) => (f[k] = el('input', { class: 'input', placeholder: ph, value: o[k] || '', ...attrs }));
    const kindSel = (f.kind = el('select', { class: 'input' }, el('option', { value: '' }, 'Выберите тип'), Object.entries(kinds).map(([k, v]) => el('option', { value: k, selected: k === o.kind }, `${v.emoji} ${v.title}`))));
    const kindHint = el('div', { class: 'help' }); const paintHint = () => { kindHint.textContent = kinds[kindSel.value]?.hint || 'Тип влияет на сценарий добавления, подсказки поиска и карточку организации.'; }; kindSel.addEventListener('change', paintHint); paintHint();
    const st = { logo: o.logoId || null, logoUrl: o.logo || null, cover: o.coverId || null, coverUrl: o.cover || null };
    const logoThumb = el('div', { class: 'logo-thumb' }), coverThumb = el('div', { class: 'cover-thumb wide' });
    const paintPics = () => { logoThumb.style.backgroundImage = st.logoUrl ? `url(${st.logoUrl})` : ''; logoThumb.textContent = st.logoUrl ? '' : o.name.charAt(0).toUpperCase(); coverThumb.style.backgroundImage = st.coverUrl ? `url(${st.coverUrl})` : ''; coverThumb.textContent = st.coverUrl ? '' : '🖼️'; };
    paintPics();
    const pick = (key, label) => el('label', { class: 'btn btn-outline btn-sm' }, label, el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async ev => { const file = ev.target.files[0]; if (!file) return; try { toast('Загружаем…'); const r = await uploadImage(file); st[key] = r.id; st[key + 'Url'] = r.url; paintPics(); } catch { toast('Не удалось загрузить'); } } }));
    const about = mdEditor(o.about || '', 'Что это за место, чем занимаетесь, для кого, как давно. Можно вставить фото и заголовки.');
    const ann = o.announcement || {};
    const aTitle = el('input', { class: 'input', placeholder: 'Например: Сезон открыт! Катаемся с 15 ноября', value: ann.title || '', maxlength: 120 });
    const aText = el('textarea', { class: 'input', style: 'height:80px;padding:12px 14px', placeholder: 'Что открыто, часы, цены, что взять с собой', maxlength: 600 }, ann.text || '');
    const aFrom = dateField(ann.from || '', { allowEmpty: true, min: null, title: 'Показывать с', placeholder: 'Сразу' }), aUntil = dateField(ann.until || '', { allowEmpty: true, min: null, title: 'Показывать до', placeholder: 'Без срока' });
    const annBox = el('div', { class: 'nf-section' + (cabState.focusAnnounce ? ' flash' : '') }, el('div', { class: 'nf-head' }, el('span', { class: 'nf-num' }, '📣'), el('div', {}, el('h2', {}, kinds[o.kind]?.season ? 'Объявление о сезоне' : 'Объявление'), el('p', {}, 'Баннер на странице организации; текст индексируется поиском. Чтобы попасть в выдачу по датам, добавьте ещё «свободное посещение» с часами работы.'))),
      el('div', { class: 'field' }, el('label', {}, 'Заголовок'), aTitle), el('div', { class: 'field' }, el('label', {}, 'Текст'), aText), el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', {}, 'Показывать с'), aFrom), el('div', { class: 'field' }, el('label', {}, 'До'), aUntil)),
      kinds[o.kind]?.season ? el('a', { class: 'btn btn-outline btn-sm', href: `#/new?org=${encodeURIComponent(o.name)}&kind=open` }, '+ Добавить часы работы сезона (свободное посещение)') : null);
    cabState.focusAnnounce = false;
    const save = async () => {
      try {
        await api(`/api/organizers/${o.id}`, { method: 'PATCH', body: { kind: kindSel.value || undefined, about: about.get(), address: f.address.value, hours: f.hours.value, phone: f.phone.value, telegram: f.telegram.value, max: f.max.value, vk: f.vk.value, website: f.website.value, contact: f.contact.value, logo: st.logo, cover: st.cover, announcement: aTitle.value.trim() ? { title: aTitle.value.trim(), text: aText.value.trim(), from: aFrom.value || null, until: aUntil.value || null } : null } });
        toast('Профиль сохранён'); renderCabinet();
      } catch (err) { toast(err.body?.message || 'Не получилось сохранить'); }
    };
    return el('div', { class: 'profile-form' },
      el('section', { class: 'nf-section' }, el('div', { class: 'nf-head' }, el('span', { class: 'nf-num' }, '1'), el('div', {}, el('h2', {}, 'Кто вы'), el('p', {}, 'Так вас увидят гости на странице и в подсказках поиска.'))),
        el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', {}, 'Название'), el('input', { class: 'input', value: o.name, disabled: true })), el('div', { class: 'field' }, el('label', {}, 'Тип организации'), kindSel, kindHint)),
        el('div', { class: 'pics-row' }, el('div', { class: 'pic-block' }, logoThumb, el('div', {}, pick('logo', '📷 Логотип'), el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { st.logo = null; st.logoUrl = null; paintPics(); } }, 'Убрать'), el('div', { class: 'help' }, 'Квадрат, минимум 200×200'))),
          el('div', { class: 'pic-block' }, coverThumb, el('div', {}, pick('cover', '🖼️ Обложка страницы'), el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { st.cover = null; st.coverUrl = null; paintPics(); } }, 'Убрать'), el('div', { class: 'help' }, 'Широкое фото зала, трассы, площадки')))),
        el('div', { class: 'field' }, el('label', {}, 'О вас'), about.el)),
      el('section', { class: 'nf-section' }, el('div', { class: 'nf-head' }, el('span', { class: 'nf-num' }, '2'), el('div', {}, el('h2', {}, 'Где и как связаться'), el('p', {}, 'Адрес даёт кнопку «Маршрут», контакты — «Написать» и «Позвонить».'))),
        el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', {}, 'Адрес'), inp('address', 'ул. Баумана, 44')), el('div', { class: 'field' }, el('label', {}, 'Часы работы'), inp('hours', 'пн–вс 10:00–22:00'))),
        el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', {}, 'Телефон'), inp('phone', '+7 843 …')), el('div', { class: 'field' }, el('label', {}, 'Telegram'), inp('telegram', '@username или ссылка'))),
        el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', {}, 'MAX'), inp('max', 'ник или ссылка max.ru/…')), el('div', { class: 'help', style: 'align-self:center' }, 'Если указан Telegram или MAX, кнопка «Записаться» на ваших событиях ведёт к вам в чат.')),
        el('div', { class: 'grid2' }, el('div', { class: 'field' }, el('label', {}, 'ВКонтакте'), inp('vk', 'vk.com/…')), el('div', { class: 'field' }, el('label', {}, 'Сайт'), inp('website', 'example.ru'))),
        el('div', { class: 'field' }, el('label', {}, 'Контакт для гостей (виден записавшимся)'), inp('contact', 'Email или телефон администратора'))),
      annBox,
      el('div', { class: 'nf-actions' }, el('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: save }, 'Сохранить профиль'), el('a', { class: 'btn btn-ghost', href: `#/org/${o.slug}` }, 'Посмотреть страницу'),
        o.mine ? el('button', { type: 'button', class: 'btn btn-ghost btn-danger', style: 'margin-left:auto', onclick: () => confirmModal('Удалить организацию?', `«${o.name}» вместе со всеми событиями, записями и кампаниями. Это нельзя отменить.`, 'Удалить', async () => { try { await api(`/api/organizers/${o.id}`, { method: 'DELETE' }); toast('Организация удалена'); cabState.org = null; loadMe(); renderCabinet(); } catch (err) { toast(err.body?.message || 'Не получилось'); } }) }, 'Удалить организацию') : null));
  }
  // --- Команда: код приглашения и участники
  function cabTeam(cur) {
    const o = cur.organizer; const box = el('div', {});
    box.append(el('p', { class: 'lead' }, 'Несколько человек управляют одной организацией: администратор заводит сеансы, кассир отмечает гостей на входе, маркетолог запускает продвижение. Доступ выдаётся кодом, пароли не нужны.'));
    if (o.mine) {
      const codeBox = el('div', { class: 'invite' });
      const paint = code => { codeBox.innerHTML = ''; if (!code) { codeBox.append(el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => { const r = await api(`/api/organizers/${o.id}/invite`, { method: 'POST', body: {} }); paint(r.code); } }, 'Создать код приглашения')); return; } const link = `${location.origin}/#/cabinet?join=${code}`; codeBox.append(el('div', { class: 'code' }, code), el('div', { class: 'meta' }, 'Коллега вводит код в кабинете («Войти по коду») или открывает ссылку:'), el('div', { class: 'invite-link' }, link), el('div', { class: 'pills' }, el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { navigator.clipboard?.writeText(link); toast('Ссылка скопирована'); } }, '🔗 Скопировать ссылку'), el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: async () => { const r = await api(`/api/organizers/${o.id}/invite`, { method: 'POST', body: { rotate: true } }); paint(r.code); toast('Старый код больше не работает'); } }, 'Сменить код'))); };
      paint(o.inviteCode);
      box.append(el('div', { class: 'section' }, el('h3', {}, 'Пригласить'), codeBox));
    }
    box.append(el('div', { class: 'section' }, el('h3', {}, `Участники · ${cur.members.length + 1}`), el('div', { class: 'guest-list' },
      el('div', { class: 'guest' }, el('span', { class: 'mini-avatar' }, '★'), el('b', {}, o.mine ? 'Вы' : 'Владелец'), el('span', { class: 'meta' }, 'владелец'), el('span', {})),
      cur.members.map(m => el('div', { class: 'guest' }, el('span', { class: 'mini-avatar' }, m.name.charAt(0)), el('b', {}, m.me ? `${m.name} (вы)` : m.name), el('span', { class: 'meta' }, m.role === 'manager' ? 'менеджер' : m.role), (o.mine || m.me) ? el('button', { type: 'button', class: 'btn btn-ghost btn-danger btn-sm', onclick: () => confirmModal(m.me ? 'Выйти из команды?' : 'Убрать участника?', m.me ? 'Доступ к организации пропадёт.' : `${m.name} потеряет доступ к кабинету.`, m.me ? 'Выйти' : 'Убрать', async () => { await api(`/api/organizers/${o.id}/members/${m.clientId}`, { method: 'DELETE' }); toast('Готово'); if (m.me) cabState.org = null; renderCabinet(); }) }, m.me ? 'Выйти' : 'Убрать') : el('span', {}))))));
    box.append(el('div', { class: 'callout', style: 'margin-top:24px' }, el('span', { class: 'e' }, '🔐'), el('div', {}, el('b', {}, 'Доступ привязан к браузеру. '), 'Вход по коду из SMS или email появится в следующей версии; до этого сохраните код приглашения — им же вы восстановите доступ с другого устройства.')));
    return box;
  }
  function createOrgModal(kinds) {
    const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; };
    const name = el('input', { class: 'input', placeholder: 'Название: «Кинотеатр Родина», «Прокат сапов на Казанке»', maxlength: 80 });
    let kind = 'community';
    const grid = el('div', { class: 'kind-grid' });
    const paint = () => { grid.innerHTML = ''; for (const [k, v] of Object.entries(kinds)) grid.append(el('button', { type: 'button', class: 'kind-btn' + (kind === k ? ' on' : ''), onclick: () => { kind = k; paint(); } }, el('span', { class: 'e' }, v.emoji), el('b', {}, v.title), el('small', {}, v.hint))); };
    paint();
    rootM.append(el('div', { class: 'modal-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'modal modal-wide' }, el('h2', {}, 'Новая организация'), el('p', {}, 'Страница с расписанием, которую находят в поиске, плюс кабинет: объявления, гости, продвижение, статистика.'),
        el('div', { class: 'field' }, el('label', {}, 'Название'), name), el('div', { class: 'field' }, el('label', {}, 'Тип'), grid),
        el('div', { style: 'display:flex;gap:8px;margin-top:18px;justify-content:flex-end' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Отмена'),
          el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => { if (!name.value.trim()) return toast('Введите название'); try { const r = await api('/api/organizers', { method: 'POST', body: { name: name.value.trim(), kind } }); close(); cabState.org = r.id; cabState.tab = 'profile'; toast('Организация создана — заполните профиль'); loadMe(); renderCabinet(); } catch (err) { toast(err.body?.message || 'Не получилось'); } } }, 'Создать')))));
    name.focus();
  }
  function joinModal() {
    const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; };
    const code = el('input', { class: 'input', placeholder: 'Код из 8 символов', maxlength: 8, autocapitalize: 'off' });
    rootM.append(el('div', { class: 'modal-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'modal' }, el('h2', {}, 'Войти по коду приглашения'), el('p', {}, 'Код выдаёт владелец организации в разделе «Команда».'), code,
        el('div', { style: 'display:flex;gap:8px;margin-top:18px;justify-content:flex-end' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Отмена'),
          el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => { try { const r = await api('/api/organizers/join', { method: 'POST', body: { code: code.value.trim() } }); close(); cabState.org = r.organizer.id; toast(`Вы в команде «${r.organizer.name}»`); loadMe(); renderCabinet(); } catch (err) { toast(err.body?.message || 'Код не подошёл'); } } }, 'Войти')))));
    code.focus();
  }

  // ---------- Экран поиска: текст + все условия, кнопка показывает число событий ----------
  function screenSearch(p) {
    S.via = 'search';
    const q = livePlaceholder(el('input', { type: 'search', placeholder: 'Кино, пробежка, квиз, английский…', value: S.q, 'aria-label': 'Поиск событий', enterkeyhint: 'search', autocomplete: 'off' }));
    const countBtn = el('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: () => apply() }, 'Показать события →');
    const apply = () => { S.q = q.value.trim(); $('#nav-q').value = S.q; S.filtersDirty = false; persist(); renderFilters(); go('when'); };
    let timer = null;
    const refreshCount = () => { clearTimeout(timer); timer = setTimeout(async () => { S.q = q.value.trim(); persist(); const [from, to] = range(); try { const d = await api(`/api/events?${params(from, to)}&facets=1`); panel.setFacets(d.facets); const n = d.events.length; countBtn.textContent = n ? `Показать ${n} ${plural(n, ['событие', 'события', 'событий'])} →` : 'Ничего не нашли — измените условия'; countBtn.disabled = !n; } catch {} }, 250); };
    q.addEventListener('input', refreshCount);
    const panel = filtersPanel(S, { onChange: refreshCount, inline: true });
    const clearAll = () => { S.q = ''; q.value = ''; S.cats = []; S.cat = null; S.sub = null; S.subs = []; S.acts = []; S.mood = null; S.withWhom = ''; S.kidAge = ''; S.pmin = ''; S.pmax = ''; S.tod = ''; S.noise = ''; S.when = 'any'; $('#nav-q').value = ''; persist(); panel.el.replaceWith(filtersPanel(S, { onChange: refreshCount, inline: true }).el); refreshCount(); };
    const aiQ = el('textarea', { class: 'ai-input', rows: 2, placeholder: 'Например: хочу прогуляться где-то с ребёнком, недорого и недалеко от центра', enterkeyhint: 'search' });
    const aiOut = el('div', { class: 'ai-out' });
    let aiTimer = null;
    aiQ.addEventListener('input', () => { clearTimeout(aiTimer); aiTimer = setTimeout(async () => { const v = aiQ.value.trim(); if (!v) { aiOut.innerHTML = ''; return; } try { const d = await api(`/api/ai/parse?q=${encodeURIComponent(v)}`); aiOut.innerHTML = ''; if (d.parsed.human.length) aiOut.append(el('span', { class: 'meta' }, 'Понял так: '), ...d.parsed.human.map(h => el('span', { class: 'ai-chip' }, h))); } catch {} }, 300); });
    aiQ.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); if (aiQ.value.trim()) { S.when = 'any'; setQuery(aiQ.value, true); } } });
    const aiBlock = el('div', { class: 'ai-box' },
      el('div', { class: 'ai-head' }, el('b', {}, '✨ Спросите словами'), el('span', { class: 'meta' }, 'ИИ-подбор: опишите, чего хочется, как другу')),
      aiQ, aiOut,
      el('div', { class: 'ai-actions' }, ['хочу поиграть в футбол вечером', 'куда пойти одному вечером, спокойно', 'активно провести выходные с друзьями', 'что-то бесплатное и познавательное'].map(x => el('button', { type: 'button', class: 'chip', onclick: () => { aiQ.value = x; aiQ.dispatchEvent(new Event('input')); } }, x)),
        el('button', { type: 'button', class: 'btn btn-ink btn-sm', onclick: () => { if (aiQ.value.trim()) { S.when = 'any'; setQuery(aiQ.value, true); } } }, 'Подобрать →')));
    p.append(el('h1', { class: 'srch-title' }, 'Поиск'),
      el('p', { class: 'q-sub' }, 'Слова и условия вместе: покажем события, которые подходят под всё сразу.'),
      el('form', { class: 'hero-search srch-input', role: 'search', onsubmit: ev => { ev.preventDefault(); apply(); } },
        el('span', { class: 'ico', html: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' }),
        q, el('button', { type: 'submit', class: 'go' }, el('span', {}, 'Найти'), ' →')),
      panel.el,
      aiBlock,
      el('div', { class: 'srch-bar' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: clearAll }, 'Сбросить всё'), countBtn));
    refreshCount();
  }

  // ---------- Оформление страницы события: темы как у Luma, обложка, галерея ----------
  const THEMES = {
    minimal: { title: 'Минимал', sw: 'linear-gradient(135deg,#f5f1ea,#fdfbf7)' },
    night: { title: 'Ночь', dark: true, bg: '#111318', fg: '#f3f3f1', muted: '#a0a3ad', surface: '#1b1e26', line: '#2a2e3a', soft: '#22262f', accent: '#ff5a63', sw: 'linear-gradient(135deg,#111318,#2a2e3a)' },
    sunset: { title: 'Закат', bg: 'linear-gradient(160deg,#ffe8d6 0%,#ffc3a0 55%,#ffafbd 100%)', fg: '#2b1b14', muted: '#7a5a4e', surface: 'rgba(255,255,255,.72)', line: 'rgba(0,0,0,.08)', soft: 'rgba(255,255,255,.5)', accent: '#e8333f', sw: 'linear-gradient(160deg,#ffe8d6,#ffafbd)' },
    forest: { title: 'Лес', dark: true, bg: 'linear-gradient(160deg,#0f3d2e,#1f6b4a)', fg: '#eef7f1', muted: '#b9d6c6', surface: 'rgba(255,255,255,.08)', line: 'rgba(255,255,255,.14)', soft: 'rgba(255,255,255,.12)', accent: '#7ee0a0', font: 'serif', sw: 'linear-gradient(160deg,#0f3d2e,#1f6b4a)' },
    ocean: { title: 'Океан', dark: true, bg: 'linear-gradient(160deg,#0b2545,#13315c 60%,#1b4a7a)', fg: '#eaf2ff', muted: '#a9bddc', surface: 'rgba(255,255,255,.08)', line: 'rgba(255,255,255,.14)', soft: 'rgba(255,255,255,.12)', accent: '#5ec2ff', sw: 'linear-gradient(160deg,#0b2545,#1b4a7a)' },
    candy: { title: 'Конфетти', bg: '#fff5fa', pattern: 'dots', fg: '#2a1a24', muted: '#8a6a7a', surface: '#ffffff', line: '#f3d6e6', soft: '#fde9f3', accent: '#e0218a', font: 'rounded', sw: 'radial-gradient(#e0218a 1.5px, #fff5fa 1.5px) 0 0/10px 10px' },
    paper: { title: 'Газета', bg: '#f4efe6', pattern: 'lines', fg: '#1d1a16', muted: '#6b645a', surface: '#fbf8f2', line: '#e2d9c8', soft: '#ece5d7', accent: '#1d1a16', font: 'serif', sw: 'repeating-linear-gradient(0deg,#f4efe6 0 7px,#e2d9c8 7px 8px)' },
    neon: { title: 'Неон', dark: true, bg: '#0a0a0f', fg: '#f0f0ff', muted: '#9a9ab8', surface: '#15152a', line: '#262647', soft: '#1c1c36', accent: '#39ff88', font: 'mono', sw: 'linear-gradient(135deg,#0a0a0f,#15152a 60%,#39ff88)' },
  };
  function themeStyle(e) {
    const t = THEMES[e.theme] || THEMES.minimal;
    const v = [];
    for (const k of ['bg', 'fg', 'muted', 'surface', 'line', 'soft']) if (t[k]) v.push(`--ev-${k}:${t[k]}`);
    const accent = e.accent || t.accent; if (accent) v.push(`--ev-accent:${accent}`);
    return { style: v.join(';'), cls: 'event-theme' + (t.dark ? ' is-dark' : '') + (t.font ? ' font-' + t.font : '') + (t.pattern ? ' pat-' + t.pattern : ''), t };
  }
  async function shrinkImage(file, max = 1600, quality = 0.85) {
    let img = null;
    try { img = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { img = null; }
    if (!img) img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    const w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('blob')), 'image/jpeg', quality));
  }
  async function uploadImage(file) {
    const blob = await shrinkImage(file);
    const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob, credentials: 'same-origin' });
    if (!r.ok) throw new Error('upload');
    return r.json();
  }
  function designerFields(init = {}) {
    const st = { cover: init.coverId || null, coverUrl: init.cover || null, photos: (init.photoIds || []).map((id, i) => ({ id, url: (init.photos || [])[i] || `/api/files/${id}` })), theme: init.theme || 'minimal', emoji: init.emoji || '🎉', category: init.category || 'social' };
    const titleOf = () => (typeof init.title === 'function' ? init.title() : init.title) || 'Название события';
    const pvBanner = el('div', { class: 'pv-banner' }); const pvTitle = el('div', { class: 'pv-title' }); const pvBtn = el('span', { class: 'pv-btn' }, 'Записаться');
    const preview = el('div', { class: 'design-preview' }, pvBanner, el('div', { class: 'pv-body' }, pvTitle, el('div', { class: 'pv-meta' }, 'Суббота, 19:00 · Казань'), pvBtn));
    const coverThumb = el('div', { class: 'cover-thumb' });
    const gal = el('div', { class: 'gallery-edit' });
    const themesBox = el('div', { class: 'themes' });
    const accentInput = el('input', { type: 'color', value: init.accent || '#e8333f' });
    const accentOn = el('input', { type: 'checkbox', checked: !!init.accent });
    const paint = () => {
      const ts = themeStyle({ theme: st.theme, accent: accentOn.checked ? accentInput.value : null });
      preview.className = 'design-preview ' + ts.cls; preview.style.cssText = ts.style;
      pvBanner.style.background = st.coverUrl ? `url(${st.coverUrl}) center/cover` : (CAT_GRAD[st.category] || CAT_GRAD.social); pvBanner.textContent = st.coverUrl ? '' : st.emoji;
      pvTitle.textContent = titleOf();
      pvBtn.style.background = (accentOn.checked ? accentInput.value : ts.t.accent) || '';
      coverThumb.style.backgroundImage = st.coverUrl ? `url(${st.coverUrl})` : ''; coverThumb.textContent = st.coverUrl ? '' : '🖼️';
      for (const b of themesBox.children) b.classList.toggle('on', b.dataset.k === st.theme);
      gal.innerHTML = '';
      for (const ph of st.photos) gal.append(el('div', { class: 'gthumb', style: `background-image:url(${ph.url})` }, el('button', { type: 'button', title: 'Убрать', onclick: () => { st.photos = st.photos.filter(x => x !== ph); paint(); } }, '✕')));
      if (st.photos.length < 6) gal.append(el('label', { class: 'gadd', title: 'Добавить фото' }, '+', el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: async ev => {
        for (const file of [...ev.target.files].slice(0, 6 - st.photos.length)) { try { toast('Загружаем фото…'); const r = await uploadImage(file); st.photos.push({ id: r.id, url: r.url }); paint(); } catch { toast('Не удалось загрузить фото'); } }
      } })));
    };
    for (const [k, t] of Object.entries(THEMES)) themesBox.append(el('button', { type: 'button', class: 'theme-sw', 'data-k': k, onclick: () => { st.theme = k; paint(); } }, el('div', { class: 'sw', style: `background:${t.sw}` }), el('div', { class: 'nm' }, t.title)));
    accentInput.addEventListener('input', () => { accentOn.checked = true; paint(); });
    accentOn.addEventListener('change', paint);
    const coverInput = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async ev => { const file = ev.target.files[0]; if (!file) return; try { toast('Загружаем обложку…'); const r = await uploadImage(file); st.cover = r.id; st.coverUrl = r.url; paint(); toast('Обложка загружена'); } catch { toast('Не удалось загрузить фото'); } } });
    const node = el('div', { class: 'design' },
      el('h4', {}, '🎨 Оформление страницы'),
      preview,
      el('div', { class: 'cover-row' }, coverThumb, el('label', { class: 'btn btn-outline btn-sm' }, '📷 Загрузить обложку', coverInput), el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { st.cover = null; st.coverUrl = null; paint(); } }, 'Без фото'), el('span', { class: 'help' }, 'JPEG или PNG, уменьшим до 1600 px')),
      el('div', { class: 'help', style: 'margin:14px 0 6px' }, 'Галерея — до 6 фото'), gal,
      el('div', { class: 'help', style: 'margin:14px 0 6px' }, 'Тема страницы'), themesBox,
      el('div', { class: 'accent-row' }, el('label', { class: 'accent-toggle' }, accentOn, ' Свой цвет кнопок'), accentInput));
    paint();
    return { el: node, paint, setContext: ({ emoji, category } = {}) => { if (emoji) st.emoji = emoji; if (category) st.category = category; paint(); }, get: () => ({ cover: st.cover, photos: st.photos.map(x => x.id), theme: st.theme === 'minimal' ? null : st.theme, accent: accentOn.checked ? accentInput.value : null }) };
  }
  function designerModal(e, { series } = {}) {
    const rootM = $('#modal-root'); const close = () => { rootM.innerHTML = ''; };
    const title = el('input', { class: 'input', value: e.title });
    const descEd = mdEditor(e.description || '', 'Описание'); const desc = descEd.ta;
    const video = el('input', { class: 'input', placeholder: 'Ссылка на видео: VK Видео, Rutube или YouTube', value: e.videoUrl || '', style: 'margin-top:10px' });
    const design = designerFields({ ...e, title: () => title.value });
    title.addEventListener('input', () => design.paint());
    rootM.append(el('div', { class: 'modal-bg', onclick: ev => { if (ev.target === ev.currentTarget) close(); } },
      el('div', { class: 'modal modal-wide' }, el('h2', {}, series ? 'Оформить серию' : 'Оформить событие'), el('p', {}, series ? 'Изменения применятся ко всем будущим событиям серии.' : 'Так страницу увидят гости.'), title, el('div', { style: 'height:10px' }), descEd.el, video, el('div', { style: 'height:12px' }), design.el,
        el('div', { style: 'display:flex;gap:8px;margin-top:18px;justify-content:flex-end' }, el('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Отмена'),
          el('button', { type: 'button', class: 'btn btn-primary', onclick: async () => { try { const r = await api(`/api/events/${e.id}${series ? '?series=1' : ''}`, { method: 'PATCH', body: { title: title.value.trim(), description: desc.value.trim(), video_url: video.value.trim() || null, ...design.get() } }); close(); toast(series ? `Обновлено событий: ${r.updated}` : 'Сохранили'); renderCabinet(); } catch { toast('Не получилось'); } } }, 'Сохранить')))));
  }
  function renderMarkdown(text) {
    const box = el('div', { class: 'desc md' });
    try {
      const html = window.marked ? window.marked.parse(String(text || ''), { breaks: true, gfm: true }) : String(text || '');
      box.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'script', 'iframe'] }) : html.replace(/<[^>]+>/g, '');
      for (const a of box.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener'; }
      for (const img of box.querySelectorAll('img')) img.loading = 'lazy';
    } catch { box.textContent = text || ''; }
    return box;
  }
  function videoEmbed(url) {
    try {
      const u = new URL(url);
      if (/youtu\.be$/.test(u.hostname)) return `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
      if (/youtube\.com$/.test(u.hostname)) { const id = u.searchParams.get('v') || u.pathname.split('/').pop(); return id ? `https://www.youtube.com/embed/${id}` : null; }
      if (/rutube\.ru$/.test(u.hostname)) { const m = u.pathname.match(/\/video\/([a-z0-9]+)/i); return m ? `https://rutube.ru/play/embed/${m[1]}` : null; }
      if (/vk\.com$|vkvideo\.ru$|vk\.video$/.test(u.hostname)) { const m = (u.pathname + u.search).match(/video(-?\d+)_(\d+)/); return m ? `https://vk.com/video_ext.php?oid=${m[1]}&id=${m[2]}&hd=2` : null; }
    } catch {}
    return null;
  }
  // Редактор описания: markdown + вставка фото
  function mdEditor(initial = '', placeholder = '') {
    const ta = el('textarea', { class: 'md-ta', placeholder }, initial);
    const preview = el('div', { class: 'md-preview', hidden: true });
    const wrapSel = (before, after = '', sample = 'текст') => { const a = ta.selectionStart, b = ta.selectionEnd; const sel = ta.value.slice(a, b) || sample; ta.setRangeText(before + sel + after, a, b, 'select'); ta.dispatchEvent(new Event('input')); ta.focus(); };
    const insertLine = prefix => { const a = ta.selectionStart; const lineStart = ta.value.lastIndexOf('\n', a - 1) + 1; ta.setRangeText(prefix, lineStart, lineStart, 'end'); ta.dispatchEvent(new Event('input')); ta.focus(); };
    const fileIn = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async ev => { const f = ev.target.files[0]; if (!f) return; try { toast('Загружаем фото…'); const r = await uploadImage(f); const a = ta.selectionStart; ta.setRangeText(`\n![фото](${r.url})\n`, a, a, 'end'); ta.dispatchEvent(new Event('input')); } catch { toast('Не удалось загрузить'); } } });
    const btn = (label, title, fn) => el('button', { type: 'button', class: 'md-btn', title, onclick: fn }, label);
    const previewBtn = btn('👁 Превью', 'Показать, как увидят гости', () => { const on = preview.hidden; preview.hidden = !on; ta.hidden = on; previewBtn.classList.toggle('on', on); if (on) { preview.innerHTML = ''; preview.append(renderMarkdown(ta.value)); } });
    const bar = el('div', { class: 'md-bar' },
      btn('B', 'Жирный', () => wrapSel('**', '**')), btn('I', 'Курсив', () => wrapSel('_', '_')), btn('H', 'Заголовок', () => insertLine('## ')), btn('•', 'Список', () => insertLine('- ')), btn('1.', 'Нумерованный', () => insertLine('1. ')), btn('❝', 'Цитата', () => insertLine('> ')),
      btn('🔗', 'Ссылка', () => wrapSel('[', '](https://)', 'название')), el('label', { class: 'md-btn', title: 'Вставить фото' }, '🖼️ Фото', fileIn), el('span', { class: 'md-spacer' }), previewBtn);
    const node = el('div', { class: 'md-editor' }, bar, ta, preview, el('div', { class: 'help' }, 'Markdown: **жирный**, _курсив_, ## заголовок, списки, ссылки, фото прямо в тексте. Чем подробнее, тем выше в поиске.'));
    return { el: node, ta, get: () => ta.value };
  }
  function gallery(urls) { return el('div', { class: 'gallery' }, urls.map(u => el('button', { type: 'button', 'aria-label': 'Открыть фото', style: `background-image:url(${u})`, onclick: () => lightbox(u) }))); }
  function lightbox(u) { const lb = el('div', { class: 'lightbox', onclick: () => lb.remove() }, el('img', { src: u, alt: '' })); document.body.append(lb); }

  // ---------- Загрузка, подвал, роутер ----------
  async function loadMe() { try { me = await api('/api/me'); renderMe(); } catch { me = null; } }
  function initFooter() {
    const form = $('#digest-form'); if (!form) return;
    form.addEventListener('submit', async ev => { ev.preventDefault(); const v = $('#digest-email').value.trim(); if (!v) return; try { await api('/api/digest', { method: 'POST', body: { email: v } }); form.replaceWith(el('div', { class: 'digest ok' }, `✓ Подписали ${v}. Первый выпуск — 19 ноября.`)); toast('Подписка оформлена'); } catch { toast('Проверьте адрес почты'); } });
  }
  let routeId = 0;
  // Предзаполнение мастера: сценарий по типу организации, название организации, копия события
  async function prefillNew(params) {
    const kind = params.get('kind'), org = params.get('org'), from = params.get('from');
    await new Promise(r => setTimeout(r, 0));
    if (kind) $(`.scen[data-k="${kind}"]`)?.click();
    if (org) { const i = $('[name=organizer]'); if (i) { i.value = org; i.dispatchEvent(new Event('input')); } }
    if (from) {
      try {
        const e = await api(`/api/events/${encodeURIComponent(from)}`);
        if (e.kind && !kind) $(`.scen[data-k="${e.kind === 'single' ? 'single' : e.kind}"]`)?.click();
        const set = (n, v) => { const i = $(`[name=${n}]`); if (i && v != null) { i.value = v; i.dispatchEvent(new Event(i.tagName === 'SELECT' ? 'change' : 'input')); } };
        set('cat', e.category); await new Promise(r => setTimeout(r, 0)); set('sub', e.sub || '');
        set('title', e.title + ' (копия)'); set('venue', e.venue); set('address', e.address); set('district', e.district); set('price', e.price); set('capacity', e.capacity); set('organizer', e.organizer.name);
        const ta = $('.md-ta'); if (ta) { ta.value = e.description || ''; ta.dispatchEvent(new Event('input')); }
        const kw = $('[name=keywords]'); if (kw) kw.value = (e.keywords || []).join(', ');
        toast('Скопировали событие — проверьте даты и сохраните');
      } catch { toast('Не удалось скопировать событие'); }
    }
  }
  function route() {
    routeId++; track('page_view', { hash: location.hash || '#/' });
    const mr = $('#modal-root'); if (mr) mr.innerHTML = '';
    syncNavSearch(); // модалки не переживают смену страницы
    $('#cta-bar')?.remove();
    updateTabbar();
    const h = location.hash || '#/';
    let m;
    if ((m = h.match(/^#\/event\/(.+)$/))) return renderEvent(decodeURIComponent(m[1]));
    if ((m = h.match(/^#\/org\/(.+)$/))) return renderOrg(decodeURIComponent(m[1]));
    if ((m = h.match(/^#\/checkin\/(.+)$/))) return renderCheckin(m[1]);
    if (h.startsWith('#/new')) return renderNew().then(() => prefillNew(new URLSearchParams(h.split('?')[1] || '')));
    if (h.startsWith('#/cabinet')) return renderCabinet(new URLSearchParams(h.split('?')[1] || ''));
    if (h === '#/my') return renderMy();
    if (h === '#/rules') return renderRules();
    if (h.startsWith('#/stats')) return renderStats();
    renderHome();
  }
  document.addEventListener('DOMContentLoaded', async () => {
    initTheme(); initNavSearch(); initMobile(); initFooter();
    // Открыт как мини-приложение Telegram (бот → кнопка меню): подключаем SDK, тема и кнопка «Назад» как в Telegram
    if (/tgWebApp/.test(location.hash) || new URLSearchParams(location.search).has('tg')) {
      const sc = document.createElement('script'); sc.src = 'https://telegram.org/js/telegram-web-app.js';
      sc.onload = () => { const tg = window.Telegram?.WebApp; if (!tg) return; tg.ready(); tg.expand(); document.body.classList.add('in-telegram');
        if (tg.colorScheme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
        const syncBack = () => { if ((location.hash || '#/').startsWith('#/event') || (location.hash || '#/').startsWith('#/org')) tg.BackButton.show(); else tg.BackButton.hide(); };
        tg.BackButton.onClick(() => history.back()); window.addEventListener('hashchange', syncBack); syncBack(); };
      document.head.append(sc);
      if (/tgWebApp/.test(location.hash)) history.replaceState(null, '', location.pathname + '?tg=1#/');
    }
    { const u = new URL(location.href); const ok = u.searchParams.get('auth'), bad = u.searchParams.get('auth_error');
      if (ok || bad) { setTimeout(() => toast(bad || `Вы вошли через ${ok === 'yandex' ? 'Яндекс ID' : ok === 'google' ? 'Google' : ok}`), 400); u.searchParams.delete('auth'); u.searchParams.delete('auth_error'); history.replaceState(null, '', u.pathname + u.search + u.hash); } }
    loadConfig();
    try { const tx = await api('/api/taxonomy'); taxonomy = tx.categories; taxonomy.activities = tx.activities || []; taxonomy.groups = tx.groups || {}; taxonomy.districts = tx.districts || []; } catch { taxonomy = []; taxonomy.activities = []; taxonomy.groups = {}; }
    loadMe();
    window.addEventListener('hashchange', route);
    route();
  });
})();
