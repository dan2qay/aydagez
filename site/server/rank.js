// Ранжирование выдачи: релевантность текста, реклама, купленные слова, рейтинг, заполненность, полнота карточки.
import { stem, tokenize } from './search.js';

export const REASON_LABEL = { novel: 'Что-то новое для вас', clicked: 'Часто выбирают по этому запросу', interest: 'Ваши интересы', promo: 'Реклама', boost: 'Продвижение по запросу', text: 'Совпадение с запросом', rating: 'Высокий рейтинг', popular: 'Быстро заполняется', complete: 'Полная карточка', ai: 'Подходит по смыслу' };

export function isPromoted(e, now = new Date()) {
  return !!(e.promotedUntil && new Date(e.promotedUntil) > now);
}

// ctx: { now, hits: Map(id -> текстовый балл), tokens: стемы запроса, aiScores: Map(id -> 0..1) }
export function scoreEvent(e, ctx = {}) {
  const now = ctx.now || new Date();
  let score = 0;
  const reasons = [];
  if (ctx.hits && ctx.hits.has(e.id)) { const t = ctx.hits.get(e.id); score += Math.min(40, t * 8); reasons.push('text'); }
  if (isPromoted(e, now)) { score += 60; reasons.push('promo'); }
  if (ctx.tokens?.length && e.boostTerms?.length) {
    const bt = new Set(e.boostTerms.flatMap(t => tokenize(t).map(stem)));
    if (ctx.tokens.some(t => bt.has(t))) { score += 30; reasons.push('boost'); }
  }
  if (ctx.aiScores && ctx.aiScores.has(e.id)) { score += Math.round(ctx.aiScores.get(e.id) * 45); reasons.push('ai'); }
  if (ctx.clicks) { const n = ctx.clicks.get(e.seriesKey || `#${e.id}`); if (n) { score += Math.min(20, Math.round(5 * Math.log2(1 + n))); reasons.push('clicked'); } } // по этому запросу сюда уже кликали
  if (ctx.popularity) { const n = ctx.popularity.get(e.seriesKey || `#${e.id}`); if (n) score += Math.min(10, n); } // записи за 7 дней
  if (ctx.novelty?.has(e.id)) { score += Math.round(ctx.novelty.get(e.id) * 60); reasons.push('novel'); } // «что-нибудь новое»: редкое и невиданное — выше
  if (ctx.interests?.length && ctx.interests.includes(e.category)) { score += 8; reasons.push('interest'); }
  if (e.orgPromoted) { score += 40; reasons.push('promo'); }
  if (e.orgRating) { score += Math.min(10, e.orgRating * 2); if (e.orgRating >= 4.5 && e.orgReviews >= 3) reasons.push('rating'); }
  const fill = e.capacity ? e.going / e.capacity : 0;
  if (fill >= 0.5 && fill < 1) { score += Math.round(fill * 8); reasons.push('popular'); }
  if (fill >= 1) score -= 15; // мест нет — ниже
  let complete = 0;
  if (e.cover) complete += 3;
  if ((e.description || '').length >= 200) complete += 3;
  if (e.keywords?.length >= 3) complete += 2;
  if (e.photos?.length) complete += 1;
  if (e.videoUrl) complete += 1;
  score += complete; if (complete >= 8) reasons.push('complete');
  return { score, reasons };
}

// Разнообразие: внутри дня чередуем виды занятий (для «хочу позаниматься спортом» — бег, волейбол, йога, а не пять пробежек подряд)
export function diversifyByDay(list, keyOf) {
  const out = [];
  let i = 0;
  while (i < list.length) {
    const date = list[i].date; const day = [];
    while (i < list.length && list[i].date === date) day.push(list[i++]);
    const buckets = new Map();
    for (const e of day) { const k = keyOf(e); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(e); }
    const qs = [...buckets.values()];
    while (qs.some(q => q.length)) for (const q of qs) if (q.length) out.push(q.shift());
  }
  return out;
}

// Сортировка внутри дня: реклама и релевантные выше, далее по баллу, затем по времени
export function rankList(list, ctx) {
  return list.map(e => { const { score, reasons } = scoreEvent(e, ctx); return { ...e, rank: score, reasons }; })
    .sort((a, b) => a.date.localeCompare(b.date) || b.rank - a.rank || a.start.localeCompare(b.start));
}
