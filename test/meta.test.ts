// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Meta araçları — güven kapısının ALAN-BAĞIMSIZ olduğunun kanıtı.
 *
 * Bu dosyanın işi Meta'nın API'sini sınamak değil. İşi şunu göstermek: "insana sorulmadan
 * önce ağa sor" kuralı Google Ads'e özgü bir özellik değil. Aynı kapı, aynı risk
 * kademeleri, aynı kapalı-arıza davranışı ikinci bir harcama alanında da geçerli.
 *
 * Ağa çıkılmaz: __setMetaKanalForTests ile sahte istemci enjekte edilir ve hangi araçların
 * çağrıldığı kaydedilir — böylece "duraklatılmış doğar" gibi sözler iddia değil ölçüm olur.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import {
  __setMetaKanalForTests,
  hataTemizle,
  hesapYolu,
  minorUnit,
  type MetaKampanya,
} from "../src/meta/client.js";
import { __setSimSwapKanalForTests, __setErisimKanalForTests } from "../src/networkTrust.js";

const HESAP = "act_555000111";
const TOKEN = "meta-gizli-jeton-1234567890";

interface SahteSecenek {
  /** Ağ kapısı: SIM değişmiş sayılsın mı? */
  simDegisti?: boolean;
  /** Ağ doğrulaması hiç yapılandırılmamış olsun mu (token yok)? */
  agKapali?: boolean;
  /** Kampanyanın mevcut bütçesi; undefined = okunamadı. */
  mevcutButce?: number;
  /** Bütçe okunamadıysa istemcinin bildirdiği sebep (ret mesajına geçmeli). */
  butceNotu?: string;
  /** Rakamın NEREDEN geldiği; onay özetinin bunu söylemesi gerekir. */
  butceKaynagi?: "kampanya" | "reklam-setleri";
  /** İnsan onay istemine verilecek cevap. */
  onay?: boolean;
  /** Yazma izni. */
  yazma?: boolean;
  metaToken?: string;
  metaHesap?: string;
  /**
   * Kademeli doğrulama (ADSPILOT_STEPUP) açık mı? Açıkken erişilebilirlik halkası da
   * GERÇEK kanaldan koşar: yükseltmenin en az bir gerçek doğrulayana ihtiyacı vardır.
   */
  stepUp?: boolean;
  /**
   * İstemci MCP elicitation BİLDİRMİYOR — yani insana soracak bir kanal yok. Kapının
   * zayıf (confirm) dalı tam olarak burada koşar.
   */
  elicitationsiz?: boolean;
}

/** Çağrılan Meta işlemleri — "hangi araç çağrıldı" ölçülebilsin diye. */
let cagrilar: string[] = [];
/** Gösterilen onay istemi sayısı — "istem hiç gösterilmedi" ölçülebilsin diye. */
let istemSayisi = 0;
/**
 * İnsana GÖSTERİLEN metinler. Sayıyı saymak "insana soruldu mu" sorusunu cevaplar ama
 * "insana NE soruldu" sorusunu cevaplamaz — ve onay özetinin içeriği tam da operatörün
 * rakamı Ads Manager'da doğrulayıp doğrulayamayacağını belirleyen şeydir.
 */
let istemMetinleri: string[] = [];

afterEach(() => {
  __setMetaKanalForTests(undefined);
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  cagrilar = [];
  istemSayisi = 0;
  istemMetinleri = [];
  // Günlük bir SÜREÇ AYARI: açık bırakılırsa sonraki testler farkında olmadan yazar.
  delete process.env.ADSPILOT_DECISION_LOG;
  if (gunlukKok) {
    rmSync(gunlukKok, { recursive: true, force: true });
    gunlukKok = undefined;
  }
});

