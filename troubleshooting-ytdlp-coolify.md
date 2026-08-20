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

## ⚠️ Primer redeploy a producción (2026-08-20): reveló 2 problemas más

### Coolify puede reusar una imagen vieja sin avisar ("Build step skipped")

El primer redeploy después del commit mostró en el log: `No build configuration changed & image found ... Build step skipped.` — sin ninguna línea de `apt-get`/`pip install`. Probando el endpoint justo después, la respuesta fue instantánea (0.09s) con `"No se pudo iniciar yt-dlp. Verifica que esté instalado."` — el contenedor corriendo no tenía yt-dlp, es decir, Coolify reusó una imagen vieja/incompleta en vez de compilar el Dockerfile nuevo.

**Solución:** forzar **Force Rebuild** (sin caché) en Coolify. Con eso sí compiló de verdad (~70s, con todas las líneas de instalación visibles en el log). **Lección: cuando cambie el Dockerfile, no basta con Redeploy normal — hay que forzar rebuild sin caché para asegurar que Coolify realmente reconstruya.**

### Bug real encontrado ya en producción: `--js-runtimes node` no funciona, hacía falta `deno`

Con la imagen ya reconstruida de verdad, `PFZh58z32m0` seguía fallando (`yt-dlp terminó con código 1`, esta vez en ~1.7s — sí corrió pero falló rápido). El log de runtime mostró la causa:
```
WARNING: [youtube] The provided YouTube account cookies are no longer valid...
WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is enabled by default...
ERROR: [youtube] PFZh58z32m0: Sign in to confirm you're not a bot...
```
El código forzaba `--js-runtimes node:/usr/local/bin/node`, pero **`node` no es un JS challenge provider funcional en yt-dlp** (aparece como "unavailable" aunque el binario exista — confirmado también en yt-dlp local). El único que sirve es `deno`, que nunca se instaló en la imagen Docker (era justo el pendiente anotado desde el inicio de este documento). Sin un JS runtime que resuelva el reto de YouTube, cae en el bloqueo de bot incluso con cookies — y por eso también reaparecía el warning de "cookies no longer valid" (yt-dlp toma un camino degradado sin el JS runtime).

**Fix:**
- `Dockerfile` — se agrega `curl`/`unzip` y se instala deno (`https://deno.land/install.sh`), symlink a `/usr/local/bin/deno`.
- `src/controllers/audio.controller.js` — cambia `--js-runtimes node:/usr/local/bin/node` → `--js-runtimes deno:/usr/local/bin/deno`.

**Verificado:** local (yt-dlp directo con deno) y con Docker real (build + run, mount `:ro`) contra `PFZh58z32m0`: sin warning de cookies inválidas, sin warning de JS runtime, sin bloqueo de bot. HTTP 200, mp3 válido de 32.7 MB.

### Segundo redeploy: cookies frescas resolvieron el bloqueo de bot, pero apareció un 3er problema — faltaba `yt-dlp-ejs`

Con deno ya funcionando (confirmado: ya no salía el warning de JS runtime) y cookies re-exportadas frescas en el File Mount, `PFZh58z32m0` seguía fallando, pero con un error nuevo:
```
[youtube] [jsc:deno] Solving JS challenges using deno
WARNING: [youtube] [jsc] Remote components challenge solver script (deno) and NPM package (deno) were skipped...
WARNING: [youtube] PFZh58z32m0: n challenge solving failed: Some formats may be missing...
WARNING: Only images are available for download. use --list-formats to see them
ERROR: [youtube] PFZh58z32m0: Requested format is not available.
```
Causa: deno como runtime ya corre, pero yt-dlp necesita además el **script que resuelve el reto JS** (paquete `yt-dlp-ejs` en PyPI). El ejecutable oficial de Windows (`win_exe`, el que usa el usuario en su PC) lo trae empaquetado; nuestra instalación vía `pip3 install yt-dlp` no. Sin él, yt-dlp intenta bajarlo al vuelo y lo salta por defecto, dejando solo miniaturas de imagen disponibles (sin audio/video real).

**Fix (`Dockerfile`):**
```dockerfile
RUN pip3 install --break-system-packages -U yt-dlp yt-dlp-ejs && yt-dlp --version
```

**Verificado con Docker real** (`docker build --no-cache` + `docker run`, mount `:ro`, cookies frescas): HTTP 200, 32.7 MB, mp3 válido, sin ningún warning — solo la línea informativa `[jsc:deno] Solving JS challenges using deno`.

### Listo para redeploy

Con todos estos fixes (cookies wireadas, mp3 real vía ffmpeg, yt-dlp siempre actualizado, a prueba de mount read-only, deno instalado, y `yt-dlp-ejs`), todo quedó verificado con Docker real corriendo localmente. Pendiente: commitear y hacer **Force Rebuild sin caché** en Coolify (no un Redeploy normal), y repetir la prueba con `PFZh58z32m0` ya en producción.

### Pasos para el redeploy a producción

