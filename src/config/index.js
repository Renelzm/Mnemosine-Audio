module.exports = {
  port: process.env.PORT || 3000,

  // Ruta al cookies.txt (formato Netscape) usada como FALLBACK cuando el request no trae
  // cookies propias. En Coolify se monta como File Mount (ver troubleshooting-ytdlp-coolify.md).
  // Lo preferible es que n8n mande las cookies en el body: así refrescarlas no requiere redeploy.
  cookiesPath: process.env.COOKIES_PATH || '/data/cookies/cookies.txt',

  // Componentes remotos que yt-dlp puede bajar cuando los necesita. "ejs:github" trae el script
  // que resuelve los retos JS de YouTube. Sin esto, si el cliente elegido necesita el reto JS,
  // yt-dlp lo salta y solo quedan miniaturas disponibles ("Only images are available").
  // El paquete pip yt-dlp-ejs cubre el mismo hueco de forma local; esto es el cinturón extra.
  remoteComponents: process.env.REMOTE_COMPONENTS || 'ejs:github',

  // Clientes de YouTube a forzar. Por defecto VACIO = que yt-dlp elija: sus clientes por defecto
  // son los que consumen PO tokens, y con el provider corriendo esa es la ruta buena. Pinear
  // visionos aqui (no requiere reto JS ni PO tokens) es el plan B si el provider falla.
  playerClients: process.env.PLAYER_CLIENTS ?? '',

  // Provider de PO tokens (bgutil) que el entrypoint levanta en el mismo contenedor. Los PO
  // tokens hacen que el trafico desde una IP de datacenter parezca legitimo, que es lo unico
  // que puede evitar el "Sign in to confirm you're not a bot" sin cookies de una cuenta real.
  // Vaciar la env var para desactivar el plugin y volver a depender solo de cookies.
  potBaseUrl: process.env.POT_BASE_URL ?? `http://127.0.0.1:${process.env.POT_PORT || 4416}`,

  jsRuntime: process.env.JS_RUNTIME || 'deno:/usr/local/bin/deno',

  // Secreto compartido opcional. Si se define, /download exige el header X-Api-Token.
  // Recomendado: el endpoint es público y usa cookies de una cuenta real de YouTube.
  apiToken: process.env.API_TOKEN || null,

  allowedDomains: [
    'youtube.com',
    'youtu.be',
    'www.youtube.com',
    'music.youtube.com',
    'm.youtube.com',
    'facebook.com',
    'www.facebook.com',
    'fb.watch',
    'm.facebook.com',
  ],
};
