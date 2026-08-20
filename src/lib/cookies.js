const fs = require('fs');
const os = require('os');
const path = require('path');
const { cookiesPath } = require('../config');

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';

/**
 * Normaliza un cookies.txt que viene por HTTP.
 *
 * Dos cosas se rompen seguido al mandar el archivo dentro de un JSON (n8n, Postman, etc.):
 *  - Los TABs que separan los campos se convierten en espacios. yt-dlp exige TABs y si no los
 *    encuentra ignora la línea en silencio: el archivo "existe" pero va vacío de cookies.
 *  - Se pierde la línea de cabecera, y sin ella yt-dlp rechaza el archivo completo.
 * Por eso se re-tabula cada línea de datos y se fuerza la cabecera.
 */
function normalizeNetscape(raw) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Los comentarios (menos la cabecera, que se agrega aparte) y las directivas #HttpOnly_ se
    // conservan tal cual: #HttpOnly_ es un prefijo de dominio válido, no un comentario.
    if (trimmed.startsWith('#') && !trimmed.startsWith('#HttpOnly_')) continue;

    const fields = trimmed.split(/\t+/);
    // Si ya venía con TABs (7 campos) se respeta; si no, se reconstruye partiendo por espacios.
    // El último campo (el valor de la cookie) puede contener espacios, así que se limita el split.
    const parts = fields.length >= 7 ? fields : trimmed.split(/\s+/);
    if (parts.length < 7) continue;

    const head = parts.slice(0, 6);
    const value = parts.slice(6).join(' ');
    out.push([...head, value].join('\t'));
  }

  return { text: `${NETSCAPE_HEADER}\n${out.join('\n')}\n`, count: out.length };
}

function decode(value, encoding) {
  if (encoding === 'base64') return Buffer.from(value, 'base64').toString('utf8');
  return value;
}

/**
 * Resuelve de dónde salen las cookies para este request y las deja en un archivo temporal.
 *
 * Prioridad: body.cookiesB64 > body.cookies > header x-cookies-b64 > archivo montado.
 * Siempre se escribe una copia temporal escribible: yt-dlp reescribe el cookies.txt al cerrar
 * (para persistir las cookies que YouTube rota) y el File Mount de Coolify puede ser read-only
 * — eso hacía que yt-dlp saliera con código 1 despues de haber descargado el audio completo.
 *
 * @returns {{path: string|null, source: string, count: number, cleanup: () => void, error?: string}}
 */
function resolveCookies(req) {
  const noop = { path: null, source: 'none', count: 0, cleanup: () => {} };

  const body = req.body || {};

  // Escape hatch de diagnóstico: unas cookies muertas son PEORES que ninguna — con cookies de
  // cuenta inválidas yt-dlp toma un camino degradado y cae en el bloqueo anti-bot, mientras que
  // sin cookies puede pasar limpio usando el cliente visionos. Sirve para saber si la IP está
  // bloqueada de verdad o si solo son las cookies las que envenenan el request.
  if (body.noCookies === true) return { ...noop, source: 'disabled' };

  let raw = null;
  let source = null;

  if (typeof body.cookiesB64 === 'string' && body.cookiesB64.trim()) {
    raw = decode(body.cookiesB64.trim(), 'base64');
    source = 'request:cookiesB64';
  } else if (typeof body.cookies === 'string' && body.cookies.trim()) {
    raw = body.cookies;
    source = 'request:cookies';
  } else if (typeof req.headers['x-cookies-b64'] === 'string' && req.headers['x-cookies-b64'].trim()) {
    raw = decode(req.headers['x-cookies-b64'].trim(), 'base64');
    source = 'header:x-cookies-b64';
  } else if (fs.existsSync(cookiesPath)) {
    raw = fs.readFileSync(cookiesPath, 'utf8');
    source = `file:${cookiesPath}`;
  }

  if (raw === null) return noop;

  const { text, count } = normalizeNetscape(raw);
  if (count === 0) {
    return { ...noop, source, error: 'El cookies.txt recibido no contiene ninguna cookie válida (se esperaba formato Netscape de 7 campos por línea).' };
  }

  const tmp = path.join(os.tmpdir(), `cookies-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(tmp, text, { mode: 0o600 });

  let done = false;
  return {
    path: tmp,
    source,
    count,
    cleanup: () => {
      if (done) return;
      done = true;
      fs.unlink(tmp, () => {});
    },
  };
}

module.exports = { resolveCookies, normalizeNetscape };
