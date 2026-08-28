// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAPI KAPSAMI — harcamayı artıran her araç, ağ kapısından geçmek ZORUNDA.
 *
 * NEDEN VAR: bu depoda tekrar tekrar aynı şey oldu — yeni bir şey eklendi, kendi testleri
 * yeşil kaldı, ama onu güvence altına alan mekanizmaya BAĞLANMADI. Zincire halka
 * eklendiğinde karar günlüğü güncellenmedi; ikinci bir harcama alanı (Meta) eklendiğinde
 * kayma gözcülerinin dışında kaldı. Ortak payda hep aynı: testi olan bağlantı tuttu,
 * testsiz olan sessizce kaydı.
 *
 * Bu dosya, projenin MERKEZÎ İDDİASINI bağlar: "insana sorulmadan önce ağa sor" kuralı
 * tek bir platformun özelliği değil, para hareket ettiren HER yolun niteliğidir. Yeni bir
 * platform (TikTok, LinkedIn, ödeme sağlayıcı…) eklendiğinde ve onun yıkıcı aracı bu
 * kayda yazılmadığında burası KIRMIZI olur — ve kırmızı olması, o aracın kapıdan geçip
 * geçmediğini birinin bilerek karara bağlamasını zorunlu kılar.
 *
 * SÖZLEŞME: destructiveHint=true olan her araç, ya kapı testi olan bir kayıt satırına
 * sahiptir ya da burada gerekçesiyle muaf tutulur. Sessiz üçüncü bir seçenek yoktur.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";

/**
 * Kapıdan geçtiği DAVRANIŞSAL olarak kanıtlanmış araçlar ve kanıtın yeri.
 *
 * "Kanıt" burada süsleme değil: her satırın karşısındaki test, sahte bir SIM-swap kanalı
 * enjekte edip aracı çağırır ve (a) reddedildiğini, (b) onay isteminin HİÇ gösterilmediğini,
 * (c) hiçbir yazma yapılmadığını doğrular. Bu kayda satır eklemek, o testi yazmadan
 * anlamsızdır — ve bu dosya onu denetleyemez, o yüzden satır eklerken dürüst ol.
 */
const KAPI_KAPSAMI: Record<string, string> = {
  update_campaign_budget: "test/networkTrust.test.ts — bütçe artışı, medium katman",
  set_campaign_status: "test/networkTrust.test.ts — yayına alma, high katman",
  create_responsive_search_ad: "test/networkTrust.test.ts — canlı kampanyaya yazma, high katman",
  update_meta_campaign_budget: "test/meta.test.ts — Meta bütçe artışı, medium katman",
  set_meta_campaign_status: "test/meta.test.ts — Meta yayına alma, high katman",
};

/**
 * Yıkıcı işaretli OLMADIĞI hâlde para yolunda duran araçlar için bilinçli muafiyetler.
 * Şu an boş: kampanya oluşturma araçları duraklatılmış doğdukları için harcama
 * başlatmaz, dolayısıyla kapı istemezler.
 */
const MUAFLAR: Record<string, string> = {};

async function araclar() {
  const config: any = {
    developerToken: "x",
    clientId: "x",
    clientSecret: "x",
    refreshToken: "x",
    writeEnabled: true,
    maxDailyBudget: 500,
    simSwapWindowHours: 72,
    reachCheck: false,
    devSwapCheck: false,
    callFwdCheck: false,
  };
  const server = buildServer(() => ({ config }) as any);
  const istemci = new Client({ name: "kapi-kapsami", version: "1.0.0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), istemci.connect(b)]);
  const { tools }: any = await istemci.listTools();
  return tools as Array<{ name: string; annotations?: { destructiveHint?: boolean } }>;
}

test("YIKICI işaretli her araç, kapı kapsamı kaydında bulunur", async () => {
  const yikicilar = (await araclar())
    .filter((t) => t.annotations?.destructiveHint === true)
    .map((t) => t.name);

  assert.ok(yikicilar.length > 0, "yıkıcı araç bulunamadı — test yolu bayatlamış olabilir");

  const kapsamsiz = yikicilar.filter((ad) => !(ad in KAPI_KAPSAMI) && !(ad in MUAFLAR));
  assert.deepEqual(
    kapsamsiz,
    [],
    `Kapı kapsamı dışında YIKICI araç(lar): ${kapsamsiz.join(", ")}.\n` +
      `Harcamayı artıran bir araç eklendiyse üç şey birlikte yapılır:\n` +
      `  1) araç onayAl'ı risk etiketi + agAyar ile çağırır,\n` +
      `  2) sahte SIM-swap kanalıyla reddedildiğini kanıtlayan bir test yazılır,\n` +
      `  3) o testin yeri test/kapiKapsami.ts içindeki KAPI_KAPSAMI kaydına eklenir.\n` +
      `Aracın kapı istememesi gerekiyorsa MUAFLAR'a GEREKÇESİYLE yazılır — sessiz üçüncü yol yoktur.`
  );
});

test("kapı kapsamı kaydı bayat değil: kayıttaki her araç HÂLÂ var ve HÂLÂ yıkıcı", async () => {
  /**
   * Ters yön de önemlidir: yeniden adlandırılmış ya da kaldırılmış bir araç kayıtta
   * kalırsa, kayıt gerçekte kimseyi korumadığı hâlde koruyormuş gibi görünür.
   */
  const hepsi = await araclar();
  for (const ad of Object.keys(KAPI_KAPSAMI)) {
    const arac = hepsi.find((t) => t.name === ad);
    assert.ok(arac, `KAPI_KAPSAMI '${ad}' aracını sayıyor ama böyle bir araç yok (yeniden adlandırıldı mı?)`);
    assert.equal(
      arac!.annotations?.destructiveHint,
      true,
      `'${ad}' artık yıkıcı işaretli değil — ya işaret düştü ya araç değişti; ikisi de bilerek karara bağlanmalı`
    );
  }
});
