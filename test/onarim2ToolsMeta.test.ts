// SPDX-License-Identifier: AGPL-3.0-only
/**
 * src/tools/meta.ts — İKİNCİ tur onarım gerileme testleri.
 *
 * Birinci tur üç şeyi kapattığını söylemişti; bağımsız gözden geçiren üçünün de yarım
 * kaldığını ölçtü. Bu dosya o üç boşluğu kapatan düzeltmeleri kilitler:
 *
 *  1) KİMLİK KELEPÇESİ RAKAM DOĞRULAR, KAMPANYA DOĞRULAMAZ. Meta reklam seti kimliği de
 *     rakamdır ve `id,name,status,daily_budget` alanlarının hepsi bir reklam setinde de
 *     vardır — yani kelepçeden geçen bir reklam seti kimliğiyle okuma başarılı oluyor,
 *     hesabın 500'lük tavanı O TEK SETİN 400'üyle karşılaştırılıyor ve POST reklam setine
 *     gidiyordu. Dokuz set × 400, tavanı teker teker geçer. Okuma artık kampanyaya ÖZGÜ
 *     `objective` alanını istiyor; kanal ancak GÖZLEDİĞİ şeye kefil olabilir.
 *
 *  2) "BAŞARISIZ" İLE "SONUCU BİLİNMİYOR" AYRIMI YÖNTEME BAĞLI, HATANIN ADINA DEĞİL.
 *     Yalnız AbortError belirsiz sayılıyordu; `TypeError: fetch failed` ile düşen bir POST
 *     (Node'da ECONNRESET / socket hang up böyle gelir — istek Meta'ya ULAŞMIŞ ve
 *     UYGULANMIŞ olabilir) ajana "Meta işlemi başarısız" diye özetleniyordu, ve "hiçbir şey
 *     olmadı" duyan ajanın olağan hamlesi tekrar denemektir.
 *
 *  3) BELİRSİZLİK SINIFI ARTIK KOMŞU MODÜLÜN CÜMLESİNE DEĞİL TİPE BAĞLI. Eski testler
 *     client.ts'in cümlelerinin KOPYASINI sahte kanaldan fırlatıyordu: cümle orada
 *     değişseydi suit yeşil kalır, kelepçe sessizce açılırdı. Bu dosya cümleyi hiç
 *     kopyalamaz — üretim yolunu gerçek istemci + sahte fetch ile uçtan uca koşturur, ve
 *     tipi cümleden bağımsız olarak ayrıca ölçer.
 *
 * Ağa çıkılmaz: global fetch taklit edilir.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import {
  __setMetaKanalForTests,
  MetaBelirsizSonuc,
  belirsizSonucMu,
  kampanyaDugumu,
  type MetaKampanya,
} from "../src/meta/client.js";

const TOKEN = "meta-gizli-jeton-1234567890";
const HESAP = "act_1";
const KIMLIK = "23851234567890123";

const gercekFetch = globalThis.fetch;

/** Yapılan HTTP çağrıları — "hiç POST yapılmadı" ölçülebilsin diye. */
let istekler: { yontem: string; yol: string; sorgu: string }[] = [];
/** Gösterilen onay istemi sayısı — "istem kapıdan ÖNCE gösterilmedi" ölçülebilsin diye. */
let istemSayisi = 0;

afterEach(() => {
  globalThis.fetch = gercekFetch;
  __setMetaKanalForTests(undefined);
  istekler = [];
  istemSayisi = 0;
});

const metin = (r: any) => String(r.content?.[0]?.text ?? "");
const postVar = () => istekler.some((i) => i.yontem === "POST");

/** Hesabın para birimi yanıtı (USD: minor-unit çarpanı 100). */
const USD = { currency: "USD", currency_offset: 100 };

/**
 * GERÇEK istemci + sahte fetch. Sahte KANAL enjekte edilmez: ölçülen şey üretim yolunun
 * kendisidir — bulgu 3'ün özü budur, çünkü sahte kanal komşu modülün cümlesini kopyalayınca
 * cümle ile kelepçe arasındaki bağ hiç ölçülmez.
 */
