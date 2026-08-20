const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { allowedDomains, cookiesPath, remoteComponents, playerClients, potBaseUrl, jsRuntime, apiToken } = require('../config');
const { resolveCookies } = require('../lib/cookies');
const { classify, summarize } = require('../lib/ytdlp-errors');

const VERSION = '2.2';

function isAllowedUrl(url) {
  try {
    const { hostname, protocol } = new URL(url);
    return (protocol === 'http:' || protocol === 'https:') && allowedDomains.includes(hostname);
  } catch {
    return false;
  }
}

function fail(res, status, code, error, extra = {}) {
  if (res.headersSent) return;
  res.status(status).json({ ok: false, code, error, ...extra });
}

function download(req, res) {
  const startedAt = Date.now();

  if (apiToken && req.headers['x-api-token'] !== apiToken) {
    return fail(res, 401, 'UNAUTHORIZED', 'Falta o es invalido el header X-Api-Token.');
  }

  const { url } = req.body || {};

  if (!url) {
    return fail(res, 400, 'MISSING_URL', 'Se requiere el campo "url".');
  }

  if (!isAllowedUrl(url)) {
    return fail(res, 400, 'DOMAIN_NOT_ALLOWED', 'URL no permitida. Solo se aceptan URLs de YouTube y Facebook.', { allowedDomains });
  }

  const cookies = resolveCookies(req);

  if (cookies.error) {
    return fail(res, 400, 'COOKIES_MALFORMED', cookies.error, {
      cookiesSource: cookies.source,
      hint: 'Manda el archivo en base64 en "cookiesB64": los TABs del formato Netscape se pierden al viajar como texto dentro de un JSON.',
    });
  }

  console.log(`[${new Date().toISOString()}] Descargando: ${url} | cookies: ${cookies.source} (${cookies.count})`);

  // Override por request, solo para diagnostico: cada redeploy es ciego y lento, asi que poder
  // comparar clientes contra la misma imagen desde el cliente ahorra ciclos completos de deploy.
  const clients = typeof req.body.playerClients === 'string' ? req.body.playerClients : playerClients;

  const extractorArgs = [];
  if (clients) extractorArgs.push(`youtube:player_client=${clients}`);
  // El plugin bgutil pide el token al provider local; sin este arg usa su default (mismo puerto),
  // pero se pasa explicito para que el valor real quede visible en los logs y en /diag.
  if (potBaseUrl) extractorArgs.push(`youtubepot-bgutilhttp:base_url=${potBaseUrl}`);

  // Diagnostico: -v es la unica forma de ver si los providers de PO token se cargaron y si
  // el token se llego a mintear. summarize() solo guarda lineas ERROR/WARNING, asi que sin
  // esto las lineas informativas del plugin (las que dicen si funciona) son invisibles.
  const verbose = req.body.verbose === true;

  const ytdlpArgs = [
    ...(verbose ? ['-v'] : []),
    '-f', 'bestaudio/best',
    '--no-playlist',
    '--no-progress',
    '--socket-timeout', '30',
    '--js-runtimes', jsRuntime,
    ...(remoteComponents ? ['--remote-components', remoteComponents] : []),
    ...extractorArgs.flatMap((a) => ['--extractor-args', a]),
    ...(cookies.path ? ['--cookies', cookies.path] : []),
    '-o', '-',
    url,
  ];

  const ffmpegArgs = [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn',
    '-acodec', 'libmp3lame',
    '-q:a', '0',
    '-f', 'mp3',
    'pipe:1',
  ];

  const ytdlp = spawn('yt-dlp', ytdlpArgs);
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  ytdlp.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdin.on('error', () => {}); // EPIPE si ffmpeg ya murio; el close de abajo da el error real

  let ytdlpStderr = '';
  let ffmpegStderr = '';
  let ytdlpExitCode = null;
  let spawnFailure = null;

  ytdlp.stderr.on('data', (data) => {
    const text = data.toString();
    ytdlpStderr += text;
    console.error(`[yt-dlp] ${text.trim()}`);
  });

  ffmpeg.stderr.on('data', (data) => {
    const text = data.toString();
    ffmpegStderr += text;
    console.error(`[ffmpeg] ${text.trim()}`);
  });

  ytdlp.on('error', (err) => {
    spawnFailure = { code: 'YTDLP_NOT_INSTALLED', message: `No se pudo iniciar yt-dlp: ${err.message}` };
    ffmpeg.kill('SIGTERM');
  });

  ffmpeg.on('error', (err) => {
    spawnFailure = { code: 'FFMPEG_NOT_INSTALLED', message: `No se pudo iniciar ffmpeg: ${err.message}` };
    ytdlp.kill('SIGTERM');
  });

  ytdlp.on('close', (code) => {
    ytdlpExitCode = code;
  });

  // El audio se acumula en memoria en vez de pipearse directo a la respuesta: asi se conocen los
  // codigos de salida de ambos procesos ANTES de mandar headers, y un fallo devuelve un JSON de
  // error limpio en lugar de un 200 con un stream truncado. Costo: RAM ~= tamano del mp3.
  const chunks = [];
  let bytes = 0;
  ffmpeg.stdout.on('data', (chunk) => {
    chunks.push(chunk);
    bytes += chunk.length;
  });

  ffmpeg.on('close', (ffmpegCode) => {
    const ms = Date.now() - startedAt;
    console.log(`[${new Date().toISOString()}] Fin. yt-dlp: ${ytdlpExitCode}, ffmpeg: ${ffmpegCode}, bytes: ${bytes}, ${ms}ms`);
    cookies.cleanup();

    if (res.headersSent) return;

    if (spawnFailure) {
      return fail(res, 500, spawnFailure.code, spawnFailure.message, {
        hint: 'El contenedor no tiene la dependencia instalada. Revisa GET /diag y fuerza rebuild sin cache en Coolify.',
      });
    }

    if (ytdlpExitCode !== 0) {
      const verdict = classify(ytdlpStderr, ytdlpExitCode);
      return fail(res, verdict.status, verdict.code, verdict.error, {
        hint: verdict.hint,
        retryable: verdict.retryable,
        cookiesStale: verdict.cookiesStale,
        refreshCookies: verdict.refreshCookies,
        cookiesSource: cookies.source,
        detail: summarize(ytdlpStderr),
        ...(verbose ? { verboseLog: ytdlpStderr.slice(-12000) } : {}),
      });
    }

    if (ffmpegCode !== 0) {
      return fail(res, 502, 'TRANSCODE_FAILED', 'ffmpeg no pudo convertir el audio a mp3.', {
        retryable: true,
        detail: ffmpegStderr.trim().split('\n').slice(-4).join(' | ').slice(0, 1000),
      });
    }

    if (bytes === 0) {
      // yt-dlp y ffmpeg salieron en 0 pero no hubo audio: raro, pero mejor un error explicito que
      // devolver un mp3 de 0 bytes que el cliente tomaria como exito.
      return fail(res, 502, 'EMPTY_OUTPUT', 'No se genero audio aunque yt-dlp y ffmpeg terminaron bien.', {
        retryable: true,
        cookiesStale: classify(ytdlpStderr, 0).cookiesStale,
        detail: summarize(ytdlpStderr),
      });
    }

    const buffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Cookies-Source', cookies.source);
    res.setHeader('X-Cookies-Stale', String(classify(ytdlpStderr, 0).cookiesStale));
    res.setHeader('X-Duration-Ms', String(ms));
    res.end(buffer);
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(`[${new Date().toISOString()}] Cliente desconectado, cancelando descarga`);
      ytdlp.kill('SIGTERM');
      ffmpeg.kill('SIGTERM');
      cookies.cleanup();
    }
  });
}

