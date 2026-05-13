const express = require('express');
const audioRoutes = require('./src/routes/audio.routes');

const app = express();

app.use(express.json());
app.use('/', audioRoutes);

// Captura errores síncronos no manejados en handlers de Express
app.use((err, _req, res, _next) => {
  console.error(`[error] ${err.message}`, err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = app;
