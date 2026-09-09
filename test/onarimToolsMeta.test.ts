// SPDX-License-Identifier: AGPL-3.0-only
/**
 * src/tools/meta.ts — onarım gerileme testleri.
 *
 * İki bulgu, tek ilke: ARAÇ KATMANI, ALTINDAKİ KATMANIN SÖYLEMEDİĞİ ŞEYİ SÖYLEMEZ.
 *
 *  1) meta/client.ts, gözleyemediği bir yazma için özellikle "başarısız" DEMEYEN bir cümle
 *     üretir (metaClient.test.ts o cümlede 'başarısız' kelimesini yasaklar). Araç katmanı
 *     bu cümleyi `Meta işlemi başarısız: ...` diye sarmalayarak ajana tam da o yasak iddiayı
 *     iletiyordu — ve "hiçbir şey olmadı" duyan ajanın olağan hamlesi tekrar denemektir,
 *     yani bütçeyi ikinci kez artırmak ya da ikinci bir kampanya doğurmak.
 *
 *  2) campaignId hiç doğrulanmadan Graph API YOL PARÇASI olarak kullanılıyordu; Google
 *     tarafındaki `invalidId` kelepçesinin Meta karşılığı hiç yoktu. "act_.../campaigns"
 *     ya da "../me/adaccounts" bir kimlik değil, okumayı VE ardından gelen yazmayı
 *     operatörün adını bile duymadığı bir düğüme çeviren bir yönlendirmedir.
 *
 * Ağa çıkılmaz: sahte Meta kanalı enjekte edilir ve hangi çağrıların yapıldığı ölçülür.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { __setMetaKanalForTests, type MetaKampanya } from "../src/meta/client.js";

const TOKEN = "meta-gizli-jeton-1234567890";
const HESAP = "act_555000111";

/** Sahte kanala giden çağrılar — "hangi düğüme yazıldı" ölçülebilsin diye. */
let cagrilar: string[] = [];

afterEach(() => {
  __setMetaKanalForTests(undefined);
  cagrilar = [];
});

interface Secenek {
  mevcutButce?: number;
  /** kampanyaOlustur fırlatsın. */
  olusturPatlasin?: () => Error;
  /** butceGuncelle / durumDegistir fırlatsın. */
  yazPatlasin?: () => Error;
}

async function kur(opts: Secenek = {}) {
  cagrilar = [];
  const kampanya: MetaKampanya = {
    id: "120200000000001",
    ad: "Test Kampanyası",
    // Gerçek bir kampanya okumasını canlandırıyor: gerçek istemci `objective` alanını
    // (yalnız kampanyalarda bulunur) sorar ve türü ondan saptar. kampanyaDegilseRet bir AK
    // LİSTE olduğu için bu alan zorunlu — sessizlik gözlem sayılmaz.
    dugumTuru: "kampanya",
    durum: "PAUSED",
    gunlukButce: opts.mevcutButce,
    butceKaynagi: "kampanya",
  };

  __setMetaKanalForTests({
    async kampanyaOlustur({ ad, gunlukButce }) {
      cagrilar.push("kampanyaOlustur");
      if (opts.olusturPatlasin) throw opts.olusturPatlasin();
      return { id: "120200000000002", ad, durum: "PAUSED", gunlukButce };
    },
    async kampanyaOku(id) {
      cagrilar.push(`kampanyaOku:${id}`);
      return kampanya;
    },
    async butceGuncelle(id, yeni) {
      cagrilar.push(`butceGuncelle:${id}:${yeni}`);
      if (opts.yazPatlasin) throw opts.yazPatlasin();
    },
    async durumDegistir(id, durum) {
      cagrilar.push(`durumDegistir:${id}:${durum}`);
      if (opts.yazPatlasin) throw opts.yazPatlasin();
    },
  });

  const config: any = {
    developerToken: "x",
    clientId: "x",
    clientSecret: "x",
    refreshToken: "x",
    writeEnabled: true,
    maxDailyBudget: 500,
    metaToken: TOKEN,
    metaAdAccountId: HESAP,
    simSwapWindowHours: 72,
    reachCheck: false,
    stepUp: false,
    devSwapCheck: false,
    callFwdCheck: false,
    // Ağ katmanı yapılandırılmamış: kapı "kapalı" dalından geçer, ölçülen şey ağ zinciri
    // değil ARAÇ KATMANININ kendi davranışıdır.
    nacToken: undefined,
    approverPhone: undefined,
  };

  const server = buildServer(() => ({ config }) as any);
  // Elicitation bildirilmez: insana soracak kanal yoktur, dolayısıyla onay isteyen dallar
  // zaten reddeder ve testler yazma yollarını tek başına ölçer.
  const istemci = new Client({ name: "onarim-meta", version: "1.0.0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), istemci.connect(b)]);
  return istemci;
}

const metin = (r: any) => String(r.content?.[0]?.text ?? "");

/** meta/client.ts'in iptal edilen POST için ürettiği cümlenin BİREBİR kendisi. */
const ZAMAN_ASIMI = () =>
  new Error(
    "Meta işleminin SONUCU BİLİNMİYOR: istek 15 saniyede yanıt vermediği için iptal " +
      "edildi, ama iptal bizim tarafımızdadır — Meta isteği almış ve UYGULAMIŞ olabilir. " +
      "TEKRAR DENEME; önce Meta Ads Manager'dan kampanyanın güncel durumunu ve bütçesini " +
      "doğrula."
  );

/** Kimliksiz oluşturma yanıtı için üretilen cümlenin BİREBİR kendisi. */
const KIMLIKSIZ = () =>
  new Error(
    "Meta kampanya oluşturma yanıtında kimlik (id) yok — kampanyanın kurulup " +
      "kurulmadığı doğrulanamıyor. TEKRAR DENEME; önce Meta Ads Manager'dan kontrol et."
  );

/* ── BULGU 1: sonucu bilinmeyen yazma "başarısız" diye etiketlenemez ───────── */

test("KRİTİK: zaman aşımına uğrayan Meta YAZMASI ajana 'başarısız' diye sunulmaz", async () => {
  const c = await kur({ mevcutButce: 100, yazPatlasin: ZAMAN_ASIMI });
  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "PAUSED" },
  });

  const t = metin(r);
  assert.doesNotMatch(
    t,
    /başarısız/iu,
    "POST gözlenemedi; 'başarısız' ajana 'hiçbir şey olmadı' der ve tekrar denemeye iter"
  );
  assert.match(t, /SONUCU BİLİNMİYOR/u, "belirsizlik ajana ADIYLA söylenmeli");
  assert.match(t, /UYGULAMIŞ olabilir/u, "işlemin geçmiş olabileceği korunmalı");
  assert.match(t, /TEKRAR DENEME/u, "tekrar denemenin tehlikesi korunmalı");
  assert.equal(r.isError, true, "tamamlanmamış bir işlem hâlâ hata sinyali taşımalı");
});

