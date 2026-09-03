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
 *
 * KAYIT ARTIK KENDİ KENDİNİ DENETLİYOR. Bu dosya bir kez şunu söyledi: "kanıt burada,
 * o testi yazmadan satır eklemek anlamsızdır — ve bu dosya onu denetleyemez". Denetleyemeyen
 * bir söz, tutulmamış bir sözle aynı yere düşer: create_responsive_search_ad satırı
 * networkTrust.test.ts'i gösteriyordu, o dosyada aracın adı HİÇ geçmiyordu. Kayıt artık
 * serbest metin değil (dosya, araç) çiftidir ve bayatlık testi işaret edilen dosyayı
 * GERÇEKTEN AÇIP o aracı ağ reddiyle sınayan bir test bloğu arar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";

interface KapiKaniti {
  /** Kanıtın bulunduğu test dosyası — bayatlık testi bu dosyayı gerçekten okur. */
  dosya: string;
  /** Kanıtın ne olduğu, insan okuru için. */
  not: string;
}

/**
 * Kapıdan geçtiği DAVRANIŞSAL olarak kanıtlanmış araçlar ve kanıtın yeri.
 *
 * "Kanıt" burada süsleme değil: her satırın karşısındaki test, sahte bir SIM-swap kanalı
 * enjekte edip aracı çağırır ve (a) reddedildiğini, (b) onay isteminin HİÇ gösterilmediğini,
 * (c) hiçbir yazma yapılmadığını doğrular.
 */
const KAPI_KAPSAMI: Record<string, KapiKaniti> = {
  update_campaign_budget: { dosya: "test/networkTrust.test.ts", not: "bütçe artışı, medium katman" },
  set_campaign_status: { dosya: "test/networkTrust.test.ts", not: "yayına alma, high katman" },
  create_responsive_search_ad: { dosya: "test/networkTrust.test.ts", not: "canlı kampanyaya reklam, high katman" },
  /**
   * add_keywords buraya gecikmeli girdi: aracın kendisi liveCampaignGuard'ı "high" risk
   * etiketiyle çağırıyor ve networkTrust.test.ts onu SIM-swap kanalıyla reddedilirken
   * ölçüyordu — ama araç WRITE_SAFE işaretli olduğu için aşağıdaki gözcü onu hiç
   * görmüyordu. İşaret düzeltildi, satır da yerine kondu.
   */
  add_keywords: { dosya: "test/networkTrust.test.ts", not: "canlı kampanyaya pozitif kelime, high katman" },
  update_meta_campaign_budget: { dosya: "test/meta.test.ts", not: "Meta bütçe artışı, medium katman" },
  set_meta_campaign_status: { dosya: "test/meta.test.ts", not: "Meta yayına alma, high katman" },
};

/**
 * Yıkıcı işaretli OLMADIĞI hâlde para yolunda duran araçlar için bilinçli muafiyetler.
 * Şu an boş: kampanya oluşturma araçları duraklatılmış doğdukları için harcama
 * başlatmaz, dolayısıyla kapı istemezler.
 */
const MUAFLAR: Record<string, string> = {};

/** Ağ kapısını çağırma ihtimali olan araçların kaynak dosyaları. */
const ARAC_KAYNAKLARI = ["src/tools/write.ts", "src/tools/meta.ts"];

/** Ağ reddinin araca kadar ULAŞTIĞINI gösteren, kullanıcıya dönen metin. */
const AG_RET_IMZASI = "AĞ DOĞRULAMASI BAŞARISIZ";

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

/**
 * Kaynak dosyayı registerTool bloklarına böler: her blok bir aracın adı + gövdesidir.
 * Bir sonraki registerTool çağrısına kadar olan her şey o araca aittir; dosyanın
 * başındaki yardımcı fonksiyonlar (liveCampaignGuard'ın kendisi dahil) ilk parçadan
 * önce kaldığı için hiçbir araca yazılmaz.
 */
function kaynaktakiAraclar(): Array<{ ad: string; govde: string; dosya: string }> {
  const hepsi: Array<{ ad: string; govde: string; dosya: string }> = [];
  for (const dosya of ARAC_KAYNAKLARI) {
    const kaynak = readFileSync(dosya, "utf8");
    for (const parca of kaynak.split("server.registerTool(").slice(1)) {
      const m = parca.match(/"([a-z0-9_]+)"/);
      hepsi.push({ ad: m ? m[1] : "(adı okunamadı)", govde: parca, dosya });
    }
  }
  return hepsi;
}

