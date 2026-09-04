import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { onayAl, onaySonrasiKelepce } from "../src/approval.js";
import {
  __setSimSwapKanalForTests,
  __setErisimKanalForTests,
  __setCihazDegisimKanalForTests,
  type AgAyar,
} from "../src/networkTrust.js";
import { sahteContext, baglanti } from "./helpers/harness.js";

/**
 * Human-in-the-loop approval.
 *
 * The central assertion: with an elicitation-capable client, a human decline must
 * override the agent — even when the agent sends confirm: true. Consent has to be
 * something the server observes, not something the agent claims.
 */

const MUSTERI = "1234567890";
const KAMPANYA = "24120539226";

const YAYINA_HAZIR: Array<[RegExp, any[]]> = [
  [/campaign_budget\.amount_micros/, [{ campaign: { name: "Hazır" }, campaign_budget: { amount_micros: 50_000_000 } }]],
  [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
  [/FROM campaign_criterion/, []],
];

type InsanKarari = "accept" | "decline" | "cancel" | "hata";

/** A client that advertises the elicitation capability and plays back a human decision. */
async function elicitationliIstemci(
  ctx: any,
  karar: InsanKarari,
  onayDegeri = true,
  /**
   * İSTEM AÇIKKEN koşan kanca. Onay istemi elicitation ile insana gösterildiğinde
   * 10 dakikaya kadar açık kalabilir; bu kanca o pencerede olan bir şeyi — tipik
   * olarak hesap sahibinin ayarlar sayfasından kelepçeyi değiştirmesini — canlandırır.
   */
  istemAcikken?: () => void
) {
  const sorulanlar: string[] = [];
  const client = new Client(
    { name: "elicitation-testi", version: "0" },
    { capabilities: { elicitation: {} } }
  );

  client.setRequestHandler(ElicitRequestSchema, async (req: any) => {
    sorulanlar.push(String(req.params.message));
    istemAcikken?.();
    if (karar === "hata") throw new Error("istemci onay penceresini açamadı");
    if (karar === "accept") return { action: "accept", content: { onay: onayDegeri } };
    return { action: karar };
  });

  const server = buildServer(() => ctx);
  const [ist, sun] = InMemoryTransport.createLinkedPair();
  await server.connect(sun);
  await client.connect(ist);
  return { client, sorulanlar };
}

async function cagir(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res: any = await client.callTool({ name, arguments: args });
  return String(res.content?.[0]?.text ?? "");
}

test("KRİTİK: insan REDDEDERSE ajan confirm=true göndermiş olsa bile yayına ALINMAZ", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "decline");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true, // the agent is fabricating consent
  });

  assert.match(out, /İşlem yapılmadı/);
  assert.match(out, /reddetti/);
  assert.equal(rec.mutations.length, 0, "insan reddettiyse HİÇBİR yazma gitmemeli");
  assert.equal(sorulanlar.length, 1, "insana gerçekten sorulmuş olmalı");
  assert.match(sorulanlar[0], /YAYINA ALINACAK/);
  assert.match(sorulanlar[0], /Günlük bütçe: 50/, "karar için özet gösterilmeli");
});

test("insan İPTAL ederse de işlem yapılmaz", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client } = await elicitationliIstemci(ctx, "cancel");
  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });
  assert.match(out, /iptal etti/);
  assert.equal(rec.mutations.length, 0);
});

test("insan 'onay: false' derse işlem yapılmaz", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client } = await elicitationliIstemci(ctx, "accept", false);
  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });
  assert.match(out, /İşlem yapılmadı/);
  assert.equal(rec.mutations.length, 0);
});

test("onay penceresi AÇILAMAZSA kapalı arıza: işlem yapılmaz", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client } = await elicitationliIstemci(ctx, "hata");
  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });
  assert.match(out, /onayı alınamadı/);
  assert.equal(rec.mutations.length, 0, "onay alınamadıysa güvenli tarafa düşülmeli");
});

test("insan ONAYLARSA ajan confirm GÖNDERMESE BİLE yayına alınır", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "accept");
  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    // no confirm — human approval on its own is enough
  });
  assert.match(out, /YAYINDA/);
  assert.equal(rec.mutations.filter((m) => m.kind === "campaigns").length, 1);
  assert.equal(sorulanlar.length, 1);
});

