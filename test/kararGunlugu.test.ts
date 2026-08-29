// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ağ kapısı KARAR GÜNLÜĞÜ (denetlenebilirlik izi).
 *
 * Merkezi iddialar:
 *  - Günlük VARSAYILAN KAPALI: ADSPILOT_DECISION_LOG yoksa dosya bile oluşmaz.
 *  - Ret ve geçiş kayıtları gerçek onay akışından, doğru alanlarla düşer.
 *  - Kayıt YAPISAL İZDEN üretilir, metinden değil: iki halka (SIM-Swap + Number
 *    Verification) AYRI alanlara yazılır ve birbirinin gerçekliğini gizleyemez.
 *  - Kayıtta SIR YOK: tam numara, token/"Bearer" benzeri kalıp, ham upstream metin.
 *  - Günlük KAPI DEĞİL: yazılamayan yol akışı düşürmez — işlem yine de gerçekleşir.
 *  - Risk etiketsiz işlemler hiç kaydedilmez (günlük ağ kapısının izidir).
 *  - hesapId: çok-kiracılı modda hangi hesabın kararı olduğu kayıttan okunabilir.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { sahteContext, agKanaliniSifirla } from "./helpers/harness.js";
import { agKararKaydiOlustur, kararYaz } from "../src/kararGunlugu.js";
import { agDogrula } from "../src/networkTrust.js";
import { onayAl } from "../src/approval.js";

const MUSTERI = "1234567890";
const KAMPANYA = "24120539226";
/** harness'in enjekte ettiği onaylayıcı numarası — maskeliliği burada sınanır. */
const TAM_NUMARA = "5551112233";

/** Kayıt alan kümesi KAPALIDIR: yeni bir alan bu listeye eklenmeden testi kırar. */
const ALANLAR = [
  "zaman",
  "eylem",
  "hesapId",
  "risk",
  "karar",
  "simSwapKanali",
  "nvKanali",
  "reachKanali",
  "locKanali",
  "devSwapKanali",
  "callFwdKanali",
  "pencereSaat",
  "devSwapPencereSaat",
  "tutar",
  "maskeliNumara",
  "retNedeniKisa",
];

/**
 * Zincirin HER halkası için: izdeki alan → kayıttaki alan.
 *
 * Bu eşleme bir testin konusu, çünkü eksikliği sessizdir. 3. ve 4. halka ilk
 * yazıldığında ize giriyor ama kayda geçmiyordu; ALANLAR listesi yalnız FAZLA alanı
 * yakaladığı için hiçbir test kızarmadı ve simüle bir halkanın ürettiği ret, kayıtta
 * yalnız "simSwapKanali":"gercek" görünerek gerçek bir CAMARA sorgusunun ürünü gibi
 * okunuyordu. Yeni halka eklendiğinde buraya da satır eklenmezse aşağıdaki test kırılır.
 *
 * KAPSAM: burası yalnız ZİNCİR HALKALARI içindir. `tutar` bir halka değildir — izden
 * değil çağrı yerinden (okunan bütçeden) gelir ve karşılığı olan bir `iz.` alanı yoktur;
 * buraya yazmak, hiç var olmayan bir halkayı varmış gibi göstermek olurdu. Onun kapsamı
 * ALANLAR listesi ve aşağıdaki "riskteki tutar" testleridir.
 */
const HALKA_ALANLARI = [
  { iz: "simSwap", kayit: "simSwapKanali" },
  { iz: "nv", kayit: "nvKanali" },
  { iz: "reach", kayit: "reachKanali" },
  { iz: "loc", kayit: "locKanali" },
  { iz: "devSwap", kayit: "devSwapKanali" },
  { iz: "callFwd", kayit: "callFwdKanali" },
] as const;

let kok: string;
let gunluk: string;

beforeEach(() => {
  kok = mkdtempSync(path.join(tmpdir(), "adspilot-karar-"));
  gunluk = path.join(kok, "kararlar.jsonl");
  delete process.env.ADSPILOT_DECISION_LOG;
});

afterEach(() => {
  delete process.env.ADSPILOT_DECISION_LOG;
  agKanaliniSifirla();
  rmSync(kok, { recursive: true, force: true });
});

function satirlar(): any[] {
  return readFileSync(gunluk, "utf8")
    .split("\n")
    .filter((s) => s.trim() !== "")
    .map((s) => JSON.parse(s));
}

/** Ham dosya içeriği — sır taraması JSON.parse'tan ÖNCE, bayt düzeyinde yapılmalı. */
function hamGunluk(): string {
  return readFileSync(gunluk, "utf8");
}

const YAYINA_HAZIR: Array<[RegExp, any[]]> = [
  [/campaign_budget\.amount_micros/, [{ campaign: { name: "Hazır" }, campaign_budget: { amount_micros: 50_000_000 } }]],
  [/FROM ad_group_ad/, [{ ad_group_ad: { ad: { id: 1 } } }]],
  [/FROM campaign_criterion/, []],
];