test("KRİTİK: kimliksiz oluşturma yanıtı da 'başarısız' diye özetlenmez", async () => {
  const c = await kur({ olusturPatlasin: KIMLIKSIZ });
  const r: any = await c.callTool({
    name: "create_meta_campaign",
    arguments: { name: "Yeni", objective: "OUTCOME_TRAFFIC", dailyBudget: 50 },
  });

  assert.doesNotMatch(metin(r), /başarısız/iu, "kampanya kurulmuş OLABİLİR; 'başarısız' yanlış");
  assert.match(metin(r), /doğrulanamıyor/u, "belirsizlik cümlesi olduğu gibi geçmeli");
});

test("Bütçe yazmasında zaman aşımı: 'başarısız' yok, belirsizlik var", async () => {
  // Artış dalı onay ister; elicitation yok, bu yüzden yazma yoluna AZALTMA ile gidilir.
  const c = await kur({ mevcutButce: 300, yazPatlasin: ZAMAN_ASIMI });
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: "120200000000001", dailyBudget: 100 },
  });

  assert.doesNotMatch(metin(r), /başarısız/iu, "bütçe POST'u uygulanmış olabilir");
  assert.match(metin(r), /SONUCU BİLİNMİYOR/u);
});

test("GERÇEK ret hâlâ 'Meta işlemi başarısız' der — düzeltme her hatayı belirsiz saymaz", async () => {
  const c = await kur({
    mevcutButce: 100,
    yazPatlasin: () => new Error('Meta API 401: {"error":{"message":"Invalid OAuth token"}}'),
  });
  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "PAUSED" },
  });

  assert.match(
    metin(r),
    /^Meta işlemi başarısız: /u,
    "401 gerçekten reddedildi: burada 'başarısız' doğru özet"
  );
  assert.equal(r.isError, true);
});

test("Belirsiz metin de jeton maskesinden geçer (önek kalkması sızıntı açmaz)", async () => {
  const c = await kur({
    mevcutButce: 100,
    yazPatlasin: () =>
      new Error(`Meta işleminin SONUCU BİLİNMİYOR: access_token=${TOKEN} ile gönderildi`),
  });
  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "PAUSED" },
  });

  assert.doesNotMatch(metin(r), new RegExp(TOKEN, "u"), "ham jeton ajana ASLA sızmaz");
  assert.match(metin(r), /\*\*\*/u, "maskeleme uygulanmış olmalı");
});