async function kur(opts: SahteSecenek = {}) {
  const kampanya: MetaKampanya = {
    id: "120200000000001",
    ad: "Test Kampanyası",
    durum: "PAUSED",
    gunlukButce: opts.mevcutButce,
    butceNotu: opts.butceNotu,
    butceKaynagi: opts.butceKaynagi,
  };

  __setMetaKanalForTests({
    async kampanyaOlustur({ ad, gunlukButce }) {
      cagrilar.push("kampanyaOlustur");
      return { id: "120200000000002", ad, durum: "PAUSED", gunlukButce };
    },
    async kampanyaOku() {
      cagrilar.push("kampanyaOku");
      return kampanya;
    },
    async butceGuncelle(_id, yeni) {
      cagrilar.push(`butceGuncelle:${yeni}`);
      kampanya.gunlukButce = yeni;
    },
    async durumDegistir(_id, durum) {
      cagrilar.push(`durumDegistir:${durum}`);
      kampanya.durum = durum;
    },
  });

  __setSimSwapKanalForTests({
    verifySimSwap: async () => opts.simDegisti === true,
  });
  // Yükseltmeyi TAŞIYACAK gerçek halka: temiz dönmezse kademe zaten düz rette biter.
  if (opts.stepUp) __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });

  const config: any = {
    developerToken: "x",
    clientId: "x",
    clientSecret: "x",
    refreshToken: "x",
    writeEnabled: opts.yazma !== false,
    maxDailyBudget: 500,
    metaToken: "metaToken" in opts ? opts.metaToken : TOKEN,
    metaAdAccountId: "metaHesap" in opts ? opts.metaHesap : HESAP,
    simSwapWindowHours: 72,
    reachCheck: opts.stepUp === true,
    stepUp: opts.stepUp === true,
    devSwapCheck: false,
    callFwdCheck: false,
    // agKapali: token yok → ağ katmanı "kapalı" dalına girer, kapı geçirir.
    nacToken: opts.agKapali ? undefined : "nac-token",
    approverPhone: opts.agKapali ? undefined : "+905551112233",
  };

  const server = buildServer(() => ({ config }) as any);
  const istemci = new Client(
    { name: "meta-test", version: "1.0.0" },
    { capabilities: opts.elicitationsiz ? {} : { elicitation: { form: {} } } }
  );
  // Yeteneği bildirmeyen istemciye SDK zaten handler taktırmaz; istem sayacının 0
  // kalması "gösterilecek kanal hiç yoktu"nun ölçüsüdür.
  if (!opts.elicitationsiz) {
    istemci.setRequestHandler(ElicitRequestSchema, async (istek: any) => {
      istemSayisi++;
      istemMetinleri.push(String(istek?.params?.message ?? ""));
      return opts.onay === false
        ? { action: "decline" as const }
        : { action: "accept" as const, content: { onay: true } };
    });
  }

  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), istemci.connect(b)]);
  return istemci;
}

const metin = (r: any) => String(r.content?.[0]?.text ?? "");

/* ── 1) Alan-bağımsızlık: kapı Meta'da da ateşleniyor ─────────────────────── */

test("KRİTİK: Meta yayına alma, SIM değişmişse İNSANA SORULMADAN reddedilir", async () => {
  const c = await kur({ simDegisti: true, mevcutButce: 100 });
  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "ACTIVE" },
  });

  assert.match(metin(r), /AĞ DOĞRULAMASI BAŞARISIZ/, "ağ kapısı Meta'da da konuşmalı");
  assert.equal(istemSayisi, 0, "ağ reddettiğinde onay istemi HİÇ gösterilmemeli");
  assert.ok(
    !cagrilar.some((x) => x.startsWith("durumDegistir")),
    "reddedilen yayına alma Meta'ya HİÇ yazmamalı"
  );
});

test("KRİTİK: Meta bütçe ARTIŞI, SIM değişmişse reddedilir; yazma olmaz", async () => {
  const c = await kur({ simDegisti: true, mevcutButce: 100 });
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: "120200000000001", dailyBudget: 200 },
  });

  assert.match(metin(r), /AĞ DOĞRULAMASI BAŞARISIZ/);
  assert.equal(istemSayisi, 0);
  assert.ok(!cagrilar.some((x) => x.startsWith("butceGuncelle")), "bütçe değişmemeli");
});

test("Meta bütçe artışı temiz sinyalde insana sorulur ve onayla uygulanır", async () => {
  const c = await kur({ mevcutButce: 100, onay: true });
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: "120200000000001", dailyBudget: 200 },
  });

  assert.equal(istemSayisi, 1, "temiz sinyalde insana SORULMALI");
  assert.ok(cagrilar.includes("butceGuncelle:200"), "onaydan sonra uygulanmalı");
  assert.match(metin(r), /100 → 200/);
});

