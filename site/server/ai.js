// ИИ-поиск, локальный пример поведения.
// Схема одна для двух уровней: сильная модель при создании события заполняет ai_tags,
// слабая модель (или эти правила) при запросе разбирает фразу гостя в те же поля, дальше совпадение тегов даёт балл.
// Подключение настоящих моделей: см. docs/ai-search.md, функции tagEvent / parseQuery — точки замены.

import { normalize, tokenize, stem } from './search.js';
import { llmEnabled, chatJson, cached, remember, models } from './llm.js';
import { DISTRICTS, OUTSKIRTS_TERMS } from './districts.js';
import { nearestScenarios, scenarioAnswer, SCENARIOS } from './scenarios.js';

// Словарь признаков. Каждый признак: ключ → список стемов-маркеров.
const AUDIENCE = {
  kids: ['ребенок', 'ребен', 'дети', 'детей', 'детьми', 'детям', 'детк', 'детск', 'сын', 'дочь', 'дочк', 'малыш', 'школьник', 'подрост'],
  family: ['родствен', 'родител', 'родным', 'родных', 'семьей', 'семьёй', 'семье', 'семья', 'семей', 'мамой', 'маму', 'мама', 'папой', 'папу', 'папа', 'бабушк', 'дедушк', 'сестр', 'брат', 'племян', 'тетей', 'тётей', 'тетю', 'тётю', 'дяд', 'внук'],
  solo: ['один', 'одна', 'одному', 'одной', 'сам', 'соло', 'незнаком', 'познаком', 'новые люди', 'компани'],
  couple: ['вдвоем', 'вдвоём', 'девушк', 'парн', 'свидан', 'романтич', 'пара', 'жена', 'муж'],
  friends: ['друз', 'подруж', 'подруг', 'компани', 'коллег', 'команд', 'корпоратив'],
  tourist: ['турист', 'приезж', 'впервые', 'достопримечат', 'посмотреть город'],
  newcomer: ['переех', 'новичк', 'недавно', 'новый в городе'],
};
const VIBE = {
  calm: ['спокойн', 'тих', 'расслаб', 'отдохн', 'неспешн', 'уютн', 'медленн', 'лениво', 'чил', 'посидеть', 'посидим', 'поболтать', 'пообщаться', 'душевн', 'без суеты'],
  active: ['активн', 'подвиж', 'спорт', 'энергичн', 'адреналин', 'экстрим', 'размят', 'потеть', 'подвигаться'],
  party: ['вечеринк', 'тусов', 'танц', 'пати', 'диджей', 'ночной клуб', 'клубн', 'ночь', 'ночн', 'повесел', 'весел', 'развлеч', 'оторв', 'потус', 'зажечь', 'драйв'],
  smart: ['узнать', 'лекци', 'поумнеть', 'для ума', 'интеллект', 'познавательн', 'книг', 'науч', 'обсуд', 'поучить'],
  romantic: ['романтич', 'свидан', 'красив', 'атмосфер'],
  creative: ['творч', 'рисов', 'лепить', 'мастер', 'своими руками', 'хобби'],
};
const SETTING = {
  outdoor: ['гулять', 'прогул', 'улиц', 'парк', 'на свежем', 'воздух', 'природ', 'набережн', 'лес', 'озер', 'река', 'на улице', 'под открытым'],
  indoor: ['в помещении', 'тепл', 'дожд', 'в зале', 'внутри', 'крыш'],
  water: ['вода', 'воде', 'сап', 'вейк', 'лодк', 'плав', 'бассейн', 'река', 'реке', 'озер', 'теплоход', 'казанк', 'волг', 'катер', 'яхт'],
  food: ['поесть', 'покушать', 'перекусить', 'ужин', 'еды', 'едой', 'кафе', 'ресторан', 'кофе', 'чай', 'бар', 'посидеть', 'посидим', 'столик'],
};
const NOISE = { loud: ['шумн', 'громк', 'танцпол', 'диджей', 'потусить', 'оторваться', 'живая музыка', 'концерт', 'караоке', 'вечеринк', 'ночной клуб', 'клубн', 'в баре', 'бар «'], quiet: ['тих', 'тишин', 'спокойн', 'без шума', 'уютн', 'медитац', 'библиотек', 'читальн', 'камерн', 'неспешн', 'поговорить'] };
const NOISE_SUB = { loud: ['party', 'concert', 'karaoke', 'quiz', 'mafia', 'standup', 'market', 'team', 'climb', 'vr', 'park', 'bowling', 'kidsclub'], quiet: ['yoga', 'book', 'lecture', 'exhibition', 'chess', 'walk', 'it', 'workshop', 'lang', 'cinema', 'theatre', 'classical', 'tour', 'run', 'anticafe', 'boat'] };
const INTENSITY = { low: ['спокойн', 'тих', 'неспешн', 'легк', 'без нагрузки', 'расслаб', 'погулять', 'посидеть'], high: ['интенсив', 'тренировк', 'бег', 'пробежк', 'нагрузк', 'спорт', 'экстрим', 'потеть'] };
const PRICE = { free: ['бесплатн', 'даром', 'без денег', 'недорог', 'дешев', 'бюджетн'], paid: ['дорог', 'премиум', 'vip'] };
const TIME = { morning: ['утр', 'рано'], day: ['днем', 'днём', 'обед', 'после обеда'], evening: ['вечер', 'после работы', 'после пар'], night: ['ночь', 'ночн', 'до утра'], weekend: ['выходн', 'суббот', 'воскрес', 'уикенд'] };
const WEEKDAY = { 1: ['понедельник'], 2: ['вторник'], 3: ['в среду', 'среда', 'по средам'], 4: ['четверг'], 5: ['пятниц'], 6: ['суббот'], 0: ['воскрес'] };
const WEEKDAY_HUMAN = ['в воскресенье', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу'];
// Признаки фразы: есть слово-намерение или 4+ слов — тогда обычный поиск сам включает ИИ-разбор
const INTENT = new Set(['отдохнуть', 'отдыхать', 'провести', 'развлечься', 'сходить', 'погулять', 'хочу', 'хотим', 'хочется', 'хотелось', 'куда', 'где', 'сходить', 'пойти', 'пойдем', 'пойдём', 'сходим', 'заняться', 'чем', 'ищу', 'ищем', 'посоветуй', 'посоветуйте', 'подскажи', 'подскажите', 'нибудь', 'можно']);
export function looksLikePhrase(q) { const w = tokenize(normalize(q || '')); const n = normalize(q || ''); if (hasAnySignal(parseQuery(q || ''))) return true; /* «отдохнуть с ребёнком»: словари поняли «с детьми, спокойно» — значит, это фраза, а не слова для текстового поиска */ return w.length >= 3 || w.some(x => INTENT.has(x)) || /(^|\s)(в|к|после|до|около|с)\s+\d{1,2}(:\d{2})?(\s|$)/.test(n) || /(утром|днем|вечером|ночью|сегодня|завтра|послезавтра|выходн|уикенд|неделе|центр|окраин|бесплатн)/.test(n); }
const ACTIVITY = {
  sport: ['спорт', 'физкультур', 'размять', 'подвигать', 'тренировк', 'фитнес', 'физическ', 'потренир'],
  walk: ['гулять', 'прогул', 'погулять', 'пройтись', 'побродить'], run: ['бег', 'пробежк', 'побегать'], yoga: ['йог', 'растяж', 'медитац'], skate: ['катк', 'коньк', 'лед', 'лёд'],
  bike: ['велосипед', 'велик', 'самокат', 'велопрогул'], water: ['сап', 'вейк', 'лодк', 'катамаран'], climb: ['скалодром', 'лазать', 'боулдеринг'], team: ['футбол', 'волейбол', 'баскетбол', 'игры с мячом', 'с мячом', 'командн', 'бадминтон', 'теннис'],
  football: ['футбол', 'футзал'], volleyball: ['волейбол'], basketball: ['баскетбол'], badminton: ['бадминтон'], pingpong: ['настольный теннис', 'пинг-понг', 'теннис'], roller: ['ролик', 'роллердром'], sup: ['сап ', 'сапы', 'сапах', 'sup'], wake: ['вейк'], nordic: ['скандинавск'], swim: ['плаван', 'бассейн', 'поплавать'], dnd: ['d&d', 'днд', 'ролев'], salsa: ['сальс', 'бачат', 'латино'],
  quiz: ['квиз', 'викторин', 'интеллектуальн'], board: ['настолк', 'настольные игр', 'настольных игр', 'игротек'], chess: ['шахмат'], mafia: ['мафи'],
  cinema: ['кино', 'фильм', 'кинотеатр'], theatre: ['театр', 'спектакл'], standup: ['стендап', 'комик', 'посмеяться', 'юмор'], exhibition: ['выставк', 'музей', 'галере', 'картин'], tour: ['экскурс', 'истори', 'город'],
  concert: ['концерт', 'живая музыка', 'музык', 'группа'], jazz: ['джаз'], party: ['вечеринк', 'танц', 'диджей'], classical: ['классик', 'оркестр', 'филармон'], market: ['маркет', 'ярмарк', 'винил'], karaoke: ['караоке', 'попеть', 'спеть', 'петь', 'песн', 'вокал'],
  lecture: ['лекци', 'узнать'], it: ['айтишн', 'айти-', 'в айти', 'it-', 'программист', 'разработч', 'митап'], book: ['книг', 'чтен'], workshop: ['мастер', 'керамик', 'рисован', 'своими руками'],
  vr: ['vr', 'виар', 'виртуальн', 'кибер', 'компьютерный клуб'], quest: ['квест', 'эскейп', 'перформанс', 'иммерсив'], park: ['батут', 'веревочн', 'верёвочн', 'лазертаг', 'пейнтбол', 'аттракцион', 'попрыгать'], bowling: ['боулинг', 'бильярд', 'картинг', 'гонк'], kidsclub: ['детский центр', 'игровой парк', 'город профессий', 'аниматор'], circus: ['цирк', 'планетари', 'океанариум', 'дельфинари', 'акул'], anticafe: ['антикафе', 'тайм-кафе', 'котокафе', 'с котами'], boat: ['теплоход', 'трамвайчик', 'по воде', 'по реке', 'сити-тур', 'автобусная экскурс', 'обзорн'],
  stol: ['ужин', 'стол на', 'за столом', 'незнаком'], lang: ['английск', 'татарск', 'язык', 'разговорн'], dating: ['знакомств', 'познаком', 'девушк', 'парн', 'половинк', 'одинок', 'отношен'], networking: ['нетворк', 'деловые знакомства', 'бизнес-завтрак'], newcomers: ['новичк', 'переех'],
};
// Подкатегория события → её «врождённые» признаки (для событий без ИИ-тегов и для сида).
const SUB_PROFILE = {
  run: { activity: ['run', 'walk'], setting: ['outdoor'], vibe: ['active'], intensity: 'high', audience: ['solo', 'friends'] },
  yoga: { activity: ['yoga'], setting: ['outdoor'], vibe: ['calm'], intensity: 'low', audience: ['solo', 'couple'] },
  skate: { activity: ['skate', 'walk'], setting: ['outdoor'], vibe: ['active'], intensity: 'low', audience: ['kids', 'couple', 'friends'] },
  team: { activity: ['team'], setting: ['indoor'], vibe: ['active'], intensity: 'high', audience: ['friends', 'solo'] },
  walk: { activity: ['walk', 'bike', 'water'], setting: ['outdoor'], vibe: ['calm', 'active'], intensity: 'low', audience: ['kids', 'couple', 'friends', 'solo'] },
  climb: { activity: ['climb'], setting: ['indoor'], vibe: ['active'], intensity: 'high', audience: ['solo', 'kids'] },
  quiz: { activity: ['quiz'], setting: ['indoor', 'food'], vibe: ['smart', 'party'], intensity: 'low', audience: ['friends', 'couple'] },
  board: { activity: ['board'], setting: ['indoor', 'food'], vibe: ['calm', 'smart'], intensity: 'low', audience: ['solo', 'friends'] },
  chess: { activity: ['chess'], setting: ['indoor'], vibe: ['calm', 'smart'], intensity: 'low', audience: ['solo', 'kids'] },
  mafia: { activity: ['mafia'], setting: ['indoor'], vibe: ['party', 'smart'], intensity: 'low', audience: ['solo', 'friends'] },
  stol: { activity: ['stol'], setting: ['indoor', 'food'], vibe: ['calm'], intensity: 'low', audience: ['solo', 'newcomer'] },
  lang: { activity: ['lang'], setting: ['indoor'], vibe: ['smart', 'calm'], intensity: 'low', audience: ['solo', 'newcomer', 'tourist'] },
  dating: { activity: ['dating'], setting: ['indoor', 'food'], vibe: ['romantic'], intensity: 'low', audience: ['solo'] },
  networking: { activity: ['networking'], setting: ['indoor'], vibe: ['smart'], intensity: 'low', audience: ['solo'] },
  newcomers: { activity: ['newcomers'], setting: ['indoor'], vibe: ['calm'], intensity: 'low', audience: ['solo', 'newcomer', 'tourist'] },
  concert: { activity: ['concert'], setting: ['indoor'], vibe: ['party', 'active'], intensity: 'low', audience: ['friends', 'couple'] },
  jazz: { activity: ['jazz'], setting: ['indoor', 'food'], vibe: ['calm', 'romantic'], intensity: 'low', audience: ['couple', 'solo'] },
  party: { activity: ['party'], setting: ['indoor'], vibe: ['party'], intensity: 'low', audience: ['friends'] },
  classical: { activity: ['classical'], setting: ['indoor'], vibe: ['calm', 'romantic', 'smart'], intensity: 'low', audience: ['couple', 'kids', 'solo'] },
  market: { activity: ['market', 'walk'], setting: ['indoor'], vibe: ['calm'], intensity: 'low', audience: ['friends', 'couple', 'solo'] },
  lecture: { activity: ['lecture'], setting: ['indoor'], vibe: ['smart', 'calm'], intensity: 'low', audience: ['solo', 'couple'] },
  it: { activity: ['it', 'networking'], setting: ['indoor'], vibe: ['smart'], intensity: 'low', audience: ['solo'] },
  book: { activity: ['book'], setting: ['indoor'], vibe: ['calm', 'smart'], intensity: 'low', audience: ['solo'] },
  workshop: { activity: ['workshop'], setting: ['indoor'], vibe: ['creative', 'calm'], intensity: 'low', audience: ['solo', 'couple', 'kids'] },
  theatre: { activity: ['theatre'], setting: ['indoor'], vibe: ['smart', 'romantic'], intensity: 'low', audience: ['couple', 'kids', 'solo'] },
  standup: { activity: ['standup'], setting: ['indoor', 'food'], vibe: ['party'], intensity: 'low', audience: ['friends', 'couple', 'solo'] },
  vr: { activity: ['vr'], setting: ['indoor'], vibe: ['active', 'party'], intensity: 'high', audience: ['friends', 'kids'] },
  quest: { activity: ['quest'], setting: ['indoor'], vibe: ['active', 'smart'], intensity: 'low', audience: ['friends', 'couple', 'kids'] },
  park: { activity: ['park', 'sport'], setting: ['indoor'], vibe: ['active'], intensity: 'high', audience: ['kids', 'friends'] },
  bowling: { activity: ['bowling'], setting: ['indoor', 'food'], vibe: ['party', 'active'], intensity: 'low', audience: ['friends', 'couple', 'kids'] },
  kidsclub: { activity: ['kidsclub'], setting: ['indoor'], vibe: ['active'], intensity: 'low', audience: ['kids'] },
  circus: { activity: ['circus'], setting: ['indoor'], vibe: ['calm', 'smart'], intensity: 'low', audience: ['kids', 'couple', 'tourist'] },
  anticafe: { activity: ['anticafe', 'board'], setting: ['indoor', 'food'], vibe: ['calm'], intensity: 'low', audience: ['solo', 'friends', 'kids'] },
  boat: { activity: ['boat', 'tour'], setting: ['outdoor', 'water'], vibe: ['calm', 'romantic'], intensity: 'low', audience: ['couple', 'kids', 'tourist', 'friends'] },
  cinema: { activity: ['cinema'], setting: ['indoor'], vibe: ['calm'], intensity: 'low', audience: ['couple', 'solo', 'friends'] },
  exhibition: { activity: ['exhibition'], setting: ['indoor'], vibe: ['calm', 'smart'], intensity: 'low', audience: ['couple', 'solo', 'kids', 'tourist'] },
  tour: { activity: ['tour', 'walk'], setting: ['outdoor'], vibe: ['smart', 'calm'], intensity: 'low', audience: ['tourist', 'kids', 'couple', 'newcomer'] },
};

const hasAny = (text, markers) => markers.some(m => text.includes(m));
const pick = (text, dict) => Object.entries(dict).filter(([, markers]) => hasAny(text, markers)).map(([k]) => k);

// «Сильная модель» для события: пока правила по подкатегории и тексту. Возвращает единую схему тегов.
export const TAG_VERSION = 12;
// Спортивные занятия: у события с любым из них есть и общий «sport»; в запросе конкретный вид вытесняет общий
export const SPORT_ACTS = ['run', 'yoga', 'skate', 'bike', 'water', 'climb', 'team', 'football', 'volleyball', 'basketball', 'badminton', 'pingpong', 'roller', 'sup', 'wake', 'nordic', 'swim'];
// Занятия, которые гость называет точно: если названо — показываем только его (волейбол ≠ теннис, кино ≠ театр)
const STRICT_ACTS = new Set([...SPORT_ACTS.filter(a => !['water', 'team'].includes(a)), 'vr', 'quest', 'bowling', 'circus', 'anticafe', 'boat', 'kidsclub', 'dnd', 'salsa', 'quiz', 'board', 'chess', 'mafia', 'cinema', 'theatre', 'standup', 'exhibition', 'concert', 'jazz', 'classical', 'karaoke', 'lecture', 'book', 'lang', 'stol', 'networking']);
// Подкатегории, куда спокойно идут всей семьёй (для тега family)
const FAMILY_SUBS = new Set(['walk', 'skate', 'board', 'chess', 'stol', 'concert', 'jazz', 'classical', 'market', 'lecture', 'book', 'workshop', 'theatre', 'cinema', 'exhibition', 'tour', 'yoga', 'circus', 'kidsclub', 'park', 'bowling', 'anticafe', 'boat', 'quest']);
const HOUR_FMT = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: 'numeric', hourCycle: 'h23' });
export function mskHour(d) { const n = Number(HOUR_FMT.format(d)); return Number.isNaN(n) ? d.getHours() : n % 24; }
export function tagEvent(e) {
  const text = normalize([e.title, e.description, (e.keywords || []).join(' '), e.subTitle, e.venue].join(' '));
  const base = SUB_PROFILE[e.sub] || { activity: [], setting: ['indoor'], vibe: ['calm'], intensity: 'low', audience: ['solo', 'friends'] };
  const audience = new Set(base.audience);
  if ((e.with || []).includes('kids') || hasAny(text, AUDIENCE.kids)) audience.add('kids');
  if ((e.with || []).includes('solo')) audience.add('solo');
  if ((e.with || []).includes('duo')) audience.add('couple');
  if (hasAny(text, AUDIENCE.tourist)) audience.add('tourist');
  if (hasAny(text, AUDIENCE.newcomer)) audience.add('newcomer');
  const vibe = new Set(base.vibe); pick(text, VIBE).forEach(v => vibe.add(v));
  const setting = new Set(base.setting); pick(normalize([e.title, (e.keywords || []).join(" "), e.venue].join(" ")), SETTING).forEach(v => setting.add(v));
  const head = normalize([e.title, (e.keywords || []).join(' '), e.subTitle].join(' '));
  const activity = new Set(base.activity); pick(head, ACTIVITY).forEach(v => activity.add(v));
  if (['football', 'volleyball', 'basketball', 'badminton', 'pingpong'].some(k => activity.has(k))) activity.add('team');
  if (e.category === 'sport' || SPORT_ACTS.some(k => activity.has(k))) activity.add('sport');
  const loudish = hasAny(text, NOISE.loud) || NOISE_SUB.loud.includes(e.sub);
  if (audience.has('kids') || (FAMILY_SUBS.has(e.sub) && !loudish) || (e.kind === 'open' && !loudish) || hasAny(text, AUDIENCE.family)) audience.add('family');
  const h = e.start ? mskHour(new Date(e.start)) : 19; // час по Казани независимо от TZ процесса
  const time = h >= 22 || h < 6 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'day' : 'evening';
  const loudT = hasAny(text, NOISE.loud), quietT = hasAny(text, NOISE.quiet);
  const noiseText = loudT && quietT ? null : loudT ? 'loud' : quietT ? 'quiet' : null; // «книжный клуб в библиотеке»: спорно — решает подкатегория
  const noise = noiseText || (NOISE_SUB.loud.includes(e.sub) ? 'loud' : NOISE_SUB.quiet.includes(e.sub) ? 'quiet' : 'mid');
  const d = e.date ? new Date(e.date + 'T00:00:00').getDay() : 0;
  return {
    audience: [...audience], vibe: [...vibe], setting: [...setting], activity: [...activity],
    intensity: base.intensity, price_band: e.price === 0 ? 'free' : e.price <= 500 ? 'low' : e.price <= 1500 ? 'mid' : 'high',
    time, noise, weekend: d === 0 || d === 6, lang: e.lang || 'ru', v: TAG_VERSION,
    summary: `${[...activity].slice(0, 2).join(', ') || e.subTitle || ''} · ${[...vibe][0] || ''} · ${[...setting][0] || ''}`.replace(/^ · | · $/g, ''),
  };
}