async function elicitationliIstemci(ctx: any, karar: "accept" | "decline" = "accept") {
  const sorulanlar: string[] = [];
  const client = new Client({ name: "gunluk-testi", version: "0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (req: any) => {
    sorulanlar.push(String(req.params.message));
    return karar === "accept" ? { action: "accept", content: { onay: true } } : { action: "decline" };
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

/* ── günlük kapalı ────────────────────────────────────────────────────────────── */

test("KRİTİK: ADSPILOT_DECISION_LOG yoksa günlük KAPALI — dosya bile oluşmaz", async () => {
  // env bilerek TANIMSIZ (beforeEach siler): varsayılan kapalı olmalı.
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: "temiz" });
  const { client } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.match(out, /YAYINDA/, "günlük kapalıyken akış normal ilerlemeli");
  assert.equal(rec.mutations.length, 1);
  assert.equal(existsSync(gunluk), false, "kapalı günlük hiçbir dosya oluşturmamalı");
  // Klasörde HİÇBİR şey yazılmamış olmalı (farklı bir ada da yazılmamalı).
  assert.deepEqual(readdirSync(kok), [], "kapalı günlük klasöre hiç dokunmamalı");
});

/* ── ret kaydı ────────────────────────────────────────────────────────────────── */

test("RET kaydı: SIM değişti → karar 'ret', kanal ve pencere doğru, numara maskeli", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: "degisti" });
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true, // ajanın onay iddiası da kayda geçen reti değiştirmemeli
  });

  assert.match(out, /AĞ DOĞRULAMASI BAŞARISIZ/);
  assert.equal(rec.mutations.length, 0);
  assert.equal(sorulanlar.length, 0, "ret, insan istemi gösterilmeden kaydedilmeli");

  const kayitlar = satirlar();
  assert.equal(kayitlar.length, 1, "tek karar = tek satır");
  const k = kayitlar[0];
  assert.equal(k.karar, "ret");
  assert.equal(k.simSwapKanali, "simulasyon");
  assert.equal(k.nvKanali, undefined, "NV halkası koşmadıysa alanı hiç yazılmaz");
  assert.equal(k.risk, "high");
  assert.equal(k.pencereSaat, 72);
  assert.equal(k.retNedeniKisa, "sim-degisti");
  assert.match(k.maskeliNumara, /^\+905\*+33$/, "numara yalnız maskeli hâliyle kaydedilmeli");
  assert.match(k.eylem, /YAYINA ALINACAK/, "hangi eylem reddedildiği okunabilmeli");
  assert.ok(!Number.isNaN(Date.parse(k.zaman)), "zaman ISO-8601 olmalı");
});

test("RET kaydı: ağ yanıtsız (gerçek kanal hata verirse) → 'ag-yanitsiz', kanal 'gercek'", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "hata" });
  const { client } = await elicitationliIstemci(ctx, "accept");

  await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });

  assert.equal(rec.mutations.length, 0);
  const k = satirlar()[0];
  assert.equal(k.karar, "ret");
  assert.equal(k.simSwapKanali, "gercek", "yapılandırma sağlamdı ve gerçek sorgu DENENDİ");
  assert.equal(k.pencereSaat, 72, "denenen pencere denetimde görünmeli");
  assert.equal(k.retNedeniKisa, "ag-yanitsiz");
  /**
   * Kapının ret metni upstream ayrıntısını zaten içermez; günlük de sabit sözlükten
   * kod yazar. Ham hata metni ("NaC sandbox unreachable") kayda ASLA giremez.
   */
  assert.doesNotMatch(hamGunluk(), /sandbox|unreachable/i, "ham upstream metin günlüğe sızmamalı");
});

/* ── geçiş kaydı ──────────────────────────────────────────────────────────────── */

test("GEÇİŞ kaydı: gerçek kanal temiz → karar 'gecti', kanal 'gercek', pencere 72", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "temiz" });
  const { client } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.match(out, /YAYINDA/);
  assert.equal(rec.mutations.length, 1);
  const k = satirlar()[0];
  assert.equal(k.karar, "gecti");
  assert.equal(k.simSwapKanali, "gercek");
  assert.equal(k.risk, "high");
  assert.equal(k.pencereSaat, 72);
  assert.equal(k.retNedeniKisa, undefined, "geçişte ret nedeni alanı hiç yazılmamalı");
  assert.match(k.maskeliNumara, /^\+905\*+33$/);
});

test("GEÇİŞ kaydı: bütçe artışı 'medium' riski ve 24 saatlik pencereyi kaydeder", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const butce: Array<[RegExp, any[]]> = [
    [
      /campaign_budget\.explicitly_shared/,
      [{ campaign: { name: "K" }, campaign_budget: { resource_name: "r", amount_micros: 50_000_000, explicitly_shared: false } }],
    ],
  ];
  const { ctx } = sahteContext({ queries: butce, agDurumu: "temiz" });
  const { client } = await elicitationliIstemci(ctx, "accept");

  await cagir(client, "update_campaign_budget", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    newDailyBudget: 400,
  });

  const k = satirlar()[0];
  assert.equal(k.risk, "medium", "risk katmanı denetim izinde görünmeli");
  assert.equal(k.pencereSaat, 24, "medium daha dar pencereyi kullanır ve kayda o düşer");
  assert.equal(k.karar, "gecti");
});

test("ağ doğrulaması KAPALIYKEN karar 'kapali' olarak kaydedilir (geçişle karışmaz)", () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  kararYaz(
    agKararKaydiOlustur("Kampanya YAYINA ALINACAK.", "high", {
      kanit: ["Ağ doğrulaması: kapalı (ADSPILOT_NAC_TOKEN tanımlı değil)"],
      iz: { simSwap: "kapali" },
    })
  );
  const k = satirlar()[0];
  assert.equal(k.karar, "kapali");
  assert.equal(k.simSwapKanali, "kapali");
  assert.equal(k.maskeliNumara, undefined, "kanal çalışmadıysa numara alanı hiç yazılmaz");
  assert.equal(k.pencereSaat, undefined);
});

