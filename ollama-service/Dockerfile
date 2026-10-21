# Ollama с Qwen как отдельный сервис Railway (приватная сеть: http://ollama.railway.internal:11434/v1).
# На бесплатном плане контейнеру достаётся ~1 ГБ памяти и доля одного ядра: поэтому qwen2.5:0.5b,
# а рабочая модель qwen-kazan собирается в start.sh с ограничением потоков (num_thread) и контекста.
FROM ollama/ollama:latest
ENV OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_KEEP_ALIVE=24h \
    OLLAMA_NUM_PARALLEL=1 \
    OLLAMA_MAX_LOADED_MODELS=1 \
    OLLAMA_MODELS_PULL="qwen2.5:0.5b" \
    OLLAMA_SERVE_MODEL=qwen-kazan \
    OLLAMA_THREADS=2 \
    OLLAMA_CTX=1536
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 11434
ENTRYPOINT ["/start.sh"]
