# Prime Suite · paquete de instalación

Este paquete instala Prime Suite a partir de la imagen publicada en
`ghcr.io/smondelof/primesuite`, sin compilar nada en el servidor. La versión
del paquete está en el fichero `VERSION`.

## Requisitos

- Linux con **Docker** y **Docker Compose v2**, y un usuario que pueda usar Docker.
- Salida a Internet hacia `ghcr.io` para descargar la imagen.
- Una URL **https** de acceso (obligatoria para el SSO). El TLS lo termina vuestro
  balanceador/proxy o el propio paquete con `--tls`.

## Instalar

```bash
tar xzf primesuite-X.Y.Z.tar.gz
cd primesuite-X.Y.Z
bash install.sh --dir /opt/primesuite-prod --issuer https://primesuite.empresa.com:8443 --port 18081
```

- Se crea `/opt/primesuite-prod/.env` con una `PRIME_SECRET_KEY` nueva.
  **Guarda una copia segura de ese fichero.**
- Al terminar, abre la URL y completa el asistente de primera configuración.
- Cada instalación tiene su propio nombre (`--name`, por defecto el de la carpeta),
  contenedor, volumen de datos, puerto y cookie de sesión. Varias instalaciones pueden
  convivir en el mismo servidor e incluso en el mismo dominio con distinto puerto.
- `bash install.sh --help` muestra todas las opciones, incluido `--tls` para que el
  paquete sirva HTTPS con vuestro certificado (`certs/fullchain.pem` y `certs/privkey.pem`).

## Cambiar de versión

```bash
bash /opt/primesuite-prod/update.sh 1.1.0          # solo cambia la imagen
# o, con el paquete nuevo descomprimido (actualiza también compose y scripts):
bash primesuite-1.1.0/update.sh --dir /opt/primesuite-prod
```

Antes de cambiar hace un backup en `backups/`. Si la versión nueva no responde,
vuelve sola a la anterior. Para volver atrás a mano: `bash update.sh <versión anterior>`.

## Operación

```bash
cd /opt/primesuite-prod
docker compose ps
docker compose logs -f app
docker compose exec app npm run backup /data/backup.json && docker compose cp app:/data/backup.json ./backups/
```
