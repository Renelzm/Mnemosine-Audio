# Troubleshooting: microservicio yt-dlp en Coolify (Oracle Cloud)

**Servicio:** `http://ykqdg5azuafvmhq0ehbeembr.40.233.14.61.sslip.io/download`
**Fecha:** 19 de agosto de 2026

## Contexto

Microservicio propio desplegado en Coolify (Oracle Cloud ARM64) que recibe `POST /download` con `{ "url": "..." }` y hace spawn de `yt-dlp` para descargar el audio/video de YouTube.

## Problemas encontrados y resueltos

### 1. `500 - "No se pudo iniciar yt-dlp. Verifica que esté instalado."`
- **Causa:** el binario `yt-dlp` no estaba instalado en la imagen del contenedor.
- **Diagnóstico:** revisar el Build Pack de la app en Coolify (Configuration → Build Pack: Dockerfile / Nixpacks / Docker Compose) y confirmar con:
  ```bash
  which yt-dlp
  which python3
  cat /etc/os-release
  ```
- **Fix (Dockerfile):**
  ```dockerfile
  # Debian/Ubuntu
  RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg && \
      pip3 install --break-system-packages -U yt-dlp
  ```

### 2. `500 - "yt-dlp terminó con código 1"`
- **Diagnóstico:** correr en modo verbose dentro del Terminal del contenedor:
  ```bash
  yt-dlp -v "https://www.youtube.com/watch?v=PFZh58z32m0"
  ```
- **Causa real (confirmada por log):**
  ```
  ERROR: [youtube] ...: Sign in to confirm you're not a bot.
  ```
  YouTube bloquea por IP de datacenter (Oracle Cloud). Requiere cookies de sesión autenticada.

- **Warning secundario (no bloqueante todavía):**
  ```
  WARNING: [youtube] No supported JavaScript runtime could be found...
  ```
  YouTube requiere ejecutar JS para ciertos formatos. Pendiente instalar `deno`:
  ```dockerfile
  RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y \
      && ln -s /root/.deno/bin/deno /usr/local/bin/deno
  ```

## Solución en curso: cookies persistentes vía Coolify File Mount

1. Exportar cookies de YouTube logueado en el navegador con la extensión **"Get cookies.txt LOCALLY"** (formato Netscape).
2. En Coolify → app → **Persistent Storage** → **Add mount** → **File mount** (no "Host file mount": ese requiere SSH previo al servidor; File mount deja pegar el contenido directo en la UI).
3. Configurar:
   - **Destination Path:** `/data/cookies/cookies.txt` *(⚠️ incluir el nombre del archivo, no solo la carpeta)*
   - **Content:** pegar el `cookies.txt` completo exportado.
4. Click **Add file** → **Redeploy** la app.
5. Verificar dentro del contenedor:
   ```bash
   cat /data/cookies/cookies.txt
   ```
6. Probar:
   ```bash
   yt-dlp -v --cookies /data/cookies/cookies.txt "https://www.youtube.com/watch?v=PFZh58z32m0"
   ```

## ✅ Resuelto (2026-08-19): código actualizado para usar las cookies

El spawn de `yt-dlp` en `src/controllers/audio.controller.js` **no incluía `--cookies` en ningún lado** — por eso "no lo encontró": el archivo se podía montar perfecto en Coolify, pero el proceso nunca le decía a yt-dlp que lo usara.

Cambios hechos:

- `src/config/index.js` — nuevo `cookiesPath`, tomado de `process.env.COOKIES_PATH` con default `/data/cookies/cookies.txt` (coincide con el Destination Path del File Mount, así que **en producción no hace falta configurar ninguna env var nueva**, solo redeploy).
- `src/controllers/audio.controller.js` — antes de hacer `spawn`, valida con `fs.existsSync(cookiesPath)` y solo agrega `--cookies <ruta>` si el archivo existe. Si no existe, sigue funcionando sin cookies (con un log de aviso) en vez de romperse.
- `.gitignore` / `.dockerignore` — se agregó `cookies.txt`, `*cookies*.txt`, `/cookies/` y `.env*` a ambos. El `cookies.txt` real **nunca debe** llegar a un commit de git ni copiarse dentro de la imagen Docker (son credenciales de sesión; si quedan en una capa de la imagen, cualquiera con acceso a esa imagen las puede extraer). Por eso siguen inyectándose solo en runtime vía el File Mount de Coolify — el Dockerfile no necesita tocarse para esto.

