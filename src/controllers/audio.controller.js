const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { allowedDomains, cookiesPath } = require('../config');

function isAllowedUrl(url) {
  try {
    const { hostname } = new URL(url);
    return allowedDomains.includes(hostname);
  } catch {
    return false;
  }
}

function download(req, res) {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Se requiere el campo "url"' });
  }

  if (!isAllowedUrl(url)) {
    return res.status(400).json({ error: 'URL no permitida. Solo se aceptan URLs de YouTube y Facebook.' });
  }

  console.log(`[${new Date().toISOString()}] Descargando audio de: ${url}`);

  const hasCookies = fs.existsSync(cookiesPath);

  // yt-dlp intenta reescribir el cookies.txt al cerrar (para persistir cookies rotadas).
  // El File Mount de Coolify puede ser de solo lectura, y aunque no lo sea, no queremos que
  // yt-dlp modifique el archivo "fuente de verdad" configurado ahí. Por eso se usa una copia
  // temporal y escribible por request en vez de apuntar directo al cookiesPath montado.
  let workingCookiesPath = null;
  if (hasCookies) {
    workingCookiesPath = path.join(os.tmpdir(), `cookies-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.copyFileSync(cookiesPath, workingCookiesPath);
  }

  console.log(hasCookies
    ? `[yt-dlp] Usando cookies de sesión: ${cookiesPath}`
    : `[yt-dlp] Sin cookies (no se encontró ${cookiesPath}); YouTube puede bloquear la descarga`);

  const cleanupWorkingCookies = () => {
    if (workingCookiesPath) {
      fs.unlink(workingCookiesPath, () => {});
    }
  };

  // yt-dlp solo extrae el mejor audio original (opus/webm, etc.) y lo manda por stdout.
  // La conversión real a mp3 la hace ffmpeg en un segundo proceso encadenado: al mandar
  // a stdout ('-o -'), el postprocesador de yt-dlp (-x/--audio-format) no se aplica.
  const ytdlpArgs = [
    '-f', 'bestaudio',
    '--no-playlist',
    '--js-runtimes', 'deno:/usr/local/bin/deno',
    ...(hasCookies ? ['--cookies', workingCookiesPath] : []),
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
  ffmpeg.stdin.on('error', () => {}); // EPIPE si ffmpeg ya murió, el 'close' de abajo maneja el error real

  let ytdlpExitCode = null;

  ytdlp.stderr.on('data', (data) => {
    console.error(`[yt-dlp] ${data.toString().trim()}`);
  });

  ffmpeg.stderr.on('data', (data) => {
    console.error(`[ffmpeg] ${data.toString().trim()}`);
  });

  ytdlp.on('error', (err) => {
    console.error('Error al iniciar yt-dlp:', err.message);
    ffmpeg.kill('SIGTERM');
    cleanupWorkingCookies();
    if (!res.headersSent) {
      res.status(500).json({ error: 'No se pudo iniciar yt-dlp. Verifica que esté instalado.' });
    }
  });

  ffmpeg.on('error', (err) => {
    console.error('Error al iniciar ffmpeg:', err.message);
    ytdlp.kill('SIGTERM');
    cleanupWorkingCookies();
    if (!res.headersSent) {
      res.status(500).json({ error: 'No se pudo iniciar ffmpeg. Verifica que esté instalado.' });
    }
  });

  ytdlp.on('close', (code) => {
    ytdlpExitCode = code;
    if (code !== 0) {
      console.error(`[yt-dlp] Terminó con código ${code}`);
    }
  });

  const chunks = [];

  ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));

  ffmpeg.on('close', (ffmpegCode) => {
    console.log(`[${new Date().toISOString()}] Descarga completada. yt-dlp: ${ytdlpExitCode}, ffmpeg: ${ffmpegCode}, bytes: ${chunks.reduce((n, c) => n + c.length, 0)}`);
    cleanupWorkingCookies();

    if (res.headersSent) return;

    if (ytdlpExitCode !== null && ytdlpExitCode !== 0) {
      return res.status(500).json({ error: `yt-dlp terminó con código ${ytdlpExitCode}` });
    }

    if (ffmpegCode !== 0) {
      return res.status(500).json({ error: `ffmpeg terminó con código ${ffmpegCode}` });
    }

    const buffer = Buffer.concat(chunks);

    if (buffer.length === 0) {
      return res.status(500).json({ error: 'No se generó audio. Revisa la URL.' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(`[${new Date().toISOString()}] Cliente desconectado, cancelando descarga`);
      ytdlp.kill('SIGTERM');
      ffmpeg.kill('SIGTERM');
    }
  });
}

function health(_req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.2' });
}

module.exports = { download, health };
