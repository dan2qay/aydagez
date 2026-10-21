// Подключение настоящей модели к ИИ-поиску через OpenAI-совместимый API.
// Подходят: DeepSeek (https://api.deepseek.com/v1), Qwen через DashScope (https://dashscope.aliyuncs.com/compatible-mode/v1),
// локальная Ollama (http://localhost:11434/v1, модели qwen2.5:7b, deepseek-r1 и т.п.), vLLM, OpenRouter.
// Настройка через переменные окружения (см. .env.example): LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_STRONG, LLM_MODEL_WEAK.
// Без настроек всё работает на правилах из ai.js — модель только улучшает разбор, падение модели не ломает поиск.

const BASE = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.LLM_API_KEY || '';
const STRONG = process.env.LLM_MODEL_STRONG || process.env.LLM_MODEL || '';
const WEAK = process.env.LLM_MODEL_WEAK || STRONG;
const TIMEOUT_WEAK = Number(process.env.LLM_TIMEOUT_MS || 6000);
const TIMEOUT_STRONG = Number(process.env.LLM_TIMEOUT_STRONG_MS || 20000);

const stats = { calls: 0, errors: 0, ms: 0, cacheHits: 0 };
const cache = new Map(); // ключ → результат разбора фразы (до 3000 записей)

export function llmEnabled() { return !!(BASE && WEAK); }
export function llmInfo() {
  if (!llmEnabled()) return { enabled: false, provider: null, strong: null, weak: null, stats };
  let provider = 'openai-compatible';
  try { const h = new URL(BASE).hostname; provider = /deepseek/.test(h) ? 'deepseek' : /aliyuncs|dashscope/.test(h) ? 'qwen (dashscope)' : /localhost|127\.0\.0\.1/.test(h) ? 'local (ollama/vllm)' : /openrouter/.test(h) ? 'openrouter' : h; } catch {}
  return { enabled: true, provider, strong: STRONG || WEAK, weak: WEAK, stats };
}

// Один вызов chat/completions с ответом в JSON. Бросает ошибку при таймауте, не-JSON или кодах ≠ 200.
export async function chatJson({ model, system, user, timeoutMs = TIMEOUT_WEAK, maxTokens = 500, temperature = 0 }) {
  if (!llmEnabled()) throw new Error('llm_disabled');
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now(); stats.calls++;
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify({ model, temperature, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error(`llm_http_${r.status}`);
    const data = await r.json();
    let content = data?.choices?.[0]?.message?.content ?? '';
    if (Array.isArray(content)) content = content.map(c => c.text || '').join('');
    content = String(content).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const m = content.match(/\{[\s\S]*\}/); // на случай текста вокруг JSON
    return JSON.parse(m ? m[0] : content);
  } catch (e) { stats.errors++; throw e; }
  finally { clearTimeout(t); stats.ms += Date.now() - started; }
}

export function cached(key) { const v = cache.get(key); if (v !== undefined) stats.cacheHits++; return v; }
export function remember(key, value) { if (cache.size >= 3000) cache.delete(cache.keys().next().value); cache.set(key, value); return value; }
export const models = { strong: () => STRONG || WEAK, weak: () => WEAK, timeoutStrong: TIMEOUT_STRONG };
