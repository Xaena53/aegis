#!/usr/bin/env node
// Google OAuth refresh token üretici.
// Kullanım: .env içine GOOGLE_ADS_CLIENT_ID ve GOOGLE_ADS_CLIENT_SECRET yazdıktan sonra `npm run auth`.
// Tarayıcı açılır, Google hesabınla izin verirsin, refresh token terminale yazılır.
import http from "node:http";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// .env'i sade biçimde oku (bağımlılıksız)
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("HATA: .env içinde GOOGLE_ADS_CLIENT_ID ve GOOGLE_ADS_CLIENT_SECRET dolu olmalı.");
  process.exit(1);
}

const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/adwords";

const STATE = randomBytes(16).toString("hex"); // CSRF koruması

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: STATE,
  }).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (url.searchParams.get("state") !== STATE) {
    res.writeHead(403).end("state uyusmadi");
    console.error("HATA: OAuth state eşleşmedi — istek bu scriptten çıkmamış olabilir.");
    return;
  }
  if (error || !code) {
    res.end("Yetkilendirme reddedildi. Terminale dönün.");
    console.error("Yetkilendirme başarısız:", error);
    server.close();
    process.exit(1);
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      throw new Error("refresh_token dönmedi: " + JSON.stringify(tokens));
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<h2>Tamam! Terminale dönebilirsin, bu sekmeyi kapat.</h2>");
    // .env'e otomatik yaz (varsa satırı güncelle, yoksa ekle; dosya yoksa .env.example'dan başlat)
    try {
      let envText = existsSync(".env")
        ? readFileSync(".env", "utf8")
        : existsSync(".env.example")
          ? readFileSync(".env.example", "utf8")
          : "";
      if (/^GOOGLE_ADS_REFRESH_TOKEN=.*$/m.test(envText)) {
        envText = envText.replace(/^GOOGLE_ADS_REFRESH_TOKEN=.*$/m, `GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}`);
      } else {
        envText += `${envText.endsWith("\n") || !envText ? "" : "\n"}GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}\n`;
      }
      writeFileSync(".env", envText);
      console.log("\n✔ Refresh token alındı ve .env dosyasına YAZILDI. Sunucuyu yeniden başlatman yeterli.");
    } catch (we) {
      console.log("\n.env yazılamadı (" + we.message + ") — satırı elle ekle:");
      console.log(`GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}`);
    }
  } catch (e) {
    res.end("Token alınamadı, terminale bakın.");
    console.error("Token hatası:", e.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`HATA: ${PORT} portu dolu. Eski bir auth denemesi açık kalmış olabilir — kapatıp tekrar dene.`);
  } else {
    console.error("Sunucu hatası:", e.message);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Tarayıcı açılıyor... Açılmazsa şu URL'i elle aç:\n\n" + authUrl + "\n");
  const opener = process.platform === "win32" ? "start \"\"" : process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${opener} "${authUrl.replaceAll('"', '\\"')}"`);
});
