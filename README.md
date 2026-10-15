# Prime Suite v2 · Prime ID

Portal de aplicaciones con **SSO propio (Prime ID)**, **integración de cualquier app por URL**, **panel de widgets** y módulos nativos: **Prime Insights** (dashboards de Superset) y **Atajos de Evalos** (Evalos 8).
Frontend React + Vite y backend Node/TypeScript. En producción corre en **nuestro servidor Ubuntu (Docker) con los datos en SQL Server**; Netlify queda como entorno de pruebas.

| Carpeta | Contenido |
|---|---|
| [`prime-suite/`](prime-suite/) | La aplicación. Documentación completa en [`prime-suite/README.md`](prime-suite/README.md): integraciones, Prime Insights, Atajos de Evalos, desarrollo y estructura. |
| [`deploy/`](deploy/) | Instalación autoalojada (Docker Compose, Caddy, `.env.example`). Guía en [`deploy/DEPLOY.md`](deploy/DEPLOY.md). |
| [`scripts/`](scripts/) | Despliegue automático (`deploy-ubuntu.sh`) e instalación del runner (`setup-runner-ubuntu.sh`). |

## Producción · despliegue automático

- **Cada push a `main` se despliega solo** en el servidor Ubuntu (`/opt/primesuite`) mediante el workflow `.github/workflows/deploy-ubuntu.yml` («Desplegar en Ubuntu»), que corre en un runner autoalojado del propio servidor.
- `scripts/deploy-ubuntu.sh` hace backup de los datos, reconstruye la imagen, reinicia la app y comprueba `/api/health`. Si la versión nueva no responde, **vuelve sola a la anterior**.
- Para lanzar un despliegue a mano: GitHub › Actions › *Desplegar en Ubuntu* › *Run workflow*.
- Las variables de la instalación (`deploy/.env`) y los certificados viven solo en el servidor; nunca se suben al repo.

## Desarrollo rápido

```bash
cd prime-suite
npm install
npm run dev     # API en :8888 + Vite en :5173
npm test        # tests del servidor
```