test("bütçe ARTIŞINDA insana sorulur ve reddi bağlayıcıdır", async () => {
  const butce: Array<[RegExp, any[]]> = [
    [
      /campaign_budget\.explicitly_shared/,
      [{ campaign: { name: "K" }, campaign_budget: { resource_name: "r", amount_micros: 50_000_000, explicitly_shared: false } }],
    ],
  ];
  const { ctx, rec } = sahteContext({ queries: butce });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "decline");
  const out = await cagir(client, "update_campaign_budget", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    newDailyBudget: 400,
    confirm: true,
  });
  assert.match(out, /İşlem yapılmadı/);
  assert.equal(rec.mutations.length, 0);
  assert.match(sorulanlar[0], /Mevcut: 50 → Yeni: 400/, "artış insana gösterilmeli");
  assert.match(sorulanlar[0], /\+350/, "artış miktarı açıkça yazılmalı");
});

test("CANLI kampanyaya reklam eklemede insan onayı bağlayıcıdır", async () => {
  const canli: Array<[RegExp, any[]]> = [
    [/FROM ad_group\b/, [{ campaign: { id: 1, name: "Canlı", status: 2 /* ENABLED */ } }]],
  ];
  const { ctx, rec } = sahteContext({ queries: canli });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "decline");
  const out = await cagir(client, "create_responsive_search_ad", {
    customerId: MUSTERI,
    adGroupId: "200057393038",
    finalUrl: "https://ornek.com",
    headlines: ["Bir", "Iki", "Uc"],
    descriptions: ["Aciklama bir", "Aciklama iki"],
    confirm: true,
  });
  assert.match(out, /İşlem yapılmadı/);
  assert.equal(rec.mutations.length, 0);
  assert.match(sorulanlar[0], /ornek\.com/, "hangi sayfaya reklam verileceği gösterilmeli");
});

test("PAUSED kampanyada insana HİÇ sorulmaz (taslak akışı akıcı kalmalı)", async () => {
  const paused: Array<[RegExp, any[]]> = [
    [/FROM ad_group\b/, [{ campaign: { id: 1, name: "Taslak", status: 3 /* PAUSED */ } }]],
  ];
  const { ctx, rec } = sahteContext({ queries: paused });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "decline");
  const out = await cagir(client, "create_responsive_search_ad", {
    customerId: MUSTERI,
    adGroupId: "200057393038",
    finalUrl: "https://ornek.com",
    headlines: ["Bir", "Iki", "Uc"],
    descriptions: ["Aciklama bir", "Aciklama iki"],
  });
  assert.match(out, /RSA oluşturuldu/);
  assert.equal(sorulanlar.length, 0, "taslağa reklam eklemek onay istememeli");
  assert.equal(rec.mutations.length, 1);
});

/* ══════════════════════════════════════════════════════════════════════════════
 * KADEMELİ DOĞRULAMA × ZAYIF KANAL
 *
 * Yükseltme (step-up) bozuk bir ağ sinyalini düz retten çıkarıp İNSAN ONAYINA bağlar.
 * Bu takasın tek dayanağı, insana daha güçlü bir soru sorabilmektir. Elicitation'sız
 * bir istemcide sorulacak soru yoktur; geriye yalnız ajanın confirm iddiası kalır ve o
 * iddia ağ kapısı hiç koşmadan ÖNCE üretilmiştir — yani bozuk sinyali hiç görmemiş,
 * bayat bir rızadır.
 *
 * Aşağıdaki bekçiler yükseltmenin NEREDE durduğunu sabitler. Yoklukları ölçüldü:
 * bugünkü kodda AEGIS_STEPUP=1 + elicitation'sız istemci + confirm=true, taşınmış
 * bir SIM ile kampanyayı insana hiç sorulmadan yayına alıyordu.
 * ══════════════════════════════════════════════════════════════════════════════ */