1. Commitear estos cambios de código (**nunca** el `www.youtube.com_cookies.txt`, ya está en `.gitignore`).
2. Confirmar en Coolify que el File Mount sigue en `/data/cookies/cookies.txt` con un cookies.txt fresco (re-exportar si tiene más de unos días — YA se hizo el 2026-08-20).
3. **Force Rebuild sin caché** (no un Redeploy normal — el Dockerfile cambió y Coolify puede reusar una imagen vieja si no se fuerza).
4. Probar en el Terminal del contenedor: `cat /data/cookies/cookies.txt` (confirmar que el mount sigue ahí) y luego pegarle al endpoint real con el video que antes fallaba (`PFZh58z32m0`).
5. Revisar logs de la app: debe aparecer `[yt-dlp] Usando cookies de sesión: /data/cookies/cookies.txt` y `[jsc:deno] Solving JS challenges using deno`, sin warnings de "cookies no longer valid" ni "Remote components ... skipped".

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

---

## 2026-08-20 (tarde): rediseño — cookies por request desde n8n + errores con código

**Síntoma reportado desde n8n:** `500 - {"error":"yt-dlp terminó con código 1"}`. Un mensaje que no dice nada: no distingue "refresca las cookies" de "el video no existe" de "falta una dependencia en el contenedor".

### Diagnóstico

Los dos logs de producción eran **dos fallos distintos**, no uno:

- **01:03Z** (= 19:03 local, *antes* del commit que agregó `yt-dlp-ejs`): `Remote components ... were skipped` → `n challenge solving failed` → `Only images are available` → `Requested format is not available`. Faltaba el solver EJS.
- **14:36Z** (el que reportó el usuario): ni siquiera llega al reto JS. `cookies are no longer valid` → `Sign in to confirm you're not a bot`. **Cookies muertas.**

Comprobado en local con el mismo `cookies.txt` del mount: `yt-dlp --cookies ... -F PFZh58z32m0` da **exactamente el mismo warning** de cookies rotadas — pero desde IP residencial YouTube lista todos los formatos igual y la descarga funciona. Confirmación de que el bloqueo es IP de datacenter + cookies muertas, no un bug del código.

**Hallazgo colateral importante:** el yt-dlp local eligió el cliente `visionos`, que **no requiere reto JS ni PO tokens** — de ahí que funcione en Windows sin deno. Producción eligió `web embedded` / `tv`, que sí lo requieren. Forzar `player_client=default,visionos` esquiva todo el problema de deno/EJS por el camino corto.

### Cambios

**1. Cookies por request (`src/lib/cookies.js`, nuevo).** Prioridad `body.cookiesB64` → `body.cookies` → header `x-cookies-b64` → archivo montado. Refrescar cookies ya no requiere tocar Coolify ni redeploy: se actualizan en una variable de n8n.

El normalizador **re-tabula** el archivo: el formato Netscape exige TABs y al viajar como texto dentro de un JSON se convierten en espacios; yt-dlp entonces ignora esas líneas **en silencio** (archivo válido, cero cookies dentro). Por eso base64 es la vía recomendada. También fuerza la cabecera `# Netscape HTTP Cookie File` y preserva `#HttpOnly_` (es prefijo de dominio, no comentario).

**2. Errores clasificados (`src/lib/ytdlp-errors.js`, nuevo).** El stderr de yt-dlp se traduce a un `code` estable + status HTTP + flags `retryable` / `cookiesStale` / `refreshCookies`, y se devuelve el stderr real en `detail`. Ojo: el apóstrofe de `Sign in to confirm you’re not a bot` es **U+2019, no ASCII** — el regex usa `you.re`.

**3. `--remote-components ejs:github`** como cinturón extra sobre el pip `yt-dlp-ejs`, que en producción no bastó. Y `--extractor-args youtube:player_client=default,visionos` para evitar el reto JS de entrada. Ambos configurables por env (`REMOTE_COMPONENTS`, `PLAYER_CLIENTS`).

**4. `GET /diag`.** Devuelve las versiones reales de yt-dlp / deno / ffmpeg / yt-dlp-ejs del contenedor **vivo**, más edad y permisos del cookies.txt montado. Nace del problema del "Build step skipped": hasta ahora no había forma de saber qué quedó desplegado más que provocar un fallo real y leer el log.

**5. `-f bestaudio/best`** (antes solo `bestaudio`, que fallaba en seco cuando el mejor formato no estaba disponible), `HEALTHCHECK` en el Dockerfile, y `API_TOKEN` opcional.

### Probado en local

- Descarga completa con cookies en el body (`PFZh58z32m0`): HTTP 200, 32.7 MB, `ffprobe` → `mp3 (mp3float)`, 19:14 de duración. Header `X-Cookies-Stale: true` — detectó las cookies rotadas **aunque la descarga funcionó**, que es justo la señal para refrescarlas antes de que empiece a fallar.
- Las tres fuentes de cookies verificadas end-to-end: `request:cookiesB64`, `request:cookies`, `file:...` — mismo resultado, y sin temporales huérfanos en tmp.
- Clasificador probado contra el texto literal de los logs de producción: bot check → `401 BOT_CHECK refreshCookies:true`; EJS faltante → `502 JS_CHALLENGE_FAILED`; video caído → `404 VIDEO_UNAVAILABLE`.
- **No verificado:** que el bot check de la IP de Oracle se resuelva. Eso es imposible de reproducir desde IP residencial y solo se confirma en producción, con cookies frescas.

