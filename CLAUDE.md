# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es esto

Microservicio Express de un solo endpoint: recibe `POST /download { "url": "..." }` de YouTube/Facebook y responde con un MP3, **sin tocar disco** para el audio. No hay build step, ni tests, ni linter.

El código y los logs están en español — mantén ese idioma en comentarios y mensajes.

## Comandos

```bash
npm start                                              # node server.js (puerto 3000 en local, 8080 en Docker)
npm run dev                                            # nodemon

# Local con cookies (yt-dlp, ffmpeg y deno deben estar en el PATH del host)
COOKIES_PATH=./www.youtube.com_cookies.txt node server.js

# Docker: replica producción, incluido el mount read-only de cookies
docker build -t audio-downloader .
docker run -p 8080:8080 -v "$(pwd)/cookies.txt:/data/cookies/cookies.txt:ro" audio-downloader

# Probar. -D - muestra los headers X-Cookies-Stale / X-Duration-Ms
curl -s -D - -X POST localhost:8080/download -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=PFZh58z32m0"}' -o out.mp3
ffprobe out.mp3                                        # debe decir mp3float, NO matroska/webm/opus
curl -s localhost:8080/diag                            # versiones reales del contenedor vivo

# Mandando cookies en el request (como lo hace n8n)
node -e "const fs=require('fs');fs.writeFileSync('p.json',JSON.stringify({url:'https://www.youtube.com/watch?v=PFZh58z32m0',cookiesB64:fs.readFileSync('cookies.txt').toString('base64')}))"
curl -s -X POST localhost:8080/download -H 'Content-Type: application/json' -d @p.json -o out.mp3
```

Env vars: `PORT`, `COOKIES_PATH`, `REMOTE_COMPONENTS`, `PLAYER_CLIENTS`, `JS_RUNTIME`, `POT_PORT`, `POT_BASE_URL` (vacía = desactiva PO tokens), `API_TOKEN` (si se define, `/download` exige el header `X-Api-Token`). Todas tienen default en `src/config/index.js`; ninguna es obligatoria.

`PFZh58z32m0` es el video de regresión: es el que dispara los bloqueos anti-bot de YouTube. Un video "fácil" como `jNQXAC9IVRw` pasa incluso con la configuración rota, así que no sirve para validar cambios en yt-dlp/cookies/deno.

## Arquitectura

`server.js` (listen + señales + handlers de proceso) → `app.js` (Express) → `src/routes/audio.routes.js` → `src/controllers/audio.controller.js`. Toda la lógica real vive en el controller; `src/config/index.js` tiene el puerto, `cookiesPath` y el allowlist de dominios.

### El pipeline de `/download`

`spawn('yt-dlp', ['-f','bestaudio', ..., '-o','-'])` → `.stdout` piped a `spawn('ffmpeg', [...'-acodec','libmp3lame'...,'pipe:1'])` → chunks acumulados en un array → `Buffer.concat` → `res.end(buffer)`.

Decisiones que parecen raras pero son deliberadas — no las "simplifiques":

- **Dos procesos, no el postprocesador de yt-dlp.** Con `-o -` (stdout), los flags `-x --audio-format mp3` de yt-dlp **no se aplican**: lo que sale es el audio original (Opus/WebM) con nombre `.mp3`. La conversión real la hace el `ffmpeg` encadenado.
- **Se bufferea todo en memoria antes de responder**, en vez de pipear `ffmpeg.stdout` a `res`. Así los códigos de salida de ambos procesos se evalúan *antes* de mandar headers y un fallo devuelve un JSON 500 limpio en lugar de un stream truncado con status 200. Costo: RAM ≈ tamaño del MP3 (~33 MB para un video de ~1h) por request concurrente.
- **Copia temporal de las cookies por request.** yt-dlp reescribe el `cookies.txt` al cerrar (para persistir cookies rotadas). Si el archivo montado es read-only truena con `OSError: [Errno 30]` y sale con código 1 *después* de haber descargado el audio completo — un 500 falso. Por eso se copia a `os.tmpdir()` y se le pasa esa copia; el temporal se borra en éxito, error y desconexión del cliente.
- **`res.on('close')` mata ambos procesos** si el cliente se desconecta.

### Dependencias del sistema (lo que más ha fallado)

yt-dlp necesita varias cosas para que YouTube no responda "Sign in to confirm you're not a bot", y se han roto por separado en producción:

