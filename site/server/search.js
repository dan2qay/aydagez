// Поиск по событиям с терпимостью к опечаткам: нормализация, раскладка, транслит,
// лёгкий стемминг русского, расстояние Дамерау–Левенштейна и триграммы, синонимы.

const LAYOUT = { q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з', '[': 'х', ']': 'ъ', a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д', ';': 'ж', "'": 'э', z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь', ',': 'б', '.': 'ю' };
const TRANSLIT = [['shch', 'щ'], ['sch', 'щ'], ['sh', 'ш'], ['ch', 'ч'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['yu', 'ю'], ['ya', 'я'], ['yo', 'ё'], ['ye', 'е'], ['e', 'е'], ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['z', 'з'], ['i', 'и'], ['j', 'й'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'ц'], ['y', 'ы'], ['w', 'в'], ['x', 'кс'], ['q', 'к']];
const SYNONYMS = {
  кино: ['фильм', 'кинотеатр'], фильм: ['кино', 'кинотеатр'], кинотеатр: ['кино'],
  пробежка: ['бег', 'забег'], бег: ['пробежка', 'забег'], бегать: ['бег', 'пробежка'], побегать: ['бег', 'пробежка'],
  тусовка: ['вечеринка'], пати: ['вечеринка'], танцы: ['вечеринка', 'диджей'], потанцевать: ['вечеринка'],
  английский: ['english', 'speaking'], инглиш: ['английский', 'english'], татарский: ['татарча'],
  настолки: ['настольные', 'игротека'], настольные: ['настолки'], шахматы: ['шахматный', 'блиц'],
  квиз: ['викторина', 'quiz'], викторина: ['квиз'], стендап: ['стэндап', 'комики', 'микрофон', 'comedy'], стэндап: ['стендап'], юмор: ['стендап', 'комики'],
  театр: ['спектакль'], спектакль: ['театр'], лекция: ['лекторий'], концерт: ['музыка', 'живая'], музыка: ['концерт', 'джаз'],
  знакомства: ['свидания', 'стол', 'нетворкинг', 'незнакомцы'], познакомиться: ['знакомства', 'свидания', 'стол', 'незнакомцы'], свидание: ['свидания'],
  ужин: ['стол', 'ресторан'], поесть: ['ужин', 'стол'], коньки: ['каток'], покататься: ['каток', 'коньки'], лед: ['каток'],
  йога: ['растяжка', 'медитация'], спорт: ['бег', 'футбол', 'йога', 'скалодром', 'каток'], футбол: ['футзал'],
  айти: ['it', 'митап', 'разработка'], программирование: ['it', 'разработка', 'митап'], работа: ['нетворкинг', 'it'],
  дети: ['детский', 'куклы', 'семейный'], ребенок: ['детский', 'куклы'], бесплатно: ['бесплатный'], выставка: ['галерея', 'музей'], экскурсия: ['прогулка', 'слобода'],
  керамика: ['гончарный', 'мастер-класс', 'лепим'], рисование: ['мастер-класс', 'акварель'],
};
const ENDINGS = ['иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ешь', 'ете', 'ать', 'ять', 'ить', 'еть', 'ать', 'ует', 'ют', 'ят', 'ат', 'ет', 'ит', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ую', 'юю', 'ов', 'ев', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'ью', 'ия', 'ие', 'ии', 'ия', 'ы', 'и', 'а', 'я', 'у', 'ю', 'е', 'о', 'ь', 'й'];

export function normalize(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-яәөүңһҗñ0-9\s-]/gi, ' ').replace(/\s+/g, ' ').trim();
}
export function layoutSwap(s) { return s.split('').map(ch => LAYOUT[ch] ?? ch).join(''); }
export function translit(s) {
  let out = s;
  for (const [lat, cyr] of TRANSLIT) out = out.split(lat).join(cyr);
  return out;
}
export function stem(w) {
  if (w.length <= 3) return w;
  for (const e of ENDINGS) {
    if (w.length - e.length >= 3 && w.endsWith(e)) return w.slice(0, -e.length);
  }
  return w;
}
export function tokenize(s) { return normalize(s).split(/[\s-]+/).filter(t => t.length > 1); }
const stems = s => tokenize(s).map(stem);

export function damerau(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}
const trigrams = w => { const s = `  ${w} `; const out = new Set(); for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3)); return out; };
export function similarity(a, b) {
  const ta = trigrams(a), tb = trigrams(b);
  let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// Насколько токен запроса подходит к токену документа: 1 точно, 0.85 префикс, 0.6–0.7 опечатка, 0 нет.
function tokenMatch(qs, ds) {
  if (qs === ds) return 1;
  if (ds.startsWith(qs) && qs.length >= 3) return 0.85;
  if (qs.startsWith(ds) && ds.length >= 4) return 0.7;
  const maxDist = qs.length >= 8 ? 2 : qs.length >= 5 ? 1 : 0;
  if (maxDist && damerau(qs, ds, maxDist) <= maxDist) return 0.65;
  if (qs.length >= 5 && similarity(qs, ds) >= 0.5) return 0.55;
  return 0;
}

// Документ: { id, fields: [{ terms: string[], w: number }] }
export function buildDoc(e) {
  const f = (text, w) => ({ terms: [...new Set(stems(text))], w });
  return {
    id: e.id,
    fields: [
      f(e.title, 3),
      f([e.subTitle, ...(e.keywords || [])].join(' '), 2.5), // ключевые слова подкатегории не индексируем: у «командных игр» они перечисляют все виды сразу
      f([e.catTitle, ...(e.tags || [])].join(' '), 1.5),
      f(`${e.venue} ${e.organizer?.name || ''}`, 1.2),
      f(e.description, 1),
      f(e.district, 0.6),
    ],
  };
}

function scoreDoc(doc, qTokens, minMatch = qTokens.length, idf = null) {
  // qTokens: массив слотов, каждый — список альтернативных стемов (синонимы); minMatch — сколько слов обязано совпасть
  let total = 0, missed = 0;
  const matchedTerms = [];
  for (const alts of qTokens) {
    let best = 0, bestTerm = null;
    for (const field of doc.fields) {
      for (const term of field.terms) {
        for (let k = 0; k < alts.length; k++) {
          const m = tokenMatch(alts[k], term) * (k === 0 ? 1 : 0.75); // синонимы весят меньше точного слова
          const w = m * field.w * (idf ? (idf.get(term) || 1) : 1); // BM25-подобный вес: редкие слова важнее частых
          if (w > best) { best = w; bestTerm = { term, exact: m === 1, alt: alts[k] }; }
        }
      }
    }
    if (best === 0) { missed++; if (qTokens.length - missed < minMatch) return { score: 0, matched: [] }; matchedTerms.push(null); continue; }
    total += best; matchedTerms.push(bestTerm);
  }
  return { score: total, matched: matchedTerms };
}

function expand(token) {
  const alts = new Set([stem(token)]);
  const syn = SYNONYMS[token] || SYNONYMS[stem(token)];
  if (syn) for (const s of syn) alts.add(stem(normalize(s)));
  return [...alts];
}

// Возвращает { hits: Map(id -> score), corrected: string|null, variant: string }
export function search(query, docs, vocab) {
  const raw = normalize(query);
  if (!raw) return { hits: new Map(), corrected: null, variant: raw };
  const variants = [raw];
  if (/^[a-z\s'.,;\[\]-]+$/.test(raw)) { variants.push(normalize(layoutSwap(raw))); variants.push(normalize(translit(raw))); }
  let best = null;
  for (const v of variants) {
    const tokens = tokenize(v);
    if (!tokens.length) continue;
    const slots = tokens.map(expand);
    const hits = new Map(); const matchedAll = [];
    const run = minMatch => { hits.clear(); matchedAll.length = 0; for (const doc of docs) { const { score, matched } = scoreDoc(doc, slots, minMatch, docs.idf); if (score > 0) { hits.set(doc.id, score); matchedAll.push(matched); } } };
    run(slots.length);
    if (!hits.size && slots.length >= 3) run(Math.max(2, Math.ceil(slots.length / 2))); // фраза: достаточно половины слов
    const strength = [...hits.values()].reduce((a, b) => a + b, 0);
    if (!best || strength > best.strength) best = { hits, strength, variant: v, tokens, matchedAll };
  }
  if (!best || best.hits.size === 0) return { hits: new Map(), corrected: suggest(raw, vocab), variant: raw };
  // Подсказка «возможно, вы имели в виду», если слова запроса не совпали точно
  let corrected = null;
  const exactAll = best.matchedAll.some(m => m.every(x => x && x.exact));
  if (!exactAll || best.variant !== raw) {
    const words = best.tokens.map((t, i) => {
      const counts = new Map();
      for (const m of best.matchedAll) { const x = m[i]; if (x && !x.exact) counts.set(x.term, (counts.get(x.term) || 0) + 1); }
      let top = null; for (const [term, n] of counts) if (!top || n > top.n) top = { term, n };
      return top ? (vocab.get(top.term) || top.term) : t;
    });
    const c = words.join(' ');
    if (c !== raw) corrected = c;
  }
  return { hits: best.hits, corrected, variant: best.variant };
}

// Словарь: стем -> самое частое исходное слово (для подсказок)
export function buildVocab(events) {
  const freq = new Map();
  for (const e of events) {
    for (const w of tokenize([e.title, e.subTitle, ...(e.subKeywords || []), e.catTitle, e.venue].join(' '))) {
      const s = stem(w); if (!freq.has(s)) freq.set(s, new Map());
      const m = freq.get(s); m.set(w, (m.get(w) || 0) + 1);
    }
  }
  const vocab = new Map();
  for (const [s, m] of freq) { let top = null; for (const [w, n] of m) if (!top || n > top.n) top = { w, n }; vocab.set(s, top.w); }
  return vocab;
}

function suggest(raw, vocab) {
  const words = tokenize(raw).map(w => {
    const s = stem(w); let bestTerm = null, bestScore = 0;
    for (const [term, orig] of vocab) {
      const m = tokenMatch(s, term);
      if (m > bestScore) { bestScore = m; bestTerm = orig; }
    }
    return bestScore >= 0.55 ? bestTerm : w;
  });
  const c = words.join(' ');
  return c !== raw ? c : null;
}

// Обратная частота документов для BM25-подобных весов: считается один раз при обновлении кэша и вешается на массив docs.
export function buildIdf(docs) {
  const df = new Map(); const N = docs.length || 1;
  for (const d of docs) { const seen = new Set(); for (const f of d.fields) for (const t of f.terms) seen.add(t); for (const t of seen) df.set(t, (df.get(t) || 0) + 1); }
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.min(2.2, Math.max(0.6, 0.55 + Math.log(1 + (N - n + 0.5) / (n + 0.5)) / 3)));
  docs.idf = idf;
  return idf;
}