/** Kaynak gövdesi insan onayı / canlı kampanya kapısını çağırıyor mu? */
function kapiyiCagiriyor(govde: string): boolean {
  return /\bonayAl\s*\(/.test(govde) || /\bliveCampaignGuard\s*\(/.test(govde);
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

/**
 * TERS GÖZCÜ — İŞARETE DEĞİL, KODA BAKAR.
 *
 * Üstteki test yalnız destructiveHint=true olanları tarar, yani bir aracın kapsam dışı
 * kalması için işaretinin yanlış olması yetiyordu: add_keywords tam olarak böyle kaçtı —
 * canlı kampanyada "high" risk etiketiyle kapıyı çağırıyordu ama WRITE_SAFE işaretli
 * olduğu için gözcü onu hiç görmedi. Bu test işaretin doğruluğuna güvenmez, KAYNAĞA
 * bakar: onayAl ya da liveCampaignGuard çağıran her araç ya kayıtta ya muaflardadır.
 */
test("KAYNAKTA kapıyı çağıran her araç kayıtta (ya da gerekçeli muaf) — işarete güvenilmez", async () => {
  const kapiliAraclar = kaynaktakiAraclar().filter((a) => kapiyiCagiriyor(a.govde));
  assert.ok(kapiliAraclar.length > 0, "kaynakta kapı çağıran araç bulunamadı — ayrıştırıcı bayatlamış olabilir");

  const kapsamsiz = kapiliAraclar
    .filter((a) => !(a.ad in KAPI_KAPSAMI) && !(a.ad in MUAFLAR))
    .map((a) => `${a.ad} (${a.dosya})`);

  assert.deepEqual(
    kapsamsiz,
    [],
    `Kapıyı ÇAĞIRAN ama kapı kapsamı kaydında olmayan araç(lar): ${kapsamsiz.join(", ")}.\n` +
      `Bir araç onayAl/liveCampaignGuard çağırıyorsa para yolundadır: kaydı yazılır ya da\n` +
      `MUAFLAR'a gerekçesiyle konur. İşaretin (destructiveHint) doğru olması bu testi susturmaz.`
  );

  // Ve tersi: kayıtta olan bir araç kaynakta kapıyı çağırmayı bırakmışsa kayıt yalan söyler.
  const kapiliAdlar = new Set(kapiliAraclar.map((a) => a.ad));
  for (const ad of Object.keys(KAPI_KAPSAMI)) {
    assert.ok(
      kapiliAdlar.has(ad),
      `KAPI_KAPSAMI '${ad}' aracını sayıyor ama kaynağında artık onayAl/liveCampaignGuard çağrısı yok — kapı düşmüş olabilir`
    );
  }
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

/**
 * KANIT GERÇEKTEN ORADA MI?
 *
 * Kaydın en zayıf yeri, işaret ettiği dosyanın hiç açılmamasıydı: bir satır var olmayan
 * bir kanıtı gösterebiliyor ve denetçi "kanıtlanmış" diye okuyordu. Bu test işaret edilen
 * dosyayı okur, test bloklarına böler ve o araç adını AĞ REDDİYLE aynı blokta arar —
 * yani "araç çağrıldı VE ağ kapısı onu reddetti" iddiasının tek bir testte durduğunu
 * doğrular. Kanıtı taşıyan test silinirse ya da adı değişirse burası kırmızı olur.
 */
test("kapı kapsamı kaydındaki kanıt GERÇEKTEN var: işaret edilen dosya açılır ve blok aranır", () => {
  const onbellek = new Map<string, string[]>();

  for (const [ad, kanit] of Object.entries(KAPI_KAPSAMI)) {
    if (!onbellek.has(kanit.dosya)) {
      // Dosya yoksa readFileSync fırlatır — bu da bayatlığın en kaba hâlidir.
      onbellek.set(kanit.dosya, readFileSync(kanit.dosya, "utf8").split(/\btest\s*\(/));
    }
    const bloklar = onbellek.get(kanit.dosya)!;
    const kanitliBlok = bloklar.some((b) => b.includes(ad) && b.includes(AG_RET_IMZASI));
    assert.ok(
      kanitliBlok,
      `KAPI_KAPSAMI '${ad}' için ${kanit.dosya} dosyasını kanıt gösteriyor (${kanit.not}), ` +
        `ama o dosyada aracı çağırıp "${AG_RET_IMZASI}" retini doğrulayan tek bir test bloğu yok. ` +
        `Kanıt ya yazılmalı ya da satır kaldırılmalı — var olmayan kanıta işaret eden kayıt, kayıt değildir.`
    );
  }
});
