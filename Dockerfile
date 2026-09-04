# SPDX-License-Identifier: AGPL-3.0-only
# Aegis — hosted (HTTP) sunucu imajı
#
# Node 22.13+ ZORUNLU: hosted mod `node:sqlite` kullanır ve bu modül Node 22.5'te
# geldi, 22.13'te bayraksız hale geldi. Node 18/20 ile ilk import'ta çöker.
# node:22-alpine güncel 22.x'i çeker (>= 22.13); package.json'daki engines alanı
# da aynı sınırı doğrular.

# ── 1. Aşama: derleme (dev bağımlılıkları dahil) ──────────────────────────
FROM node:22-alpine AS derleme
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── 2. Aşama: yalnız üretim bağımlılıkları ────────────────────────────────
FROM node:22-alpine AS bagimliliklar
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── 3. Aşama: çalışma imajı (yalnız dist + üretim node_modules) ───────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Port, deponun her yerindeki varsayılanla AYNI olmalı: .env.example, src/http.ts
# yedeği ve AEGIS_PUBLIC_URL örnekleri 8787 der. Farklı bir imaj portu, kopyalanan
# .env'deki AEGIS_PUBLIC_URL ile uyuşmayınca her /mcp isteğini 403'e düşürür.
ENV PORT=8787

# package.json çalışma anında da gerekli: "type": "module" olmadan Node,
# dist/http.js'i CommonJS sanır ve ilk import'ta çöker.
COPY package.json ./
COPY --from=bagimliliklar /app/node_modules ./node_modules
COPY --from=derleme /app/dist ./dist

# Veritabanı kalıcı bir birimde tutulmalı: içinde ŞİFRELİ refresh token'lar var.
# WAL modu .db-wal ve .db-shm yan dosyaları üretir; üçü birlikte yedeklenmeli.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
ENV AEGIS_DB=/data/aegis.db

# Kök olarak çalıştırma
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# TEK INSTANCE: oturumlar ve hız sınırı sayaçları süreç belleğindedir.
# Birden çok replika çalıştırmak 404 session_not_found döngüsü yaratır.
CMD ["node", "dist/http.js"]
