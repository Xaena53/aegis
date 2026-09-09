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
import { readFileSync, readdirSync } from "node:fs";
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
 *
 * DİKKAT — bu gerekçe bir ÖNCÜLDÜR ve artık dosyanın alt yarısındaki DURAKLATILMIŞ
 * kapsamı onu bağlar. Öncül çökerse (bir create_ aracı kampanyayı yayında doğurursa)
 * orası kırmızı olur; bu satırın "kapı istemezler" muafiyeti o kayıt olmadan
 * doğrulanmamış bir varsayımdı.
 */
const MUAFLAR: Record<string, string> = {};

/**
 * src/tools altındaki HER kaynak dosya — bu dosyadaki İKİ tarayıcının da tek listesi.
 *
 * Burada bir zamanlar sabit bir ikili duruyordu ("src/tools/write.ts", "src/tools/meta.ts")
 * ve tam da gözcünün var oluş nedeni olan arızayı üretiyordu: yeni bir platform yeni bir
 * dosyayla gelir, o dosya listeye yazılmayı unutulur, içindeki araç hiçbir kapsam kaydına
 * girmeden içeri sızar. Ölçüldü: src/tools altına konan, liveCampaignGuard + onayAl çağıran,
 * WRITE_SAFE işaretli bir araç yedi gözcüyü de yeşil geçiyordu. Dizin okunur ki gözcü kendi
 * kör noktasını üretemesin; "yeni dosya eklendi" bilinmeyendir ve bilinmeyen taranır.
 */
function toolKaynaklari(): string[] {
  return readdirSync("src/tools")
    .filter((d) => d.endsWith(".ts"))
    .map((d) => `src/tools/${d}`)
    .sort();
}

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
function kaynaktakiAraclar(
  dosyalar: string[] = toolKaynaklari()
): Array<{ ad: string; govde: string; dosya: string }> {
  const hepsi: Array<{ ad: string; govde: string; dosya: string }> = [];
  for (const dosya of dosyalar) {
    const kaynak = readFileSync(dosya, "utf8");
    for (const parca of kaynak.split("server.registerTool(").slice(1)) {
      const m = parca.match(/"([a-z0-9_]+)"/);
      hepsi.push({ ad: m ? m[1] : "(adı okunamadı)", govde: parca, dosya });
    }
  }
  return hepsi;
}

/**
 * Bu ad KAYDIN KENDİSİNDE mi geçiyor? — `in` DEĞİL, `Object.hasOwn`.
 *
 * Bu dosyadaki kapsam sorguları `ad in KAYIT` yazıyordu ve `in` prototip zincirini de tarar.
 * Ölçüldü: `"constructor" in { create_search_campaign: 1 }` → **true**. Araç adları
 * `[a-z0-9_]+` ile ayrıştırıldığı için `constructor` geçerli bir addır; yani `constructor`
 * adlı bir araç bütün gözcülerin gözünde "zaten kayıtlı" sayılıp sessizce içeri girerdi.
 * Absürt ama fail-OPEN bir delik: sözleşme bilinmeyeni REDDE götürür, kayda değil.
 */
