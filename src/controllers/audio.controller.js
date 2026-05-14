const { spawn } = require('child_process');
const { allowedDomains } = require('../config');

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

  const ytdlp = spawn('yt-dlp', [
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--no-playlist',
    '--js-runtimes', 'nodejs',
    '--paths', '/tmp',
    '-o', '-',
    url,
  ]);

  const chunks = [];

  ytdlp.stdout.on('data', (chunk) => chunks.push(chunk));

  ytdlp.stderr.on('data', (data) => {
    console.error(`[yt-dlp] ${data.toString().trim()}`);
  });

  ytdlp.on('error', (err) => {
    console.error('Error al iniciar yt-dlp:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'No se pudo iniciar yt-dlp. Verifica que esté instalado.' });
    }
  });

  ytdlp.on('close', (code) => {
    console.log(`[${new Date().toISOString()}] Descarga completada. Código: ${code}, bytes: ${chunks.reduce((n, c) => n + c.length, 0)}`);

    if (code !== 0) {
      if (!res.headersSent) {
        res.status(500).json({ error: `yt-dlp terminó con código ${code}` });
      }
      return;
    }

    const buffer = Buffer.concat(chunks);

    if (buffer.length === 0) {
      return res.status(500).json({ error: 'yt-dlp no generó audio. Revisa la URL.' });
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
    }
  });
}

function health(_req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.2' });
}

module.exports = { download, health };
