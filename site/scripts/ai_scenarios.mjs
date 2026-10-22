// Проверка ИИ-поиска по сценариям (server/scenarios.js).
//   node scripts/ai_scenarios.mjs            — правила (быстро, без сервера и модели)
//   node scripts/ai_scenarios.mjs --model    — плюс ответ модели через Ollama (LLM_* из .env)
//   node scripts/ai_scenarios.mjs --api      — плюс проверки выдачи на запущенном сервере (BASE=http://localhost:3000)
//   node scripts/ai_scenarios.mjs --dataset  — выгрузить JSONL для дообучения в data/ai-scenarios.jsonl
import { writeFileSync, mkdirSync } from 'node:fs';
import { SCENARIOS, scenarioAnswer } from '../server/scenarios.js';
import { parseQuery, parseQuerySmart, SYSTEM_WEAK } from '../server/ai.js';
import { llmEnabled } from '../server/llm.js';

const args = new Set(process.argv.slice(2));
const base = process.env.BASE || 'http://localhost:3000';

if (args.has('--dataset')) {
  mkdirSync('data', { recursive: true });
  const lines = SCENARIOS.map(s => JSON.stringify({ messages: [{ role: 'system', content: SYSTEM_WEAK }, { role: 'user', content: s.q }, { role: 'assistant', content: JSON.stringify(scenarioAnswer(s)) }] }));
  writeFileSync('data/ai-scenarios.jsonl', lines.join('\n') + '\n');
  console.log(`JSONL: data/ai-scenarios.jsonl, ${lines.length} примеров (формат messages — подходит для LoRA через unsloth/LLaMA-Factory)`);
  process.exit(0);
}

const sub = (want, got) => (want || []).every(x => (got || []).includes(x));
// Подмножество: массивы — «содержит», объекты — по своим ключам, остальное — равенство
const fits = (want, got) => Array.isArray(want) ? sub(want, got) : want && typeof want === 'object' ? !!got && Object.entries(want).every(([k, v]) => fits(v, got[k])) : got === want;
function diff(expect, p, activityOnly, not) {
  const bad = [];
  for (const [k, v] of Object.entries(expect)) if (!fits(v, p[k])) bad.push(`${k}: ждали ${JSON.stringify(v)}, разобрано ${JSON.stringify(p[k] ?? null)}`);
  for (const [k, v] of Object.entries(not || {})) for (const x of v) if ((p[k] || []).includes(x)) bad.push(`${k}: лишнее ${JSON.stringify(x)}`);
  if (activityOnly && expect.activity && p.activity.some(a => !expect.activity.includes(a))) bad.push(`лишние занятия: ${JSON.stringify(p.activity.filter(a => !expect.activity.includes(a)))}`);
  return bad;
}
async function settled(q) { // дождаться ответа модели (разбор может вернуть правила с pending)
  for (let i = 0; i < 40; i++) { const p = await parseQuerySmart(q); if (!p.pending) return p; await new Promise(r => setTimeout(r, 1500)); }
  return parseQuerySmart(q);
}
async function apiCheck(s) {
  const bad = [];
  let d; try { d = await (await fetch(`${base}/api/events?when=any&q=${encodeURIComponent(s.q)}`)).json(); } catch { return ['сервер недоступен']; }
  const seenS = new Set(); const top = d.events.filter(e => { const k = e.seriesKey || e.id; if (seenS.has(k)) return false; seenS.add(k); return true; }).slice(0, 12); // как в ленте: серия — одна карточка
  if (!d.events.length && !s.check?.allowEmpty) bad.push('пустая выдача');
  if (s.check?.allAct) { const miss = d.events.filter(e => !(e.acts || []).includes(s.check.allAct) && !(e.aiTags?.activity || []).includes(s.check.allAct)); if (miss.length) bad.push(`не ${s.check.allAct}: ${[...new Set(miss.map(e => e.title))].slice(0, 3).join(' | ')}`); }
  if (s.check?.diverse) { const kinds = new Set(top.map(e => (e.acts || [])[0] || e.sub)); if (kinds.size < s.check.diverse) bad.push(`мало разных видов в топе: ${[...kinds].join(',')}`); }
  return bad;
}

let fails = 0;
const useModel = args.has('--model') && llmEnabled();
if (args.has('--model') && !llmEnabled()) console.log('модель не настроена (LLM_BASE_URL), проверяю только правила');
for (const s of SCENARIOS) {
  const rules = parseQuery(s.q);
  const r = diff(s.expect, rules, s.activityOnly, s.not);
  let m = null, a = null;
  if (useModel) { const p = await settled(s.q); m = { bad: diff(s.expect, p, s.activityOnly, s.not), src: p.source, human: p.human }; }
  if (args.has('--api')) a = await apiCheck(s);
  const ok = !r.length && !(a && a.length);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} «${s.q}» → ${JSON.stringify(rules.human)}${s.note ? '  // ' + s.note : ''}`);
  for (const b of r) console.log('      правила: ' + b);
  if (m) { console.log(`      модель [${m.src}]: ${m.bad.length ? m.bad.join('; ') : 'совпало'} → ${JSON.stringify(m.human)}`); }
  if (a) for (const b of a) console.log('      выдача: ' + b);
}
console.log(`\n${SCENARIOS.length - fails}/${SCENARIOS.length} сценариев прошли${useModel ? ' (расхождения модели — справочно: правила главнее)' : ''}`);
process.exit(fails ? 1 : 0);
