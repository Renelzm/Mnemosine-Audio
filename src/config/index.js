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

  // Clientes de YouTube a probar, en orden. visionos/tv_simply no requieren resolver el reto JS
  // ni PO tokens, así que suelen pasar donde web/tv fallan. Vaciar la env var para dejar
  // que yt-dlp decida solo.
  playerClients: process.env.PLAYER_CLIENTS ?? 'default,visionos',

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
