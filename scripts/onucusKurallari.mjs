#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Aegis — Google Ads MCP server
 * Copyright (C) 2026 Xaena53 (github.com/Xaena53) and the Aegis contributors
 *
 * This program is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License version 3 as published by the Free
 * Software Foundation. See the LICENSE file for details.
 */

/**
 * ÖN-UÇUŞ KURALLARI — prova ve duman testinin ORTAK karar mantığı.
 *
 * NEDEN AYRI DOSYA: bu iki kural (derleme tazeliği ve ağ kapısı yapılandırması) daha
 * önce `scripts/prova.mjs` içine gömülüydü. Gömülü olduğu için hiçbir testin ulaşamadığı
 * bir karardı: kural yanlış olsa bile süit yeşil kalıyordu ve yanlışlık ancak sahnede
 * ortaya çıkıyordu. Kararlar saf fonksiyonlara ayrıldı ki test edilebilsinler; betikler
 * yalnız bu kararları RAPORLASIN.
 *
 * Ortak olmasının ikinci sebebi: aynı tazelik önkoşulu `scripts/smoke.mjs`te de gerekli.
 * Duman testi `dist/index.js`i sınar; bayat bir ikili sınandığında "canlı doğrulandı"
 * diyen fiş, aslında ARTIK VAR OLMAYAN bir kodun fişidir.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/** Ağaçtaki en yeni dosyanın mtime'ı — `npm run build` gerekip gerekmediğinin ölçüsü. */
export function enYeniDosya(dizin, kabul) {
  let enYeni = { ms: 0, yol: "" };
  const gez = (d) => {
    let girdiler;
    try {
      girdiler = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const g of girdiler) {
      const tam = join(d, g.name);
      if (g.isDirectory()) {
        gez(tam);
        continue;
      }
      if (!kabul(g.name)) continue;
      try {
        const s = statSync(tam);
        if (s.mtimeMs > enYeni.ms) enYeni = { ms: s.mtimeMs, yol: tam };
      } catch {
        /* okunamayan tek dosya kontrolü bozmasın — sonuç yine de mtime'sız kalırsa
           aşağıdaki "mtime-okunamadi" dalı devreye girer ve kararı kapalı arızaya alır */
      }
    }
  };
  gez(dizin);
  return enYeni;
}

export const saatMetni = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
export const kisaYol = (kok, yol) => (yol ? relative(kok, yol).replace(/\\/g, "/") : "");

/**
 * DERLEME TAZELİĞİ — kapalı arıza.
 *
 * NEDEN KAPALI ARIZA: bu kural eskiden UYARI üretiyordu ve uyarı çıkış kodunu bozmuyordu.
 * Yani kapı düzeltmesini derlemeyi unutan geliştirici YEŞİL rapor alıyor, prova bayat
 * ikiliyi koşturup "SAHNEYE HAZIR" diyordu — betiğin var olma sebebi olan arıza, tam da
 * betiğin onayıyla gerçekleşiyordu. Aynısı mtime okunamayan dal için de geçerli:
 * "tazeliği ölçemedim" ile "taze" AYNI ŞEY DEĞİLDİR, ikisi de RET demektir.
 *
 * @returns {{ taze: boolean, kod: "taze"|"dist-yok"|"mtime-okunamadi"|"bayat", not: string,
 *             kaynak: {ms:number,yol:string}, derleme: {ms:number,yol:string} }}
 */
export function derlemeTazeligi(kok) {
  const giris = join(kok, "dist", "index.js");
  const bos = { ms: 0, yol: "" };
  if (!existsSync(giris)) {
    return { taze: false, kod: "dist-yok", not: "dist/index.js yok — `npm run build` çalıştır", kaynak: bos, derleme: bos };
  }
  const kaynak = enYeniDosya(join(kok, "src"), (a) => a.endsWith(".ts"));
  const derleme = enYeniDosya(join(kok, "dist"), (a) => a.endsWith(".js"));
  if (!kaynak.ms || !derleme.ms) {
    return {
      taze: false,
      kod: "mtime-okunamadi",
      not: "mtime okunamadı — tazelik DOĞRULANAMADI; doğrulanamayan derleme sınanmaz, `npm run build` çalıştır",
      kaynak,
      derleme,
    };
  }
  if (kaynak.ms > derleme.ms) {
    return {
      taze: false,
      kod: "bayat",
      not:
        `${kisaYol(kok, kaynak.yol)} (${saatMetni(kaynak.ms)}) derlemeden yeni ` +
        `(${kisaYol(kok, derleme.yol)}, ${saatMetni(derleme.ms)}) — \`npm run build\` çalıştır`,
      kaynak,
      derleme,
    };
  }
  return {
    taze: true,
    kod: "taze",
    not: `en yeni kaynak ${saatMetni(kaynak.ms)} <= derleme ${saatMetni(derleme.ms)}`,
    kaynak,
    derleme,
  };
}

/**
 * AĞ KAPISI YAPILANDIRMASI — sunucunun kendi kapalı arıza kurallarının aynası.
 *
 * Sunucu (src/networkTrust.ts) onaylayıcı numarası olmadan hiçbir harcama artışını
 * geçirmez; bunu SİMÜLASYON kanalında da yapar ("onaylayici-numarasi-yok"). Prova
 * eskiden numarayı yalnız gerçek token dalında sorguluyordu: docker-compose'daki iki
 * yorumlu satırdan yalnız simülasyonu açan operatör "SAHNEYE HAZIR" alıyor, sahnede
 * her bütçe artışı istem gösterilmeden reddediliyordu. Kural artık kanalı değil,
 * SONUCU ölçüyor: kanallardan biri açıksa numara zorunludur.
 *
 * @returns {{ durum: "gecti"|"uyari"|"kaldi", kod: string }}
 */
export function agKapisiKarari({ simVar, tokenVar, telefonVar, simDeger }) {
  if (simVar && tokenVar) return { durum: "kaldi", kod: "yapilandirma-celiskili" };
  if ((tokenVar || simVar) && !telefonVar) return { durum: "kaldi", kod: "onaylayici-numarasi-yok" };
  if (simVar && simDeger !== "temiz" && simDeger !== "degisti") {
    return { durum: "uyari", kod: "simulasyon-degeri-tanimsiz" };
  }
  return { durum: "gecti", kod: "tamam" };
}