function fetchTakli(opts: {
  /** Kampanya/düğüm okuma yanıtı gövdesi. */
  dugum: unknown;
  /** POST'ta fırlatılacak hata (taşıma katmanı arızası). */
  postPatlasin?: () => Error;
  /** POST yanıtının gövdesi okunamasın (bağlantı yanıt sırasında koptu). */
  postGovdesiPatlasin?: boolean;
  /** GET'te fırlatılacak hata — yöntem ayrımının korunduğunu ölçmek için. */
  getPatlasin?: () => Error;
}) {
  globalThis.fetch = (async (url: any, init: any) => {
    const s = String(url);
    const yol = s.split("?")[0];
    const yontem = String(init?.method ?? "GET");
    istekler.push({ yontem, yol, sorgu: s.split("?")[1] ?? "" });
    if (yontem === "POST") {
      if (opts.postPatlasin) throw opts.postPatlasin();
      if (opts.postGovdesiPatlasin) {
        return {
          ok: true,
          text: async () => {
            throw new TypeError("terminated");
          },
        } as any;
      }
      return { ok: true, text: async () => JSON.stringify({ id: KIMLIK }) } as any;
    }
    if (opts.getPatlasin) throw opts.getPatlasin();
    const govde = yol.endsWith("/act_1") ? USD : opts.dugum;
    return { ok: true, text: async () => JSON.stringify(govde) } as any;
  }) as typeof fetch;
  __setMetaKanalForTests(undefined);
}

/** MCP sunucusu + istemci. Ağ katmanı yapılandırılmamış: ölçülen şey ARAÇ katmanıdır. */
async function sunucuKur(opts: { elicitation?: boolean } = {}) {
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
    nacToken: undefined,
    approverPhone: undefined,
  };
  const server = buildServer(() => ({ config }) as any);
  const istemci = new Client(
    { name: "onarim2-meta", version: "1.0.0" },
    { capabilities: opts.elicitation ? { elicitation: { form: {} } } : {} }
  );
  if (opts.elicitation) {
    istemci.setRequestHandler(ElicitRequestSchema, async () => {
      istemSayisi++;
      return { action: "accept" as const, content: { onay: true } };
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), istemci.connect(b)]);
  return istemci;
}

/**
 * BİR REKLAM SETİNİN yanıtı. Kampanya okumasının istediği eski alanların HEPSİ burada var —
 * bulgunun çekirdeği tam olarak bu: rakam kelepçesi bunu ayırt edemez.
 */
const REKLAM_SETI = {
  id: KIMLIK,
  name: "Reklam Seti 1",
  status: "PAUSED",
  daily_budget: "40000", // 400 — hesabın 500'lük tavanının altında görünür
};

/** GERÇEK bir kampanya yanıtı: kampanyaya özgü `objective` alanını taşır. */
const KAMPANYA = { ...REKLAM_SETI, name: "Yaz Kampanyası", objective: "OUTCOME_TRAFFIC" };

/* ── BULGU 1: reklam seti kimliğiyle tavan atlatma ─────────────────────────── */

test("KRİTİK: reklam seti kimliğiyle bütçe yazması REDDEDİLİR; hiçbir POST yapılmaz", async () => {
  /**
   * Onarım öncesi ölçülen davranış: GET .../23851234567890123 okunuyor, tavan o TEK setin
   * 400'üyle karşılaştırılıyor, POST daily_budget=30000 gidiyor ve araç "Meta bütçesi
   * güncellendi" diyordu. Azaltma yolu seçildi ki ret'i durduran şeyin onay istemi değil
   * DÜĞÜM KAPISI olduğu tek başına görünsün.
   */
  fetchTakli({ dugum: REKLAM_SETI });
  const c = await sunucuKur();
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 300 },
  });

  assert.match(metin(r), /Reddedildi/, "kampanya olmayan düğüme yazma reddedilmeli");
  assert.match(metin(r), /objective/, "hangi gözlemin eksik olduğu söylenmeli");
  assert.equal(postVar(), false, "KRİTİK: hiçbir yazma yapılmamalı");
  assert.ok(
    !/güncellendi/.test(metin(r)),
    "yapılmamış bir güncelleme bildirilmemeli"
  );
});