const KADEME_AYARI: AgAyar = {
  nacToken: "TEST-ONLY-token",
  approverPhone: "+905551112277",
  simSwapWindowHours: 137,
  reachCheck: true,
  /**
   * Cihaz değişimi halkası AÇIK ve bu bilinçli: SIM değişimine kefil olabilen bir halka
   * gerekiyor. Erişilebilirlik halkası temiz dönse de kefil sayılmaz (KEFIL_ESLEMESI) —
   * canlılık sinyali kimlik sinyalini doğrulayamaz. Bu dosyanın konusu onay KANALI
   * (elicitation var/yok), kefaletin kendisi değil; o kural
   * test/kademeliDogrulama.test.ts'te ölçülür.
   */
  devSwapCheck: true,
  callFwdCheck: false,
  stepUp: true,
};

/** SIM taşınmış, cihaz AYNI (gerçek kanaldan temiz) → yükseltmeye kefil olabilen halka var. */
function kademeKosullari(): void {
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
}

/** Zincirin tamamı temiz — sızıntı testleri için. */
function temizKosullar(): void {
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
}

/**
 * Onay kapısına verilen sahte MCP sunucusu. `yetenek` istemcinin bildirdiği elicitation
 * yeteneğidir; `sorulanlar` gerçekten gösterilen istemleri toplar (0 olması "insana hiç
 * sorulmadı"nın ölçüsüdür).
 */
function sahteSunucu(sorulanlar: string[], sorular: string[], yetenek: unknown): any {
  return {
    server: {
      getClientCapabilities: () => (yetenek === undefined ? {} : { elicitation: yetenek }),
      elicitInput: async (istek: any) => {
        sorulanlar.push(String(istek.message));
        sorular.push(String(istek.requestedSchema?.properties?.onay?.title ?? ""));
        return { action: "accept", content: { onay: true } };
      },
    },
  };
}

afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
});

test("KRİTİK: kademe açıkken elicitation'sız istemcide confirm=true GEÇİŞ ÜRETMEZ", async () => {
  kademeKosullari();
  const sorulanlar: string[] = [];
  const sonuc = await onayAl(
    sahteSunucu(sorulanlar, [], undefined),
    {
      eylem: "kampanya YAYINA ALINACAK",
      satirlar: ["Günlük bütçe: 50"],
      risk: "high",
      agAyar: KADEME_AYARI,
    },
    true // ajan rızayı UYDURUYOR
  );

  assert.equal(sonuc.onaylandi, false, "yükseltme, ajanın confirm iddiasıyla geçemez");
  assert.equal(sonuc.kanal, "ag");
  assert.match(sonuc.mesaj!, /AĞ SİNYALİ BOZUK/, "bozuk sinyal ajana ADIYLA söylenmeli");
  assert.match(sonuc.mesaj!, /SIM kartı yakın zamanda değişmiş/);
  assert.match(sonuc.mesaj!, /YÜKSELTME YAPILAMAZ/, "neden geçilemediği açıkça yazılmalı");
  assert.equal(sorulanlar.length, 0, "gösterilecek istem yoktu — ölçüt de bu");
});

test("KRİTİK: aynı durumda kademe KAPALIYKEN de geçmez (ret metni değişir, karar değişmez)", async () => {
  kademeKosullari();
  const sonuc = await onayAl(
    sahteSunucu([], [], undefined),
    {
      eylem: "kampanya YAYINA ALINACAK",
      satirlar: ["Günlük bütçe: 50"],
      risk: "high",
      agAyar: { ...KADEME_AYARI, stepUp: false },
    },
    true
  );
  assert.equal(sonuc.onaylandi, false);
  assert.equal(sonuc.kanal, "ag");
  assert.match(sonuc.mesaj!, /AĞ DOĞRULAMASI BAŞARISIZ/);
});