### Lo que falta y lo que sigue

- **Las cookies siguen siendo el punto frágil.** Rotan porque el navegador que las exportó siguió activo. Procedimiento para que duren: ventana privada → login → dejar una sola pestaña → ir a `youtube.com/robots.txt` → exportar → **cerrar la ventana sin logout**. Usar el mismo archivo desde dos IPs (PC + server) también las mata más rápido.
- **Solución de fondo pendiente:** provider de PO tokens (`bgutil-ytdlp-pot-provider`) como sidecar. Permite descargar desde IP de datacenter **sin cookies de cuenta**, lo que elimina de raíz la rotación y el riesgo de ToS/suspensión de la cuenta personal.
- **El endpoint es HTTP plano y sin auth.** Mandar cookies de sesión en el body sobre `http://` las expone en claro, y hoy cualquiera que conozca la URL puede descargar usando la cuenta de YouTube del usuario. Activar HTTPS en Coolify y definir `API_TOKEN`.

---

## 2026-08-20 (noche): PO tokens (bgutil) — instalados y funcionando, pero la IP sigue bloqueada

Decisión del usuario: ir por la solución que no necesita cookies.

### Diagnóstico previo que la justificó

Con el flag `noCookies: true` se probó que la IP de Oracle recibe `Sign in to confirm you're not a bot`
**tanto con cookies muertas como sin cookies del todo**, con deno + yt-dlp-ejs + `visionos` todos verdes.
No hay configuración de yt-dlp que esquive el bloqueo sin credenciales: o cookies de cuenta real, o PO tokens.

### Cómo se armó

Un solo contenedor, sin sidecar. Un stage del Dockerfile copia el server bgutil **ya compilado**
desde su imagen oficial (`brainicism/bgutil-ytdlp-pot-provider:1.3.1-node`, que publica arm64) y
`docker-entrypoint.sh` lo levanta en loopback antes de hacer `exec` de la app.

Tres decisiones que evitaron trabajo perdido:

- **Copiar en vez de compilar.** Compilar el server exige `canvas`, que en arm64 pide cairo/pango dev
  y toolchain de C++.
- **No hubo que cambiar la imagen base.** La imagen del provider trae Node 25 y la nuestra Node 20, lo
  que normalmente rompería el módulo nativo — pero `canvas` 3.x declara `napi_versions: [7]`, o sea
  **N-API, de ABI estable entre versiones de Node**. Verificado en el registry de npm antes de escribir
  nada, lo que ahorró migrar la base a Node 25 (que además ya es EOL).
- **Mismo contenedor, no Compose.** Un sidecar obligaría a migrar el build pack de Coolify a Docker
  Compose, que re-deriva dominio, puertos y File Mounts de un servicio que ya funcionaba.

El plugin pip se pinea a la **misma versión** del server (1.3.1): el protocolo entre ambos no está
versionado y una mezcla de versiones falla en silencio.

### Verificado

`GET /diag` reporta las dos mitades por separado — `plugin: 1.3.1` y
`server: {"server_uptime":51.2,"version":"1.3.1"}`. Ambas arriba y coincidiendo.

### Resultado: no alcanzó

`PFZh58z32m0` sin cookies sigue dando `401 BOT_CHECK`. Se barrieron los clientes que consumen PO
tokens (`web`, `mweb`, `web_safari`, `tv`, `web_embedded`) con el override `playerClients` por
request: los cinco fallan igual, en 1.5–2s. El propio README de bgutil ya lo advierte —
*"Providing a PO token does not guarantee bypassing 403 errors or bot checks"*.

Se agregó el flag `verbose: true`, que mete `-v` a yt-dlp y devuelve el stderr completo en
`verboseLog`, porque `summarize()` solo conserva líneas ERROR/WARNING y las informativas del plugin
(las que dicen si el token se minteó) eran invisibles desde el cliente.

### Lo que queda por determinar

**Si cookies frescas funcionan desde esta IP.** Es la bifurcación que decide todo y no se puede
resolver sin que el usuario exporte cookies nuevas:

- **Si funcionan** → el camino es cookies (con los PO tokens ya puestos ayudando), y el trabajo hecho
  en n8n (Data Table `Config` + `cookiesB64` en el body) es la forma de mantenerlas frescas sin redeploy.
- **Si NO funcionan** → el rango de IP de Oracle está duro y ninguna credencial lo salva. La salida
  entonces es cambiar la ruta de salida del tráfico: proxy residencial, o mover el servicio a otro
  proveedor/IP.

Nada de esto se puede validar desde la PC del usuario: desde IP residencial hasta las cookies muertas
descargan bien.