1. **`deno` como JS runtime.** `--js-runtimes node:...` **no funciona** — node no es un JS challenge provider válido en yt-dlp (aparece como "unavailable" aunque el binario exista). El controller pasa `--js-runtimes deno:/usr/local/bin/deno`; el Dockerfile instala deno y hace el symlink.
2. **El solver EJS.** Sin él, deno corre pero no hay script que resuelva el reto JS: yt-dlp deja solo miniaturas y falla con `Requested format is not available`. El ejecutable oficial de Windows lo trae empaquetado, `pip install yt-dlp` no. Se cubre por dos lados: el paquete pip `yt-dlp-ejs` (local) y `--remote-components ejs:github` (fallback en runtime). En producción el pip solo no bastó — el log mostraba `Remote components ... were skipped`.
3. **Evitar el reto JS de entrada.** El cliente `visionos` no requiere reto JS ni PO tokens; es lo que hace que yt-dlp funcione en local sin deno instalado. Se fija con `PLAYER_CLIENTS=default,visionos`, pero **hoy va vacío por defecto** para no anular los PO tokens (ver abajo).
4. **PO tokens o cookies frescas.** El bloqueo se dispara por IP de datacenter, y **no se reproduce desde una IP residencial**: en local, cookies muertas listan formatos sin problema; desde Oracle las mismas cookies dan bot check. Probado el 2026-08-20 con el flag `noCookies`: la IP bloquea **con cookies muertas y sin cookies igual**, así que no hay configuración de yt-dlp que lo esquive sin credenciales.

En el Dockerfile, `pip3 install -U yt-dlp yt-dlp-ejs` va **después** de `COPY . .` a propósito: así la capa se invalida en cada commit y cada redeploy jala la versión más reciente. Si se mueve antes, Docker la cachea y el contenedor puede quedarse con un yt-dlp viejo que YouTube ya bloquea.

## PO tokens (bgutil)

Los PO tokens hacen que el tráfico parezca legítimo sin cookies de una cuenta real — la única salida que no depende de re-exportar credenciales ni arriesga suspensión de la cuenta por ToS. **No garantizan** evitar el bot check; el propio proyecto lo advierte.

Son dos mitades y `/diag` las reporta por separado en `poTokens`, porque si el plugin está y el server no, yt-dlp cae de vuelta a cookies **sin que el 200 lo delate**:

- **Server**: se copia ya compilado desde la imagen oficial `brainicism/bgutil-ytdlp-pot-provider:1.3.1-node` en un stage del Dockerfile. Se copia en vez de compilarse porque `canvas` en arm64 exigiría cairo/pango dev y toolchain de C++. Corre bajo Node 20 aunque esa imagen traiga Node 25 porque `canvas` 3.x es **N-API** (`napi_versions: [7]`), cuyo ABI es estable entre versiones de Node.
- **Plugin**: pip `bgutil-ytdlp-pot-provider`, **pineado a la misma versión del server** (1.3.1). El protocolo entre ambos no está versionado y una mezcla de versiones falla en silencio.

`docker-entrypoint.sh` levanta el server en loopback (`POT_PORT`, default 4416) y luego hace `exec` de la app. Va en el **mismo contenedor** a propósito: un sidecar obligaría a migrar el build pack de Coolify a Docker Compose, que re-deriva dominio, puertos y File Mounts de un servicio que ya funciona. Si el server no arranca, la app sigue sirviendo y cae a cookies.

`PLAYER_CLIENTS` está **vacío por defecto** desde que existe el provider: los clientes por defecto de yt-dlp son los que consumen PO tokens. Pinear `visionos` (no requiere reto JS ni PO tokens) es el plan B si el provider falla.


## Contrato de la API

`POST /download` → `200` con el MP3 en el body, o un JSON de error. Los errores **siempre** traen `code` estable para que el cliente (n8n) ramifique sin parsear texto:

```jsonc
{ "url": "https://...",          // requerido
  "cookiesB64": "IyBOZXRz...",   // opcional, recomendado: cookies.txt en base64
  "cookies": "# Netscape...",    // opcional, alternativa en texto plano
  "noCookies": true,             // diagnóstico: ignora TODAS las fuentes de cookies
  "playerClients": "default" }   // diagnóstico: pisa PLAYER_CLIENTS en este request
```

Los dos últimos son para diagnóstico: cada redeploy es ciego y tarda minutos, así que comparar configuraciones contra la misma imagen desde el cliente ahorra ciclos completos.

```jsonc
{ "ok": false, "code": "BOT_CHECK", "error": "...", "hint": "...",
  "retryable": true, "cookiesStale": true, "refreshCookies": true,
  "cookiesSource": "request:cookiesB64", "detail": "<stderr real de yt-dlp>" }
```

