// SPDX-License-Identifier: AGPL-3.0-only
/**
 * src/tools/meta.ts — ÜÇÜNCÜ tur onarım gerileme testleri: DÜĞÜM KAPISI BİR AK LİSTEDİR.
 *
 * İkinci tur `kampanyaDegilseRet` kapısını koydu ve reklam seti kimliğiyle tavan atlatmayı
 * kapattı. Bağımsız gözden geçiren kapının KARA LİSTE olduğunu ölçtü: koşul
 * `if (k.dugumTuru !== "dogrulanmadi") return null` idi, yani reddedilen tek şey kanalın
 * "kampanya olduğunu DOĞRULAYAMADIM" DEMESİydi. Hiçbir şey demeyen kanal — `dugumTuru`
 * alanı hiç olmayan yanıt — kampanya sayılıyor ve yazma gidiyordu. Ölçüm:
 * `kampanyaOku`'su alanı atlayan bir kanalla `update_meta_campaign_budget` GERÇEK
 * `butceGuncelle` çağrısını yapıp "Meta bütçesi güncellendi" diyordu.
 *
 * SESSİZLİK GÖZLEM DEĞİLDİR. Ağ halkalarında bu turda koda geçen kural ("hiçbir şey
 * gözlememiş halka hiçbir şeye kefil olamaz") para yolunda da geçerli: kapı yalnız kanalın
 * GÖZLEDİĞİNİ SÖYLEMESİYLE açılır — `dugumTuru === "kampanya"`, ki istemci bunu ancak
 * kampanyaya özgü `objective` alanı okumada gerçekten döndüğünde yazar.
 *
 * Bu dosya davranışı İKİ YÖNLÜ kilitler: alan susarsa yazma OLMAMALI, alan kefil olursa
 * yazma OLMALI (yoksa "her şeyi reddet" de testi geçerdi). Ayrıca kapının kendi yorumunu
 * koda karşı ölçer: yorum kodun yapmadığı bir kapalı-arıza özelliği iddia ediyordu.
 *
 * Ağa çıkılmaz: global fetch taklit edilir ya da kanal enjekte edilir.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { __setMetaKanalForTests, metaKanali, type MetaKampanya } from "../src/meta/client.js";

const TOKEN = "meta-gizli-jeton-1234567890";
const HESAP = "act_1";
const KIMLIK = "9998887776";

const gercekFetch = globalThis.fetch;

/** Kanala GERÇEKTEN giden yazma çağrıları — "hiç yazılmadı" ölçülebilsin diye. */
let yazmalar: string[] = [];
/** Gösterilen onay istemi sayısı — "insana kapıdan ÖNCE sorulmadı" ölçülebilsin diye. */
let istemSayisi = 0;

afterEach(() => {
  globalThis.fetch = gercekFetch;
  __setMetaKanalForTests(undefined);
  yazmalar = [];
  istemSayisi = 0;
});

const metin = (r: any) => String(r.content?.[0]?.text ?? "");

/**
 * Kanal, `dugumTuru` DIŞINDA her şeyi kusursuz döndürür: kimlik rakam, bütçe okunabilir ve
 * tavanın altında, durum belli. Yani reddi tetikleyebilecek BAŞKA hiçbir sebep yok —
 * ölçülen tek şey düğüm kapısıdır.
 */
function kanalKur(dugumTuru?: MetaKampanya["dugumTuru"]) {
  const kampanya: MetaKampanya = {
    id: KIMLIK,
    ad: "Test Kampanyası",
    durum: "PAUSED",
    gunlukButce: 100,
    butceKaynagi: "kampanya",
    ...(dugumTuru ? { dugumTuru } : {}),
  };
  __setMetaKanalForTests({
    async kampanyaOlustur() {
      throw new Error("bu testlerde kullanılmıyor");
    },
    async kampanyaOku() {
      return kampanya;
    },
    async butceGuncelle(_id, yeni) {
      yazmalar.push(`butceGuncelle:${yeni}`);
      kampanya.gunlukButce = yeni;
    },
    async durumDegistir(_id, durum) {
      yazmalar.push(`durumDegistir:${durum}`);
      kampanya.durum = durum;
    },
  });
}