test("KRİTİK: reklam seti kimliğiyle YAYINA ALMA, insana sorulmadan reddedilir", async () => {
  /**
   * Onay istemi "kampanyası YAYINA ALINACAK" diyor. O cümle ancak düğüm gerçekten kampanya
   * ise doğrudur; yanlış nesne türü için alınan onay, kayda geçmiş bir rıza olduğu için
   * hiç onay almamaktan daha kötüdür. Bu yüzden kapı istemden ÖNCE koşar.
   */
  fetchTakli({ dugum: REKLAM_SETI });
  const c = await sunucuKur({ elicitation: true });
  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: KIMLIK, status: "ACTIVE" },
  });

  assert.match(metin(r), /Reddedildi/, "kampanya olmayan düğüm yayına alınamaz");
  assert.equal(istemSayisi, 0, "KRİTİK: onay istemi HİÇ gösterilmemeli");
  assert.equal(postVar(), false, "KRİTİK: hiçbir yazma yapılmamalı");
});

test("okuma, kampanyaya ÖZGÜ alanı gerçekten İSTER (kefil olduğu şeyi gözler)", async () => {
  /**
   * Kanal ancak ÇELİŞEBİLECEĞİ bir sinyale kefil olabilir. Alan hiç sorulmazsa yanıtta
   * bulunmaması da bir gözlem değildir: canlı Graph API'de reklam setine `objective`
   * sormak zaten hata döndürür, yani istek satırının kendisi savunmanın parçasıdır.
   */
  fetchTakli({ dugum: KAMPANYA });
  const c = await sunucuKur();
  await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 300 },
  });

  const okuma = istekler.find((i) => i.yontem === "GET" && i.yol.endsWith(`/${KIMLIK}`));
  assert.ok(okuma, "düğüm okuması yapılmalı");
  assert.match(
    decodeURIComponent(okuma!.sorgu),
    /fields=[^&]*\bobjective\b/,
    "okuma kampanyaya özgü alanı istemeli"
  );
});

test("GERÇEK kampanya kimliği engellenmez — kapı meşru yolu kapatmaz", async () => {
  fetchTakli({ dugum: KAMPANYA });
  const c = await sunucuKur();
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 300 },
  });

  assert.match(metin(r), /Meta bütçesi güncellendi/, "azaltma yolu çalışmaya devam etmeli");
  assert.equal(postVar(), true, "yazma gerçekten yapılmalı");
  assert.ok(!/Reddedildi/.test(metin(r)), "meşru kampanya reddedilmemeli");
});

test("düğüm kefaleti bir İZİN LİSTESİDİR: tanınmayan her biçim 'doğrulanmadı'", async () => {
  /**
   * `objective` alanının VARLIĞI değil, KAMPANYA OLDUĞUNU GÖSTEREN bir değer taşıması
   * aranıyor. Boş dize, boşluk, null, sayı, dizi, nesne: hiçbiri gözlem değildir.
   */
  assert.equal(kampanyaDugumu("OUTCOME_TRAFFIC").tur, "kampanya");
  for (const bozuk of [undefined, null, "", "   ", 0, 1, [], {}, ["OUTCOME_TRAFFIC"], true]) {
    assert.equal(
      kampanyaDugumu(bozuk).tur,
      "dogrulanmadi",
      `tanınmayan değer kefil sayılmamalı: ${JSON.stringify(bozuk) ?? "undefined"}`
    );
  }
});

/* ── BULGU 2: gözlenemeyen YAZMA "başarısız" değildir (yöntem, hata adı değil) ── */

/** Node'da ECONNRESET / socket hang up bu biçimde gelir. */
const TASIMA_ARIZASI = () => new TypeError("fetch failed");

