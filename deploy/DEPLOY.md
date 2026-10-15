# Prime Suite · despliegue autoalojado (Linux + Docker + SQL Server)

Guía para instalar Prime Suite en un servidor propio y poder **replicarlo** en otras instalaciones.
La app es un único contenedor Node que sirve el frontend y la API; todos los datos se guardan en
**SQL Server** (ver «Base de datos» más abajo). En el volumen Docker `/data` solo quedan el fichero de
conexión y el SQLite anterior, que se migra solo la primera vez.

## Base de datos (SQL Server)

Prime Suite guarda todos sus datos en **SQL Server** (tabla `dbo.PrimeSuite_Datos`: una fila por registro, con
`Clave`, `Ambito`, `Valor` en JSON, `Creado` y `Actualizado`; y `dbo.PrimeSuite_Info` con la versión del esquema y la
migración). La app **crea sola** la base de datos si no existe, las tablas y las columnas que falten al conectar.

- Los datos de conexión están en `/data/sqlserver.json` (dentro del volumen, nunca en el repo), con la contraseña
  cifrada con `PRIME_SECRET_KEY`. Desplegar el código no los toca.
- Si ese fichero no existe o la conexión falla, la web muestra el formulario **Base de datos SQL Server**. Para
  guardarlo hace falta el **código de configuración** que la app escribe al arrancar en el log y en
  `/data/codigo-configuracion.txt`:
  ```bash
  docker compose logs app | grep -A1 "Código de configuración"
  docker compose exec app cat /data/codigo-configuracion.txt
  ```
- Si se pierde la conexión, la app reintenta sola cada 30 s y mientras tanto muestra el formulario (con «Reintentar ahora»).
- La primera vez copia a SQL Server todo lo que había en el SQLite anterior (`/data/prime-suite.db`), sin sobrescribir
  nada. El fichero SQLite se conserva como copia y queda marcado (`prime-suite.db.migrado-a-sqlserver`) para no migrarlo dos veces.
- Usa **una base de datos distinta por entorno** (desarrollo y producción).
- El usuario de SQL Server necesita `db_owner` en la base de datos (o permiso `CREATE DATABASE` si debe crearla).


---

## 1. Requisitos

- Un servidor **Linux** con **Docker** y **Docker Compose v2** (`docker compose`).
- **1 vCPU / 1–2 GB RAM** y ~1 GB de disco sobran.
- Un **nombre de dominio** (interno o público) y **HTTPS** (obligatorio para el SSO).
- Conectividad de red desde este servidor al **SQL Server de Evalos 8** (TCP 1433), si se va a usar
  el módulo Atajos de Evalos contra la base de datos real.

El TLS puede terminar de **dos maneras** (elige una, ver §4):
- **A)** en vuestro **balanceador/edge de Equinix** (recomendado): la app va por HTTP detrás de él.
- **B)** en la **propia app**, sirviendo HTTPS con vuestro certificado (perfil `tls` con Caddy).

---

## 2. Estructura

```
PrimeSuite/
├─ prime-suite/           # la aplicación (código + Dockerfile)
└─ deploy/                # todo lo de despliegue
   ├─ docker-compose.yml
   ├─ .env.example
   ├─ Caddyfile           # solo para el modo HTTPS directo
   └─ certs/              # (solo modo B) fullchain.pem + privkey.pem
```

---

## 3. Instalación

```bash
cd deploy
cp .env.example .env
#  edita .env:  PRIME_ISSUER (tu URL https), PRIME_SECRET_KEY (genera una larga), TZ
#  genera el secreto:  openssl rand -base64 48

docker compose up -d --build
```

La primera vez, abre la URL en el navegador: aparece el **asistente de primera configuración**
para crear la empresa principal y el superadministrador. (Si vas a **migrar** datos desde Netlify,
mira §5 y hazlo antes de crear nada.)

Comprobaciones rápidas:
```bash
docker compose ps
curl -s http://127.0.0.1:8080/api/health      # {"ok":true,...}
docker compose logs -f app
```

---

## 4. HTTPS / TLS

**Importante:** `PRIME_ISSUER` debe ser la URL **https exacta** con la que entra el usuario. Las
cookies de sesión van con `Secure`, así que sin HTTPS no se puede iniciar sesión.

