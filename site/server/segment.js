// Разбор запроса гостя на сегменты (по мотивам Томита-парсера: газетир + грамматика + покрытие без пересечений).
// 1) Предобработка: «19:30» → время, «25.10» → «25 октября», «18+» → маркировка — до того, как нормализация съест знаки.
// 2) Грамматика по токенам: время, даты, цена, возраст ребёнка, размер компании, длительность.
// 3) Газетир фраз: каждый маркер — префикс слова (многословные — подряд). Сегменты не пересекаются;
//    длинный и точный маркер побеждает короткий («вечеринка» ≠ «вечер», «картинг» ≠ «картина»).
// 4) Отрицания «не», «без», «кроме» перед сегментом. 5) Остаток — слова для текстового поиска.
import { normalize, stem } from './search.js';

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const monthOf = t => { if (/^ма[йяе]$/.test(t)) return 4; const i = MONTHS.findIndex((m, k) => k !== 4 && t.startsWith(m)); return i; };
const NUMW = { один: 1, одна: 1, одного: 1, часа: null, два: 2, две: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4, пять: 5, пяти: 5, шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9, десять: 10, десяти: 10, одиннадцать: 11, одиннадцати: 11, двенадцать: 12, двенадцати: 12 };
const num = t => /^\d{1,4}$/.test(t) ? Number(t) : (NUMW[t] ?? null);
const NOT_TIME = /^(лет|год|года|человек|человека|чел|людей|рубл|руб|р|тыс|км|мин|минут|числа|раз|процент|штук|мест)/;
const CURRENCY = /^(руб|рубл|р$|тыс|тысяч|к$)/;
const DAYPART = { утра: 'm', дня: 'd', вечера: 'e', ночи: 'n' };
const pad = n => String(n).padStart(2, '0');
// Хвост после маркера, похожий на окончание: «сап|ах», «вечер|ом» — то же слово; «вечер|инка», «картин|г» — другое
const ENDING = /^(а|я|ы|и|у|ю|е|о|ой|ей|ом|ем|ам|ям|ах|ях|ами|ями|ов|ев|ий|ый|ая|ое|ые|ых|их|ую|юю|ть|ся|ет|ют|ат|ят|ом|ку|ки|ке)?$/;

// Сегодня по Москве/Казани (UTC+3) — для «через неделю», «25 октября» и т. п.
export function mskToday(now = new Date()) { const d = new Date(now.getTime() + 3 * 3600e3); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)); }
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

function prepass(raw) {
  let s = String(raw || '');
  s = s.replace(/(\d{1,2})\s*\+/g, (m, a) => ` ${a}плюс `); // 18+ → маркировка
  s = s.replace(/(^|[^\d])(\d{1,2}):(\d{2})(?!\d)/g, (m, p, h, mm) => Number(h) <= 23 && Number(mm) <= 59 ? `${p} ${h}ч${mm} ` : m);
  s = s.replace(/(^|[^\d.])(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?![\d.])/g, (m, p, a, b, y, off) => {
    const A = Number(a), B = Number(b);
    const before = (s.slice(0, off + p.length).trim().split(/\s+/).pop() || '').toLowerCase();
    const timeCtx = ['в', 'к', 'до', 'после', 'с', 'около'].includes(before);
    if (timeCtx && A <= 23 && b.length === 2 && B <= 59) return `${p} ${A}ч${b} `; // «в 19.30»
    if (A >= 1 && A <= 31 && B >= 1 && B <= 12) return `${p} ${A} ${MONTH_GEN[B - 1]} `; // «25.10»
    if (A <= 23 && b.length === 2 && B <= 59) return `${p} ${A}ч${b} `;
    return m;
  });
  return s;
}
const toks = q => normalize(prepass(q)).split(/[\s-]+/).filter(Boolean);

