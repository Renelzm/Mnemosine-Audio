#!/bin/sh
# Levanta el provider de PO tokens y luego la app, en un solo contenedor.
#
# Va en el mismo contenedor en vez de un sidecar a proposito: la app se despliega en Coolify con
# el build pack "Dockerfile", y meter un segundo servicio obligaria a migrar a Docker Compose,
# lo que re-deriva dominio, puertos y File Mounts de un servicio que ya funciona.
#
# Escucha solo en loopback: el provider no tiene autenticacion y no debe quedar expuesto.
set -e

POT_PORT="${POT_PORT:-4416}"
POT_MAIN=/opt/pot-provider/build/main.js

if [ -f "$POT_MAIN" ]; then
  (
    cd /opt/pot-provider || exit 1
    # --port es la unica opcion que acepta; el bind a loopback lo resuelve el propio server.
    exec node build/main.js --port "$POT_PORT"
  ) &
  echo "[entrypoint] provider de PO tokens iniciado en 127.0.0.1:${POT_PORT} (pid $!)"
else
  # Sin provider la app sigue sirviendo: yt-dlp cae de vuelta a cookies. GET /diag lo reporta.
  echo "[entrypoint] AVISO: no se encontro ${POT_MAIN}; se arranca sin PO tokens"
fi

exec "$@"