/* ── YAPISAL İZ: iki halka birbirini gizleyemez ───────────────────────────────── */

/**
 * Denetçilerin kodla kanıtladığı 1(a) numaralı hata. Metin koklayan eski kayıt,
 * NV'nin "SİMÜLASYON" ibaresini görüp kanalı "simulasyon", kararı "gecti" yazıyordu:
 * SIM-Swap katmanı KAPALI olduğu, yani HİÇBİR sorgu yapılmadığı hâlde kayıt işlemi
 * doğrulanmış gösteriyordu.
 */
test("KRİTİK iz: SIM-Swap kapalı (token yok) + NV simülasyonu → karar 'kapali', halkalar AYRI yazılır", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR }); // token YOK, simülasyon YOK
  ctx.config.approverPhone = "+905551112233";
  ctx.config.simSwapWindowHours = 72;
  ctx.config.nvSimulate = "dogrulandi";
  const { client } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.match(out, /YAYINDA/, "insan onayı geldiği için işlem gider — kapı gevşemedi, sadece kapalıydı");
  assert.equal(rec.mutations.length, 1);
  const k = satirlar()[0];
  assert.equal(k.karar, "kapali", "hiçbir SIM-Swap sorgusu yapılmadı: 'gecti' demek yalan olurdu");
  assert.equal(k.simSwapKanali, "kapali");
  assert.equal(k.nvKanali, "simulasyon", "2. halka koştu ve kendi alanında dürüstçe görünüyor");
  assert.equal(k.pencereSaat, undefined, "sorgulanan bir pencere yok");
  assert.equal(k.retNedeniKisa, undefined);
});

/**
 * Hata 1(b): gerçek CAMARA sorgusu + NV simülasyonu birlikteyken eski kayıt kanalı
 * "simulasyon" yazıyor, yani GERÇEK ağ doğrulamasını simülasyon gibi gösteriyordu.
 */
test("KRİTİK iz: GERÇEK CAMARA sorgusu + NV simülasyonu → simSwapKanali 'gercek', nvKanali 'simulasyon'", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const pencereler: number[] = [];
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "temiz", agPencereKaydi: pencereler });
  ctx.config.nvSimulate = "dogrulandi";
  const { client } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.match(out, /YAYINDA/);
  assert.equal(rec.mutations.length, 1);
  assert.deepEqual(pencereler, [72], "gerçek SIM-Swap sorgusu gerçekten yapılmalı");
  const k = satirlar()[0];
  assert.equal(k.karar, "gecti");
  assert.equal(k.simSwapKanali, "gercek", "gerçek sorgu simülasyona indirgenemez");
  assert.equal(k.nvKanali, "simulasyon", "simüle halka gerçek gibi gösterilemez");
  assert.equal(k.pencereSaat, 72, "pencere GERÇEKTEN sorgulanan katmanınkidir");
});

/** Hata 2: NV reti eskiden sözlükte yoktu ve "bilinmeyen-ret" olarak düşüyordu. */
test("iz: NV reti sabit sözlükten 'nv-uyusmadi' kodunu yazar (bilinmeyen-ret değil)", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "temiz" });
  ctx.config.nvSimulate = "uyusmadi";
  const { client, sorulanlar } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });

  assert.match(out, /NUMARA DOĞRULAMASI BAŞARISIZ/);
  assert.equal(rec.mutations.length, 0);
  assert.equal(sorulanlar.length, 0);
  const k = satirlar()[0];
  assert.equal(k.karar, "ret");
  assert.equal(k.retNedeniKisa, "nv-uyusmadi", "hangi halkanın reddettiği koddan okunmalı");
  assert.equal(k.simSwapKanali, "gercek", "1. halka temiz geçti ve gerçekti — ret 2. halkanın");
  assert.equal(k.nvKanali, "simulasyon");
});

test("iz: YAPILANDIRMA hatasında simSwapKanali 'calismadi' ve pencereSaat YOK", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  // Çelişkili yapılandırma: gerçek token VE simülasyon birlikte → hiç sorgu yapılamaz.
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "temiz" });
  ctx.config.nacSimulate = "temiz";
  const { client } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
    confirm: true,
  });

  assert.match(out, /çelişkili yapılandırma/);
  assert.equal(rec.mutations.length, 0, "fail-closed gevşemedi");
  const k = satirlar()[0];
  assert.equal(k.karar, "ret");
  assert.equal(k.simSwapKanali, "calismadi", "'kapali' (bilerek kapatıldı) ile karıştırılamaz");
  assert.equal(k.pencereSaat, undefined, "sorgu hiç yapılmadıysa pencere de yazılmaz");
  assert.equal(k.maskeliNumara, undefined, "numara hiçbir halkada değerlendirilmedi");
  assert.equal(k.retNedeniKisa, "yapilandirma-celiskili");

  // İkinci yapılandırma hatası kodu: token var ama onaylayıcı numarası yok.
  const eksik = await agDogrula({ nacToken: "t", simSwapWindowHours: 72 }, "high");
  const kayit = agKararKaydiOlustur("Bütçe DEĞİŞTİRİLECEK.", "medium", eksik);
  assert.equal(kayit.simSwapKanali, "calismadi");
  assert.equal(kayit.pencereSaat, undefined);
  assert.equal(kayit.retNedeniKisa, "onaylayici-numarasi-yok");
});