test("KRİTİK: taşıma hatasıyla düşen POST 'başarısız' diye özetlenmez", async () => {
  /**
   * Ölçülen eski çıktı birebir: "Meta işlemi başarısız: fetch failed". İstek Meta'ya
   * ulaşmış ve uygulanmış olabilir; ajana "hiçbir şey olmadı" demek, bütçenin ikinci kez
   * artmasına giden cümledir. Azaltma yolu: onay istemi devrede değil, ölçülen tek şey
   * hata özeti.
   */
  fetchTakli({ dugum: KAMPANYA, postPatlasin: TASIMA_ARIZASI });
  const c = await sunucuKur();
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 300 },
  });

  assert.equal(r.isError, true, "tamamlanmış bir işlem değil");
  assert.doesNotMatch(metin(r), /başarısız/iu, "KRİTİK: 'başarısız' yanlış ve tehlikeli bir özet");
  assert.match(metin(r), /SONUCU BİLİNMİYOR/u, "sonucun bilinmediği söylenmeli");
  assert.match(metin(r), /UYGULANMIŞ olabilir/u, "işlemin geçmiş olabileceği söylenmeli");
  assert.match(metin(r), /TEKRAR DENEME/u, "tekrar denemenin tehlikesi söylenmeli");
});

test("KRİTİK: taşıma hatasıyla düşen DURAKLATMA da 'başarısız' diye özetlenmez", async () => {
  fetchTakli({ dugum: KAMPANYA, postPatlasin: TASIMA_ARIZASI });
  const c = await sunucuKur();
  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: KIMLIK, status: "PAUSED" },
  });

  assert.equal(r.isError, true);
  assert.doesNotMatch(metin(r), /başarısız/iu, "duraklatma yolunda da aynı ayrım geçerli");
  assert.match(metin(r), /SONUCU BİLİNMİYOR/u);
});

test("POST gitti ama yanıt gövdesi okunamadı: bu da belirsizliktir", async () => {
  /**
   * İstek TAM OLARAK gönderildi ve Meta yanıt verdi; kaybolan yalnız dönüş gövdesi. Bir
   * yazma için bu, "sonucu gözleyemedik"in en güçlü hâlidir.
   */
  fetchTakli({ dugum: KAMPANYA, postGovdesiPatlasin: true });
  const c = await sunucuKur();
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 300 },
  });

  assert.equal(r.isError, true);
  assert.doesNotMatch(metin(r), /başarısız/iu);
  assert.match(metin(r), /SONUCU BİLİNMİYOR/u);
});

test("OKUMA arızası hâlâ GERÇEK başarısızlıktır (yöntem ayrımı genişletilmedi)", async () => {
  /**
   * Düzeltmeyi "her taşıma hatası belirsizdir"e genişletmek okuma arızalarını da
   * çözülemez belirsizlik gibi raporlar ve ajanı yanlış yöne — Ads Manager'a — yollardı.
   * Bir GET'in düşmesi hiçbir şeyi değiştirmez.
   */
  fetchTakli({ dugum: KAMPANYA, getPatlasin: TASIMA_ARIZASI });
  const c = await sunucuKur();
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 300 },
  });

  assert.equal(r.isError, true);
  assert.match(metin(r), /Meta işlemi başarısız/u, "okuma arızası gerçekten başarısızlıktır");
  assert.doesNotMatch(metin(r), /SONUCU BİLİNMİYOR/u, "okuma iptali belirsizlik değildir");
  assert.equal(postVar(), false, "okuma düştüğünde yazma denenmemeli");
});

test("kimliksiz oluşturma yanıtı da üretim yolunda 'başarısız' diye özetlenmez", async () => {
  /** POST 200 döndü ama gövdede id yok: kampanya kurulmuş da olabilir, kurulmamış da. */
  globalThis.fetch = (async (url: any, init: any) => {
    const s = String(url);
    const yontem = String(init?.method ?? "GET");
    istekler.push({ yontem, yol: s.split("?")[0], sorgu: s.split("?")[1] ?? "" });
    if (yontem === "POST") return { ok: true, text: async () => "{}" } as any;
    return { ok: true, text: async () => JSON.stringify(USD) } as any;
  }) as typeof fetch;
  __setMetaKanalForTests(undefined);

  const c = await sunucuKur();
  const r: any = await c.callTool({
    name: "create_meta_campaign",
    arguments: { name: "Yeni", objective: "OUTCOME_TRAFFIC", dailyBudget: 50 },
  });

  assert.equal(r.isError, true);
  assert.doesNotMatch(metin(r), /başarısız/iu);
  assert.match(metin(r), /TEKRAR DENEME/u);
});