/* ── BULGU 2: campaignId bir Graph yol parçası; kelepçesiz kullanılamaz ────── */

const KOTU_KIMLIKLER = [
  "act_555000111/campaigns", // hesabın TÜM kampanyaları düğümü
  "../me/adaccounts", // yol dışına çıkma
  "me", // tamamen başka bir düğüm
  "120200000000001/copies", // kampanyanın alt kenarı
  "120200000000001?fields=id", // sorgu enjeksiyonu
  "12020000000000a", // rakam dışı
  "120200000000001 120200000000002", // içeride boşluk: tek düğüm değil
  "", // Not: boş dize zaten zod'un min(1) kapısında elenir; buradaki kapı ikinci sıradır.
].filter((s) => s.length > 0);

test("KRİTİK: rakam olmayan campaignId yayına almayı REDDEDER; hiçbir çağrı yapılmaz", async () => {
  for (const kotu of KOTU_KIMLIKLER) {
    const c = await kur({ mevcutButce: 100 });
    const r: any = await c.callTool({
      name: "set_meta_campaign_status",
      arguments: { campaignId: kotu, status: "ACTIVE" },
    });

    assert.match(
      metin(r),
      /Geçersiz Meta kampanya kimliği/u,
      `'${kotu}' bir kimlik değil, yönlendirmedir — reddedilmeli`
    );
    assert.deepEqual(cagrilar, [], `'${kotu}' için Meta'ya HİÇBİR çağrı yapılmamalı`);
  }
});

test("KRİTİK: rakam olmayan campaignId DURAKLATMA yolunda da yazmayı engeller", async () => {
  // Duraklatma bilerek okumaya bağlı DEĞİL (durdurma yönü güvenli yöndür). Ama geçersiz
  // bir kimlikle atılan POST bir duraklatma değil, adı konmamış bir düğüme yazmadır.
  for (const kotu of KOTU_KIMLIKLER) {
    const c = await kur({ mevcutButce: 100 });
    const r: any = await c.callTool({
      name: "set_meta_campaign_status",
      arguments: { campaignId: kotu, status: "PAUSED" },
    });

    assert.match(metin(r), /Geçersiz Meta kampanya kimliği/u);
    assert.deepEqual(cagrilar, [], `'${kotu}' duraklatma yolunda da Meta'ya yazmamalı`);
  }
});

test("KRİTİK: rakam olmayan campaignId bütçe yazmasını da engeller", async () => {
  for (const kotu of KOTU_KIMLIKLER) {
    const c = await kur({ mevcutButce: 300 });
    const r: any = await c.callTool({
      name: "update_meta_campaign_budget",
      arguments: { campaignId: kotu, dailyBudget: 100 }, // azaltma: onay istemez
    });

    assert.match(metin(r), /Geçersiz Meta kampanya kimliği/u);
    assert.deepEqual(cagrilar, [], `'${kotu}' için okuma da yazma da yapılmamalı`);
  }
});

test("Kelepçe MEŞRU kimliği geçirir ve kanala KIRPILMIŞ değeri verir", async () => {
  /**
   * Baştaki/sondaki boşluk bir REDDİ değil bir NORMALLEŞTİRMEYİ hak eder — Google
   * ikizindeki kural birebir aynı: `invalidId` kırpılmış değeri doğrular, `cleanId` de
   * yola O kırpılmış değeri koyar. Aksi halde " 123" doğrulamayı geçip bozuk bir yol
   * üretirdi. Bu test o iki adımın AYRILMADIĞINI kilitler.
   */
  const c = await kur({ mevcutButce: 100 });
  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "  120200000000001  ", status: "PAUSED" },
  });

  assert.match(metin(r), /durumu: PAUSED/u, "kırpınca geçerli olan kimlik reddedilmemeli");
  assert.ok(
    cagrilar.includes("durumDegistir:120200000000001:PAUSED"),
    `kanala KIRPILMIŞ kimlik gitmeli; gerçekleşen: ${JSON.stringify(cagrilar)}`
  );

  const c2 = await kur({ mevcutButce: 300 });
  const r2: any = await c2.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: " 120200000000001 ", dailyBudget: 100 },
  });
  assert.match(metin(r2), /Meta bütçesi güncellendi/u);
  assert.ok(
    cagrilar.includes("butceGuncelle:120200000000001:100"),
    `bütçe yolunda da kırpılmış kimlik gitmeli; gerçekleşen: ${JSON.stringify(cagrilar)}`
  );
  assert.ok(
    cagrilar.includes("kampanyaOku:120200000000001"),
    "okuma da aynı kırpılmış kimliği kullanmalı"
  );
});
