// Виды занятий для фильтров и ИИ-разбора: детальнее подкатегорий (футбол, волейбол, сапы, караоке…).
// Совпадение — по словам в названии, ключевых словах и тегах события; подкатегория даёт вид по умолчанию.
import { normalize } from './search.js';

export const ACTIVITIES = [
  // Спорт
  { key: 'run', cat: 'sport', title: 'Бег', emoji: '🏃', terms: ['бег', 'пробежк', 'забег', 'run'] },
  { key: 'yoga', cat: 'sport', title: 'Йога и растяжка', emoji: '🧘', terms: ['йог', 'растяжк', 'пилатес', 'медитац'] },
  { key: 'football', cat: 'sport', title: 'Футбол', emoji: '⚽', terms: ['футбол', 'футзал'], group: 'ball' },
  { key: 'volleyball', cat: 'sport', title: 'Волейбол', emoji: '🏐', terms: ['волейбол'], group: 'ball' },
  { key: 'basketball', cat: 'sport', title: 'Баскетбол', emoji: '🏀', terms: ['баскетбол'], group: 'ball' },
  { key: 'badminton', cat: 'sport', title: 'Бадминтон', emoji: '🏸', terms: ['бадминтон'], group: 'ball' },
  { key: 'pingpong', cat: 'sport', title: 'Настольный теннис', emoji: '🏓', terms: ['настольный теннис', 'пинг-понг', 'теннис'], group: 'ball' },
  { key: 'climb', cat: 'sport', title: 'Скалолазание', emoji: '🧗', terms: ['скалодром', 'скалолаз', 'боулдеринг'] },
  { key: 'skate', cat: 'sport', title: 'Коньки', emoji: '⛸️', terms: ['каток', 'коньк'] },
  { key: 'roller', cat: 'sport', title: 'Ролики', emoji: '🛼', terms: ['ролик', 'роллердром'] },
  { key: 'sup', cat: 'sport', title: 'Сапы', emoji: '🏄', terms: ['сап', 'sup'] },
  { key: 'wake', cat: 'sport', title: 'Вейкборд', emoji: '🏄‍♂️', terms: ['вейк'] },
  { key: 'bike', cat: 'sport', title: 'Велосипед', emoji: '🚲', terms: ['велосипед', 'велик', 'велопрогул'] },
  { key: 'nordic', cat: 'sport', title: 'Скандинавская ходьба', emoji: '🥾', terms: ['скандинавск'] },
  { key: 'walk', cat: 'sport', title: 'Прогулки', emoji: '🚶', terms: ['прогулк', 'погулять'] },
  { key: 'swim', cat: 'sport', title: 'Плавание', emoji: '🏊', terms: ['плаван', 'бассейн'] },
  // Игры
  { key: 'quiz', cat: 'games', title: 'Квизы', emoji: '🧠', terms: ['квиз', 'викторин', 'quiz'] },
  { key: 'board', cat: 'games', title: 'Настолки', emoji: '🎲', terms: ['настолк', 'настольные игр', 'настольных игр', 'игротек'] },
  { key: 'chess', cat: 'games', title: 'Шахматы', emoji: '♟️', terms: ['шахмат'] },
  { key: 'mafia', cat: 'games', title: 'Мафия', emoji: '🕵️', terms: ['мафи'] },
  { key: 'dnd', cat: 'games', title: 'D&D и ролевые', emoji: '🐉', terms: ['d&d', 'днд', 'dnd', 'ролев', 'подземел'] },
  // Развлечения
  { key: 'vr', cat: 'fun', title: 'VR', emoji: '🥽', terms: ['vr', 'виртуальн', 'кибер'] },
  { key: 'quest', cat: 'fun', title: 'Квесты', emoji: '🔐', terms: ['квест', 'эскейп', 'иммерсив'] },
  { key: 'lasertag', cat: 'fun', title: 'Лазертаг и пейнтбол', emoji: '🔫', terms: ['лазертаг', 'пейнтбол', 'страйкбол'] },
  { key: 'ropepark', cat: 'fun', title: 'Верёвочный парк', emoji: '🌲', terms: ['веревочн', 'верёвочн'] },
  { key: 'trampoline', cat: 'fun', title: 'Батуты', emoji: '🤸', terms: ['батут'] },
  { key: 'bowling', cat: 'fun', title: 'Боулинг', emoji: '🎳', terms: ['боулинг', 'бильярд'] },
  { key: 'karting', cat: 'fun', title: 'Картинг', emoji: '🏎️', terms: ['картинг'] },
  { key: 'circus', cat: 'fun', title: 'Цирк и шоу', emoji: '🎪', terms: ['цирк', 'планетари', 'океанариум'] },
  { key: 'boat', cat: 'fun', title: 'Теплоходы', emoji: '🚤', terms: ['теплоход', 'трамвайчик'] },
  // Музыка
  { key: 'concert', cat: 'music', title: 'Концерты', emoji: '🎸', terms: ['концерт', 'кавер', 'живая музыка'] },
  { key: 'jazz', cat: 'music', title: 'Джаз', emoji: '🎷', terms: ['джаз'] },
  { key: 'party', cat: 'music', title: 'Вечеринки', emoji: '🎉', terms: ['вечеринк', 'диджей', 'техно', 'танцпол'] },
  { key: 'salsa', cat: 'music', title: 'Сальса и танцы', emoji: '💃', terms: ['сальс', 'латино', 'бачат', 'танцевальн'] },
  { key: 'karaoke', cat: 'music', title: 'Караоке', emoji: '🎤', terms: ['караоке'] },
  { key: 'classical', cat: 'music', title: 'Классика', emoji: '🎻', terms: ['классик', 'оркестр', 'орган', 'филармон'] },
  { key: 'vinyl', cat: 'music', title: 'Винил и маркеты', emoji: '📀', terms: ['винил', 'маркет', 'ярмарк'] },
  // Культура
  { key: 'cinema', cat: 'culture', title: 'Кино', emoji: '🎬', terms: ['кино', 'фильм', 'кинотеатр'] },
  { key: 'theatre', cat: 'culture', title: 'Театр', emoji: '🎭', terms: ['театр', 'спектакл'] },
  { key: 'standup', cat: 'culture', title: 'Стендап', emoji: '🎙️', terms: ['стендап', 'стэндап', 'комик', 'импров', 'comedy'] },
  { key: 'exhibition', cat: 'culture', title: 'Выставки', emoji: '🖼️', terms: ['выставк', 'галере', 'музей', 'эрмитаж'] },
  { key: 'tour', cat: 'culture', title: 'Экскурсии', emoji: '🗺️', terms: ['экскурс', 'прогулка по'] },
  { key: 'planetarium', cat: 'culture', title: 'Планетарий', emoji: '🔭', terms: ['планетар'] },
  // Знания
  { key: 'lecture', cat: 'knowledge', title: 'Лекции', emoji: '🎓', terms: ['лекци', 'лектор'] },
  { key: 'it', cat: 'knowledge', title: 'IT и стартапы', emoji: '💻', terms: ['it', 'айти', 'python', 'митап', 'хакатон', 'стартап'] },
  { key: 'book', cat: 'knowledge', title: 'Книжные клубы', emoji: '📚', terms: ['книжн', 'книг', 'читальн'] },
  { key: 'workshop', cat: 'knowledge', title: 'Мастер-классы', emoji: '🎨', terms: ['мастер-класс', 'керамик', 'гончар', 'акварел', 'рисован', 'своими руками'] },
  { key: 'english', cat: 'social', title: 'Английский', emoji: '🇬🇧', terms: ['английск', 'english', 'speaking'] },
  { key: 'tatar', cat: 'social', title: 'Татарский', emoji: '🌙', terms: ['татарск', 'татарча'] },
  { key: 'langs', cat: 'social', title: 'Другие языки', emoji: '🗣️', terms: ['испанск', 'французск', 'немецк', 'китайск', 'разговорный клуб'] },
  // Общение
  { key: 'stol', cat: 'social', title: 'Ужин с незнакомцами', emoji: '🍽️', terms: ['стол на', 'ужин', 'незнаком'] },
  { key: 'dating', cat: 'social', title: 'Знакомства', emoji: '💘', terms: ['свидан', 'знакомств', 'speed'] },
  { key: 'networking', cat: 'social', title: 'Нетворкинг', emoji: '🤝', terms: ['нетворк', 'фриланс'] },
  { key: 'newcomers', cat: 'social', title: 'Для новичков в городе', emoji: '🧭', terms: ['новичк', 'переех', 'знакомимся с казанью'] },
];
export const ACT_GROUPS = { ball: { title: 'Игры с мячом', keys: ['football', 'volleyball', 'basketball', 'badminton', 'pingpong'] } };
const SUB_DEFAULT = { run: 'run', yoga: 'yoga', skate: 'skate', climb: 'climb', quiz: 'quiz', board: 'board', chess: 'chess', mafia: 'mafia', concert: 'concert', jazz: 'jazz', party: 'party', classical: 'classical', market: 'vinyl', cinema: 'cinema', theatre: 'theatre', standup: 'standup', exhibition: 'exhibition', tour: 'tour', lecture: 'lecture', it: 'it', book: 'book', workshop: 'workshop', stol: 'stol', dating: 'dating', networking: 'networking', newcomers: 'newcomers' };
const byKey = Object.fromEntries(ACTIVITIES.map(a => [a.key, a]));

