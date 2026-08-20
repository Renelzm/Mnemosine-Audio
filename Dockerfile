# Provider de PO tokens, ya compilado y con sus node_modules (incluido el binario nativo de
# canvas) para la arquitectura del host — Oracle Cloud es arm64 y esta imagen publica arm64.
# Se copia en vez de compilarse: construir canvas desde fuente en arm64 exige cairo/pango dev
# y toolchain de C++. Funciona bajo Node 20 aunque la imagen origen traiga Node 25 porque
# canvas 3.x es N-API (napi_versions: [7]), cuyo ABI es estable entre versiones de Node.
FROM brainicism/bgutil-ytdlp-pot-provider:1.3.1-node AS pot

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    unzip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp necesita un JS runtime para resolver los retos de YouTube. "node" NO sirve como
# JS challenge provider (queda "unavailable" aunque el binario exista); el que sí funciona
# es deno. Sin esto, YouTube fuerza el bloqueo "Sign in to confirm you're not a bot" incluso
# con cookies válidas.
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y \
  && ln -s /root/.deno/bin/deno /usr/local/bin/deno \
  && deno --version

COPY --from=pot /app /opt/pot-provider

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# yt-dlp se instala DESPUES de copiar el código (capa que cambia en cada redeploy) para que
# siempre jale la versión más reciente en vez de reusar una versión vieja cacheada por Docker.
# YouTube cambia sus bloqueos anti-bot seguido y una versión desactualizada puede volver a fallar.
# yt-dlp-ejs trae el script que resuelve los retos JS de YouTube con deno; el ejecutable
# oficial (win_exe, el que usa el usuario en su PC) lo trae empaquetado, pero pip no.
# bgutil-ytdlp-pot-provider es el plugin que le pide los PO tokens al provider de arriba; su
# version se fija a la MISMA del server copiado (1.3.1) porque el protocolo entre ambos no
# esta versionado y una mezcla de versiones falla en silencio.
RUN pip3 install --break-system-packages -U yt-dlp yt-dlp-ejs \
  && pip3 install --break-system-packages "bgutil-ytdlp-pot-provider==1.3.1" \
  && yt-dlp --version

ENV PORT=8080
ENV POT_PORT=4416

EXPOSE 8080

# Healthcheck: que Coolify sepa si el contenedor de verdad responde, no solo si arrancó.
# El puerto se lee de $PORT en runtime, NO se hardcodea: Coolify inyecta su propia PORT segun el
# ajuste "Ports Exposes" de la app y pisa el ENV de arriba. Hardcodear 8080 hizo que el healthcheck
# golpeara un puerto donde nadie escuchaba y Coolify abortara el deploy con la app perfectamente sana.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/health" || exit 1

# El entrypoint levanta el provider de PO tokens antes de la app (ver docker-entrypoint.sh).
ENTRYPOINT ["docker-entrypoint.sh"]

CMD ["node", "server.js"]
