#!/bin/sh
# Запускаем Ollama, докачиваем модели из OLLAMA_MODELS_PULL (через пробел) и собираем рабочую модель
# с ограничением потоков: в контейнере Railway видно 96 ядер, но доступна доля одного — 48 потоков llama.cpp
# только мешают друг другу (14 токенов/с на промпте). OLLAMA_THREADS=2 и короткий контекст дают в разы быстрее.
ollama serve &
PID=$!
i=0
until ollama list >/dev/null 2>&1 || [ $i -ge 30 ]; do i=$((i+1)); sleep 1; done
for m in ${OLLAMA_MODELS_PULL:-qwen2.5:0.5b}; do
  if ollama list 2>/dev/null | grep -q "^$m"; then echo "[ollama] модель $m уже есть"; else echo "[ollama] скачиваю $m"; ollama pull "$m" || echo "[ollama] не удалось скачать $m"; fi
done
BASE=$(echo "${OLLAMA_MODELS_PULL:-qwen2.5:0.5b}" | cut -d' ' -f1)
NAME=${OLLAMA_SERVE_MODEL:-qwen-kazan}
cat > /tmp/Modelfile <<EOF
FROM $BASE
PARAMETER num_thread ${OLLAMA_THREADS:-2}
PARAMETER num_ctx ${OLLAMA_CTX:-1536}
PARAMETER temperature 0
EOF
echo "[ollama] собираю $NAME из $BASE (потоков: ${OLLAMA_THREADS:-2}, контекст: ${OLLAMA_CTX:-1536})"
ollama create "$NAME" -f /tmp/Modelfile || echo "[ollama] не удалось собрать $NAME"
echo "[ollama] готово, модели:"; ollama list
wait $PID
