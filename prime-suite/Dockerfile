# Prime Suite · imagen de producción autoalojada (Node; datos en SQL Server)
# Etapa de compilación: instala dependencias y genera el frontend (dist/).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# Etapa de ejecución: solo lo necesario para servir la app.
FROM node:22-bookworm-slim AS runtime
# Versión publicada (la pone el workflow «Publicar versión»; en desarrollo queda vacía).
ARG PRIME_VERSION=
ENV PRIME_VERSION=${PRIME_VERSION} \
    NODE_ENV=production \
    PRIME_STORE=sqlserver \
    PRIME_SQLITE_PATH=/data/prime-suite.db \
    PORT=8080
WORKDIR /app
# Reutiliza node_modules de la etapa de build (incluye tsx para ejecutar el servidor y mssql para Evalos).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm","run","start"]