Códigos y su status: `MISSING_URL`/`DOMAIN_NOT_ALLOWED`/`COOKIES_MALFORMED`/`UNSUPPORTED_URL` (400), `UNAUTHORIZED`/`BOT_CHECK` (401), `VIDEO_RESTRICTED` (403), `VIDEO_UNAVAILABLE` (404), `NOT_YET_AVAILABLE` (409), `RATE_LIMITED` (429), `YTDLP_NOT_INSTALLED`/`FFMPEG_NOT_INSTALLED` (500), `JS_CHALLENGE_FAILED`/`NETWORK_ERROR`/`TRANSCODE_FAILED`/`EMPTY_OUTPUT`/`YTDLP_FAILED` (502). Las reglas de clasificación viven en `src/lib/ytdlp-errors.js` y se prueban contra el stderr literal de yt-dlp — el apóstrofe de "Sign in to confirm you’re not a bot" es U+2019, no ASCII.

En éxito, los headers `X-Cookies-Source`, `X-Cookies-Stale` y `X-Duration-Ms` permiten detectar cookies rotadas **aunque la descarga haya funcionado** (pasa seguido desde IP residencial). Es la señal para refrescarlas antes de que empiece a fallar.

`GET /diag` reporta las versiones reales de yt-dlp/deno/ffmpeg/yt-dlp-ejs del contenedor vivo, más el estado del cookies.txt montado (edad, si es escribible). Existe porque Coolify reusa imágenes viejas en silencio: es la primera cosa que hay que mirar tras un deploy, en vez de deducirlo provocando un fallo.

## Cookies

Tres fuentes, en orden de prioridad: `body.cookiesB64` → `body.cookies` → header `x-cookies-b64` → archivo en `COOKIES_PATH` (default `/data/cookies/cookies.txt`). Sin ninguna, el endpoint sigue funcionando sin `--cookies` (con log de aviso) pero YouTube probablemente bloquee desde datacenter.

**Preferir base64.** `src/lib/cookies.js` re-tabula el archivo porque el formato Netscape exige TABs y al viajar como texto dentro de un JSON se convierten en espacios; yt-dlp entonces ignora las líneas **en silencio** y el archivo parece válido pero va vacío. El normalizador también fuerza la línea de cabecera y preserva el prefijo `#HttpOnly_` (es dominio, no comentario).

**Las cookies rotan y mueren.** El síntoma `The provided YouTube account cookies are no longer valid` aparece cuando el navegador que las exportó siguió activo y las rotó. Para que duren: ventana privada → login → dejar una sola pestaña → ir a `youtube.com/robots.txt` → exportar → **cerrar la ventana sin hacer logout**. Usar el mismo archivo desde dos IPs a la vez (tu PC y el server) también las mata más rápido.

**Nunca commitear ni copiar a la imagen ningún `*cookies*.txt`** — son credenciales de sesión y quedarían extraíbles de la capa de Docker. Ya están cubiertas por `.gitignore` y `.dockerignore`; se inyectan solo en runtime. Hay un `www.youtube.com_cookies (1).txt` sin trackear en el repo para pruebas locales: no lo agregues a git.

Las cookies expiran/rotan. Si vuelve el bloqueo de bot, lo primero es re-exportarlas frescas.

## Despliegue

Dos caminos coexisten en el repo:

- **Coolify (Oracle Cloud ARM64)** — el que está en uso. Las cookies se inyectan como *File mount* (no "Host file mount") con Destination Path `/data/cookies/cookies.txt` (incluyendo el nombre del archivo). **Cuando cambia el Dockerfile hay que usar Force Rebuild sin caché**, no un Redeploy normal: Coolify reusa imágenes viejas silenciosamente (`No build configuration changed & image found ... Build step skipped`) y el síntoma es un 500 instantáneo diciendo que yt-dlp no está instalado.
- **GCP Cloud Run** vía `cloudbuild.yaml` (proyecto `clever-overview-326002`, servicio `mnemosine-audios`, `europe-west1`). Ahí no hay File Mount, así que habría que resolver aparte cómo montar las cookies.

## `troubleshooting-ytdlp-coolify.md`

Bitácora cronológica de cada fallo en producción con su diagnóstico y fix — vale leerla antes de tocar el pipeline o el Dockerfile. Ojo: es un log histórico, no un estado actual. La sección final "el audio no se convierte a MP3 real" **ya está resuelta** (es justo lo que hace el `ffmpeg` encadenado de hoy); si arreglas algo, agrega una sección nueva en vez de reescribir las viejas.