### Modo A — detrás de vuestro balanceador (recomendado)
El balanceador/Equinix termina el TLS y reenvía a este host por HTTP al puerto `8080`.
Debe enviar las cabeceras `X-Forwarded-Proto: https` y `X-Forwarded-Host` (Prime Suite las usa
para construir el issuer). En `.env`:
```
APP_BIND=0.0.0.0      # si el balanceador está en otra máquina (protégelo por firewall)
APP_PORT=8080
```
No se usa el servicio `caddy`.

### Modo B — la app sirve HTTPS con vuestro certificado
```bash
mkdir -p deploy/certs
#  copia tu certificado de Equinix:
#    deploy/certs/fullchain.pem   (certificado + cadena)
#    deploy/certs/privkey.pem     (clave privada)
#  en .env:  PRIME_DOMAIN=primesuite.vuestro-dominio.com
docker compose --profile tls up -d --build
```
Caddy escucha en 443 y hace de proxy a la app. (Si tu certificado viene en `.pfx`/`.crt+.key`,
conviértelo a PEM: `openssl pkcs12 -in cert.pfx -nokeys -out fullchain.pem` y
`openssl pkcs12 -in cert.pfx -nocerts -nodes -out privkey.pem`.)

---

## 5. Migrar los datos desde Netlify

En la instalación de Netlify, con tu usuario **superadministrador**, descarga la copia:
```
https://primesuite.netlify.app/api/admin/backup
```
(se descarga un `prime-suite-backup-AAAA-MM-DD.json`).

Impórtala en el servidor nuevo **antes** de crear nada:
```bash
docker compose cp prime-suite-backup-2026-10-02.json app:/data/backup.json
docker compose exec app npm run restore /data/backup.json
docker compose restart app
```
Entra con tus mismos usuarios de las pruebas. (Nota: las contraseñas de los servidores de Superset
van cifradas con una clave interna que también se migra; si prefieres fijar `PRIME_SECRET_KEY` propia
en este servidor, vuelve a introducir esas contraseñas en Prime Insights › Servidores tras migrar.)

> Más adelante, para una **exportación limpia** (catálogo de módulos sin datos de clientes) añadiremos
> una opción al backup; de momento `/api/admin/backup` exporta todo.

---

## 6. Actualizar a una versión nueva

> Esto es el entorno de **desarrollo/pruebas**. Producción se despliega solo a mano con versiones publicadas: ver §11.

**Automático (lo habitual):** cada push a `main` lo despliega el runner de GitHub Actions instalado en el servidor (`scripts/setup-runner-ubuntu.sh`, se instala una sola vez). Hace backup, reconstruye, reinicia y, si `/api/health` falla, vuelve a la versión anterior. Se sigue en GitHub › Actions.

**Manual:**

```bash
cd PrimeSuite && git pull            # o sustituye los ficheros por la versión nueva
cd deploy && docker compose up -d --build
```
Los datos persisten en el volumen `prime-data`; la actualización no los toca.

---

## 7. Copias de seguridad

Los datos están en SQL Server: haz copias de la base de datos con las herramientas de SQL Server.
Además, cada despliegue guarda un backup lógico en JSON en `backups/`, y se puede hacer a mano:

```bash
docker compose exec app npm run backup /data/backup.json
docker compose cp app:/data/backup.json ./prime-suite-$(date +%F).json
```
Restaurar: `npm run restore /data/backup.json` (ver §5).

---

## 8. Módulo Atajos de Evalos

El módulo usa tres conexiones con Evalos 8. Todas se configuran desde la interfaz, no en `.env`:

- **Base de datos SQL Server** (Departamentos, Personal, Convenios, catálogos y lo que lee Teletrabajo).
  - Se configura en **Atajos de Evalos › Configuración**: motor **Demostración** (datos ficticios) o **SQL Server**.
  - Para el modo real, introduce la cadena de conexión, p. ej.:
    ```
    Server=TU-SQLSERVER,1433;Database=EVALOS8;User Id=atajos;Password=****;Encrypt=true;TrustServerCertificate=true
    ```
  - Usa un usuario de SQL Server propio. Además de leer y escribir las tablas de Evalos que usa, necesita
    **permiso para crear y modificar tablas** (p. ej. el rol `db_ddladmin`): Prime Suite crea solo lo que le falte,
    sin scripts — sus tablas `PS_CONVENIOS*`, `PS_WF2PERFILES` y `PS_WF2VALIDA`, y las
    columnas `EM_CONV` y `EM_WORKFLOWROL` en `PERSONAL`. Sin ese permiso, la pantalla
    afectada lo explica (y deja el script plegado como último recurso).
  - Requiere que este servidor **alcance** al SQL Server por TCP 1433 (regla de firewall/VPN).