function health(_req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: VERSION });
}

function probe(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message).trim().split('\n')[0] });
      resolve({ ok: true, out: (stdout || stderr).trim().split('\n')[0] });
    });
  });
}

/** Salud del provider de PO tokens que levanta el entrypoint dentro del mismo contenedor. */
async function pingPot() {
  if (!potBaseUrl) return { ok: false, error: 'desactivado (POT_BASE_URL vacio)' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${potBaseUrl}/ping`, { signal: ctrl.signal });
    clearTimeout(t);
    const body = await r.text();
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, out: body.trim().slice(0, 300) };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

/**
 * Radiografia del contenedor que esta corriendo AHORA MISMO.
 *
 * Existe porque Coolify puede reusar una imagen vieja sin avisar ("Build step skipped") y no habia
 * forma de saber que version de yt-dlp / deno / EJS quedo desplegada mas que provocando un fallo real.
 */
async function diag(_req, res) {
  const denoBin = jsRuntime.includes(':') ? jsRuntime.slice(jsRuntime.indexOf(':') + 1) : 'deno';

  const [ytdlp, deno, ffmpeg, ejs, potPlugin, potServer] = await Promise.all([
    probe('yt-dlp', ['--version']),
    probe(denoBin, ['--version']),
    probe('ffmpeg', ['-version']),
    probe('python3', ['-c', 'import importlib.metadata as m; print(m.version("yt-dlp-ejs"))']),
    probe('python3', ['-c', 'import importlib.metadata as m; print(m.version("bgutil-ytdlp-pot-provider"))']),
    pingPot(),
  ]);

  let mountedCookies;
  try {
    const stat = fs.statSync(cookiesPath);
    let writable = false;
    try {
      fs.accessSync(cookiesPath, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    mountedCookies = {
      present: true,
      path: cookiesPath,
      bytes: stat.size,
      modified: stat.mtime.toISOString(),
      ageDays: Number(((Date.now() - stat.mtimeMs) / 86400000).toFixed(1)),
      writable,
    };
  } catch {
    mountedCookies = { present: false, path: cookiesPath };
  }

  res.json({
    appVersion: VERSION,
    timestamp: new Date().toISOString(),
    ytdlp,
    deno,
    ffmpeg,
    ytdlpEjs: ejs,
    // Las dos mitades del sistema de PO tokens: el plugin de yt-dlp y el server que lo alimenta.
    // Si el plugin esta y el server no, yt-dlp cae de vuelta a cookies sin avisar en el 200.
    poTokens: { plugin: potPlugin, server: potServer, baseUrl: potBaseUrl || null },
    config: { remoteComponents, playerClients, jsRuntime, authRequired: Boolean(apiToken) },
    mountedCookies,
  });
}

module.exports = { download, health, diag };