test("Meta bütçe AZALTMA onay istemez (harcamayı düşürür)", async () => {
  const c = await kur({ mevcutButce: 200 });
  await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: "120200000000001", dailyBudget: 100 },
  });

  assert.equal(istemSayisi, 0, "azaltma için onay istenmemeli");
  assert.ok(cagrilar.includes("butceGuncelle:100"));
});

test("Meta DURAKLATMA onay istemez; YAYINA ALMA ister", async () => {
  const c = await kur({ onay: true, mevcutButce: 100 });
  await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "PAUSED" },
  });
  assert.equal(istemSayisi, 0, "duraklatma harcamayı düşürür — onay istenmez");

  await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "ACTIVE" },
  });
  assert.equal(istemSayisi, 1, "yayına alma onay istemeli");
});

/* ── 2) Duraklatılmış doğma sözü ──────────────────────────────────────────── */

test("KRİTİK: Meta kampanyası DURAKLATILMIŞ doğar ve durum parametresi YOKTUR", async () => {
  const c = await kur();
  const r: any = await c.callTool({
    name: "create_meta_campaign",
    arguments: { name: "Yeni", objective: "OUTCOME_TRAFFIC", dailyBudget: 50 },
  });

  assert.match(metin(r), /DURAKLATILMIŞ/);
  assert.ok(cagrilar.includes("kampanyaOlustur"));
  assert.ok(
    !cagrilar.some((x) => x.startsWith("durumDegistir")),
    "oluşturma yolu durum değiştirmemeli"
  );

  // Araç şemasında 'status' alanı OLMAMALI: çağıran duraklatılmışlığı geçememeli.
  const araclar: any = await c.listTools();
  const olustur = araclar.tools.find((t: any) => t.name === "create_meta_campaign");
  assert.ok(olustur, "create_meta_campaign kayıtlı olmalı");
  assert.ok(
    !Object.keys(olustur.inputSchema.properties ?? {}).includes("status"),
    "oluşturma aracında status parametresi olmamalı — söz çağrı yerine bırakılamaz"
  );
});

/* ── 3) Kelepçeler ve kapalı arıza ────────────────────────────────────────── */

test("Meta: tavan üstü bütçe reddedilir ve ağ kapısına HİÇ gelinmez", async () => {
  const c = await kur();
  const r: any = await c.callTool({
    name: "create_meta_campaign",
    arguments: { name: "Pahalı", objective: "OUTCOME_SALES", dailyBudget: 5000 },
  });

  assert.match(metin(r), /tavan|500/i);
  assert.equal(cagrilar.length, 0, "tavan aşımında Meta'ya hiç çağrı gitmemeli");
});

test("Meta: yazma kapalıysa hiçbir araç iş yapmaz", async () => {
  const c = await kur({ yazma: false });
  const r: any = await c.callTool({
    name: "create_meta_campaign",
    arguments: { name: "X", objective: "OUTCOME_TRAFFIC", dailyBudget: 10 },
  });
  assert.match(metin(r), /devre dışı/);
  assert.equal(cagrilar.length, 0);
});

test("Meta: token yokken araç SESSİZ KALMAZ, açıkça 'yapılandırılmamış' der", async () => {
  const c = await kur({ metaToken: undefined });
  const r: any = await c.callTool({
    name: "create_meta_campaign",
    arguments: { name: "X", objective: "OUTCOME_TRAFFIC", dailyBudget: 10 },
  });
  assert.match(metin(r), /ADSPILOT_META_TOKEN/);
  assert.equal(cagrilar.length, 0);
});

test("Meta: token var ama hesap kimliği yoksa KAPALI ARIZA", async () => {
  const c = await kur({ metaHesap: undefined });
  const r: any = await c.callTool({
    name: "create_meta_campaign",
    arguments: { name: "X", objective: "OUTCOME_TRAFFIC", dailyBudget: 10 },
  });
  assert.match(metin(r), /ADSPILOT_META_AD_ACCOUNT_ID/);
  assert.equal(cagrilar.length, 0, "hangi hesap olduğu belirsizken hiçbir şey yapılmamalı");
});

/* ── 4) Sır hijyeni ───────────────────────────────────────────────────────── */