function kayitli(kayit: Record<string, unknown>, ad: string): boolean {
  return Object.hasOwn(kayit, ad);
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

  const kapsamsiz = yikicilar.filter((ad) => !kayitli(KAPI_KAPSAMI, ad) && !kayitli(MUAFLAR, ad));
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
    .filter((a) => !kayitli(KAPI_KAPSAMI, a.ad) && !kayitli(MUAFLAR, a.ad))
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

/**
 * TARAYICININ KÖR NOKTASI — GÖZCÜ KENDİ KAPSAMINI ÖLÇER.
 *
 * Üstteki ters gözcü ne kadar iyi olursa olsun, OKUMADIĞI dosyada hiçbir şey göremez ve
 * "hiçbir şey görmedim" ile "temiz" arasındaki farkı kendi başına söyleyemez. Bu dosya
 * bu arızayı bir kez yaşadı: kaynak tarayıcısının varsayılan listesi elle yazılmış bir
 * ikiliydi ("src/tools/write.ts", "src/tools/meta.ts") ve ölçüldü — src/tools altına konan,
 * liveCampaignGuard + onayAl çağıran, WRITE_SAFE işaretli bir araç YEDİ GÖZCÜYÜ DE yeşil
 * geçiyordu: yanlış işaret + tarayıcının görmediği konum, kaydın tamamen dışında bir para
 * yolu demektir. Aynı arıza add_keywords'te de yaşanmıştı.
 *
 * Bu test tarayıcının VARSAYILAN davranışını bağlar: araç kaydeden hiçbir src/tools dosyası
 * taramanın dışında kalamaz. Liste elle yazılmış bir sabite düşerse burası kırmızı olur.
 */
test("KAYNAK TARAYICISI dizini okur: araç kaydeden hiçbir src/tools dosyası varsayılan taramanın dışında kalmaz", () => {
  const taranan = new Set(kaynaktakiAraclar().map((a) => a.dosya));

  const kayitliDosyalar = toolKaynaklari().filter((d) =>
    readFileSync(d, "utf8").includes("server.registerTool(")
  );
  assert.ok(
    kayitliDosyalar.length > 1,
    "src/tools altında araç kaydeden birden fazla dosya bulunamadı — dizin yolu ya da kayıt deseni bayatlamış olabilir"
  );

  const gormedikleri = kayitliDosyalar.filter((d) => !taranan.has(d));
  assert.deepEqual(
    gormedikleri,
    [],
    `Araç kaydettiği hâlde varsayılan kaynak taramasının DIŞINDA kalan dosya(lar): ${gormedikleri.join(", ")}.\n` +
      `kaynaktakiAraclar() elle yazılmış bir dosya listesine düşmüş demektir. O listeye yazılmayı\n` +
      `unutulan her yeni platform dosyası, içindeki araç kapıyı çağırsa bile hiçbir kapsam kaydına\n` +
      `girmeden içeri sızar — gözcü kendi kör noktasını üretemez, dizini okur.`
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

/* ════════════════════════════════════════════════════════════════════════════════
 * İKİZ KAYIT — "KAMPANYALAR DURAKLATILMIŞ DOĞAR"
 *
 * Üstteki kayıt tek bir sözleşme maddesini bağlıyordu: para hareketi ağ kapısından
 * geçer. Sözleşmenin ikinci maddesi — "Kampanyalar DURAKLATILMIŞ doğar; yayına alma
 * ayrı bir araç + insan onayı ister" — bugüne kadar HİÇBİR kapsam kaydına sahip
 * değildi. Üstelik MUAFLAR'ın boş bırakılma gerekçesi doğrudan bu doğrulanmamış
 * öncüle dayandırılmıştı: "kampanya oluşturma araçları duraklatılmış doğdukları için
 * harcama başlatmaz". Öncülü sınayan tek şey, araç adı elle sabit kodlanmış iki testti
 * (promises.test.ts, metaClient.test.ts).
 *
 * NEDEN YETMİYORDU: yarın create_pmax_campaign (ya da TikTok/LinkedIn karşılığı)
 * eklenip kampanyayı ENABLED yazsa, üstteki iki gözcünün ikisi de kör kalırdı —
 * araç WRITE_SAFE işaretli olduğu için YIKICI testi görmez, onayAl/liveCampaignGuard
 * çağırmadığı için KAYNAK testi görmez. Elle yazılmış testler de yalnız kendi
 * adlarını bilir. Sonuç: bütün suit yeşilken ürün ilk çağrıda harcamaya başlayan bir
 * kampanya doğurabilirdi.
 *
 * SÖZLEŞME: kampanya doğuran — adı `create_` ile başlayan YA DA gövdesi bir KAMPANYA DOĞUM
 * İMZASI taşıyan (bkz. KAMPANYA_DOGUM_IMZALARI) — her araç, ya DAVRANIŞSAL kanıtı gösterilen
 * bir kayıt satırına sahiptir ya da burada gerekçesiyle muaf tutulur. Sessiz üçüncü seçenek
 * yoktur — üstteki kaydın kuralının aynısı.
 */

interface DuraklatmaKaniti {
  /** Kanıtın bulunduğu test dosyası — bayatlık testi bu dosyayı GERÇEKTEN açar. */
  dosya: string;
  /**
   * Kanıt bloğunun çağırdığı tanıtıcı. Araç adının kendisi olabilir (Google yolu) ya da
   * aracın kaynağından çağırdığı kanal fonksiyonu olabilir (Meta yolu: söz telde ölçülür).
   * Bu tanıtıcının aracın KAYNAK gövdesinde de geçmesi zorunludur; yoksa kanıt başka bir
   * şeyi ölçüyor demektir.
   */
  cagri: string;
  /** Kanıtın ne olduğu, insan okuru için. */
  not: string;
}

/**
 * Duraklatılmış doğduğu DAVRANIŞSAL olarak kanıtlanmış kampanya araçları.
 *
 * "Kanıt" burada yine süsleme değil: karşısındaki test aracı/kanalı çağırır ve giden
 * yükte durumun PAUSED olduğunu ölçer — metinde "duraklatılmış" kelimesini aramaz.
 */
const DURAKLATILMIS_KAPSAMI: Record<string, DuraklatmaKaniti> = {
  create_search_campaign: {
    dosya: "test/promises.test.ts",
    cagri: "create_search_campaign",
    not: "mutasyon yükünde campaign.status = PAUSED; kurulum akışı kampanya durumuna hiç dokunmaz",
  },
  create_meta_campaign: {
    dosya: "test/metaClient.test.ts",
    cagri: "kampanyaOlustur",
    not: "TELDE ölçülür: Meta'ya POST edilen gövdede status=PAUSED ve çağıran ACTIVE seçemez",
  },
};

/**
 * Tetikleyiciye takıldığı (adı `create_` ile başladığı ya da imzası tuttuğu) hâlde KAMPANYA
 * doğurmayan araçlar için bilinçli muafiyetler. Muafiyet gerekçesi, harcamanın hangi başka
 * mekanizmayla bağlandığını söylemek zorundadır.
 *
 * Muafiyet gerekçesi TAŞINIR bir varsayımdır ve aşağıdaki imza gözcüsü onu bağlar: muaf bir
 * araç günün birinde bir doğum imzası kazanırsa ("kampanya değil reklam doğurur" gerekçesi
 * çöktüyse) orası kırmızı olur.
 */
const DURAKLATILMIS_MUAFLAR: Record<string, string> = {
  create_responsive_search_ad:
    "Kampanya değil REKLAM doğurur; harcamayı kampanyanın durumu yönetir, duraklatılmış " +
    "kampanyadaki reklam gösterim yapmaz. Canlı kampanyaya reklam eklemek ayrı bir risktir ve " +
    "KAPI_KAPSAMI'nda ağ kapısıyla (high katman) zaten bağlıdır.",
};

/** Kampanyanın duraklatılmış doğduğunu gösteren, giden yükte aranan imza. */
const DURAKLATMA_IMZASI = "PAUSED";

/**
 * Kampanyayı YAYINDA doğurmak anlamına gelen kaynak desenleri.
 *
 * Reklam grubu / kriter düzeyindeki ENABLED bilinçli ve doğrudur (duraklatılmış kampanya
 * içindeki ENABLED reklam grubu hiçbir şey yayınlamaz, onay anında hazır olsun diye öyle
 * kurulur) — bu yüzden desenler KAMPANYA düzeyine özgüdür. Yorum içinde geçse bile kırmızı
 * olur: şüphe REDDE gider, gerekirse muafiyet gerekçesiyle yazılır.
 */
const YAYINDA_DOGUM_DESENLERI: Array<{ desen: RegExp; ne: string }> = [
  { desen: /CampaignStatus\s*\.\s*ENABLED/, ne: "CampaignStatus.ENABLED" },
  { desen: /status\s*:\s*["'`]ACTIVE["'`]/, ne: 'status: "ACTIVE"' },
  { desen: /status\s*:\s*["'`]ENABLED["'`]/, ne: 'status: "ENABLED"' },
];

/**
 * KAMPANYA DOĞUM İMZALARI — ada değil, GÖVDEYE bakan tetikleyiciler.
 *
 * Tetikleyici bir zamanlar yalnız `create_` ad önekiydi ve bu, dosyanın kendi doktrinine
 * tersti: üst yarıdaki kardeş gözcü "işarete güvenilmez" deyip kaynaktan ÇAĞRI tarar, bu
 * ikiz ise konvansiyona güveniyordu. Aracın adını, tam da onu ekleyen kişi seçer; ölçüldü:
 * gövdesi kampanyayı `CampaignStatus.ENABLED` ile doğuran bir araç `launch_pmax_campaign`
 * diye adlandırıldığında yedi gözcü de yeşil kalıyordu. Fail-closed ilkesi gereği "ad önekine
 * uymuyor" BİLİNMEYEN demektir ve redde gitmelidir, sessiz muafiyete değil.
 *
 * KEFALET: buradaki her imza BUGÜN gerçek bir araç gövdesiyle eşleşmek zorundadır (aşağıdaki
 * imza gözcüsü bunu bağlar). Hiçbir şeyle eşleşmeyen bir desen hiçbir şey gözlemez, dolayısıyla
 * hiçbir şeye kefil olamaz — ve bayatladığında sessizce körelir.
 *
 * SINIR — dürüstçe ve ÖLÇÜLMÜŞ olarak: bu iki imza Google mutate ve Meta kanalı yollarına
 * özgüdür. Bunların hiçbirine benzemeyen, ADI DA `create_` ile başlamayan bambaşka bir yol
 * hâlâ kaçar. Ölçüldü: src/tools altına konan, gövdesinde YALNIZCA
 * `status: enums.CampaignStatus.ENABLED` bulunan (mutate `entity` alanı ya da kanal çağrısı
 * OLMAYAN) `launch_pmax_campaign` bu suiti hâlâ 9/9 yeşil geçiyor. Bu yüzden aşağıdaki testin
 * başlığı kapsamı "ad öneki VEYA doğum imzası" diye söyler; "kampanya doğuran her araç" diye
 * değil — ve `CampaignStatus.ENABLED` bilerek imza YAPILMADI: set_campaign_status kampanyayı
 * meşru olarak ENABLED yapan ayrı araçtır, o deseni tetikleyiciye koymak yayına-alma yolunu
 * çıkışsız bir kırmızıya hapsederdi. Yeni platform eklenirken burası genişletilmelidir.
 */
const KAMPANYA_DOGUM_IMZALARI: Array<{ desen: RegExp; ne: string }> = [
  // Google Ads mutateResources: KAMPANYA düzeyinde kaynak. `campaign_budget` /
  // `campaign_criterion` bilinçli olarak DIŞARIDA — onlar kampanya doğurmaz.
  { desen: /entity\s*:\s*["'`]campaign["'`]/, ne: 'entity: "campaign"' },
  // Meta (ve aynı adlandırmayı izleyecek her yeni kanal): kanal üzerinden kampanya kurma.
  { desen: /\bkampanya\w*Olustur\s*\(/, ne: "kampanya*Olustur(" },
];

/** Bir araç kaydı kampanya doğurabilir mi? Ad öneki VEYA gövdedeki doğum imzası. */
function kampanyaDogurabilir(ad: string, govde: string): boolean {
  return ad.startsWith("create_") || KAMPANYA_DOGUM_IMZALARI.some((i) => i.desen.test(govde));
}

/**
 * Kampanya doğurma ihtimali olan araçlar: adı `create_` ile başlayan YA DA imzası tutan her kayıt.
 *
 * Kayıt listesi ENJEKTE EDİLEBİLİR olmak zorunda: bugünkü kaynakta ad öneki ile doğum imzası
 * AYNI üç aracı seçiyor, dolayısıyla gerçek kaynağı okuyan hiçbir iddia "tetikleyici ada mı
 * gövdeye mi bakıyor" sorusunu ayırt edemez. Sahte kayıtlar bu filtrenin ta kendisinden
 * geçirilebilsin ki gerileme gözcüsü boşluğa konuşmasın.
 */
function kampanyaDoguranlar(
  kayitlar: Array<{ ad: string; govde: string; dosya: string }> = kaynaktakiAraclar()
): Array<{ ad: string; govde: string; dosya: string }> {
  return kayitlar.filter((a) => kampanyaDogurabilir(a.ad, a.govde));
}

/** Kampanya doğurduğu hâlde ne kayıtta ne muaflarda olan araç adları — sessiz üçüncü yol. */
function kapsamDisiDoguranlar(adlar: string[]): string[] {
  return adlar.filter((ad) => !kayitli(DURAKLATILMIS_KAPSAMI, ad) && !kayitli(DURAKLATILMIS_MUAFLAR, ad));
}

test("KAMPANYA DOĞURAN (ad öneki VEYA doğum imzası) her araç, DURAKLATILMIŞ kapsamı kaydında (ya da gerekçeli muaf)", async () => {
  const kaynaktakiler = kampanyaDoguranlar().map((a) => a.ad);
  assert.ok(
    kaynaktakiler.length > 0,
    "kaynakta create_ önekli ya da doğum imzalı araç bulunamadı — ayrıştırıcı ya da dizin yolu bayatlamış olabilir"
  );

  const canliAdlar = (await araclar()).map((t) => t.name);
  const canliCreate = canliAdlar.filter((ad) => ad.startsWith("create_"));

  /**
   * Kaynak tarayıcı canlı sunucuyu GÖRMEZDEN gelemez. Bir araç başka bir dosyaya ya da
   * `server.registerTool(` dışında bir kayıt desenine taşınırsa tarayıcı sessizce körleşir;
   * o körlük burada gürültü çıkarır.
   */
  const gorunmeyen = canliCreate.filter((ad) => !kaynaktakiler.includes(ad));
  assert.deepEqual(
    gorunmeyen,
    [],
    `Sunucuda kayıtlı ama KAYNAK taramasında görünmeyen create_ aracı: ${gorunmeyen.join(", ")}.\n` +
      `Tarayıcı src/tools/*.ts içindeki "server.registerTool(" bloklarını okur; araç başka bir\n` +
      `dizine ya da başka bir kayıt desenine taşındıysa bu gözcü artık kimseyi korumuyor demektir.`
  );

  const hepsi = [...new Set([...kaynaktakiler, ...canliCreate])].sort();
  const kapsamsiz = kapsamDisiDoguranlar(hepsi);
  assert.deepEqual(
    kapsamsiz,
    [],
    `DURAKLATILMIŞ kapsamı dışında kampanya oluşturma aracı/araçları: ${kapsamsiz.join(", ")}.\n` +
      `Kampanya doğuran bir araç eklendiyse üç şey birlikte yapılır:\n` +
      `  1) araç kampanyayı DURAKLATILMIŞ (PAUSED) doğurur ve bu bir parametre DEĞİLDİR,\n` +
      `  2) giden yükte durumu ölçen davranışsal bir test yazılır (metinde kelime aramak sayılmaz),\n` +
      `  3) o testin yeri DURAKLATILMIS_KAPSAMI kaydına (dosya, çağrı) çifti olarak eklenir.\n` +
      `Araç kampanya doğurmuyorsa DURAKLATILMIS_MUAFLAR'a GEREKÇESİYLE yazılır — sessiz üçüncü yol yoktur.`
  );

  // Ters yön: kaldırılmış ya da yeniden adlandırılmış bir araç kayıtta kalırsa, kayıt
  // gerçekte kimseyi korumadığı hâlde koruyormuş gibi görünür.
  for (const ad of [...Object.keys(DURAKLATILMIS_KAPSAMI), ...Object.keys(DURAKLATILMIS_MUAFLAR)]) {
    assert.ok(
      canliAdlar.includes(ad),
      `DURAKLATILMIŞ kaydı '${ad}' aracını sayıyor ama sunucuda böyle bir araç yok (yeniden adlandırıldı mı?)`
    );
  }
});

test("KAYNAK TARAMASI: hiçbir kampanya oluşturma bloğu kampanyayı YAYINDA doğurmuyor", () => {
  const suclular: string[] = [];
  for (const arac of kampanyaDoguranlar()) {
    for (const { desen, ne } of YAYINDA_DOGUM_DESENLERI) {
      if (desen.test(arac.govde)) suclular.push(`${arac.ad} (${arac.dosya}): ${ne}`);
    }
  }
  assert.deepEqual(
    suclular,
    [],
    `Kampanyayı YAYINDA doğuran kaynak deseni: ${suclular.join(", ")}.\n` +
      `Kampanya oluşturma araçları kampanyayı DURAKLATILMIŞ doğurmak zorundadır; yayına alma\n` +
      `ayrı bir araçtır ve insan onayı + ağ kapısı ister. Desen bir yorumda geçiyorsa bile\n` +
      `kırmızıdır: bu satır bilerek karara bağlanmalı, sessizce içeri alınmamalıdır.`
  );
});

test("DURAKLATILMIŞ kaydındaki kanıt GERÇEKTEN var: işaret edilen dosya açılır ve blok aranır", () => {
  const onbellek = new Map<string, string[]>();
  const kaynakGovdeleri = new Map(kampanyaDoguranlar().map((a) => [a.ad, a.govde]));

  for (const [ad, kanit] of Object.entries(DURAKLATILMIS_KAPSAMI)) {
    /**
     * Önce kanıtın DOĞRU ŞEYİ ölçtüğünü bağla: kayıttaki çağrı tanıtıcısı aracın kendi
     * kaynak gövdesinde geçmiyorsa, kanıt başka bir yolu ölçüyor ve bu araç için hiçbir
     * şey söylemiyordur.
     */
    const govde = kaynakGovdeleri.get(ad);
    assert.ok(govde, `DURAKLATILMIŞ kaydı '${ad}' aracını sayıyor ama kaynakta böyle bir create_ bloğu yok`);
    assert.ok(
      govde!.includes(kanit.cagri),
      `DURAKLATILMIŞ kaydı '${ad}' için kanıt tanıtıcısı olarak '${kanit.cagri}' diyor, ama aracın ` +
        `kaynak gövdesinde bu tanıtıcı geçmiyor — kanıt başka bir yolu ölçüyor olabilir.`
    );

    if (!onbellek.has(kanit.dosya)) {
      // Dosya yoksa readFileSync fırlatır — bayatlığın en kaba hâli.
      onbellek.set(kanit.dosya, readFileSync(kanit.dosya, "utf8").split(/\btest\s*\(/));
    }
    const bloklar = onbellek.get(kanit.dosya)!;
    const kanitliBlok = bloklar.some(
      (b) => b.includes(kanit.cagri) && b.includes(DURAKLATMA_IMZASI) && b.includes("assert")
    );
    assert.ok(
      kanitliBlok,
      `DURAKLATILMIS_KAPSAMI '${ad}' için ${kanit.dosya} dosyasını kanıt gösteriyor (${kanit.not}), ` +
        `ama o dosyada '${kanit.cagri}' çağırıp giden yükte "${DURAKLATMA_IMZASI}" durumunu doğrulayan ` +
        `tek bir test bloğu yok. Kanıt ya yazılmalı ya da satır kaldırılmalı — var olmayan kanıta ` +
        `işaret eden kayıt, kayıt değildir.`
    );
  }
});

/**
 * DOĞUM İMZASI GÖZCÜSÜ — TETİKLEYİCİ ADA DEĞİL GÖVDEYE BAKAR.
 *
 * İkiz kaydın tetikleyicisi bir kez yalnız `create_` ad önekiydi. Ölçüldü: gövdesi kampanyayı
 * `CampaignStatus.ENABLED` ile doğuran bir araç `launch_pmax_campaign` diye adlandırıldığında
 * yedi gözcü de yeşil kalıyordu — ve o adı, tam da aracı ekleyen kişi seçer. Tehdit tarifi
 * "yarın eklenen ve kimsenin bağlamayı unuttuğu araç" olduğuna göre, ada güvenmek tehdidin
 * kendisine güvenmektir.
 *
 * NEDEN SAHTE KAYIT: bugünkü kaynakta ad öneki ile doğum imzası TAM AYNI üç aracı seçiyor.
 * Dolayısıyla gerçek kaynağı okuyan hiçbir iddia, filtrenin ada mı gövdeye mi baktığını
 * ayırt edemez — ada geri dönen bir gerileme gerçek kaynak üzerinde YEŞİL kalırdı. Bu test
 * sahte kayıtları gerçek filtrenin ta kendisinden geçirir; boşluğa konuşmaz.
 *
 * ÇİFT YÖNLÜ: aşağıdaki son iki blok imzaları KAYNAĞA bağlar. Bir imza hiçbir gövdeyle
 * eşleşmez olursa (desen bayatladı) ya da kayıtlı bir kampanya doğurucu adından bağımsız
 * olarak yakalanamaz olursa (kaynak değişti) burası kırmızı olur.
 */
test("DOĞUM İMZASI: tetikleyici ad önekine DEĞİL gövdeye bakar, ve imzalar kaynağa BAĞLIDIR", () => {
  /** Gerçek filtreden geçirilen sahte kayıtlar — hiçbirinin adı `create_` ile başlamıyor. */
  const sahteKayitlar = [
    {
      ad: "launch_pmax_campaign",
      govde: 'entity: "campaign",\n status: enums.CampaignStatus.ENABLED,',
      dosya: "src/tools/(sahte).ts",
    },
    {
      ad: "pmax_campaign_setup",
      govde: "const k = await kanal.kampanyaOlustur({ ad, hedef, gunlukButce });",
      dosya: "src/tools/(sahte).ts",
    },
    // Kampanya doğurmayan komşular: kampanya BÜTÇESİ ve kampanya KRİTERİ ayrı varlıklardır.
    {
      ad: "update_tiktok_budget",
      govde: 'entity: "campaign_budget",\n entity: "campaign_criterion",',
      dosya: "src/tools/(sahte).ts",
    },
    { ad: "list_accounts", govde: 'entity: "customer_client",', dosya: "src/tools/(sahte).ts" },
  ];

  assert.deepEqual(
    kampanyaDoguranlar(sahteKayitlar).map((a) => a.ad),
    ["launch_pmax_campaign", "pmax_campaign_setup"],
    "Kampanya doğuran bir aracın adı `create_` ile başlamak ZORUNDA değil: `launch_pmax_campaign`, " +
      "`setup_pmax_campaign`, `pmax_campaign_create` hepsi makul adlardır. Tetikleyici ad önekine " +
      "geri düşerse, o araç hiçbir kapsam kaydına girmeden kampanyayı YAYINDA doğurabilir. " +
      "Aynı ölçüm ters yönü de bağlar: kampanya bütçesi/kriteri kampanya DEĞİLDİR, imza onları almaz."
  );

  // Ve zincirin sonu: yakalanan araç, kayıtta olmadığı için gerçekten kapsam dışı sayılmalı.
  assert.deepEqual(
    kapsamDisiDoguranlar(kampanyaDoguranlar(sahteKayitlar).map((a) => a.ad)),
    ["launch_pmax_campaign", "pmax_campaign_setup"],
    "Doğum imzası tuttuğu hâlde ne DURAKLATILMIS_KAPSAMI'nda ne DURAKLATILMIS_MUAFLAR'da olan " +
      "araç, kapsam dışı ilan edilmek zorundadır — sessiz üçüncü yol yoktur."
  );

  /**
   * Kapsam sorgusu prototip zincirini taramamalı: `"constructor" in {…}` true döner ve araç
   * adları `[a-z0-9_]+` ile ayrıştırıldığı için `constructor` GEÇERLİ bir araç adıdır.
   * `in` ile yazılmış bir sorgu bu adı "zaten kayıtlı" sayıp sessizce içeri alırdı.
   */
  assert.deepEqual(
    kapsamDisiDoguranlar(["constructor", "valueof", "__proto__"]),
    ["constructor", "valueof", "__proto__"],
    "Kapsam sorgusu prototip zincirine düşüyor: kayıtta OLMAYAN bir araç adı (`constructor` gibi) " +
      "kayıtlı sayıldı. Sorgu `ad in KAYIT` değil `Object.hasOwn(KAYIT, ad)` olmalı — bilinmeyen redde gider."
  );

  const kaynaktakiler = kaynaktakiAraclar();

  // ÇİFT YÖNLÜ (1): hiçbir şeyle eşleşmeyen imza hiçbir şey gözlemez — kefil olamaz.
  for (const { desen, ne } of KAMPANYA_DOGUM_IMZALARI) {
    const eslesenler = kaynaktakiler.filter((a) => desen.test(a.govde)).map((a) => a.ad);
    assert.ok(
      eslesenler.length > 0,
      `'${ne}' doğum imzası bugün HİÇBİR araç gövdesiyle eşleşmiyor. Desen bayatladıysa sessizce ` +
        `körelmiş demektir: ya kaynaktaki karşılığına güncellenmeli ya da listeden çıkarılmalı.`
    );
  }

  // ÇİFT YÖNLÜ (2): kayıtlı her kampanya doğurucu, ADINDAN BAĞIMSIZ olarak yakalanabilmeli.
  const govdeler = new Map(kaynaktakiler.map((a) => [a.ad, a.govde]));
  for (const ad of Object.keys(DURAKLATILMIS_KAPSAMI)) {
    const govde = govdeler.get(ad);
    assert.ok(govde, `DURAKLATILMIŞ kaydı '${ad}' aracını sayıyor ama kaynakta böyle bir araç bloğu yok`);
    assert.ok(
      KAMPANYA_DOGUM_IMZALARI.some((i) => i.desen.test(govde!)),
      `'${ad}' kampanya doğurduğu KAYITLI ama gövdesinde hiçbir doğum imzası yok — bugün yalnız ` +
        `ad öneki sayesinde kapsamda. Adı değişirse sessizce kaçar: imzalar kaynağın bugünkü hâline ` +
        `göre güncellenmeli.`
    );
  }

  // ÇİFT YÖNLÜ (3): muafiyet gerekçesi ("kampanya doğurmaz") gövdeyle çelişemez.
  for (const [ad, gerekce] of Object.entries(DURAKLATILMIS_MUAFLAR)) {
    const govde = govdeler.get(ad);
    assert.ok(govde, `DURAKLATILMIS_MUAFLAR '${ad}' aracını sayıyor ama kaynakta böyle bir araç bloğu yok`);
    const tutanlar = KAMPANYA_DOGUM_IMZALARI.filter((i) => i.desen.test(govde!)).map((i) => i.ne);
    assert.deepEqual(
      tutanlar,
      [],
      `'${ad}' muaf tutulmuş ("${gerekce.slice(0, 60)}…") ama gövdesi artık şu doğum imzasını ` +
        `taşıyor: ${tutanlar.join(", ")}. Muafiyetin dayandığı öncül çökmüş demektir — araç ya ` +
        `DURAKLATILMIS_KAPSAMI'na davranışsal kanıtıyla taşınmalı ya da gerekçe yeniden yazılmalı.`
    );
  }
});