/** MCP sunucusu + istemci. Ağ doğrulama katmanı kapalı: ölçülen şey ARAÇ katmanıdır. */
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
    { name: "onarim3-meta", version: "1.0.0" },
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

/* ── SUSAN KANAL: kefil olmayan yanıt yazma AÇMAZ ──────────────────────────── */

test("KRİTİK: düğüm türünü BİLDİRMEYEN okuma bütçe yazmasını REDDEDER; kanal hiç yazmaz", async () => {
  /**
   * Onarım öncesi ölçülen davranış aynen bu çağrıydı: kapı `!== "dogrulanmadi"` olduğu için
   * susan kanal kampanya sayılıyor, `butceGuncelle(9998887776, 400)` gerçekten koşuyor ve
   * araç "Meta bütçesi güncellendi" diyordu. Bütçe ARTIŞI seçildi ki insana sormadan
   * reddedildiği de aynı testte görünsün.
   */
  kanalKur(undefined);
  const c = await sunucuKur({ elicitation: true });
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 400 },
  });

  assert.match(metin(r), /Reddedildi/u, "kefil olunmamış düğüme yazılmamalı");
  assert.deepEqual(yazmalar, [], "KRİTİK: hiçbir yazma yapılmamalı");
  assert.equal(istemSayisi, 0, "kapı insana sormadan ÖNCE kapanmalı");
  assert.doesNotMatch(metin(r), /güncellendi/u, "yapılmamış bir güncelleme bildirilmemeli");
});

test("KRİTİK: düğüm türünü BİLDİRMEYEN okuma YAYINA ALMAYI reddeder; durum değişmez", async () => {
  kanalKur(undefined);
  const c = await sunucuKur({ elicitation: true });
  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: KIMLIK, status: "ACTIVE" },
  });

  assert.match(metin(r), /Reddedildi/u);
  assert.deepEqual(yazmalar, [], "KRİTİK: yayına alma POST'u yapılmamalı");
  assert.equal(istemSayisi, 0, "yanlış nesne için insan onayı ALINMAMALI — kayda geçer");
});

test("susan kanalın reddi SEBEBİNİ söyler: sessizlik gözlem sayılmaz", async () => {
  /**
   * Sebep satırı olmadan operatör "okudum ama doğrulayamadım" ile "bu nesne hiç okumadan
   * geldi" arasını ayıramaz; ikisinin çaresi farklıdır. `dugumNotu` yalnız birinci durumda
   * gelir, bu yüzden ikinci durumun kendi cümlesi olmalı — ve o cümle ret metnine ÇIKMALI.
   */
  kanalKur(undefined);
  const c = await sunucuKur();
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 400 },
  });

  assert.match(metin(r), /Sebep:/u, "ret bir sebep taşımalı");
  assert.match(metin(r), /sessizlik gözlem sayılmaz/u, "susan kanal için ayrı sebep cümlesi");
});

/* ── KARŞI KONTROL: kapı "her şeyi reddet" değil ───────────────────────────── */

test("KARŞI KONTROL: kanal kampanya olduğuna KEFİL olunca yazma yapılır", async () => {
  /**
   * Yukarıdaki testler tek başına "kapıyı tamamen kapat" ile de yeşil olurdu. Bu test o
   * kaçışı kapatır: tek fark alanın kefil olması, ve yazma geçmeli.
   */
  kanalKur("kampanya");
  const c = await sunucuKur({ elicitation: true });
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 400 },
  });

  assert.deepEqual(yazmalar, ["butceGuncelle:400"], "kefil olunan düğüme yazma geçmeli");
  assert.equal(istemSayisi, 1, "artış insana sorulmalı");
  assert.match(metin(r), /güncellendi/u);
});