### Probado en local

Con `yt-dlp` y `node` instalados en Windows, corriendo `COOKIES_PATH=./www.youtube.com_cookies.txt node server.js` y pegándole a `POST /download`:
- Con cookies presentes: log muestra `[yt-dlp] Usando cookies de sesión: ...` y se agrega el flag `--cookies`. Descarga OK (200, ~252 KB).
- Sin cookies (env var sin definir): log muestra `[yt-dlp] Sin cookies (...)` y sigue funcionando igual para este video de prueba.

**Importante:** el video de prueba usado localmente (`jNQXAC9IVRw`, público, sin restricciones) **no dispara el bloqueo "Sign in to confirm you're not a bot"** ni desde IP residencial con cookies ni sin ellas. Ese bloqueo se activa específicamente por la IP de datacenter de Oracle Cloud, así que este test local confirma que **el código ahora sí usa el archivo de cookies cuando existe**, pero no puede confirmar al 100% que el bloqueo de YouTube se resuelve en producción — eso solo se valida ya redeployado en Coolify, probando con el mismo video que fallaba antes (`PFZh58z32m0`).

También yt-dlp mostró este warning con las cookies actuales (exportadas hoy mismo):
```
WARNING: [youtube] The provided YouTube account cookies are no longer valid. They have likely been rotated...
```
A pesar del warning, la descarga funcionó — es un falso positivo conocido de yt-dlp en algunos casos. Si en producción el bloqueo de bot persiste después del redeploy, lo primero a probar es re-exportar cookies frescas justo antes (cerrar sesión/volver a entrar en el navegador rota las cookies viejas).

## ✅ Confirmado (2026-08-20): yt-dlp actualizado resuelve el bloqueo, + 2 bugs más encontrados y corregidos

El usuario actualizó yt-dlp en su PC (`yt-dlp -U` → `stable@2026.08.19`) y el video que antes fallaba (`PFZh58z32m0`) descargó sin problema, sin siquiera el warning de cookies rotadas. Se replicó la prueba completa:

1. **yt-dlp local actualizado** a `2026.08.19` y probado directo (`yt-dlp --cookies ... PFZh58z32m0`): descarga OK, sin bloqueo de bot.
2. **Endpoint completo en local (Node nativo)** con esa misma URL: HTTP 200, 32.7 MB, mp3 válido (`ffprobe` confirma `mp3float`).
3. **Build de la imagen Docker real** (`docker build`) y contenedor corriendo (`docker run`) con el cookies.txt montado igual que Coolify: mismo resultado, HTTP 200.

### Bug encontrado en el Dockerfile: yt-dlp podía quedar desactualizado por caché de Docker

El Dockerfile instalaba yt-dlp con `pip3 install yt-dlp` (sin `-U`) **antes** de `COPY . .`. Esa capa se cachea en Docker — un `git push` + redeploy no la invalida necesariamente, así que el contenedor podía seguir corriendo una versión de yt-dlp vieja aunque el código de la app estuviera al día (justo el tipo de problema que se acaba de resolver actualizando yt-dlp).

**Fix:** se movió la instalación de yt-dlp a **después** de `COPY . .`, con `-U` agregado:
```dockerfile
COPY . .
RUN pip3 install --break-system-packages -U yt-dlp && yt-dlp --version
```
Como `COPY . .` cambia en cada redeploy (cualquier commit nuevo), esta capa ya no se queda cacheada — cada redeploy va a jalar la versión más reciente de yt-dlp automáticamente.

### Bug encontrado probando con Docker real: yt-dlp truena si el cookies.txt es de solo lectura

Al probar con el contenedor Docker real (no solo Node nativo en Windows) con el cookies.txt montado como `:ro`, la descarga completaba el 100% pero el proceso `yt-dlp` terminaba con código 1:
```
OSError: [Errno 30] Read-only file system: '/data/cookies/cookies.txt'
```
Causa: yt-dlp intenta **reescribir** el cookies.txt al cerrar (para persistir cookies que YouTube rota). Nuestro código interpretaba ese código de salida 1 como fallo total y descartaba el audio ya descargado con éxito — un 500 falso sobre una descarga que en realidad sí funcionó. No se sabe con certeza si el File Mount de Coolify es de solo lectura o no, así que había que blindar el código contra ambos casos.