test("KRİTİK: Meta hata metni access_token'ı ajana SIZDIRMAZ", () => {
  const ham =
    'Meta API 400: {"error":{"message":"Invalid parameter"}} ' +
    `url=https://graph.facebook.com/v21.0/act_1/campaigns?access_token=${TOKEN}`;
  const temiz = hataTemizle(ham, TOKEN);
  assert.doesNotMatch(temiz, new RegExp(TOKEN), "jeton hata metninde kalmamalı");
  assert.match(temiz, /\*\*\*/, "maskeleme izi görünmeli");
});

/* ── 5) Birim dönüşümü — iki API'nin iki ayrı ölçeği ──────────────────────── */

test("minorUnit: Meta kuruş ister — 12.34 → 1234, yuvarlama aleyhe kesmez", () => {
  assert.equal(minorUnit(12.34, 100), 1234);
  assert.equal(minorUnit(1.005, 100), 101, "kesme değil yuvarlama: müşteri aleyhine eksiltme olmaz");
  assert.equal(minorUnit(0.1, 100), 10);
});

test("minorUnit: çarpan para birimine göre değişir — JPY'de ×100 yoktur", () => {
  /**
   * Çarpanın parametre olmasının sebebi bu: aynı sayı USD hesapta 1234, JPY hesapta
   * 12'dir (offset 1, tam sayıya yuvarlanır). Sabit ×100 JPY'de 100 kat fazla harcatırdı.
   */
  assert.equal(minorUnit(1234, 1), 1234, "JPY: 1 birim = 1 yen");
  assert.equal(minorUnit(1234, 100), 123400, "USD: 1 birim = 100 cent");
});

test("hesapYolu: act_ öneki tekrarlanmaz, çıplak rakam normalize edilir", () => {
  assert.equal(hesapYolu("act_123"), "act_123");
  assert.equal(hesapYolu("123"), "act_123");
  assert.equal(hesapYolu(" 123 "), "act_123");
});

/* ── 6) Karar günlüğü: RİSKTEKİ TUTAR Meta tarafında da ölçülüyor ─────────── */

/**
 * Denetçinin sorusu iki parçalıdır: "kaç kez VE NE BÜYÜKLÜKTE bir harcama". İkinci
 * parça `tutar` alanıyla cevaplanır ve Meta'nın iki çağrı yeri de onu geçer — ama
 * kuralın asıl sivri ucu tersi: OKUNAMAYAN bütçe uydurulmaz, alan HİÇ yazılmaz.
 *
 * Bu bölümün varlık nedeni kapsam boşluğuydu: alan src/tools/meta.ts'e eklendiğinde
 * Google tarafı (kararGunlugu.test.ts) davranışsal olarak sınandı, Meta tarafı hiç
 * sınanmadı — "okunamayan bütçe kayda girmez" kuralının Meta'daki tek ifadesi
 * yorumdan ibaret kaldı. Aşağıdakiler onu ÖLÇÜME çevirir.
 */

/** Günlüğün yazıldığı geçici dizin; afterEach siler. */
let gunlukKok: string | undefined;

/** Günlüğü AÇAR: geçici dizin + env. Dönüş, okunacak JSONL dosyasının yoludur. */
function gunlukAc(): string {
  gunlukKok = mkdtempSync(path.join(tmpdir(), "adspilot-meta-karar-"));
  const dosya = path.join(gunlukKok, "kararlar.jsonl");
  process.env.ADSPILOT_DECISION_LOG = dosya;
  return dosya;
}

function satirlar(dosya: string): any[] {
  return readFileSync(dosya, "utf8")
    .split("\n")
    .filter((x) => x.trim() !== "")
    .map((x) => JSON.parse(x));
}

test("TUTAR: Meta bütçe artışı geçtiğinde kayda YENİ bütçe düşer", async () => {
  const gunluk = gunlukAc();
  const c = await kur({ mevcutButce: 100, onay: true });

  await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: "120200000000001", dailyBudget: 200 },
  });

  assert.ok(cagrilar.includes("butceGuncelle:200"), "önce işlemin gerçekten olduğu sabitlensin");
  const k = satirlar(gunluk);
  assert.equal(k.length, 1, "risk etiketli tek karar, tek satır");
  assert.equal(k[0].karar, "gecti");
  assert.equal(k[0].risk, "medium", "bütçe ARTIŞI orta risk");
  assert.equal(k[0].tutar, 200, "riskteki tutar YENİ bütçedir — harcamanın çıkacağı tavan");
  assert.equal(k[0].hesapId, HESAP, "hangi Meta hesabının kararı olduğu kayıttan okunmalı");
});

