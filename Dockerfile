FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    python3 \
    --no-install-recommends \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
     -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
