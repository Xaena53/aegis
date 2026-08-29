// SPDX-License-Identifier: AGPL-3.0-only
/**
 * META BÜTÇE OKUMA — gerçek istemci, taklit edilmiş `fetch` ile.
 *
 * Bu dosya bilerek diğer Meta testlerinden ayrı: oradaki sahte kanal `kampanyaOku`'yu
 * tamamen değiştirdiği için istemcinin KENDİ mantığını hiç çalıştırmaz. Bütçenin iki
 * katmandan okunması (kampanya düzeyi CBO, yoksa reklam setleri toplamı) yalnız burada
 * sınanır — ve buradan çıkan sayı doğrudan harcama tavanına karşı ölçüldüğü için, her
 * belirsizliğin RET tarafına düşmesi gerekir: eksik bir toplam, tavanın altında görünen
 * bir aşımdır.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { metaKanali, __setMetaKanalForTests } from "../src/meta/client.js";

const AYAR = { metaToken: "TEST-ONLY-token", metaAdAccountId: "act_1" };
const KAMPANYA = "120200000000001";

const gercekFetch = globalThis.fetch;
/** Yapılan çağrıların yolları — "reklam setleri hiç sorulmadı" ölçülebilsin diye. */
let yollar: string[] = [];

afterEach(() => {
  globalThis.fetch = gercekFetch;
  __setMetaKanalForTests(undefined);
  yollar = [];
});

/** Kampanya yanıtı + (varsa) reklam seti yanıtı veren taklit. */
function fetchTakli(kampanya: unknown, adsets?: unknown) {
  globalThis.fetch = (async (url: any) => {
    const s = String(url);
    yollar.push(s.split("?")[0]);
    const govde = s.includes("/adsets") ? adsets : kampanya;
    if (govde === undefined) throw new Error("test: beklenmeyen çağrı " + s);
    return { ok: true, text: async () => JSON.stringify(govde) } as any;
  }) as typeof fetch;
  __setMetaKanalForTests(undefined);
  return metaKanali(AYAR);
}

const kampanyaGovdesi = (ek: Record<string, unknown> = {}) => ({
  id: KAMPANYA,
  name: "Yaz Kampanyası",
  status: "PAUSED",
  ...ek,
});

test("kampanya düzeyinde bütçe (CBO) varsa reklam setleri HİÇ sorulmaz", async () => {
  const k = fetchTakli(kampanyaGovdesi({ daily_budget: "50000" }));
  const c = await k.kampanyaOku(KAMPANYA);

  assert.equal(c.gunlukButce, 500, "50000 minor unit = 500");
  assert.equal(c.butceKaynagi, "kampanya");
  assert.ok(
    !yollar.some((y) => y.includes("/adsets")),
    "gereksiz ikinci çağrı yapılmamalı: CBO'da cevap zaten elimizde"
  );
});

test("KRİTİK: kampanya düzeyi bütçe yoksa ACTIVE reklam setlerinin toplamı okunur", async () => {
  /**
   * Asıl kazanım bu: eskiden bu kampanya "bütçesi okunamıyor" sayılıyor ve bu araçla
   * yayına ALINAMIYORDU. Meta'da CBO olmayan kampanyalar sıra dışı değil, olağandır.
   */
  const k = fetchTakli(kampanyaGovdesi(), {
    data: [
      { id: "1", name: "Set A", status: "ACTIVE", daily_budget: "10000" },
      { id: "2", name: "Set B", status: "ACTIVE", daily_budget: "5000" },
    ],
  });
  const c = await k.kampanyaOku(KAMPANYA);

  assert.equal(c.gunlukButce, 150, "10000 + 5000 minor unit = 150");
  assert.equal(c.butceKaynagi, "reklam-setleri");
  assert.equal(c.butceNotu, undefined, "okunabildiğinde sebep notu olmamalı");
});

test("DURAKLATILMIŞ reklam setleri toplama katılmaz — harcamayan bütçe tavan yemez", () => {
  return (async () => {
    const k = fetchTakli(kampanyaGovdesi(), {
      data: [
        { id: "1", name: "Aktif", status: "ACTIVE", daily_budget: "10000" },
        { id: "2", name: "Duraklatılmış", status: "PAUSED", daily_budget: "90000" },
      ],
    });
    const c = await k.kampanyaOku(KAMPANYA);
    assert.equal(c.gunlukButce, 100, "yalnız ACTIVE set sayılır");
  })();
});