/* ── BULGU 3: sınıflandırma TİPE bağlı, komşu modülün CÜMLESİNE değil ──────── */

/**
 * Bu dosyanın hiçbir yerinde client.ts'in cümlelerinin kopyası YOKTUR. Yukarıdaki testler
 * üretim yolunu gerçek istemciyle koşturur; aşağıdakiler bağın kendisini cümleden bağımsız
 * ölçer.
 */
test("KRİTİK: belirsizlik TİPİ, hiçbir anahtar kelime içermeyen mesajda da tanınır", async () => {
  /**
   * Mesaj kasten nötr: ne "SONUCU BİLİNMİYOR" ne "doğrulanam" geçiyor. Kelepçe yalnız
   * desene bağlı olsaydı bu metin "Meta işlemi başarısız: ..." diye sarmalanırdı — yani
   * client.ts'te yapılacak bir yeniden ifade bulgu 1'i sessizce geri getirirdi.
   */
  const kampanya: MetaKampanya = {
    id: KIMLIK,
    ad: "Test",
    durum: "PAUSED",
    gunlukButce: 400,
    butceKaynagi: "kampanya",
    dugumTuru: "kampanya",
  };
  __setMetaKanalForTests({
    async kampanyaOlustur() {
      throw new Error("kullanılmıyor");
    },
    async kampanyaOku() {
      return kampanya;
    },
    async butceGuncelle() {
      throw new MetaBelirsizSonuc("yazma gözlenemedi");
    },
    async durumDegistir() {
      throw new MetaBelirsizSonuc("yazma gözlenemedi");
    },
  });

  const c = await sunucuKur();
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 300 },
  });

  assert.equal(r.isError, true, "tamamlanmış bir işlem değil");
  assert.doesNotMatch(
    metin(r),
    /başarısız/iu,
    "KRİTİK: sınıflandırma tipe bağlı olmalı, cümlenin lafzına değil"
  );
  assert.equal(metin(r), "yazma gözlenemedi", "belirsiz mesaj sarmalanmadan geçmeli");
});

test("aynı NÖTR metin düz Error olarak gelirse 'başarısız' der (tip iş görüyor)", async () => {
  /**
   * Karşı kanıt: yukarıdaki testin yeşil olmasının sebebi kuralın gevşetilmesi değil,
   * tipin taşınması. Aynı metin işaretsiz gelince gerçek ret gibi özetlenmeli.
   */
  const kampanya: MetaKampanya = {
    id: KIMLIK,
    ad: "Test",
    durum: "PAUSED",
    gunlukButce: 400,
    butceKaynagi: "kampanya",
    dugumTuru: "kampanya",
  };
  __setMetaKanalForTests({
    async kampanyaOlustur() {
      throw new Error("kullanılmıyor");
    },
    async kampanyaOku() {
      return kampanya;
    },
    async butceGuncelle() {
      throw new Error("yazma gözlenemedi");
    },
    async durumDegistir() {
      throw new Error("yazma gözlenemedi");
    },
  });

  const c = await sunucuKur();
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 300 },
  });

  assert.equal(metin(r), "Meta işlemi başarısız: yazma gözlenemedi");
});

test("belirsizSonucMu yalnız İŞARETLİ hatayı tanır (yanlış pozitif yok)", async () => {
  assert.equal(belirsizSonucMu(new MetaBelirsizSonuc("x")), true);
  assert.equal(belirsizSonucMu(new Error("SONUCU BİLİNMİYOR")), false);
  assert.equal(belirsizSonucMu(undefined), false);
  assert.equal(belirsizSonucMu(null), false);
  assert.equal(belirsizSonucMu("SONUCU BİLİNMİYOR"), false);
  assert.equal(belirsizSonucMu({ metaBelirsizSonuc: "evet" }), false);
});