test("kademe, elicitation'LI istemcide İNSANA sorulur — istem bozuk sinyali adıyla taşır", async () => {
  kademeKosullari();
  const sorulanlar: string[] = [];
  const sorular: string[] = [];
  const sonuc = await onayAl(
    sahteSunucu(sorulanlar, sorular, { form: {} }),
    {
      eylem: "kampanya YAYINA ALINACAK",
      satirlar: ["Günlük bütçe: 50"],
      risk: "high",
      agAyar: KADEME_AYARI,
    },
    undefined
  );

  assert.equal(sonuc.onaylandi, true, "güçlü kanalda yükseltme yolu AÇIK kalmalı");
  assert.equal(sonuc.kanal, "insan");
  assert.equal(sorulanlar.length, 1, "insana gerçekten sorulmalı");
  assert.match(sorulanlar[0], /AĞ SİNYALİ BOZUK/, "uyarı istemin BAŞINDA durmalı");
  assert.match(sorulanlar[0], /SIM kartı yakın zamanda değişmiş/);
  assert.match(sorulanlar[0], /KADEMELİ DOĞRULAMA/, "kanıt satırı insana gösterilmeli");
  assert.match(sorular[0], /RAĞMEN/, "onay kutusunun sorusu da değişmeli");
});

test("SIZINTI: elicitation'sız ret metni ağ kapısının KANIT satırlarını ajana yazmaz", async () => {
  temizKosullar();
  const sonuc = await onayAl(
    sahteSunucu([], [], undefined),
    {
      eylem: "kampanya YAYINA ALINACAK",
      satirlar: ["Günlük bütçe: 50"],
      insanSatirlari: ["Reklam hesabı: act_1234567890"],
      risk: "high",
      agAyar: KADEME_AYARI,
    },
    undefined // confirm yok → ret metni üretilir
  );

  assert.equal(sonuc.onaylandi, false);
  const m = sonuc.mesaj!;
  assert.match(m, /Günlük bütçe: 50/, "ajanın KENDİ isteğine ait özet gösterilmeye devam etmeli");
  assert.doesNotMatch(m, /905\*/, "maskeli onaylayıcı numarası ajana sızmamalı");
  assert.doesNotMatch(m, /137 saat/, "geriye bakış penceresi ajana sızmamalı");
  assert.doesNotMatch(m, /GSMA Open Gateway/, "kapının kanıt satırları ajana sızmamalı");
  assert.doesNotMatch(m, /act_1234567890/, "sunucu tarafı hesap kimliği ajana sızmamalı");
});

test("aynı özet, elicitation'lı istemcide İNSANA tam gösterilir (bilgi insandan saklanmaz)", async () => {
  temizKosullar();
  const sorulanlar: string[] = [];
  await onayAl(
    sahteSunucu(sorulanlar, [], { form: {} }),
    {
      eylem: "kampanya YAYINA ALINACAK",
      satirlar: ["Günlük bütçe: 50"],
      insanSatirlari: ["Reklam hesabı: act_1234567890"],
      risk: "high",
      agAyar: KADEME_AYARI,
    },
    undefined
  );
  assert.equal(sorulanlar.length, 1);
  assert.match(sorulanlar[0], /act_1234567890/, "insan hangi hesabın parası olduğunu görmeli");
  assert.match(sorulanlar[0], /905\*/, "insan ağ kanıtını görmeli");
});

test("UÇTAN UCA (Google): kademe + elicitation'sız istemci + confirm=true → 0 mutasyon", async () => {
  const { ctx, rec } = sahteContext({
    queries: YAYINA_HAZIR,
  });
  ctx.config.nacToken = "TEST-ONLY-token";
  ctx.config.approverPhone = "+905551112277";
  ctx.config.simSwapWindowHours = 137;
  ctx.config.reachCheck = true;
  ctx.config.stepUp = true;
  // Kefil olabilen halka: canlılık sinyali SIM değişimini doğrulayamaz (KEFIL_ESLEMESI).
  ctx.config.devSwapCheck = true;
  kademeKosullari();

  // baglanti() elicitation BİLDİRMEYEN bir istemci kurar — zayıf kanal tam olarak budur.
  const client = await baglanti(ctx);
  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });

  assert.equal(rec.mutations.length, 0, "KRİTİK: insana sorulmadan kampanya yayına alınamaz");
  assert.match(out, /AĞ SİNYALİ BOZUK/, "ajan uyarıyı görmeli ki kullanıcıya aktarabilsin");
  assert.match(out, /YÜKSELTME YAPILAMAZ/);
  assert.doesNotMatch(out, /905\*/, "ret metni kapının kanıtını sızdırmamalı");
});