test("KRİTİK: sayfa taşmasında toplam KABUL EDİLMEZ — eksik toplam tavanı yanlış geçirir", async () => {
  /**
   * Kırpılmış bir listeden çıkan toplam gerçeğinden KÜÇÜKTÜR. Sessizce ilk sayfayla
   * yetinmek, kapının en tehlikeli biçimde yanılmasıdır: aşan kampanya altta görünür.
   */
  const k = fetchTakli(kampanyaGovdesi(), {
    data: [{ id: "1", name: "Set A", status: "ACTIVE", daily_budget: "10000" }],
    paging: { next: "https://graph.facebook.com/v21.0/next-page" },
  });
  const c = await k.kampanyaOku(KAMPANYA);

  assert.equal(c.gunlukButce, undefined, "eksik liste bir toplam üretemez");
  assert.match(String(c.butceNotu), /reklam seti var/, "sebep söylenmeli");
});

test("KRİTİK: ömürlük bütçeli set günlük tavana çevrilmez — tahmin, doğrulama değildir", async () => {
  const k = fetchTakli(kampanyaGovdesi(), {
    data: [{ id: "1", name: "Ömürlük Set", status: "ACTIVE", lifetime_budget: "300000" }],
  });
  const c = await k.kampanyaOku(KAMPANYA);

  assert.equal(c.gunlukButce, undefined);
  assert.match(String(c.butceNotu), /ömürlük bütçe/);
  assert.match(String(c.butceNotu), /Ömürlük Set/, "hangi set olduğu söylenmeli");
});

test("ACTIVE reklam seti yoksa RET — yayına alınsa da gösterim yapamaz", async () => {
  const k = fetchTakli(kampanyaGovdesi(), {
    data: [{ id: "1", name: "Set A", status: "PAUSED", daily_budget: "10000" }],
  });
  const c = await k.kampanyaOku(KAMPANYA);

  assert.equal(c.gunlukButce, undefined);
  assert.match(String(c.butceNotu), /ACTIVE reklam seti yok/);
});

test("bütçesi hiç olmayan ACTIVE set toplamı düşürmez — RET olur", async () => {
  /**
   * "Bu seti atlayıp diğerlerini toplayalım" demek, bilinmeyeni sıfır saymaktır ve
   * toplamı gerçeğinden küçük gösterir — deponun her yerde reddettiği kalıp.
   */
  const k = fetchTakli(kampanyaGovdesi(), {
    data: [
      { id: "1", name: "Set A", status: "ACTIVE", daily_budget: "10000" },
      { id: "2", name: "Bütçesiz", status: "ACTIVE" },
    ],
  });
  const c = await k.kampanyaOku(KAMPANYA);

  assert.equal(c.gunlukButce, undefined, "bilinmeyen set toplamı geçersiz kılar");
  assert.match(String(c.butceNotu), /Bütçesiz/);
});

test("biçimsiz reklam seti yanıtı RET üretir (kapalı arıza)", async () => {
  const k = fetchTakli(kampanyaGovdesi(), { veri: "beklenmeyen biçim" });
  const c = await k.kampanyaOku(KAMPANYA);
  assert.equal(c.gunlukButce, undefined);
  assert.match(String(c.butceNotu), /beklenen biçimde gelmedi/);
});

test("reklam seti çağrısı HATA verirse akış düşmez, RET'e döner", async () => {
  __setMetaKanalForTests(undefined);
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("/adsets")) throw new Error("ağ koptu");
    return { ok: true, text: async () => JSON.stringify(kampanyaGovdesi()) } as any;
  }) as typeof fetch;

  const c = await metaKanali(AYAR).kampanyaOku(KAMPANYA);
  assert.equal(c.gunlukButce, undefined);
  assert.match(String(c.butceNotu), /okunamadı/);
});

test("minor unit'ler ÖNCE tam sayı toplanır: kuruş artığı birikmez", async () => {
  /**
   * Her seti ayrı ayrı 100'e bölüp sonra toplamak kayan nokta artığı biriktirir.
   * 3333 + 3333 + 3334 = 10000 minor unit tam olarak 100 etmelidir.
   */
  const k = fetchTakli(kampanyaGovdesi(), {
    data: [
      { id: "1", name: "A", status: "ACTIVE", daily_budget: "3333" },
      { id: "2", name: "B", status: "ACTIVE", daily_budget: "3333" },
      { id: "3", name: "C", status: "ACTIVE", daily_budget: "3334" },
    ],
  });
  const c = await k.kampanyaOku(KAMPANYA);
  assert.equal(c.gunlukButce, 100, "toplam tam olarak 100 olmalı");
});
