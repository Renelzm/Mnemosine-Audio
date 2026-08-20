FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# yt-dlp se instala DESPUES de copiar el código (capa que cambia en cada redeploy) para que
# siempre jale la versión más reciente en vez de reusar una versión vieja cacheada por Docker.
# YouTube cambia sus bloqueos anti-bot seguido y una versión desactualizada puede volver a fallar.
RUN pip3 install --break-system-packages -U yt-dlp && yt-dlp --version

ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