/* ── hesap kimliği ────────────────────────────────────────────────────────────── */

test("hesapId: risk etiketli ÜÇ çağrı noktası da kararı hesabıyla birlikte kaydeder", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const IKINCI_HESAP = "9876543210";

  // 1) Yayına alma (high)
  {
    const { ctx } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: "temiz" });
    const { client } = await elicitationliIstemci(ctx, "accept");
    await cagir(client, "set_campaign_status", { customerId: MUSTERI, campaignId: KAMPANYA, status: "ENABLED" });
  }
  // 2) Bütçe artışı (medium) — BAŞKA bir hesapta
  {
    const butce: Array<[RegExp, any[]]> = [
      [
        /campaign_budget\.explicitly_shared/,
        [{ campaign: { name: "K" }, campaign_budget: { resource_name: "r", amount_micros: 10_000_000, explicitly_shared: false } }],
      ],
    ];
    const { ctx } = sahteContext({ queries: butce, agSimulasyon: "temiz" });
    const { client } = await elicitationliIstemci(ctx, "accept");
    await cagir(client, "update_campaign_budget", {
      customerId: `${IKINCI_HESAP.slice(0, 3)}-${IKINCI_HESAP.slice(3, 6)}-${IKINCI_HESAP.slice(6)}`,
      campaignId: KAMPANYA,
      newDailyBudget: 20,
    });
  }
  // 3) Canlı kampanyaya kelime eklemek (high, liveCampaignGuard)
  {
    const canli: Array<[RegExp, any[]]> = [
      [/FROM ad_group/, [{ campaign: { id: 1, name: "Canlı", status: 2 }, ad_group: { status: 2 } }]],
    ];
    const { ctx } = sahteContext({ queries: canli, agSimulasyon: "temiz" });
    const { client } = await elicitationliIstemci(ctx, "accept");
    await cagir(client, "add_keywords", { customerId: MUSTERI, adGroupId: "555", keywords: ["ayakkabı"] });
  }

  const kayitlar = satirlar();
  assert.equal(kayitlar.length, 3, "üç risk etiketli karar, üç satır");
  assert.deepEqual(
    kayitlar.map((k) => k.hesapId),
    [MUSTERI, IKINCI_HESAP, MUSTERI],
    "çok-kiracılı modda kararlar hesabına göre ayrıştırılabilmeli (tireli ID normalize edilir)"
  );
});

test("hesapId verilmezse alan HİÇ yazılmaz (boş dize 'bilinmiyor' ile karışmaz)", () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  kararYaz(
    agKararKaydiOlustur("Kampanya YAYINA ALINACAK.", "high", { kanit: [], iz: { simSwap: "kapali" } }, "   ")
  );
  const ham = hamGunluk();
  assert.doesNotMatch(ham, /hesapId/, "boş/boşluklu hesap kimliği alan olarak yazılmamalı");
  assert.equal(satirlar()[0].hesapId, undefined);
});

/* ── riskteki tutar ───────────────────────────────────────────────────────────── */

/**
 * Denetçinin sorusu iki parçalıdır: "geçen ay kaç kez VE NE BÜYÜKLÜKTE bir harcama
 * reddedildi". İkinci parça `tutar` alanı olmadan cevapsızdı; aşağıdaki testler hem
 * alanın düştüğünü hem de OKUNAMAYAN bütçenin uydurulmadığını sabitler.
 */

test("TUTAR: yayına alma kararı kampanyanın GÜNLÜK BÜTÇESİNİ kaydeder (micros değil)", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "temiz" });
  const { client } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "set_campaign_status", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    status: "ENABLED",
  });

  assert.match(out, /YAYINDA/);
  assert.equal(rec.mutations.length, 1);
  const k = satirlar()[0];
  assert.equal(k.karar, "gecti");
  assert.equal(k.tutar, 50, "50.000.000 micros = 50 (hesabın para biriminde)");
  assert.doesNotMatch(hamGunluk(), /50000000/, "micros kayda giremez: denetçi para birimini okur");
});

test("TUTAR: REDDEDİLEN harcamanın büyüklüğü de kayda geçer (denetçinin asıl sorusu)", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const butce: Array<[RegExp, any[]]> = [
    [
      /campaign_budget\.explicitly_shared/,
      [{ campaign: { name: "K" }, campaign_budget: { resource_name: "r", amount_micros: 50_000_000, explicitly_shared: false } }],
    ],
  ];
  const { ctx, rec } = sahteContext({ queries: butce, agSimulasyon: "degisti" });
  const { client } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "update_campaign_budget", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    newDailyBudget: 400,
    confirm: true,
  });

  assert.match(out, /AĞ DOĞRULAMASI BAŞARISIZ/);
  assert.equal(rec.mutations.length, 0, "fail-closed gevşemedi");
  const k = satirlar()[0];
  assert.equal(k.karar, "ret");
  assert.equal(k.tutar, 400, "riskteki tutar YENİ bütçedir — harcamanın çıkacağı tavan");
  assert.equal(k.risk, "medium");
});