- **EvalosRest** (Correcciones con conexión real). Se configura en **Integraciones › evalos8 › API REST**:
  URL API, URL token, Client ID y Client Secret, con *Probar conexión*.
- **Servicios SOAP ServiciosCliente** (vacaciones en Correcciones). Se configuran en el campo
  **URL servicios SOAP** de la misma pestaña, con *Probar servicios SOAP*.

Las contraseñas, cadenas de conexión y secretos se guardan cifrados con `PRIME_SECRET_KEY`.

---

## 9. Problemas frecuentes

| Síntoma | Causa / solución |
|---|---|
| No deja iniciar sesión, vuelve al login | `PRIME_ISSUER` no coincide con la URL real, o no llega por HTTPS. Revisa el dominio y que el proxy mande `X-Forwarded-Proto: https`. |
| "Error interno" en todo | Revisa `docker compose logs app`. Normalmente permisos del volumen `/data`. |
| Superset no carga / no conecta | Es herramienta interna: `PRIME_ALLOW_PRIVATE_FETCH=1` ya va activado para permitir URLs de red privada. Revisa que el host de Superset sea alcanzable. |
| Evalos (modo real) da error de conexión | Falta ruta al SQL Server (1433) o la cadena de conexión es incorrecta. |
| Correcciones no carga marcajes o vacaciones | Revisa Integraciones › evalos8 › API REST con *Probar conexión* y *Probar servicios SOAP*; con «Ver respuesta» en la pantalla se ve lo que devolvió Evalos para el listado de anomalías. |

---

## 10. Variables de entorno (resumen)

| Variable | Para qué |
|---|---|
| `PRIME_ISSUER` | URL https pública/interna exacta (issuer del SSO). **Obligatoria.** |
| `PRIME_SECRET_KEY` | Clave para cifrar todos los secretos guardados (Superset, API REST, conexiones de Evalos, inicio automático). Larga, aleatoria, estable. |
| `PRIME_ALLOW_PRIVATE_FETCH` | `1` = el servidor puede llamar a hosts de red privada. Activado por defecto en producción; no hace falta ponerla. |
| `TWON_UPSTREAM` / `TWON_TLS_FINGERPRINT` | Destino del proxy `/2n/` de 2N Access Commander y huella SHA-256 de su certificado (si falta, se acepta el que presente y se registra su huella en el log). |
| `EVALOS_TZ` | Zona horaria de las fechas de Evalos (por defecto `Europe/Madrid`). |
| `APP_PORT` / `APP_BIND` | Puerto interno y a qué interfaz del host se publica. |
| `PRIME_DOMAIN` | Dominio para el modo HTTPS directo (perfil `tls`). |
| `TZ` | Zona horaria del contenedor. |
| `PRIME_COOKIE_NAME` | Nombre de la cookie de sesión (empieza por `ps_`, por defecto `ps_session`). Distinto en cada instalación que comparta dominio, porque las cookies no distinguen puertos. |
| `PRIME_VERSION` | Versión publicada (la fijan el paquete instalable y la imagen; en desarrollo `/api/health` devuelve «desarrollo»). |
| `PRIME_STORE` / `PRIME_SQLITE_PATH` | Almacenamiento: SQL Server (`sqlite` en instalaciones antiguas significa lo mismo) y SQLite anterior que se migra. No cambiar. |

---

## 11. Producción: versiones publicadas y paquete instalable

Producción vive en el **mismo servidor** que desarrollo, pero separada en todo y **sin despliegues
automáticos**: solo se instala lo que se publica como versión y solo cuando se lanza a mano.