// Виды занятий, прямо названные в запросе гостя: «лазертаг», «волейбол», «картинг».
// Короткие термины (до 4 букв) — только с начала слова, чтобы «сап» не находился в «сапогах».
// Общие слова («свидание», «ужин», «прогулка», «знакомства») сюда не входят: это настроение или формат, а не конкретное занятие.
const LOOSE = new Set(['stol', 'dating', 'networking', 'newcomers', 'walk', 'tour', 'lang', 'book', 'market']);
export function actsInText(q) {
  const text = ' ' + normalize(q || '') + ' ';
  const hitTerm = t => t.length > 4 ? text.includes(t) : new RegExp(`[^а-яёa-z0-9]${t}`).test(text);
  const out = ACTIVITIES.filter(a => !LOOSE.has(a.key) && a.terms.some(hitTerm)).map(a => a.key);
  // «сап» — только сами сапы (сап, сапы, сапах, на сапе), а не «сапоги» или «сапёр»
  return out.filter(k => k !== 'sup' || /[^а-яёa-z](sup|сап(ы|ах|ам|е|ом|ов|а)?)[^а-яёa-z]/.test(text));
}
export function detectActs(e) {
  const text = ' ' + normalize([e.title, ...(e.keywords || []), ...(e.tags || [])].join(' ')) + ' '; // ключевые слова подкатегории не берём: у «командных» они перечисляют все виды сразу
  const out = new Set();
  if (SUB_DEFAULT[e.sub]) out.add(SUB_DEFAULT[e.sub]);
  for (const a of ACTIVITIES) if (a.terms.some(t => text.includes(t))) out.add(a.key);
  // «теннис» без «настольный» — всё равно настольный у нас; «сап» внутри других слов — не считаем
  if (out.has('sup') && !/( сап| sup)/.test(text)) out.delete('sup');
  return [...out];
}
export function facetTitle(key) { return byKey[key]?.title || key; }

// Сводка по выдаче для панели фильтров: гистограмма цен, счётчики по разделам, подкатегориям, видам
export function buildFacets(list) {
  const prices = list.map(e => e.price);
  const maxP = Math.min(6000, Math.max(300, ...prices));
  const cap = Math.ceil(maxP / 500) * 500;
  const nBins = 16, w = cap / nBins;
  const bins = Array.from({ length: nBins }, (_, i) => ({ from: Math.round(i * w), to: Math.round((i + 1) * w), n: 0 }));
  let free = 0;
  for (const p of prices) { if (p === 0) free++; const i = Math.min(nBins - 1, Math.floor(p / w)); bins[i].n++; }
  const count = (fn) => { const m = {}; for (const e of list) for (const k of fn(e)) if (k) m[k] = (m[k] || 0) + 1; return m; };
  return { total: list.length, price: { max: cap, bins, free }, cats: count(e => [e.category]), subs: count(e => [e.sub]), acts: count(e => e.acts || []), districts: count(e => [e.district]), with: count(e => e.with || []), tod: count(e => [e.aiTags?.time]), noise: count(e => [e.aiTags?.noise]) };
}