test("kanal DOGRULANMADI dediğinde de reddedilir (eski dal korunuyor)", async () => {
  kanalKur("dogrulanmadi");
  const c = await sunucuKur({ elicitation: true });
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 400 },
  });

  assert.match(metin(r), /Reddedildi/u);
  assert.deepEqual(yazmalar, []);
});

/* ── ÜRETİM TİPİNDE SUSAN ŞEKİL GERÇEKTEN VAR ─────────────────────────────── */

test("KRİTİK: kampanyaOlustur üretimde düğüm türüne KEFİL OLMAZ — susan şekil test dikişine özgü değil", async () => {
  /**
   * Eski yorum "undefined buraya yalnız `__setMetaKanalForTests` üzerinden gelir" diyordu.
   * Gerçek istemci, sahte fetch ile: oluşturma yanıtından kurulan nesne hiçbir şeye kefil
   * olmaz, çünkü POST yanıtı `objective` okumasından geçmez. Ak listenin taşıyıcı olmasının
   * sebebi budur; bu şekil bir gün bir kapıya ulaşırsa REDDE düşmelidir.
   */
  globalThis.fetch = (async (url: any) => {
    const yol = String(url).split("?")[0];
    const govde = yol.endsWith("/act_1")
      ? { currency: "USD", currency_offset: 100 }
      : { id: KIMLIK };
    return { ok: true, text: async () => JSON.stringify(govde) } as any;
  }) as typeof fetch;
  __setMetaKanalForTests(undefined);

  const k = await metaKanali({ metaToken: TOKEN, metaAdAccountId: HESAP }).kampanyaOlustur({
    ad: "Yeni",
    hedef: "OUTCOME_TRAFFIC",
    gunlukButce: 50,
  });

  assert.equal(k.dugumTuru, undefined, "oluşturma yanıtı kampanya olduğuna KEFİL OLMAZ");
});

/* ── YORUM İLE KOD AYNI ŞEYİ SÖYLEMELİ ─────────────────────────────────────── */

const KAYNAK = () => readFileSync(new URL("../src/tools/meta.ts", import.meta.url), "utf8");

/**
 * Kapının GÖVDESİ — üstündeki açıklama bilerek dışarıda bırakılır. Yorum eski koşulu
 * ANLATIYOR (yanlışın ne olduğu yazılı kalsın diye); gövdeyi ayırmadan yapılan bir metin
 * araması yorumdaki alıntıyı kodun kendisi sanardı.
 */
function kapiGovdesi(): string {
  const kaynak = KAYNAK();
  const bas = kaynak.indexOf("function kampanyaDegilseRet");
  assert.ok(bas > 0, "kapı fonksiyonu bulunamadı — dosya yeniden adlandırıldıysa gözcü tazelensin");
  const son = kaynak.indexOf("\n}\n", bas);
  assert.ok(son > bas, "kapı fonksiyonunun sonu bulunamadı");
  return kaynak.slice(bas, son);
}

/** Kapının üstündeki açıklama bloğu. */
function kapiYorumu(): string {
  const kaynak = KAYNAK();
  const bas = kaynak.indexOf("THE CEILING IS AN ACCOUNT-WIDE PROMISE");
  assert.ok(bas > 0, "kapı yorumu bulunamadı");
  return kaynak.slice(bas, kaynak.indexOf("function kampanyaDegilseRet"));
}

test("KRİTİK: düğüm kapısı AK LİSTE yazılmış (kara listeye dönerse kırmızı)", () => {
  const govde = kapiGovdesi();
  assert.equal(
    /if \(k\.dugumTuru === "kampanya"\) return null;/u.test(govde),
    true,
    "kapı yalnız açıkça gözlenmiş kampanyaya açılmalı"
  );
  assert.equal(
    /dugumTuru !==/u.test(govde),
    false,
    "KRİTİK: kara liste geri gelmiş — susan kanal yine kampanya sayılır"
  );
});