|                    | Desarrollo / pruebas            | Producción                               |
|--------------------|---------------------------------|------------------------------------------|
| Carpeta            | `/opt/primesuite`               | `/opt/primesuite-prod`                   |
| Cómo se despliega  | automático en cada push a main  | a mano: «Desplegar en Producción»        |
| Qué se despliega   | el código de main (se compila)  | una versión publicada (imagen ghcr.io)   |
| Contenedor         | `prime-suite`                   | `primesuite-prod`                        |
| Volumen de datos   | `deploy_prime-data`             | `primesuite-prod_prime-data`             |
| Puerto interno     | `APP_PORT` de su .env (18080)   | 18081                                    |
| Cookie de sesión   | `ps_session`                    | `ps_session_primesuite_prod`             |
| Backups            | `/opt/primesuite/backups`       | `/opt/primesuite-prod/backups`           |

### 11.1 Publicar una versión
GitHub › Actions › **Publicar versión** › Run workflow, con la versión (`1.0.0`, `1.1.0`…) y la rama o
commit (por defecto `main`). Construye la imagen `ghcr.io/smondelof/primesuite:<versión>`, crea el tag
`v<versión>` y una Release con el paquete `primesuite-<versión>.tar.gz` (carpeta `release/` del repo:
`docker-compose.yml`, `.env.example`, `Caddyfile`, `install.sh`, `update.sh`, `LEEME.md`).
Una versión publicada no se puede volver a publicar: para corregir algo, se publica un número nuevo.

**Solo la primera vez:** GitHub › perfil/organización › Packages › `primesuite` › Package settings ›
*Change visibility* › **Public**, para que los servidores descarguen la imagen sin credenciales.

### 11.2 Preparación del servidor (una sola vez, con sudo)
```bash
sudo mkdir -p /opt/primesuite-prod
# mismo dueño que la carpeta de desarrollo (el usuario con el que corre el runner; en monitoring, jpujol)
sudo chown "$(stat -c '%U:%G' /opt/primesuite)" /opt/primesuite-prod
```
Y en GitHub › Settings › Environments › **produccion** › *Required reviewers*: quién debe aprobar cada
despliegue (el entorno se crea solo al lanzar el primer despliegue; conviene añadir los aprobadores
antes de usarlo en serio).

### 11.3 Primera instalación de producción
Actions › **Desplegar en Producción** › versión `1.0.0`, **issuer** con la URL exacta de producción
incluido el puerto (p. ej. `https://primesuite.vuestro-dominio.com:1512`) y puerto interno `18081`.
El workflow ejecuta `install.sh`, que crea `/opt/primesuite-prod/.env` con una `PRIME_SECRET_KEY`
nueva. **Haz una copia segura de ese .env.** Después abre la URL y completa el asistente de primera
configuración (producción empieza vacía: usuarios, integraciones y conexiones de Evalos se configuran
de nuevo; las integraciones SSO, como evalos8, necesitan registrar las URL de producción).

**HTTPS en el puerto de producción.** En el servidor `monitoring`, desarrollo sirve HTTPS con su Caddy
(`prime-suite-tls`) en el 9876 y producción hace lo mismo con el suyo (`primesuite-prod-tls`) en el
**1512**, usando **el mismo certificado** (`/opt/primesuite/deploy/certs`): al renovarlo, cambia en los dos.
Es lo que hace por defecto el campo *certs* de «Desplegar en Producción» (`install.sh --certs`). Si el TLS
lo terminara un balanceador, deja *certs* vacío y apunta el balanceador a `127.0.0.1:18081`.
El cortafuegos del servidor (y el de la red, si lo hay) debe permitir la entrada al **1512/tcp**.

> **Ojo con el puerto.** Chrome, Edge y Firefox bloquean algunos puertos (`ERR_UNSAFE_PORT`), entre
> ellos 512–515, 587, 993, 995, 1719–1723, 2049, 5060, 6000 o 6665–6669, y no se pueden desbloquear por
> política. Producción usa el **1512**, que no está en esa lista.

### 11.4 Desplegar una versión nueva o volver atrás
Actions › **Desplegar en Producción** › versión (sin issuer). Hace backup, cambia de versión, comprueba
`/api/health` y, si no responde, vuelve sola a la anterior. Para volver atrás, se despliega la versión
anterior. El historial queda en `/opt/primesuite-prod/versiones.log` y en el resumen de cada ejecución.

### 11.5 Instalar en otro servidor
Descarga el `primesuite-<versión>.tar.gz` de la Release y sigue su `LEEME.md`
(`bash install.sh --dir … --issuer … --port …`; `--help` para todas las opciones).
