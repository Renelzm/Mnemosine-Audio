/**
 * Traduce el stderr de yt-dlp a un código estable + status HTTP, para que el cliente (n8n)
 * pueda ramificar sin parsear texto libre. Antes la API solo devolvía "yt-dlp terminó con
 * código 1", que no dice nada de si hay que refrescar cookies, reintentar, o si el video
 * simplemente no existe.
 *
 * El orden importa: se evalúa de la causa más específica a la más genérica.
 */
const RULES = [
  {
    // El apóstrofe de YouTube es U+2019, no ASCII — de ahí el punto en "you.re".
    match: /Sign in to confirm you.re not a bot|Sign in to confirm your age|confirm you.re not a bot/i,
    code: 'BOT_CHECK',
    status: 401,
    error: 'YouTube exige autenticación: bloqueo anti-bot por IP de datacenter.',
    hint: 'Manda cookies frescas (body.cookiesB64). Si ya las mandaste, están rotadas: re-expórtalas en ventana privada.',
    retryable: true,
    refreshCookies: true,
  },
  {
    match: /Only images are available|Requested format is not available|n challenge solving failed|Remote components .* were skipped/i,
    code: 'JS_CHALLENGE_FAILED',
    status: 502,
    error: 'yt-dlp no pudo resolver el reto JS de YouTube; no quedaron formatos de audio disponibles.',
    hint: 'Faltan el runtime deno y/o el solver EJS en el contenedor. Revisa GET /diag y fuerza rebuild sin caché en Coolify.',
    retryable: true,
  },
  {
    match: /Private video|Join this channel|members-only|This video is available to this channel's members/i,
    code: 'VIDEO_RESTRICTED',
    status: 403,
    error: 'El video es privado o solo para miembros del canal.',
    retryable: false,
  },
  {
    match: /Video unavailable|This video is not available|has been removed|does not exist/i,
    code: 'VIDEO_UNAVAILABLE',
    status: 404,
    error: 'El video no existe o no está disponible en esta región.',
    retryable: false,
  },
  {
    match: /This live event will begin|is not currently live|Premieres in/i,
    code: 'NOT_YET_AVAILABLE',
    status: 409,
    error: 'El contenido es un estreno o directo que todavía no empieza.',
    retryable: true,
  },
  {
    match: /HTTP Error 429|Too Many Requests|rate.?limit/i,
    code: 'RATE_LIMITED',
    status: 429,
    error: 'YouTube está limitando la tasa de peticiones desde esta IP.',
    hint: 'Espera antes de reintentar y baja la frecuencia de requests.',
    retryable: true,
  },
  {
    match: /Unsupported URL|is not a valid URL/i,
    code: 'UNSUPPORTED_URL',
    status: 400,
    error: 'yt-dlp no reconoce esa URL.',
    retryable: false,
  },
  {
    match: /Unable to download webpage|Connection reset|timed out|Temporary failure in name resolution/i,
    code: 'NETWORK_ERROR',
    status: 502,
    error: 'Fallo de red al hablar con YouTube.',
    retryable: true,
  },
];

const COOKIES_STALE = /cookies are no longer valid|have likely been rotated/i;

/**
 * @param {string} stderr salida completa de yt-dlp
 * @param {number|null} exitCode
 */
function classify(stderr, exitCode) {
  const text = stderr || '';
  const cookiesStale = COOKIES_STALE.test(text);

  const rule = RULES.find((r) => r.match.test(text));

  const base = rule
    ? { code: rule.code, status: rule.status, error: rule.error, hint: rule.hint, retryable: rule.retryable }
    : {
        code: 'YTDLP_FAILED',
        status: 502,
        error: `yt-dlp falló con código ${exitCode}.`,
        hint: 'Revisa el campo detail con la salida real de yt-dlp.',
        retryable: true,
      };

  return {
    ...base,
    cookiesStale,
    // Solo se pide refrescar cookies cuando eso es de verdad la acción correctiva.
    refreshCookies: Boolean(rule?.refreshCookies) || (cookiesStale && base.code !== 'VIDEO_UNAVAILABLE' && base.code !== 'VIDEO_RESTRICTED'),
  };
}

/** Últimas líneas relevantes del stderr, para mandarlas como `detail` sin inundar la respuesta. */
function summarize(stderr, maxLines = 6) {
  return (stderr || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && /^(ERROR|WARNING)/i.test(l))
    .slice(-maxLines)
    .join(' | ')
    .slice(0, 2000);
}

module.exports = { classify, summarize };