// Время суток в минутах с учётом «утра/дня/вечера/ночи»
function clock(h, m, part) {
  if (h == null || h > 24) return null;
  if (!part && h >= 1 && h <= 6) h += 12; // «в 3», «к пяти» без уточнения — днём, а не ночью
  if (part === 'e' && h < 12) h += 12; else if (part === 'd' && h <= 6) h += 12; else if (part === 'n' && h === 12) h = 0; else if (part === 'n' && h >= 9 && h <= 11) h += 12;
  if (h === 24) h = 0;
  return h * 60 + (m || 0);
}
// Читает время с позиции i: «19ч30», «19 30», «7 вечера», «семи», «полдень». Возвращает { min, len } или null
function readClock(T, i, needCtx) {
  const t = T[i]; if (t == null) return null;
  let m = t.match(/^(\d{1,2})ч(\d{2})$/); if (m) { const part = DAYPART[T[i + 1]]; return { min: clock(+m[1], +m[2], part), len: part ? 2 : 1 }; }
  if (t === 'полдень' || t === 'полудня') return { min: 720, len: 1 };
  if (t === 'полночь' || t === 'полуночи') return { min: 1439, len: 1 };
  let h = t === 'час' && DAYPART[T[i + 1]] ? 1 : num(t); if (h == null || h > 24) return null;
  let len = 1, mm = 0;
  if (/^\d{2}$/.test(T[i + 1] || '') && /^\d{1,2}$/.test(t) && +T[i + 1] <= 59 && !NOT_TIME.test(T[i + 2] || '') && monthOf(T[i + 2] || '') < 0) { mm = +T[i + 1]; len = 2; }
  const part = DAYPART[T[i + len]]; if (part) len++;
  if (/^час(а|ов)?$/.test(T[i + len] || '')) len++;
  if (NOT_TIME.test(T[i + len] || '') || monthOf(T[i + len] || '') >= 0) return null;
  if (needCtx && !part && !/^\d/.test(t) && !NUMW[t]) return null;
  if (!part && !/^\d/.test(t) && needCtx === 'strict') return null;
  return { min: clock(h, mm, part), len, ambiguous: !part && h >= 7 && h <= 11 };
}