// «Слабая модель» для запроса гостя: та же схема плюс мягкие фильтры.
export function parseQuery(q) {
  const text = normalize(q);
  const audience = pick(text, AUDIENCE), vibe = pick(text, VIBE), setting = pick(text, SETTING), activity = pick(text, ACTIVITY);
  const intensity = hasAny(text, INTENSITY.high) ? 'high' : hasAny(text, INTENSITY.low) ? 'low' : null;
  const price = hasAny(text, PRICE.free) ? 'free' : hasAny(text, PRICE.paid) ? 'high' : null;
  const times = pick(text, TIME);
  const weekdays = Object.entries(WEEKDAY).filter(([, m]) => hasAny(text, m)).map(([d]) => Number(d));
  const noise = hasAny(text, ['шумн', 'громк', 'потусить', 'оторваться', 'танцпол']) ? 'loud' : hasAny(text, ['тих', 'тишин', 'без шума', 'спокойн', 'поговорить']) ? 'quiet' : null;
  // Когда: «сегодня», «завтра», «послезавтра», «на выходных», «на этой неделе»
  const when = /послезавтра/.test(text) ? 'dayafter' : /сегодня|сейчас|вечером сегодня/.test(text) ? 'today' : /завтра/.test(text) ? 'tomorrow' : /на неделе|на этой неделе|до конца недели/.test(text) ? 'week' : hasAny(text, ['выходн', 'уикенд']) ? 'weekend' : null;
  // Где: район по названию или ориентиру, «в центре», «на окраине»
  const outskirts = hasAny(text, OUTSKIRTS_TERMS);
  const districts = outskirts ? DISTRICTS.filter(d => !d.center).map(d => d.key) : DISTRICTS.filter(d => d.terms.some(t => text.includes(t))).map(d => d.key);
  // Конкретное время: «в 19», «в 19:30», «к 20», «после 18», «до 12», «с 15 до 18»
  let hour = null;
  const rng = text.match(/(?:^|\s)с\s+(\d{1,2})(?::(\d{2}))?\s+до\s+(\d{1,2})(?::(\d{2}))?/);
  const one = text.match(/(?:^|\s)(в|к|после|до|около)\s+(\d{1,2})(?::(\d{2}))?(?:\s*(?:ч(?=\s|$)|час|часов|часа|:00))?(?!\s*(?:лет|год|человек|рубл|₽|р(?=\s|$)|км|мин))/);
  const mins = (h, m) => Number(h) * 60 + Number(m || 0);
  if (rng && Number(rng[1]) <= 23 && Number(rng[3]) <= 23) hour = { from: mins(rng[1], rng[2]), to: mins(rng[3], rng[4]) };
  else if (one && Number(one[2]) <= 23) { const t = mins(one[2], one[3]); const w = one[1]; hour = w === 'после' ? { from: t, to: 23 * 60 + 59 } : w === 'до' ? { from: 0, to: t } : { from: Math.max(0, t - 60), to: t + 90 }; }
  for (const k of ['team']) { if (activity.includes(k) && ['football', 'volleyball', 'basketball', 'badminton', 'pingpong'].some(x => activity.includes(x))) activity.splice(activity.indexOf(k), 1); } // назван конкретный вид — общий «игры с мячом» не нужен
  if (activity.includes('sport') && SPORT_ACTS.some(x => activity.includes(x))) activity.splice(activity.indexOf('sport'), 1); // «спорт» + «волейбол» = волейбол
  if (activity.includes('water') && ['sup', 'wake', 'swim'].some(x => activity.includes(x))) activity.splice(activity.indexOf('water'), 1); // «сапы» — это сапы, а не любой водный спорт
  if (activity.includes('sport') && !vibe.includes('active')) vibe.push('active');
  if (audience.includes('family') && audience.includes('kids') && !hasAny(text, AUDIENCE.kids)) audience.splice(audience.indexOf('kids'), 1);
  if (activity.includes('dating')) { const i = audience.indexOf('couple'); if (i >= 0) audience.splice(i, 1); if (!audience.includes('solo')) audience.push('solo'); } // «познакомиться с девушкой» — это знакомства, а не поход вдвоём
  // Остаток — обычные слова для текстового поиска (без служебных)
  const stop = new Set(['хочу', 'хочется', 'хотим', 'хотелось', 'хотел', 'хотела', 'куда', 'сходить', 'сходим', 'пойти', 'пойдем', 'пойдём', 'где', 'то', 'что', 'нибудь', 'можно', 'бы', 'мне', 'нам', 'мы', 'я', 'с', 'в', 'на', 'и', 'или', 'как', 'для', 'это', 'чтобы', 'сегодня', 'завтра', 'послезавтра', 'вечером', 'утром', 'днем', 'днём', 'казань', 'казани', 'казане', 'город', 'городе', 'центр', 'центре', 'окраине', 'окраина', 'район', 'районе', 'недалеко', 'рядом', 'поблизости', 'давай', 'давайте', 'ищу', 'ищем', 'посоветуй', 'посоветуйте', 'подскажи', 'подскажите', 'какой', 'какие', 'какое', 'есть', 'ли', 'же', 'еще', 'ещё', 'чем', 'заняться', 'сделать', 'провести', 'время', 'мероприяти', 'событи']);
  const rest = tokenize(text).filter(w => !stop.has(w) && !/^\d{1,2}(:\d{2})?$/.test(w)).map(stem);
  const parsed = { audience, vibe, setting, activity, intensity, price, times, weekdays, noise, hour, when, districts, outskirts, rest, restHard: rest, source: 'rules' };
  return { ...parsed, human: humanize(parsed) };
}

