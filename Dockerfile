# AdsPilot hosted sunucusu
#
# Node 22.13+ ZORUNLU: hosted mod `node:sqlite` kullanır ve bu modül Node 22.5'te
# geldi, 22.13'te bayraksız hale geldi. Node 18/20 ile ilk import'ta çöker.
FROM node:22.13-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.13-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Veritabanı kalıcı bir birimde tutulmalı: içinde ŞİFRELİ refresh token'lar var.
# WAL modu .db-wal ve .db-shm yan dosyaları üretir; üçü birlikte yedeklenmeli.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
ENV ADSPILOT_DB=/data/adspilot.db

# Kök olarak çalıştırma
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# TEK INSTANCE: oturumlar ve hız sınırı sayaçları süreç belleğindedir.
# Birden çok replika çalıştırmak 404 session_not_found döngüsü yaratır.
CMD ["node", "dist/http.js"]