/* ── elicitation alt-yeteneği: url-modlu istemci ──────────────────────────────
 *
 * SDK'nın form çağrısı `elicitation.form` yeteneğini arar. Yalnız `url` bildiren bir
 * istemcide güçlü dalı seçmek, HER onayı hataya düşürür ve kullanıcı hiçbir kampanyayı
 * yayına ALAMAZ. Bu yüzden url-modlu istemci BİLEREK zayıf kanala düşürülür.
 *
 * Bilinçli bir düşüş, sabitlenmediği sürece bilinçli kalmaz: aşağıdaki iki bekçi
 * kararın kendisini yazıya döker, böylece ters yönde bir "düzeltme" sessizce geçemez.
 * ─────────────────────────────────────────────────────────────────────────────── */

test("url-modlu istemci ZAYIF kanala düşer (bilinçli düşüş) — istem HİÇ açılmaz", async () => {
  const sorulanlar: string[] = [];
  const sonuc = await onayAl(
    sahteSunucu(sorulanlar, [], { url: {} }),
    { eylem: "kampanya YAYINA ALINACAK", satirlar: ["Günlük bütçe: 50"] },
    true
  );
  assert.equal(sonuc.onaylandi, true);
  assert.equal(sonuc.kanal, "ajan", "form desteklemeyen istemcide güçlü dal seçilirse her onay patlar");
  assert.equal(sorulanlar.length, 0, "elicitInput hiç çağrılmamalı");
});

test("url-modlu istemcide confirm YOKSA yine de RET (düşüş, kapıyı açmak değildir)", async () => {
  const sonuc = await onayAl(
    sahteSunucu([], [], { url: {} }),
    { eylem: "kampanya YAYINA ALINACAK", satirlar: ["Günlük bütçe: 50"] },
    undefined
  );
  assert.equal(sonuc.onaylandi, false);
  assert.match(sonuc.mesaj!, /açık onayını al/);
});

test("form bildiren istemci GÜÇLÜ kanalda kalır (düşüş yalnız url-moda özgü)", async () => {
  const sorulanlar: string[] = [];
  const sonuc = await onayAl(
    sahteSunucu(sorulanlar, [], { form: {} }),
    { eylem: "kampanya YAYINA ALINACAK", satirlar: ["Günlük bütçe: 50"] },
    false
  );
  assert.equal(sonuc.onaylandi, true);
  assert.equal(sonuc.kanal, "insan", "ajanın confirm=false'u insan onayını EZEMEZ");
  assert.equal(sorulanlar.length, 1);
});


/* ── Onay penceresi boyunca kelepçe değişirse ────────────────────────────────
 *
 * Kelepçe (yazma anahtarı ve günlük tavan) onay isteminden ÖNCE okunuyordu ve istem
 * insana gösterildiğinde 10 dakikaya kadar açık kalabiliyor. O pencerede hesap sahibi
 * yazmayı kapatsa bile bekleyen istek eski değerlerle yazmaya devam ediyordu — yani
 * "anında geçerli" sözü tam da acilen kullanılacağı anda tutmuyordu.
 *
 * Aşağıdaki bekçiler ölçünün TAMAMINI alır: yalnız ret metnini değil, MUTASYON SAYISINI.
 * Doğru metni basıp yine de yazan bir kapı, hiç olmayan kapıdan daha kötüdür.
 */

test("KRİTİK TOCTOU: istem açıkken YAZMA KAPATILIRSA yayına alma uygulanmaz", async () => {
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client } = await elicitationliIstemci(ctx, "accept", true, () => {
    // Hesap sahibi ayarlar sayfasından yazmayı kapattı — istem hâlâ ekranda.
    ctx.config.writeEnabled = false;
  });

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.equal(rec.mutations.length, 0, "KRİTİK: onaydan sonra kapatılan yazma yine de uygulanmamalı");
  assert.match(out, /YAZMA KAPATILDI/, "ret, kelepçenin onay sırasında değiştiğini söylemeli");
});