export function makeSegmenter({ gazetteer, stop }) {
  // Газетир: фраза → слова-префиксы
  const G = [];
  for (const g of gazetteer) { const words = normalize(g.phrase).split(/[\s-]+/).filter(w => w.length >= 2 || /\d/.test(w)); if (words.length) G.push({ ...g, words, exact: /\s$/.test(g.phrase), mlen: words.join(' ').length }); } // «сап » с пробелом — только целое слово
  G.sort((a, b) => b.words.length - a.words.length || b.mlen - a.mlen);
  const NEG = new Set(['не', 'без', 'кроме', 'никаких', 'никакого', 'никакой']);

  return function segment(q, now = new Date()) {
    const T = toks(q), used = new Array(T.length).fill(false), segs = [];
    const today = mskToday(now);
    const take = (i, len, seg) => { for (let k = i; k < i + len; k++) used[k] = true; segs.push({ i, len, text: T.slice(i, i + len).join(' '), ...seg }); };
    const free = (i, len) => { for (let k = i; k < i + len; k++) if (k >= T.length || used[k]) return false; return true; };
    const out = { hour: null, dates: [], pmin: null, pmax: null, kidAge: null, adult: false, group: null };

    // ---------- Грамматика ----------
    for (let i = 0; i < T.length; i++) {
      if (used[i]) continue;
      const t = T[i], n1 = T[i + 1];
      // возрастная маркировка «18+»
      let m = t.match(/^(\d{1,2})плюс$/); if (m) { if (+m[1] >= 16) out.adult = true; take(i, 1, { slot: 'age_mark', value: +m[1] }); continue; }
      // диапазон времени «с 15 до 18», «с 7 вечера до 10»
      if (t === 'с' || t === 'со') { const a = readClock(T, i + 1); if (a && T[i + 1 + a.len] === 'до') { const b = readClock(T, i + 2 + a.len); if (b && a.min != null && b.min != null) { out.hour = { from: a.min, to: b.min }; take(i, 2 + a.len + b.len, { slot: 'hour', value: out.hour }); continue; } } }
      // цена «до 500 рублей», «не дороже 1000», «дешевле 300», «за 500», «от 1000 руб», «до 2 тыс»
      const pricePrep = t === 'до' || t === 'дешевле' || t === 'меньше' || t === 'за' || t === 'максимум' || (t === 'не' && /^(дороже|больше)$/.test(n1 || '')) || (t === 'в' && n1 === 'пределах');
      if (pricePrep || t === 'от' || t === 'дороже') {
        const j = i + ((t === 'не' || t === 'в') ? 2 : 1); const v = /^\d{1,6}$/.test(T[j] || '') ? +T[j] : null;
        if (v != null) {
          const cur = CURRENCY.test(T[j + 1] || ''); const k = /^(тыс|тысяч|к)$/.test(T[j + 1] || '') ? 1000 : 1; const curLen = cur ? (k > 1 && /^(руб|рубл|р)/.test(T[j + 2] || '') ? 2 : 1) : 0;
          if (cur || v >= 100) {
            const val = v * k, len = j - i + 1 + curLen;
            if (t === 'от' || t === 'дороже') { out.pmin = val; take(i, len, { slot: 'pmin', value: val }); if (T[i + len] === 'до' && /^\d+$/.test(T[i + len + 1] || '')) { const v2 = +T[i + len + 1] * (/^(тыс|тысяч|к)$/.test(T[i + len + 2] || '') ? 1000 : 1); out.pmax = v2; take(i + len, CURRENCY.test(T[i + len + 2] || '') ? 3 : 2, { slot: 'pmax', value: v2 }); } }
            else { out.pmax = val; take(i, len, { slot: 'pmax', value: val }); }
            continue;
          }
        }
      }
      // возраст ребёнка «5 лет», «ребёнку 7», «сыну 3 года»
      m = t.match(/^\d{1,2}$/); if (m && /^(лет|года|год)$/.test(n1 || '') && +t <= 17) { out.kidAge = +t; take(i, 2, { slot: 'kidAge', value: +t }); continue; }
      if (/^(сыну|дочке|дочери|ребенку|малышу|детям|внуку|внучке)$/.test(t) && /^\d{1,2}$/.test(n1 || '') && +n1 <= 17) { out.kidAge = +n1; take(i, /^(лет|года|год)$/.test(T[i + 2] || '') ? 3 : 2, { slot: 'kidAge', value: +n1 }); continue; }
      // размер компании «нас 5 человек», «на 4 человека», «компания из 6»
      if (/^\d{1,3}$/.test(t) && /^(человек|человека|чел|людей)$/.test(n1 || '')) { out.group = +t; take(i, 2, { slot: 'group', value: +t }); continue; }
      // длительность «на 2 часа» — не время начала
      if (t === 'на' && num(n1 || '') != null && /^час(а|ов)?$/.test(T[i + 2] || '')) { take(i, 3, { slot: 'duration', value: num(n1) * 60 }); continue; }
      // дата «25 октября», «до 25 октября», «с 1 ноября»
      const dPrep = t === 'до' || t === 'с' || t === 'по' ? t : null; const di = dPrep ? i + 1 : i;
      if (/^\d{1,2}$/.test(T[di] || '') && monthOf(T[di + 1] || '') >= 0) {
        const day = +T[di], mon = monthOf(T[di + 1]); let y = today.getUTCFullYear(); let d = new Date(Date.UTC(y, mon, day, 12)); if (d < addDays(today, -1)) d = new Date(Date.UTC(y + 1, mon, day, 12));
        const r = dPrep === 'до' || dPrep === 'по' ? { from: iso(today), to: iso(d), label: `до ${day} ${MONTH_GEN[mon]}` } : dPrep === 'с' ? { from: iso(d), to: iso(addDays(d, 30)), label: `с ${day} ${MONTH_GEN[mon]}` } : { from: iso(d), to: iso(d), label: `${day} ${MONTH_GEN[mon]}` };
        out.dates.push(r); take(i, di - i + 2, { slot: 'date', value: r }); continue;
      }
      // «в ноябре», «в октябре»
      if (t === 'в' && /^(январ|феврал|март|апрел|ма[ей]|июн|июл|август|сентябр|октябр|ноябр|декабр)\S*е$/.test(n1 || '')) {
        const mon = monthOf(n1); let y = today.getUTCFullYear(); if (mon < today.getUTCMonth()) y++;
        const first = new Date(Date.UTC(y, mon, 1, 12)), last = new Date(Date.UTC(y, mon + 1, 0, 12)); const from = first < today ? today : first;
        const r = { from: iso(from), to: iso(last), label: `в ${n1}` }; out.dates.push(r); take(i, 2, { slot: 'date', value: r }); continue;
      }
      // «через неделю», «через 3 дня», «через день»
      if (t === 'через') {
        const k = num(n1 || ''); const unitTok = k != null ? T[i + 2] : n1; const len = k != null ? 3 : 2;
        if (/^(день|дня|дней)$/.test(unitTok || '')) { const d = addDays(today, k ?? 1); const r = { from: iso(d), to: iso(d), label: `через ${k ?? 1} дн.` }; out.dates.push(r); take(i, len, { slot: 'date', value: r }); continue; }
        if (/^(неделю|недели|недель)$/.test(unitTok || '')) { const d = addDays(today, 7 * (k ?? 1)); const r = { from: iso(addDays(d, -1)), to: iso(addDays(d, 1)), label: `через ${k ?? 1} нед.` }; out.dates.push(r); take(i, len, { slot: 'date', value: r }); continue; }
      }
      // «на следующей неделе», «в следующие выходные», «в следующую субботу»
      if (/^следующ/.test(t) || (/^(на|в|во)$/.test(t) && /^следующ/.test(n1 || ''))) {
        const j = /^следующ/.test(t) ? i + 1 : i + 2; const u = T[j] || ''; const dow = today.getUTCDay(); const nextMon = addDays(today, ((8 - dow) % 7) || 7);
        let r = null;
        if (/^недел/.test(u)) r = { from: iso(nextMon), to: iso(addDays(nextMon, 6)), label: 'на следующей неделе' };
        else if (/^(выходн|уикенд)/.test(u)) r = { from: iso(addDays(nextMon, 5)), to: iso(addDays(nextMon, 6)), label: 'в следующие выходные' };
        else { const wd = ['воскрес', 'понедельн', 'вторн', 'сред', 'четверг', 'пятниц', 'суббот'].findIndex(w => u.startsWith(w)); if (wd >= 0) { const d = addDays(nextMon, (wd + 6) % 7); r = { from: iso(d), to: iso(d), label: `в следующ. ${u}` }; } }
        if (r) { out.dates.push(r); take(i, j - i + 1, { slot: 'date', value: r }); continue; }
      }
      // время «в 19», «к 20 30», «после 18», «до 12», «около 7 вечера», «в 7 вечера», «к восьми»
      if (/^(в|во|к|ко|после|до|около|часам|часов)$/.test(t)) {
        const c = readClock(T, i + 1); if (c && c.min != null) {
          const w = t; const tmin = c.min;
          out.hour = w === 'после' ? { from: tmin, to: 1439 } : w === 'до' ? { from: 0, to: tmin } : { from: Math.max(0, tmin - 60), to: Math.min(1439, tmin + 90) };
          out.hourAmbiguous = !!c.ambiguous; take(i, 1 + c.len, { slot: 'hour', value: out.hour }); continue;
        }
      }
      // голое «19ч30» или «7 вечера» без предлога
      const bare = readClock(T, i, 'strict'); if (bare && bare.min != null && (/ч\d{2}$/.test(t) || DAYPART[T[i + 1]] || DAYPART[T[i + 2]])) { const tmin = bare.min; out.hour = { from: Math.max(0, tmin - 60), to: Math.min(1439, tmin + 90) }; take(i, bare.len, { slot: 'hour', value: out.hour }); continue; }
    }

    // ---------- Газетир: покрытие без пересечений ----------
    const cands = [];
    for (let i = 0; i < T.length; i++) {
      if (used[i]) continue;
      for (const g of G) {
        const L = g.words.length; if (!free(i, L)) continue;
        let ok = true; for (let k = 0; k < L; k++) if (g.exact && k === L - 1 ? T[i + k] !== g.words[k] : !T[i + k].startsWith(g.words[k])) { ok = false; break; }
        if (ok) cands.push({ i, len: L, g });
      }
    }
    cands.sort((a, b) => b.len - a.len || b.g.mlen - a.g.mlen || a.i - b.i);
    const ranges = [];
    for (const c of cands) {
      const same = ranges.find(r => r.i === c.i && r.len === c.len);
      if (same) { // тот же отрезок: берём другие смыслы, кроме маркеров-префиксов более длинного («вечер» внутри «вечеринка»)
        const span = T.slice(c.i, c.i + c.len).join(' '), short = c.g.words.join(' ');
        if (c.g.mlen < same.best.mlen && span.startsWith(short) && !ENDING.test(span.slice(short.length))) continue;
        same.items.push(c.g); continue;
      }
      if (!free(c.i, c.len) || ranges.some(r => c.i < r.i + r.len && r.i < c.i + c.len)) continue;
      ranges.push({ i: c.i, len: c.len, best: c.g, items: [c.g] });
    }
    for (const r of ranges) {
      const neg = r.i > 0 && NEG.has(T[r.i - 1]) && !used[r.i - 1] ? T[r.i - 1] : null;
      if (neg) used[r.i - 1] = true;
      for (let k = r.i; k < r.i + r.len; k++) used[k] = true;
      const uniq = []; for (const g of r.items) if (!uniq.some(u => u.slot === g.slot && u.value === g.value)) uniq.push(g);
      for (const g of uniq) segs.push({ i: r.i, len: r.len, text: T.slice(r.i, r.i + r.len).join(' '), slot: g.slot, value: g.value, neg: !!neg });
    }
    // ---------- Остаток ----------
    const rest = [];
    T.forEach((t, k) => { if (!used[k] && t.length > 1 && !stop.has(t) && !NEG.has(t) && !/^\d+$/.test(t)) rest.push(stem(t)); });
    segs.sort((a, b) => a.i - b.i);
    return { tokens: T, segments: segs, grammar: out, rest };
  };
}