test("TUTAR: eski bütçe OKUNAMASA bile yeni bütçe bilinir ve yazılır", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  // amount_micros YOK: kod bunu "artış olabilir" sayıp onay ister (mevcut fail-closed).
  const butce: Array<[RegExp, any[]]> = [
    [
      /campaign_budget\.explicitly_shared/,
      [{ campaign: { name: "K" }, campaign_budget: { resource_name: "r", explicitly_shared: false } }],
    ],
  ];
  const { ctx } = sahteContext({ queries: butce, agDurumu: "temiz" });
  const { client } = await elicitationliIstemci(ctx, "accept");

  await cagir(client, "update_campaign_budget", {
    customerId: MUSTERI,
    campaignId: KAMPANYA,
    newDailyBudget: 120,
  });

  const k = satirlar()[0];
  assert.equal(k.tutar, 120, "yeni bütçe çağıranın kendi girdisi: her hâlükârda bilinir");
  assert.equal(k.karar, "gecti");
});

test("TUTAR: canlı kampanyaya reklam eklerken okunabilen bütçe kaydedilir", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const canli: Array<[RegExp, any[]]> = [
    [/FROM ad_group\b/, [{ campaign: { id: 7, name: "Canlı", status: 2 /* ENABLED */ }, ad_group: { status: 2 } }]],
    [/campaign_budget\.amount_micros/, [{ campaign_budget: { amount_micros: 25_000_000 } }]],
  ];
  const { ctx, rec } = sahteContext({ queries: canli, agSimulasyon: "temiz" });
  const { client } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "create_responsive_search_ad", {
    customerId: MUSTERI,
    adGroupId: "200057393038",
    finalUrl: "https://ornek.com",
    headlines: ["Bir", "Iki", "Uc"],
    descriptions: ["Aciklama bir", "Aciklama iki"],
  });

  assert.match(out, /RSA oluşturuldu/);
  assert.equal(rec.mutations.length, 1);
  const k = satirlar()[0];
  assert.equal(k.karar, "gecti");
  assert.equal(k.risk, "high");
  assert.equal(k.tutar, 25, "yayındaki kampanyanın günlük bütçesi riskteki tutardır");
});

test("KRİTİK TUTAR: bütçe OKUNAMAZSA alan HİÇ yazılmaz — akış da düşmez", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  // Bütçe sorgusuna karşılık YOK: sahte API boş satır kümesi döner (okunamadı).
  const canli: Array<[RegExp, any[]]> = [
    [/FROM ad_group\b/, [{ campaign: { id: 7, name: "Canlı", status: 2 }, ad_group: { status: 2 } }]],
  ];
  const { ctx, rec } = sahteContext({ queries: canli, agSimulasyon: "temiz" });
  const { client } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "create_responsive_search_ad", {
    customerId: MUSTERI,
    adGroupId: "200057393038",
    finalUrl: "https://ornek.com",
    headlines: ["Bir", "Iki", "Uc"],
    descriptions: ["Aciklama bir", "Aciklama iki"],
  });

  assert.match(out, /RSA oluşturuldu/, "tutar bir gözlemdir: okunamaması onay akışını düşürmez");
  assert.equal(rec.mutations.length, 1);
  const k = satirlar()[0];
  assert.equal(k.karar, "gecti");
  assert.equal("tutar" in k, false, "'bilmiyorum' ile '0' aynı şey değildir: alan hiç yazılmaz");
  assert.doesNotMatch(hamGunluk(), /tutar/, "undefined alan JSON'dan tamamen düşmeli");
});

test("KRİTİK TUTAR: NEGATİF bütçe kayda negatif diye giremez — bilinmeyendir", async () => {
  /**
   * Bu boşluk mutasyonla bulundu: `mikrodanTutar` içindeki `sayi < 0` kontrolü
   * kaldırıldığında takım yeşil kalıyordu.
   *
   * Alan denetim günlüğünün `tutar`ıdır, yani "bu kararda risk altındaki para".
   * Negatif bir risk tutarı anlamsızdır; API'den öyle bir değer geldiyse okuma
   * başarısız olmuştur, tutar sıfırın altında değil. Onu olduğu gibi yazmak, sonradan
   * güvenilmesi gereken TEK kayda uydurma bir büyüklük koymak olurdu — üstelik
   * "ölçüldü" görünümüyle, çünkü alan mevcut olur.
   *
   * Kural bu dosyanın her yerindekiyle aynı: anlamsız değer bilinmeyendir ve
   * bilinmeyen alan HİÇ yazılmaz.
   */
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const canli: Array<[RegExp, any[]]> = [
    [/FROM ad_group\b/, [{ campaign: { id: 7, name: "Canlı", status: 2 }, ad_group: { status: 2 } }]],
    [/campaign_budget\.amount_micros/, [{ campaign_budget: { amount_micros: -50_000_000 } }]],
  ];
  const { ctx } = sahteContext({ queries: canli, agSimulasyon: "temiz" });
  const { client } = await elicitationliIstemci(ctx, "accept");

  await cagir(client, "create_responsive_search_ad", {
    customerId: MUSTERI,
    adGroupId: "200057393038",
    finalUrl: "https://ornek.com",
    headlines: ["Bir", "Iki", "Uc"],
    descriptions: ["Aciklama bir", "Aciklama iki"],
  });

  const k = satirlar()[0];
  assert.equal("tutar" in k, false, "negatif tutar 'ölçülmüş' gibi kaydedilemez");
  assert.doesNotMatch(hamGunluk(), /-5|"tutar"/, "negatif değer kayda hiç sızmamalı");
});