// Человеческие подписи признаков («с детьми», «на улице», «попеть») — для ленты и экрана поиска
export function humanize(p) {
  const { audience = [], vibe = [], setting = [], activity = [], price = null, times = [], weekdays = [] } = p;
  const human = [];
  if (audience.includes('kids')) human.push('с детьми'); if (audience.includes('solo')) human.push('одному'); if (audience.includes('couple')) human.push('вдвоём'); if (audience.includes('friends')) human.push('с друзьями'); if (audience.includes('family')) human.push('с семьёй'); if (audience.includes('tourist')) human.push('гостям города'); if (audience.includes('newcomer')) human.push('новичкам');
  if (setting.includes('outdoor')) human.push('на улице'); if (setting.includes('water')) human.push('у воды'); if (setting.includes('food')) human.push('с едой');
  if (vibe.includes('calm')) human.push('спокойно'); if (vibe.includes('active')) human.push('активно'); if (vibe.includes('party')) human.push('вечеринка'); if (vibe.includes('smart')) human.push('познавательно'); if (vibe.includes('romantic')) human.push('романтично'); if (vibe.includes('creative')) human.push('творчество');
  weekdays.forEach(d => human.push(WEEKDAY_HUMAN[d]));
  if (p.noise === 'loud') human.push('шумно'); if (p.noise === 'quiet') human.push('тихо');
  if (p.when) human.push({ today: 'сегодня', tomorrow: 'завтра', dayafter: 'послезавтра', week: 'на этой неделе', weekend: 'в выходные' }[p.when]);
  if (p.outskirts) human.push('не в центре'); else if (p.districts?.length) human.push(...p.districts.map(k => { const d = DISTRICTS.find(x => x.key === k); return d?.center ? 'в центре' : (d?.label || k); }));
  if (p.hour) { const f = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; human.push(p.hour.from === 0 ? `до ${f(p.hour.to)}` : p.hour.to >= 23 * 60 + 59 ? `после ${f(p.hour.from)}` : `${f(p.hour.from)}–${f(Math.min(p.hour.to, 23 * 60 + 59))}`); }
  if (price === 'free') human.push('бесплатно'); if (times.includes('weekend') && p.when !== 'weekend') human.push('выходные'); if (times.includes('evening')) human.push('вечером'); if (times.includes('morning')) human.push('утром'); if (times.includes('day')) human.push('днём'); if (times.includes('night')) human.push('ночью');
  activity.forEach(a => human.push({ sport: 'спорт (разный)', vr: 'VR', quest: 'квест', park: 'батуты и лазертаг', bowling: 'боулинг и картинг', kidsclub: 'детский центр', circus: 'цирк и планетарий', anticafe: 'антикафе', boat: 'теплоход и сити-тур', walk: 'прогулка', run: 'бег', yoga: 'йога', skate: 'каток', bike: 'велосипед', water: 'на воде', football: 'футбол', volleyball: 'волейбол', basketball: 'баскетбол', badminton: 'бадминтон', pingpong: 'настольный теннис', roller: 'ролики', sup: 'сапы', wake: 'вейк', nordic: 'скандинавская ходьба', swim: 'плавание', dnd: 'D&D', salsa: 'сальса', team: 'игры с мячом', climb: 'скалодром', cinema: 'кино', theatre: 'театр', standup: 'стендап', quiz: 'квиз', board: 'настолки', chess: 'шахматы', concert: 'концерт', jazz: 'джаз', lecture: 'лекция', book: 'книги', workshop: 'мастер-класс', exhibition: 'выставка', tour: 'экскурсия', karaoke: 'попеть', stol: 'ужин с незнакомцами', lang: 'языковой клуб', dating: 'знакомства', it: 'ИТ-встречи', classical: 'классика', market: 'маркет', party: 'вечеринка', climb: 'скалодром', team: 'командный спорт', mafia: 'мафия', networking: 'нетворкинг', newcomers: 'новички' }[a] || a));
  return [...new Set(human)];
}