**Fix (`src/controllers/audio.controller.js`):** antes de llamar a `spawn`, se copia el `cookies.txt` montado a un archivo temporal escribible en `os.tmpdir()` (uno nuevo por request) y se le pasa esa copia a `yt-dlp --cookies`, nunca la ruta montada original. Así yt-dlp puede "reescribir" su copia sin tocar el archivo fuente de Coolify, sin importar si el mount es de lectura/escritura. El temporal se borra al terminar la descarga (éxito, error, o desconexión del cliente).

**Verificado con Docker real:** mismo test (`PFZh58z32m0`) con mount `:ro` → antes: HTTP 500 (`yt-dlp terminó con código 1`) a pesar de tener el audio completo; después del fix: HTTP 200, 32.7 MB, mp3 válido, y sin quedar temporales huérfanos en `/tmp` del contenedor.

### Listo para redeploy

Con estos 3 fixes (cookies wireadas, mp3 real via ffmpeg, yt-dlp siempre actualizado + a prueba de mount read-only), todo quedó verificado con Docker real corriendo localmente. Pendiente: commitear y redeploy en Coolify, y repetir la prueba con `PFZh58z32m0` ya en producción para confirmar que la IP de datacenter de Oracle tampoco dispara el bloqueo.

### Pasos para el redeploy a producción

1. Commitear estos cambios de código (**nunca** el `www.youtube.com_cookies.txt`, ya está en `.gitignore`).
2. Confirmar en Coolify que el File Mount sigue en `/data/cookies/cookies.txt` con un cookies.txt fresco (re-exportar si tiene más de unos días).
3. Redeploy.
4. Probar en el Terminal del contenedor: `cat /data/cookies/cookies.txt` (confirmar que el mount sigue ahí) y luego pegarle al endpoint real con el video que antes fallaba (`PFZh58z32m0`).
5. Revisar logs de la app: debe aparecer `[yt-dlp] Usando cookies de sesión: /data/cookies/cookies.txt`.

## ⚠️ Hallazgo nuevo (no relacionado a cookies): el audio no se convierte a MP3 real

Probando localmente se detectó que el archivo devuelto por `/download` **no es MP3** aunque el `Content-Type` diga `audio/mpeg` y el nombre sea `audio.mp3`:

```
ffprobe → Input #0, matroska,webm ... Stream #0:0: Audio: opus, 48000 Hz
```

Causa probable: al usar `-o -` (salida a stdout), yt-dlp emite un warning (`--paths is ignored when an outputting to stdout`) y el postprocesador de ffmpeg (`-x --audio-format mp3`) no llega a aplicarse sobre un stream de stdout — así que lo que se manda es el audio original (Opus/WebM), no un MP3 real. Puede fallar en reproductores/apps que exigen MP3 estricto.

No se tocó porque es un problema aparte del pedido original (cookies + deploy). Si se quiere corregir, la solución típica es separar el pipeline: `yt-dlp -f bestaudio -o -` con su stdout conectado a un proceso `ffmpeg` (spawn separado) que sí convierte a mp3 y escribe a la respuesta — sin pasar por disco en ningún punto.

## Pendientes / notas

- **Riesgo de ToS:** usar cookies de una cuenta personal para scraping automatizado viola los Términos de Servicio de YouTube. Considerar cuenta secundaria dedicada solo para esto, y limitar frecuencia de requests para evitar suspensión.
- Las cookies expiran — habrá que refrescarlas periódicamente (re-exportar y actualizar el File mount).
- Alternativas a futuro si las cookies se vuelven inestables: proxy residencial, o plugin `yt-dlp-get-pot` para PO tokens.
- Falta confirmar si el warning de JS runtime (`deno`) afecta la calidad/disponibilidad de formatos una vez resuelto el bloqueo de login.
- Pendiente decidir si se corrige el bug de conversión a MP3 (ver hallazgo arriba).