test("KRİTİK TUTAR: kayıt katmanı negatifi TEK BAŞINA reddeder", () => {
  /**
   * Yukarıdaki uçtan uca test, sistemin negatifi reddettiğini kanıtlar ama HANGİ katmanın
   * reddettiğini kanıtlamaz — ve bu fark mutasyonla ortaya çıktı.
   *
   * Negatif tutar İKİ yerde eleniyor: write.ts'teki `mikrodanTutar` okumayı geçersiz
   * sayıyor, buradaki `tutarDogrula` da yazmayı reddediyor. Birbirlerini MASKELİYORLAR:
   * tek tek bozulduklarında diğeri yakaladığı için uçtan uca test hiçbirini kızdırmıyor.
   * Yani "iki kapı da çalışıyor" iddiasının uçtan uca kanıtı YOKTU.
   *
   * Bu yüzden kayıt katmanı burada DOĞRUDAN sınanıyor. Fazlalık bilinçli — biri
   * kaldırılırsa sistem hâlâ doğru davranır, ama artık hangisinin kaldırıldığı görülür.
   */
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const eskiError = console.error;
  const uyarilar: string[] = [];
  console.error = (...a: unknown[]) => void uyarilar.push(a.map(String).join(" "));
  try {
    kararYaz(
      agKararKaydiOlustur(
        "Kampanya YAYINA ALINACAK.",
        "high",
        { kanit: [], iz: { simSwap: "gercek", pencereSaat: 72 } },
        MUSTERI,
        -50
      )
    );
  } finally {
    console.error = eskiError;
  }
  assert.equal("tutar" in satirlar()[0], false, "negatif riskteki tutar anlamsızdır: yazılmaz");
  assert.doesNotMatch(hamGunluk(), /-50/, "negatif değer JSON'a sızmamalı");
  assert.equal(uyarilar.length, 1, "sessizce yutulmamalı: operatöre bildirilmeli");
});

test("TUTAR: geçersiz sayı (NaN) kayda giremez — sessizce de yutulmaz", () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const eskiError = console.error;
  const uyarilar: string[] = [];
  console.error = (...a: unknown[]) => void uyarilar.push(a.map(String).join(" "));
  try {
    kararYaz(
      agKararKaydiOlustur(
        "Kampanya YAYINA ALINACAK.",
        "high",
        { kanit: [], iz: { simSwap: "gercek", pencereSaat: 72 } },
        MUSTERI,
        // Çağrı yerinde okunamayan amount_micros'un sessizce NaN'a dönmesi senaryosu.
        Number("okunamadi")
      )
    );
  } finally {
    console.error = eskiError;
  }
  assert.equal("tutar" in satirlar()[0], false, "uydurma büyüklük kayda giremez");
  assert.doesNotMatch(hamGunluk(), /null|NaN/, "NaN JSON'da null'a dönüşüp 'ölçüldü' gibi görünemez");
  assert.equal(uyarilar.length, 1, "çağrı yerindeki hata operatörden gizlenmez");
});

/* ── sır sızıntısı ────────────────────────────────────────────────────────────── */

test("KRİTİK: kayıtta tam numara / token / 'Bearer' benzeri sır kalıbı YOK", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;

  // Aynı dosyaya birden çok karar: ret, geçiş ve yapılandırma hatası bir arada taransın.
  for (const durum of ["degisti", "temiz"] as const) {
    const { ctx } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: durum });
    const { client } = await elicitationliIstemci(ctx, "accept");
    await cagir(client, "set_campaign_status", {
      customerId: MUSTERI,
      campaignId: KAMPANYA,
      status: "ENABLED",
      confirm: true,
    });
  }
  // Gerçek kanalın hata yolu: ret metni upstream'den beslenen tek yol.
  const { ctx } = sahteContext({ queries: YAYINA_HAZIR, agDurumu: "hata" });
  const { client } = await elicitationliIstemci(ctx, "accept");
  await cagir(client, "set_campaign_status", { customerId: MUSTERI, campaignId: KAMPANYA, status: "ENABLED", confirm: true });

  const ham = hamGunluk();
  assert.equal(satirlar().length, 3, "üç karar, üç satır");
  assert.doesNotMatch(ham, new RegExp(TAM_NUMARA), "tam onaylayıcı numarası ASLA yazılmaz");
  assert.doesNotMatch(ham, /\+905551112233/, "E.164 tam numara ASLA yazılmaz");
  assert.doesNotMatch(ham, /Bearer|api[_-]?key|token/i, "token/yetki kalıbı kayda giremez");
  assert.doesNotMatch(ham, /test-nac-token/, "NaC anahtarı kayda giremez");
  /**
   * Uzun rakam dizisi taraması, çağıranın KENDİ hesap kimliği dışında hiçbir alanda
   * çalışmamalı. hesapId bilinçli bir istisnadır (sır değil, kiracı ayracı) ve deseni
   * burada rakamla sınırlanır: numara ya da kimlik oraya da sızamaz.
   */
  for (const k of satirlar()) assert.equal(k.hesapId, MUSTERI, "hesapId yalnız çağıranın hesabı olmalı");
  /**
   * İKİ ALAN TARAMADAN ÇIKARILIR ve ikisi de bilinçli istisnadır:
   *
   *   hesapId — sır değil, kiracı ayracı; deseni zaten yalnız rakamdır.
   *   tutar   — meşru bir para büyüklüğü. Google Ads'in 1e6 ölçekli para birimlerinde
   *             (VND, IDR, COP, IRR) SIRADAN bir günlük bütçe 7+ hanelidir:
   *             "tutar":1500000 bir VND hesabında normaldir. Bu alanı taramaya dahil
   *             bırakmak, meşru bir bütçeyi "numara/kimlik sızıntısı" diye raporlayan
   *             bir testtir — ve tekrarlanan yanlış alarm, eninde sonunda ya testin
   *             gevşetilmesine ya da görmezden gelinmesine yol açar. İkisi de gerçek
   *             bir sızıntıyı görünmez kılar.
   *
   * eylem alanı BİLEREK taramada KALIR: kampanya adı oraya girer ve orada gerçekten
   * uzun bir rakam dizisi belirirse görmek isteriz.
   */
  const hamHesapsiz = ham
    .replace(/"hesapId":"[0-9]*"/g, '"hesapId":""')
    .replace(/"tutar":[0-9.]+/g, '"tutar":0');
  assert.doesNotMatch(hamHesapsiz, /[0-9]{7,}/, "7+ haneli rakam dizisi (numara/kimlik) kayda giremez");
  for (const k of satirlar()) {
    // Alan kümesi kapalıdır: ileride eklenen bir alan bu testi kırar (bilinçli).
    assert.deepEqual(
      Object.keys(k).filter((a) => !ALANLAR.includes(a)),
      [],
      "kayıtta beklenmeyen alan olmamalı"
    );
  }
});