test("KRİTİK: kapının yorumu artık 'undefined yalnız testten gelir' DEMİYOR", () => {
  /**
   * Bu iddia koda karşılık gelmiyordu ve public depoda jüri onu okuyacaktı. Gözcü çift
   * yönlü: kod eski hâline dönerse yukarıdaki testler, YORUM eski hâline dönerse bu test
   * kırmızı olur.
   */
  const yorum = kapiYorumu();
  assert.equal(
    /a fake cannot vouch/iu.test(yorum),
    false,
    "yorum kodun yapmadığı bir kapalı-arıza özelliği iddia ediyordu"
  );
  assert.equal(
    /reaches here only/iu.test(yorum),
    false,
    "undefined üretim tiplerinde de var: kampanyaOlustur alanı hiç yazmıyor"
  );
  assert.equal(/ALLOW LIST/u.test(yorum), true, "yorum kapının ak liste olduğunu söylemeli");
  assert.equal(
    /Silence is not an observation/u.test(yorum),
    true,
    "kefalet ilkesi yorumda da adıyla dursun"
  );
});

/* ── KAPININ KAPSAMI: DURAKLATMA BİLEREK DIŞARIDA ─────────────────────────── */

test("KRİTİK: kanal SUSSA BİLE duraklatma geçer — kapı yalnız para çıkan yönü tutar", async () => {
  /**
   * Kapının yorumu "her yazmanın önünde durur" diyordu; kod öyle değil ve öyle OLMAMALI.
   * `set_meta_campaign_status`in PAUSED dalı yazmayı HİÇ okuma yapmadan gönderir: duraklatma
   * harcamayı DURDURUR, dolayısıyla onu Meta'nın sık sık patlattığı bir okumaya bağlamak
   * kapalı-arızayı ters yöne çevirirdi ("durdur" diyen kullanıcı kampanya yanarken elde
   * kalır). Bu test o bilinçli istisnayı çiviler: biri düğüm kapısını duraklatmanın da önüne
   * koyarsa kırmızı olur, ve o an yorumun kapsam cümlesi de yeniden yazılmak zorunda kalır.
   */
  kanalKur(undefined);
  const c = await sunucuKur({ elicitation: true });
  const r: any = await c.callTool({
    name: "set_meta_campaign_status",
    arguments: { campaignId: KIMLIK, status: "PAUSED" },
  });

  assert.deepEqual(
    yazmalar,
    ["durumDegistir:PAUSED"],
    "KRİTİK: harcamayı DURDURAN yazma bir okumanın kefaletine bağlanmamalı"
  );
  assert.equal(istemSayisi, 0, "duraklatma insan onayı istemez");
  assert.doesNotMatch(metin(r), /Reddedildi/u, "duraklatma reddedilirse 'hemen durdur' çalışmaz");
  assert.match(metin(r), /durumu: PAUSED/u);
});

test("KRİTİK: kapının yorumu KAPSAMINI olduğundan geniş anlatmıyor", () => {
  /**
   * Çift yönlü gözcünün metin ayağı: yukarıdaki test kodu, bu test yorumu çiviler. Eski
   * cümle ("it sits between the read and every write") kapıyı DURAKLATMA yazmasının da
   * önünde gösteriyordu — public depoda okuyan, kodun vermediği bir kapalı-arıza garantisi
   * çıkarırdı.
   */
  const yorum = kapiYorumu();
  assert.equal(
    /between the read and every write/iu.test(yorum),
    false,
    "kapı HER yazmanın önünde değil: DURAKLATMA yazması ondan önce ve okumasız koşar"
  );
  assert.equal(/PAUSE/u.test(yorum), true, "yorum kapsam dışı kalan yazmayı ADIYLA anmalı");
  assert.equal(
    /SPENDING paths/u.test(yorum),
    true,
    "kapının hangi yönü (para çıkan yön) tuttuğu yazılı olsun"
  );
});
