module.exports = {
  port: process.env.PORT || 3000,

  // Ruta al cookies.txt (formato Netscape) para autenticar yt-dlp ante YouTube.
  // En Coolify se monta como File Mount en /data/cookies/cookies.txt (ver troubleshooting-ytdlp-coolify.md).
  cookiesPath: process.env.COOKIES_PATH || '/data/cookies/cookies.txt',

  allowedDomains: [
    'youtube.com',
    'youtu.be',
    'www.youtube.com',
    'facebook.com',
    'www.facebook.com',
    'fb.watch',
    'm.facebook.com',
  ],
};