test("TUTAR: Meta bütçe artışı AĞ tarafından reddedilse de tutar kayda düşer", async () => {
  const gunluk = gunlukAc();
  const c = await kur({ mevcutButce: 100, simDegisti: true });

  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: "120200000000001", dailyBudget: 350 },
  });

  assert.match(metin(r), /AĞ DOĞRULAMASI BAŞARISIZ/);
  assert.ok(!cagrilar.some((x) => x.startsWith("butceGuncelle")), "fail-closed gevşemedi");
  const k = satirlar(gunluk);
  assert.equal(k[0].karar, "ret");
  assert.equal(
    k[0].tutar,
    350,
    "ret kaydı 'ne büyüklükte bir harcama engellendi' sorusunu da cevaplamalı"
  );
});

test("TUTAR: Meta yayına almada OKUNABİLEN günlük bütçe kaydedilir", async () => {
  const gunluk = gunlukAc();
  const c = await kur({ mevcutButce: 150, onay: true });

  await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "ACTIVE" },
  });

  assert.ok(cagrilar.includes("durumDegistir:ACTIVE"));
  const k = satirlar(gunluk);
  assert.equal(k[0].karar, "gecti");
  assert.equal(k[0].risk, "high", "yayına alma yüksek risk");
  assert.equal(k[0].tutar, 150, "yayına alınan kampanyanın günlük bütçesi riskteki tutardır");
});

/**
 * BÜTÇE TAVANI YAYINA ALMADA — bu üç test bir denetimde bulunan boşluğun bekçisidir.
 *
 * Bütçeyi bu araç yazmadığında tavanı kimse sınamıyordu: kampanya Meta Ads Manager'da
 * elle kurulup AdsPilot'a yalnız "yayına al" dedirtilebiliyordu. Tavan yalnız BİZİM
 * yazdığımız bütçelere uygulandığı sürece, hesap sahibinin koyduğu kelepçe harcamanın
 * değil "AdsPilot üzerinden kurulan kampanyaların" kelepçesidir.
 *
 * Onaya HİÇ gelinmediği de sınanıyor: tavan aşımı bir soru değil, bir rettir. İnsana
 * sorulsaydı, kapı "hayır" diyebilecek bir şeyi "emin misin?" diye pazarlığa açardı.
 */
test("KRİTİK: Meta yayına alma, günlük bütçe TAVANI aşıyorsa reddedilir", async () => {
  const gunluk = gunlukAc();
  // Tavan test kurulumunda 500; kampanya onun iki katıyla yayına alınmak isteniyor.
  const c = await kur({ onay: true, mevcutButce: 1000 });

  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "ACTIVE" },
  });

  assert.match(metin(r), /Reddedildi/, "tavanı aşan kampanya yayına alınamaz");
  assert.match(metin(r), /1000/, "ret, reddedilen büyüklüğü adıyla söylemeli");
  assert.ok(
    !cagrilar.includes("durumDegistir:ACTIVE"),
    "KRİTİK: ret sonrası Meta'ya durum değiştirme çağrısı GİTMEMELİ"
  );
  /**
   * Dosyanın VARLIĞINA bakılıyor: karar günlüğü ilk yazımda oluşuyor, dolayısıyla
   * "hiç satır yok" ile "dosya hiç açılmadı" burada aynı şeyin iki yüzü — ve ikincisi
   * daha güçlü bir iddia: onay akışına adım bile atılmadı.
   */
  assert.equal(existsSync(gunluk), false, "onaya hiç gelinmedi: kayda karar düşmez");
});

