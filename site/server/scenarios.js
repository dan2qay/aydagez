// Сценарии поиска: как гость пишет и что система должна понять.
// Это «обучающая выборка» для ИИ-поиска: правила проверяются по ним (npm run ai:test),
// ближайшие сценарии подставляются модели как примеры (few-shot), а экспорт в JSONL (npm run ai:dataset)
// пригодится для настоящего дообучения (LoRA) Qwen, когда наберётся несколько сотен примеров.
//
// expect — подмножество признаков разбора (см. parseQuery в ai.js): массивы должны содержать перечисленное,
// скаляры — совпадать. activityOnly — названо конкретное занятие, других в разборе быть не должно.
// check — проверки выдачи через API: diverse (минимум разных видов занятий в первых 12), allAct (у каждого события это занятие).

export const SCENARIOS = [
  // --- семья, родственники: спокойно, посидеть, без шума ---
  { q: 'посидеть где-нибудь с родственниками', expect: { audience: ['family'], vibe: ['calm'], setting: ['food'], intensity: 'low' }, keywords: ['кафе'], note: 'родственники → семья, «посидеть» → спокойно и с едой' },
  { q: 'приехали родители, куда сходить всей семьёй', expect: { audience: ['family'] }, keywords: ['экскурсия'], check: { diverse: 3 } },
  { q: 'спокойно провести вечер с мамой', expect: { audience: ['family'], vibe: ['calm'], times: ['evening'] }, keywords: ['концерт'] },
  { q: 'куда сводить бабушку в выходные', expect: { audience: ['family'], when: 'weekend' }, keywords: ['театр'] },
  { q: 'хочу посидеть и поболтать с подругой', expect: { audience: ['friends'], vibe: ['calm'], setting: ['food'] }, keywords: ['кафе'] },

  // --- спорт: конкретный вид — только он, «спорт вообще» — несколько разных ---
  { q: 'хочу позаниматься спортом', expect: { activity: ['sport'], vibe: ['active'] }, activityOnly: true, keywords: ['тренировка'], check: { diverse: 3 }, note: 'общий спорт → разные виды в выдаче' },
  { q: 'размяться после работы', expect: { activity: ['sport'], times: ['evening'] }, keywords: ['тренировка'], check: { diverse: 3 } },
  { q: 'хочу поиграть в волейбол', expect: { activity: ['volleyball'] }, activityOnly: true, keywords: ['волейбол'], check: { allAct: 'volleyball' }, note: 'волейбол ≠ теннис' },
  { q: 'футбол вечером с друзьями', expect: { activity: ['football'], audience: ['friends'], times: ['evening'] }, activityOnly: true, keywords: ['футбол'], check: { allAct: 'football' } },
  { q: 'настольный теннис в выходные', expect: { activity: ['pingpong'], when: 'weekend' }, activityOnly: true, keywords: ['теннис'], check: { allAct: 'pingpong' } },
  { q: 'покататься на сапах', expect: { activity: ['sup'], setting: ['water'] }, keywords: ['сапы'], check: { allAct: 'sup' } },
  { q: 'побегать утром в парке', expect: { activity: ['run'], setting: ['outdoor'], times: ['morning'] }, keywords: ['пробежка'] },
  { q: 'йога для начинающих', expect: { activity: ['yoga'] }, activityOnly: true, keywords: ['йога'] },
  { q: 'игры с мячом с друзьями', expect: { activity: ['team'], audience: ['friends'] }, keywords: ['волейбол', 'футбол'], check: { diverse: 2 } },
  { q: 'покататься на коньках с ребёнком', expect: { activity: ['skate'], audience: ['kids'] }, keywords: ['каток'] },

  // --- компании, вечер, веселье ---
  { q: 'хотим пойти с подружками вечером в пятницу, повеселиться', expect: { audience: ['friends'], vibe: ['party'], times: ['evening'], weekdays: [5] }, keywords: ['вечеринка', 'караоке'] },
  { q: 'хотим с подружками сходить попеть песни в казани', expect: { audience: ['friends'], activity: ['karaoke'] }, keywords: ['караоке'] },
  { q: 'куда сходить с коллегами после работы', expect: { audience: ['friends'], times: ['evening'] }, keywords: ['квиз', 'бар'], check: { diverse: 3 }, note: 'не только ИТ-митапы' },
  { q: 'шумно потусить ночью', expect: { vibe: ['party'], noise: 'loud', times: ['night'] }, keywords: ['вечеринка'] },
  { q: 'квиз с друзьями в баре', expect: { activity: ['quiz'], audience: ['friends'], setting: ['food'] }, keywords: ['квиз'] },

  // --- один, знакомства, новые люди ---
  { q: 'хочу сходить познакомиться с девушкой', expect: { audience: ['solo'], activity: ['dating'] }, keywords: ['знакомства'] },
  { q: 'недавно переехал, хочу найти друзей', expect: { audience: ['newcomer'] }, keywords: ['новички', 'знакомства'] },
  { q: 'ужин с незнакомцами', expect: { activity: ['stol'], setting: ['food'] }, keywords: ['ужин'] },
  { q: 'чем заняться одному в воскресенье', expect: { audience: ['solo'], weekdays: [0] }, keywords: ['выставка', 'лекция'], check: { diverse: 3 } },

  // --- дети, пары, туристы ---
  { q: 'отдохнуть с ребенком', expect: { audience: ['kids'], vibe: ['calm'] }, keywords: ['с детьми'], check: { diverse: 2 }, note: 'два слова плюс предлог — всё равно фраза, раз словари что-то поняли' },
  { q: 'куда сходить с ребёнком 5 лет днём', expect: { audience: ['kids'], times: ['day'] }, keywords: ['дети'], check: { diverse: 2 } },
  { q: 'романтическое свидание вечером', expect: { vibe: ['romantic'], times: ['evening'] }, keywords: ['джаз', 'ужин'] },
  { q: 'мы в казани впервые, что посмотреть', expect: { audience: ['tourist'] }, keywords: ['экскурсия'] },
  { q: 'прогулка по старому городу', expect: { activity: ['walk', 'tour'], setting: ['outdoor'] }, keywords: ['экскурсия'] },

  // --- спокойно, тихо, умно, творчески ---
  { q: 'что-то тихое и спокойное после тяжёлой недели', expect: { vibe: ['calm'], noise: 'quiet' }, keywords: ['йога', 'выставка'] },
  { q: 'послушать умную лекцию', expect: { vibe: ['smart'], activity: ['lecture'] }, keywords: ['лекция'] },
  { q: 'порисовать или слепить что-нибудь своими руками', expect: { vibe: ['creative'], activity: ['workshop'] }, keywords: ['мастер-класс'] },
  { q: 'почитать книги в тишине', expect: { activity: ['book'], noise: 'quiet' }, keywords: ['библиотека'] },

  // --- кино, театр, музыка ---
  { q: 'кино днём', expect: { activity: ['cinema'], times: ['day'] }, activityOnly: true, keywords: ['кино'], check: { allAct: 'cinema' } },
  { q: 'сходить в театр в субботу', expect: { activity: ['theatre'], weekdays: [6] }, keywords: ['спектакль'] },
  { q: 'живая музыка вечером', expect: { activity: ['concert'], times: ['evening'] }, keywords: ['концерт'] },
  { q: 'посмеяться на стендапе', expect: { activity: ['standup'] }, keywords: ['стендап'] },

  // --- деньги, даты, место ---
  { q: 'что-то бесплатное сегодня', expect: { price: 'free', when: 'today' }, keywords: [] },
  { q: 'недорого погулять в выходные', expect: { price: 'free', activity: ['walk'], when: 'weekend' }, keywords: ['прогулка'] },
  { q: 'в центре вечером', expect: { districts: ['Вахитовский'], times: ['evening'] }, keywords: [] },
  { q: 'на свежем воздухе в субботу утром', expect: { setting: ['outdoor'], weekdays: [6], times: ['morning'] }, keywords: ['прогулка', 'пробежка'] },
  { q: 'дождь, хочется куда-то в помещение', expect: { setting: ['indoor'] }, keywords: ['музей', 'кино'], check: { diverse: 3 } },
  { q: 'выучить английский в разговорном клубе', expect: { activity: ['lang'] }, keywords: ['английский'] },

  // --- развлечения: VR, квесты, батуты, цирк, теплоход ---
  { q: 'поиграть в vr с друзьями', expect: { activity: ['vr'], audience: ['friends'] }, activityOnly: true, keywords: ['vr'], check: { allAct: 'vr' } },
  { q: 'сходить на квест компанией', expect: { activity: ['quest'], audience: ['friends'] }, keywords: ['квест'] },
  { q: 'куда сводить ребёнка попрыгать на батутах', expect: { activity: ['park'], audience: ['kids'] }, keywords: ['батуты'] },
  { q: 'в цирк с детьми в выходные', expect: { activity: ['circus'], audience: ['kids'], when: 'weekend' }, activityOnly: true, keywords: ['цирк'] },
  { q: 'покататься на теплоходе по казанке', expect: { activity: ['boat'], setting: ['water'] }, keywords: ['теплоход'] },
  { q: 'боулинг с коллегами вечером', expect: { activity: ['bowling'], audience: ['friends'], times: ['evening'] }, activityOnly: true, keywords: ['боулинг'] },
  { q: 'посидеть в антикафе одному', expect: { activity: ['anticafe'], audience: ['solo'], vibe: ['calm'] }, keywords: ['антикафе'] },
];

// Самые похожие сценарии для подсказки модели: по общим основам слов, всегда с парой опорных примеров
export function nearestScenarios(stems, n = 4) {
  const set = new Set(stems);
  const scored = SCENARIOS.map(s => ({ s, hit: (s._stems || []).filter(x => set.has(x)).length })).filter(x => x.hit > 0).sort((a, b) => b.hit - a.hit);
  const out = scored.slice(0, n).map(x => x.s);
  for (const anchor of [SCENARIOS[0], SCENARIOS[5], SCENARIOS[7]]) if (out.length < n + 2 && !out.includes(anchor)) out.push(anchor);
  return out;
}

// Ответ модели для сценария: та же схема, что просим у модели
export function scenarioAnswer(s) {
  const e = s.expect || {};
  return { audience: e.audience || [], vibe: e.vibe || [], setting: e.setting || [], activity: e.activity || [], intensity: e.intensity || null, price: e.price || null, times: e.times || [], weekdays: e.weekdays || [], keywords: s.keywords || [] };
}