test("KRİTİK TOCTOU: istem açıkken TAVAN İNDİRİLİRSE yayına alma uygulanmaz", async () => {
  // Kampanyanın günlük bütçesi 50; tavan istem açıkken 10'a iniyor.
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client } = await elicitationliIstemci(ctx, "accept", true, () => {
    ctx.config.maxDailyBudget = 10;
  });

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.equal(rec.mutations.length, 0, "KRİTİK: indirilen tavan bekleyen isteği durdurmalı");
  assert.match(out, /tavanı 10 değerine/, "ret yeni tavanı adıyla söylemeli");
  assert.match(out, /onay, indirilmeden ÖNCEKİ tavana verilmişti/, "onayın neye verildiği açık olmalı");
});

test("TOCTOU kapısı meşru akışı ENGELLEMEZ: kelepçe değişmediyse yayına alma geçer", async () => {
  /**
   * Kapıyı "her şeyi reddet"e çevirerek testi yeşile boyamak mümkün olmasın diye,
   * değişmeyen kelepçede mutasyonun GERÇEKTEN olduğu da çivileniyor.
   */
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR });
  const { client } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.equal(rec.mutations.length, 1, "kelepçe değişmediyse onaylanan işlem uygulanmalı");
  assert.match(out, /YAYINDA/);
});

test("KRİTİK TOCTOU: istem açıkken tavan inerse BÜTÇE ARTIŞI da uygulanmaz", async () => {
  /**
   * Yayına almanın ikizi. İki yol ayrı ayrı bağlanıyor, dolayısıyla ayrı ayrı çivilenmeli:
   * mutasyonla ölçüldü, yalnız yayına alma yolu bekçiliyken bütçe artışındaki tazeleme
   * silinebiliyor ve takım yeşil kalıyordu.
   */
  const butce: Array<[RegExp, any[]]> = [
    [
      /campaign_budget\.explicitly_shared/,
      [
        {
          campaign: { name: "K" },
          campaign_budget: { resource_name: "r", amount_micros: 50_000_000, explicitly_shared: false },
        },
      ],
    ],
  ];
  const { ctx, rec } = sahteContext({ queries: butce });
  const { client } = await elicitationliIstemci(ctx, "accept", true, () => {
    ctx.config.maxDailyBudget = 60;
  });

  const out = await cagir(client, "update_campaign_budget", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    newDailyBudget: 90,
  });

  assert.equal(rec.mutations.length, 0, "KRİTİK: indirilen tavan bekleyen bütçe artışını durdurmalı");
  assert.match(out, /tavanı 60 değerine/, "ret yeni tavanı adıyla söylemeli");
});

test("onaySonrasiKelepce: yalnız GEVŞEMEYİ değil, DARALMAYI yakalar", () => {
  // Kelepçe değişmedi → geçer.
  assert.equal(onaySonrasiKelepce({ writeEnabled: true, maxDailyBudget: 500 }, 50), null);
  // Tam tavanda → geçer (sınır dahil).
  assert.equal(onaySonrasiKelepce({ writeEnabled: true, maxDailyBudget: 50 }, 50), null);
  // Yazma kapandı → ret.
  assert.match(
    onaySonrasiKelepce({ writeEnabled: false, maxDailyBudget: 500 }, 50) ?? "",
    /YAZMA KAPATILDI/
  );
  // Tavan tutarın altına indi → ret.
  assert.match(
    onaySonrasiKelepce({ writeEnabled: true, maxDailyBudget: 49 }, 50) ?? "",
    /güvenlik tavanı 49/
  );
  /**
   * Tutar OKUNAMADIYSA bu kapı karar vermez ve bu bilinçli: tutarın okunabilirliği
   * onaydan ÖNCEKİ kapıların işidir ve onlar okunamayan bütçeyi zaten reddeder.
   * Burada undefined'ı "tavanı aştı" saymak, tavanla ilgisi olmayan bir reddi
   * tavan reddi gibi raporlardı.
   */
  assert.equal(onaySonrasiKelepce({ writeEnabled: true, maxDailyBudget: 1 }, undefined), null);
  assert.equal(onaySonrasiKelepce({ writeEnabled: true, maxDailyBudget: 1 }, NaN), null);
});