test("KRİTİK: Meta bütçesi doğrulanamazsa yayına alma reddedilir ve SEBEBİ söylenir", async () => {
  /**
   * Okuma iki katmanlı olduğundan (kampanya düzeyi CBO, yoksa reklam setleri toplamı)
   * "doğrulanamadı" birden çok duruma karşılık gelir. Ret, hangisi olduğunu söylemezse
   * operatör neyi düzelteceğini bilemez — bu yüzden sebep sabit bir tahmin değil,
   * istemciden gelen not olmalı ve mesaja aynen geçmeli.
   */
  const c = await kur({
    onay: true,
    butceNotu: '"Yaz Seti" reklam seti ömürlük bütçe kullanıyor; günlük tavana çevrilemez',
  });

  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "ACTIVE" },
  });

  assert.match(metin(r), /Reddedildi/, "bilinmiyor, tavanın altında demek değildir");
  assert.match(metin(r), /ömürlük bütçe/, "sebep ret mesajında aynen görünmeli");
  assert.match(metin(r), /Yaz Seti/, "hangi reklam setinin sorun olduğu söylenmeli");
  assert.ok(!cagrilar.includes("durumDegistir:ACTIVE"), "ret sonrası Meta'ya çağrı gitmez");
});

test("bütçe reklam setlerinden geldiyse onay özeti bunu SÖYLER", async () => {
  /**
   * Operatör onay ekranında gördüğü rakamı Ads Manager'da doğrulamak isterse, reklam
   * setleri toplamını kampanya sayfasında ARAYAMAZ — orada öyle bir sayı yoktur.
   * Özet, rakamın nereden geldiğini söylemezse operatör yanlış yere bakar.
   *
   * Bu test bir kez adında bir davranış vaat edip yalnız `istemSayisi === 1` iddiasını
   * taşıyordu: sahte kampanya `butceKaynagi` bile set etmiyordu, dolayısıyla açıklama
   * cümlesi tools/meta.ts'ten silinse de yeşil kalıyordu. Artık istemin METNİ ölçülüyor.
   */
  const c = await kur({ onay: true, mevcutButce: 300, butceKaynagi: "reklam-setleri" });
  await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "ACTIVE" },
  });

  assert.equal(istemSayisi, 1, "onay istemi gösterilmeli");
  assert.match(istemMetinleri[0], /300/, "rakam özet metninde görünmeli");
  assert.match(
    istemMetinleri[0],
    /reklam setlerinin toplamı/,
    "operatör bu rakamı kampanya sayfasında arayamaz; nereden geldiği yazılmalı"
  );
});

test("bütçe KAMPANYA düzeyindeyse özet o açıklamayı EKLEMEZ (karşı kontrol)", async () => {
  /**
   * Açıklama her zaman yazılsaydı da test yeşil kalırdı — ve o zaman CBO kampanyalarda
   * operatöre var olmayan bir "toplam" anlatılırdı. Cümlenin KOŞULLU olduğu ancak
   * karşı kontrolle ölçülür.
   */
  const c = await kur({ onay: true, mevcutButce: 300, butceKaynagi: "kampanya" });
  await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "ACTIVE" },
  });

  assert.equal(istemSayisi, 1);
  assert.doesNotMatch(
    istemMetinleri[0],
    /reklam setlerinin toplamı/,
    "kampanya düzeyi bütçede böyle bir toplam yoktur"
  );
  assert.match(istemMetinleri[0], /300/, "rakam yine de görünmeli");
});

test("Tavanın ALTINDAKİ bütçe yayına almayı engellemez — kapı geçirgen kalmalı", async () => {
  const c = await kur({ onay: true, mevcutButce: 100 });

  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "ACTIVE" },
  });

  assert.match(metin(r), /ACTIVE/, "meşru kampanya reddedilmemeli (aksi hâlde kapı bir duvar olur)");
  assert.ok(cagrilar.includes("durumDegistir:ACTIVE"));
});

/* ── Kademeli doğrulama × zayıf kanal: platformdan BAĞIMSIZ ───────────────────
 *
 * Kapının boğazı tektir (approval.ts/onayAl), dolayısıyla oradaki bir gevşeme Google'da
 * da Meta'da da aynı anda açılır. Bu bekçi, kapatılan boşluğun ikinci harcama alanında
 * da kapalı olduğunu ölçer: aksi hâlde "Google tarafında düzelttik" cümlesi Meta
 * tarafında yanlış olurdu ve kimse fark etmezdi.
 * ─────────────────────────────────────────────────────────────────────────────── */