// Балл совпадения 0..1 между разобранным запросом и тегами события
export function matchScore(parsed, tags, e) {
  if (!tags) return 0;
  let got = 0, want = 0;
  const overlap = (a, b, w) => { if (!a.length) return; want += w; const inter = a.filter(x => (b || []).includes(x)).length; got += w * (inter / a.length); };
  const soft = parsed.soft || {};
  if (parsed.activity.length) { const w = soft.activity ? 1.5 : 3; want += w; if (parsed.activity.some(x => (tags.activity || []).includes(x))) got += w; } // любая из названных активностей
  overlap(parsed.audience, tags.audience, 2.5);
  overlap(parsed.setting, tags.setting, soft.setting ? 1 : 2);
  overlap(parsed.vibe, tags.vibe, soft.vibe ? 1 : 2.5);
  if (parsed.intensity) { want += 1; if (tags.intensity === parsed.intensity) got += 1; else if (parsed.intensity === 'low' && tags.intensity === 'low') got += 1; }
  if (parsed.price === 'free') { want += 1; if (tags.price_band === 'free') got += 1; else if (tags.price_band === 'low') got += 0.5; }
  if (parsed.times.includes('weekend')) { want += 0.5; if (tags.weekend) got += 0.5; }
  if (parsed.times.includes('evening')) { want += 0.5; if (tags.time === 'evening' || tags.time === 'night') got += 0.5; }
  if (parsed.times.includes('morning')) { want += 0.5; if (tags.time === 'morning') got += 0.5; }
  if (parsed.audience.includes('kids') && e && !(e.with || []).includes('kids')) got -= 1; // явно не для детей — штраф
  if (!soft.audience && parsed.audience.includes('solo') && e && e.with && !e.with.includes('solo')) return 0; // только компаниями — одному не подойдёт
  const ts = tags.setting || [], tv = tags.vibe || [];
  if (!soft.setting && parsed.setting.includes('outdoor') && !ts.includes('outdoor') && !ts.includes('water')) return 0; // просили улицу — помещение не предлагаем
  if (!soft.setting && parsed.setting.includes('water') && !ts.includes('water')) return 0;
  if (!soft.vibe && parsed.vibe.includes('calm') && !tv.includes('calm') && (tv.includes('active') || tv.includes('party'))) return 0;
  if (!soft.vibe && parsed.vibe.includes('active') && !tv.includes('active') && tv.includes('calm')) return 0;
  if (parsed.noise && tags.noise && tags.noise !== 'mid' && tags.noise !== parsed.noise) return 0; // просили тихо — шумное не предлагаем, и наоборот
  const openTo = e?.kind === 'open' ? String(e.meta?.open_to || '') : '', openFrom = e?.kind === 'open' ? String(e.meta?.open_from || '') : '';
  if (parsed.times.includes('evening') && !(tags.time === 'evening' || tags.time === 'night' || (openTo && openTo >= '19:00'))) return 0;
  if (parsed.times.includes('morning') && !(tags.time === 'morning' || (openFrom && openFrom <= '11:00'))) return 0;
  if (parsed.times.includes('day') && !(tags.time === 'day' || (openFrom && openFrom <= '14:00' && openTo >= '15:00'))) return 0;
  if (parsed.times.includes('night') && !(tags.time === 'night' || (openTo && openTo >= '23:00'))) return 0;
  if (parsed.activity.length && !soft.activity) {
    const actHit = parsed.activity.some(x => (tags.activity || []).includes(x));
    const setHit = parsed.setting.length && parsed.setting.some(x => (tags.setting || []).includes(x));
    if (!actHit && !setHit) return 0; // ни активность, ни обстановка не совпали — это не то
    if (!actHit && parsed.activity.some(a => STRICT_ACTS.has(a))) return 0; // назван конкретный вид (волейбол, кино) — обстановка его не заменяет
  }
  return want ? Math.max(0, Math.min(1, got / want)) : 0;
}

