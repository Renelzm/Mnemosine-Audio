const app = require('./app');
const { port } = require('./src/config');

// Errores de promesas no capturadas — loguea pero no mata el proceso
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// Excepciones síncronas no capturadas — loguea pero no mata el proceso
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${port}`);
  console.log('Endpoints disponibles:');
  console.log(`  POST http://0.0.0.0:${port}/download  { "url": "https://..." }`);
  console.log(`  GET  http://0.0.0.0:${port}/health`);
});

// Cierre ordenado ante señales del sistema (Cloud Run envía SIGTERM al hacer deploy)
function shutdown(signal) {
  console.log(`[${signal}] Cerrando servidor ordenadamente...`);
  server.close(() => {
    console.log('Servidor cerrado.');
    process.exit(0);
  });

  // Si tarda más de 10s forzar salida (Cloud Run tiene timeout de 10s por defecto)
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