test("KRİTİK: zincirin HER halkası kayda geçer — hiçbiri sessizce düşürülmez", () => {
  /**
   * Eksik alanın yönü sinsidir: kayıt hâlâ geçerli JSON'dur, hiçbir test kızarmaz,
   * ama denetçi simüle bir halkanın ürettiği reti gerçek CAMARA sorgusu sanır.
   * Bu yüzden zincirin TÜM halkaları aynı anda doluyken kayıt sınanır (HALKA_ALANLARI
   * listesi büyüdükçe bu düzenek de büyür — eksik bırakılan halka aşağıda kızarır).
   */
  const kayit: Record<string, unknown> = agKararKaydiOlustur("Kampanya YAYINA ALINACAK.", "high", {
    engel: "Reddedildi [SİMÜLASYON]: CİHAZ ERİŞİLEBİLİRLİĞİ...",
    kanit: [],
    iz: {
      simSwap: "gercek",
      nv: "simulasyon",
      reach: "simulasyon",
      loc: "simulasyon",
      devSwap: "simulasyon",
      callFwd: "simulasyon",
      pencereSaat: 72,
      devSwapPencereSaat: 72,
      retNedeni: "cihaz-erisilemez",
    },
  }) as unknown as Record<string, unknown>;

  const iz: Record<string, unknown> = {
    simSwap: "gercek",
    nv: "simulasyon",
    reach: "simulasyon",
    loc: "simulasyon",
    devSwap: "simulasyon",
    callFwd: "simulasyon",
  };
  for (const { iz: izAlani, kayit: kayitAlani } of HALKA_ALANLARI) {
    assert.equal(
      kayit[kayitAlani],
      iz[izAlani],
      `iz.${izAlani} kayda ${kayitAlani} olarak geçmeli — düşürülen halka denetim izini yalancı yapar`
    );
  }

  // Diske düşen satırda da bulunmalı: kayıt nesnesi doğru olup JSON'a girmemesi de aynı hata.
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  kararYaz(kayit as never);
  const yazilan = satirlar()[0] as Record<string, unknown>;
  for (const { kayit: kayitAlani } of HALKA_ALANLARI) {
    assert.ok(kayitAlani in yazilan, `${kayitAlani} JSONL satırında da bulunmalı`);
  }
});

test("KRİTİK: iz maskesiz numara taşısa bile günlük onu YAZMAZ (son savunma hattı)", () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const eskiError = console.error;
  const uyarilar: string[] = [];
  console.error = (...a: unknown[]) => void uyarilar.push(a.map(String).join(" "));
  try {
    kararYaz(
      agKararKaydiOlustur("Kampanya YAYINA ALINACAK.", "high", {
        kanit: [],
        // Gelecekte bir katmanın izi ham numarayla doldurduğu senaryo.
        iz: { simSwap: "gercek", pencereSaat: 72, maskeliNumara: `+90${TAM_NUMARA}` },
      })
    );
  } finally {
    console.error = eskiError;
  }
  assert.doesNotMatch(hamGunluk(), new RegExp(TAM_NUMARA), "maskesiz numara kayda giremez");
  assert.equal(satirlar()[0].maskeliNumara, undefined, "şüpheli değer düşürülür");
  assert.equal(uyarilar.length, 1, "sessizce yutulmaz: operatör stderr'den görür");
  assert.doesNotMatch(uyarilar[0], new RegExp(TAM_NUMARA), "uyarı da sır sızdırmamalı");
});

/* ── günlük kapı değildir ─────────────────────────────────────────────────────── */