// ---------- Настоящие модели (OpenAI-совместимый API) ----------
const ENUMS = { audience: Object.keys(AUDIENCE), vibe: Object.keys(VIBE), setting: Object.keys(SETTING), activity: Object.keys(ACTIVITY), times: ['morning', 'day', 'evening', 'night', 'weekend'] };
const SCHEMA_SHORT = `JSON: {"audience":[${ENUMS.audience.join('|')}],"vibe":[${ENUMS.vibe.join('|')}],"setting":[${ENUMS.setting.join('|')}],"activity":[${ENUMS.activity.join('|')}],"intensity":"low|high|null","price":"free|high|null","times":[${ENUMS.times.join('|')}],"weekdays":[0-6, 0=вс, только если день назван],"keywords":["1-3 слова для поиска"]}. Списки могут быть пустыми. Ничего не выдумывай.`;
const SCHEMA_TEXT = `Схема JSON (значения только из списков):
{"audience": подмножество ${JSON.stringify(ENUMS.audience)},
 "vibe": подмножество ${JSON.stringify(ENUMS.vibe)},
 "setting": подмножество ${JSON.stringify(ENUMS.setting)},
 "activity": подмножество ${JSON.stringify(ENUMS.activity)},
 "intensity": "low" | "high" | null,
 "price": "free" | "high" | null,
 "times": подмножество ${JSON.stringify(ENUMS.times)},
 "weekdays": числа 0-6 (0 = воскресенье) — только если назван день недели,
 "keywords": 1-4 слова на русском для текстового поиска (названия, жанры, места), без служебных слов}`;