test("KRİTİK (Meta): kademe + elicitation'sız istemci + confirm=true → yazma YOK", async () => {
  const c = await kur({ simDegisti: true, mevcutButce: 100, stepUp: true, elicitationsiz: true });
  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "ACTIVE", confirm: true },
  });

  assert.equal(istemSayisi, 0, "gösterilecek istem yoktu");
  assert.ok(
    !cagrilar.some((x) => x.startsWith("durumDegistir")),
    "KRİTİK: taşınmış SIM ile kampanya insana sorulmadan yayına alınamaz"
  );
  assert.match(metin(r), /AĞ SİNYALİ BOZUK/, "ajan bozuk sinyali görmeli");
  assert.match(metin(r), /YÜKSELTME YAPILAMAZ/);
});

test("KRİTİK (Meta): kademe AÇIKKEN bile bütçe artışı (medium) düz RET — yükseltme yok", async () => {
  /**
   * MEDIUM KATMANDA YÜKSELTME YAPISAL OLARAK İMKÂNSIZDIR ve bu iyi bir şeydir:
   * o katmanda yalnız SIM-Swap halkası koşar, dolayısıyla bozulan sinyali doğrulayacak
   * ikinci bir gerçek halka hiç yoktur. Yükseltme ikinci bir kanıta dayanır; kanıt
   * yoksa kapı eski sertliğinde kalır. Bekçi burada, ileride "medium'a da bir halka
   * ekleyip yükseltelim" denirse kararın sessizce değil bilerek alınmasını sağlar.
   */
  const c = await kur({ simDegisti: true, mevcutButce: 100, stepUp: true, elicitationsiz: true });
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: "120200000000001", dailyBudget: 400, confirm: true },
  });

  assert.equal(istemSayisi, 0);
  assert.ok(!cagrilar.some((x) => x.startsWith("butceGuncelle")), "bütçe değişmemeli");
  assert.match(metin(r), /AĞ DOĞRULAMASI BAŞARISIZ/);
  assert.match(metin(r), /GERÇEK bir ağ halkası koşmadı/, "yükseltmenin neden olmadığı yazılı olmalı");
});

test("Meta kademe, elicitation'LI istemcide İNSANA sorulur ve onayla geçer", async () => {
  const c = await kur({ simDegisti: true, mevcutButce: 100, stepUp: true });
  await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: "120200000000001", status: "ACTIVE" },
  });

  assert.equal(istemSayisi, 1, "güçlü kanalda yükseltme yolu açık kalmalı");
  assert.match(istemMetinleri[0], /AĞ SİNYALİ BOZUK/);
  assert.ok(cagrilar.some((x) => x === "durumDegistir:ACTIVE"), "insan onayladıysa uygulanmalı");
});

/* ── Sunucu tarafı sır: reklam hesabı kimliği ─────────────────────────────────
 *
 * META_AD_ACCOUNT_ID ajanın gönderdiği bir argüman değil, sunucunun yapılandırmasıdır.
 * Onay özeti iki okura birden gidiyordu; elicitation'sız istemcide ret metni ajanın
 * bağlamına — oradan transkriptlere — yazılıyordu.
 * ─────────────────────────────────────────────────────────────────────────────── */

test("SIZINTI (Meta): reklam hesabı kimliği elicitation'sız RET metninde GEÇMEZ", async () => {
  const c = await kur({ mevcutButce: 100, agKapali: true, elicitationsiz: true });
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: "120200000000001", dailyBudget: 400 }, // confirm YOK → ret metni
  });

  const out = metin(r);
  assert.match(out, /Reddedildi/, "onaysız artış reddedilmeli");
  assert.match(out, /Mevcut: 100/, "ajanın kendi isteğine ait özet kalmalı");
  assert.doesNotMatch(out, new RegExp(HESAP), "sunucu tarafı hesap kimliği ajana dönmemeli");
});

test("Meta reklam hesabı kimliği İNSAN istemine yazılmaya devam eder", async () => {
  const c = await kur({ mevcutButce: 100, agKapali: true, onay: false });
  await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: "120200000000001", dailyBudget: 400 },
  });

  assert.equal(istemSayisi, 1);
  assert.match(istemMetinleri[0], new RegExp(HESAP), "insan hangi hesabın parası olduğunu görmeli");
});