test("KRİTİK: yazılamayan yol akışı DÜŞÜRMEZ — işlem yine gerçekleşir, stderr uyarır", async () => {
  // Var olmayan bir dizinin altı: appendFileSync ENOENT ile patlar.
  process.env.ADSPILOT_DECISION_LOG = path.join(kok, "olmayan-dizin", "alt", "kararlar.jsonl");

  const uyarilar: string[] = [];
  const eskiError = console.error;
  console.error = (...a: unknown[]) => void uyarilar.push(a.map(String).join(" "));
  try {
    const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: "temiz" });
    const { client } = await elicitationliIstemci(ctx, "accept");
    const out = await cagir(client, "set_campaign_status", {
      customerId: MUSTERI,
      campaignId: KAMPANYA,
      status: "ENABLED",
    });
    assert.match(out, /YAYINDA/, "günlük yazılamasa da onaylanan işlem uygulanmalı");
    assert.equal(rec.mutations.length, 1, "günlük gözlemdir; kapı değildir");
  } finally {
    console.error = eskiError;
  }

  const gunlukUyarilari = uyarilar.filter((u) => u.includes("karar günlüğü yazılamadı"));
  assert.equal(gunlukUyarilari.length, 1, "hata sessizce yutulmamalı: stderr'e TEK satır");
  assert.doesNotMatch(gunlukUyarilari[0], new RegExp(TAM_NUMARA), "uyarı da sır sızdırmamalı");
});

test("bozuk yol RET akışını da düşürmez — ret ajana ulaşır, yazma yok", async () => {
  process.env.ADSPILOT_DECISION_LOG = path.join(kok, "olmayan-dizin", "kararlar.jsonl");
  const eskiError = console.error;
  console.error = () => {};
  try {
    const { ctx, rec } = sahteContext({ queries: YAYINA_HAZIR, agSimulasyon: "degisti" });
    const { client } = await elicitationliIstemci(ctx, "accept");
    const out = await cagir(client, "set_campaign_status", {
      customerId: MUSTERI,
      campaignId: KAMPANYA,
      status: "ENABLED",
      confirm: true,
    });
    assert.match(out, /AĞ DOĞRULAMASI BAŞARISIZ/, "ret, günlük hatasına rağmen ajana ulaşmalı");
    assert.equal(rec.mutations.length, 0, "fail-closed gevşemedi");
  } finally {
    console.error = eskiError;
  }
});

/* ── kapsam ───────────────────────────────────────────────────────────────────── */

test("risk ETİKETSİZ işlem hiç kaydedilmez (günlük ağ kapısının izidir)", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  const paused: Array<[RegExp, any[]]> = [
    [/FROM ad_group\b/, [{ campaign: { id: 1, name: "Taslak", status: 3 /* PAUSED */ } }]],
  ];
  const { ctx, rec } = sahteContext({ queries: paused, agSimulasyon: "temiz" });
  const { client } = await elicitationliIstemci(ctx, "accept");

  const out = await cagir(client, "create_responsive_search_ad", {
    customerId: MUSTERI,
    adGroupId: "200057393038",
    finalUrl: "https://ornek.com",
    headlines: ["Bir", "Iki", "Uc"],
    descriptions: ["Aciklama bir", "Aciklama iki"],
  });

  assert.match(out, /RSA oluşturuldu/);
  assert.equal(rec.mutations.length, 1);
  assert.equal(existsSync(gunluk), false, "ağ kararı olmayan işlem günlüğe satır düşürmemeli");
});

test("agAyar onay kapısına ulaşmazsa: RET kaydı 'calismadi' kanalla ve hesabıyla düşer", async () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  // Gerçek onay kapısı üzerinden: risk etiketi var, agAyar yok (sunucu tarafı hata).
  const sonuc = await onayAl(
    { server: { getClientCapabilities: () => ({}) } } as any,
    { eylem: "Bütçe DEĞİŞTİRİLECEK.", satirlar: [], risk: "medium", hesapId: MUSTERI },
    true
  );
  assert.equal(sonuc.onaylandi, false, "fail-open olamaz");
  const k = satirlar()[0];
  assert.equal(k.karar, "ret");
  assert.equal(k.simSwapKanali, "calismadi", "hiçbir kanal sorgulanmadıysa 'gercek' demek yanıltıcı olur");
  assert.equal(k.nvKanali, undefined);
  assert.equal(k.retNedeniKisa, "ag-ayari-kapiya-ulasmadi");
  assert.equal(k.hesapId, MUSTERI, "kapıya ulaşamayan yapılandırma da hesabıyla izlenebilmeli");
});

test("uzun kampanya adı kaydı şişirmez (eylem kısaltılır) ve satır tek satır kalır", () => {
  process.env.ADSPILOT_DECISION_LOG = gunluk;
  kararYaz(
    agKararKaydiOlustur(`"${"A".repeat(400)}"\nkampanyası YAYINA ALINACAK.`, "high", {
      kanit: ["Ağ doğrulaması: SIM değişimi yok (son 72 saat, +905*******33) — GSMA Open Gateway"],
      iz: { simSwap: "gercek", pencereSaat: 72, maskeliNumara: "+905*******33" },
    })
  );
  const ham = hamGunluk();
  assert.equal(ham.trimEnd().split("\n").length, 1, "JSONL değişmezi: kayıt başına TEK satır");
  const k = satirlar()[0];
  assert.ok(k.eylem.length <= 160, `eylem kısaltılmalı, uzunluk ${k.eylem.length}`);
  assert.equal(k.karar, "gecti");
  assert.equal(k.simSwapKanali, "gercek");
});