const only = (arr, allowed) => (Array.isArray(arr) ? arr : []).map(x => String(x)).filter(x => allowed.includes(x));
function sanitize(j) {
  const audience = only(j.audience, ENUMS.audience), vibe = only(j.vibe, ENUMS.vibe), setting = only(j.setting, ENUMS.setting), activity = only(j.activity, ENUMS.activity);
  const intensity = ['low', 'high'].includes(j.intensity) ? j.intensity : null;
  const price = ['free', 'high'].includes(j.price) ? j.price : null;
  const times = only(j.times, ENUMS.times);
  const weekdays = (Array.isArray(j.weekdays) ? j.weekdays : []).map(Number).filter(d => d >= 0 && d <= 6);
  const rest = (Array.isArray(j.keywords) ? j.keywords : []).flatMap(k => tokenize(String(k))).map(stem).slice(0, 6);
  return { audience, vibe, setting, activity, intensity, price, times, weekdays, rest };
}
const hasAnySignal = p => !!(p.audience.length || p.vibe.length || p.setting.length || p.activity.length || p.intensity || p.price || p.times.length || p.weekdays.length);

// Слабая модель: разбор фразы гостя. Кэш по нормализованной фразе; при ошибке/таймауте — правила.
const WAIT_MS = Number(process.env.LLM_WAIT_MS || 2500); // сколько гость ждёт модель; дальше — правила, а модель дорабатывает в фоне
const inflight = new Map();
export const SYSTEM_WEAK = `Разбери запрос гостя (куда сходить в Казани) в признаки для поиска. Отвечай только JSON.\n${SCHEMA_SHORT}\nПравила: родственники, родители, семья → audience family и спокойный vibe calm; «посидеть» → calm и setting food; конкретный вид спорта (волейбол, футбол, теннис) → только он; «заняться спортом» без вида → activity sport; не выдумывай день недели, цену и время, если их нет в запросе.`;
for (const s of SCENARIOS) s._stems = tokenize(normalize(s.q)).map(stem);
function examplesFor(q) {
  const stems = tokenize(normalize(q)).map(stem);
  return nearestScenarios(stems, 4).map(s => `«${s.q}» → ${JSON.stringify(scenarioAnswer(s))}`).join('\n');
}
function askWeak(key, q) {
  if (inflight.has(key)) return inflight.get(key);
  const pr = chatJson({ model: models.weak(), maxTokens: 220,
    system: `${SYSTEM_WEAK}\nПримеры:\n${examplesFor(q)}`,
    user: q.slice(0, 300) }).finally(() => inflight.delete(key));
  inflight.set(key, pr);
  return pr;
}
export async function parseQuerySmart(q) {
  const rules = parseQuery(q);
  if (!llmEnabled() || !rules.rest.length) return rules; // только «сегодня»/«вечером»/«в центре» — модели нечего добавить, иначе она додумывает «D&D»
  const key = normalize(q);
  const hit = cached(key); if (hit) return hit;
  // Гонка: модель против таймера ожидания. Проиграла — отвечаем правилами, но результат модели всё равно дождёмся и закэшируем.
  const full = mergeLater(key, q, rules);
  const winner = await Promise.race([full, new Promise(r => setTimeout(() => r(null), WAIT_MS))]);
  if (winner) return winner;
  return { ...rules, source: 'rules', pending: true };
}
async function mergeLater(key, q, rules) {
  try {
    const p = sanitize(await askWeak(key, q));
    // Политика доверия: маленькие локальные модели (0.5–3B) путают дни недели и додумывают признаки,
    // поэтому по умолчанию правила главнее, а модель заполняет только пустые поля (LLM_TRUST=gaps).
    // Для сильных облачных моделей можно включить LLM_TRUST=lead — тогда модель главнее, правила добирают пропуски.
    const lead = process.env.LLM_TRUST === 'lead';
    const first = lead ? p : rules, second = lead ? rules : p;
    const arr = k => first[k].length ? first[k] : second[k];
    const merged = {
      audience: arr('audience'), vibe: arr('vibe'), setting: arr('setting'), activity: arr('activity'),
      intensity: first.intensity || second.intensity, price: rules.price, // цена только из правил: «бесплатно» модели часто мерещится
      times: lead && p.times.length ? p.times : rules.times, weekdays: lead && p.weekdays.length ? p.weekdays : rules.weekdays, // время и день — явные слова, правила надёжнее
      rest: [...new Set([...rules.rest, ...p.rest])].slice(0, 8), restHard: rules.rest, noise: rules.noise, hour: rules.hour, when: rules.when, districts: rules.districts, outskirts: rules.outskirts, // слова модели только ранжируют, слова гостя — фильтруют
      soft: lead ? {} : { activity: !rules.activity.length && p.activity.length > 0, vibe: !rules.vibe.length && p.vibe.length > 0, setting: !rules.setting.length && p.setting.length > 0, intensity: !rules.intensity && !!p.intensity, audience: !rules.audience.length && p.audience.length > 0 }, // догадки модели не отсекают события, а только поднимают подходящие
    };
    const usedModel = ['audience', 'vibe', 'setting', 'activity', 'times'].some(k => !rules[k].length && p[k].length) || (!rules.intensity && p.intensity) || p.rest.some(x => !rules.rest.includes(x));
    // Подпись «ИИ понял»: уверенные признаки как есть, догадки модели — с пометкой «≈», слова модели в подпись не попадают
    const sure = humanize({ ...merged, audience: merged.soft.audience ? [] : merged.audience, vibe: merged.soft.vibe ? [] : merged.vibe, setting: merged.soft.setting ? [] : merged.setting, activity: merged.soft.activity ? [] : merged.activity });
    const human = [...sure, ...humanize(merged).filter(x => !sure.includes(x)).map(x => '≈ ' + x)];
    const out = { ...merged, source: `llm:${models.weak()}${usedModel ? '' : ' (совпало с правилами)'}`, human };
    return remember(key, out);
  } catch (e) { return { ...rules, source: 'rules', error: e.message }; }
}

// Сильная модель: разметка события при создании (один вызов на серию). При ошибке — правила.
export async function tagEventSmart(e) {
  const rules = tagEvent(e);
  if (!llmEnabled()) return rules;
  try {
    const j = await chatJson({ model: models.strong(), timeoutMs: models.timeoutStrong, maxTokens: 400,
      system: `Ты размечаешь событие для поиска по смыслу. Верни только JSON по схеме; поля выбирай из списков, учитывай описание, место, время, цену и для кого событие. Добавь "summary": короткая подпись (до 8 слов), что это за событие и кому подойдёт.\n${SCHEMA_TEXT}`,
      user: `Название: ${e.title}\nРаздел: ${e.catTitle || e.category || ''} / ${e.subTitle || e.sub || ''}\nМесто: ${e.venue || ''}, ${e.district || ''}\nВремя: ${e.start || ''}, ${e.duration || ''} мин\nЦена: ${e.price ?? ''} ₽\nДля кого: ${(e.with || []).join(', ')}\nКлючевые слова: ${(e.keywords || []).join(', ')}\nОписание: ${String(e.description || '').slice(0, 1500)}` });
    const p = sanitize(j);
    if (!hasAnySignal(p)) return rules;
    const audience = [...new Set([...p.audience, ...rules.audience.filter(a => ['solo', 'couple', 'kids'].includes(a) && (e.with || []).length)])];
    return { ...rules, audience, vibe: p.vibe.length ? p.vibe : rules.vibe, setting: p.setting.length ? p.setting : rules.setting, activity: [...new Set([...p.activity, ...rules.activity])],
      intensity: p.intensity || rules.intensity, summary: typeof j.summary === 'string' ? j.summary.slice(0, 120) : rules.summary, model: models.strong() };
  } catch { return rules; }
}
