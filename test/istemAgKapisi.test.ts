// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { baglanti } from "./helpers/harness.js";
import {
  agDogrula,
  __setSimSwapKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  type AgAyar,
} from "../src/networkTrust.js";

/**
 * THE SECURITY-POSTURE SURFACE MUST NAME THE NETWORK GATE.
 *
 * /guvenlik-durumu is the one place a user asks "what is protecting this connection".
 * It used to answer with the write permission and the budget ceiling only: the CAMARA
 * network gate — the product's headline control — appeared in no read surface at all,
 * so on a deployment with no NAC token the agent reported a complete-looking safety
 * picture while every spend increase went straight to a human with no network check.
 *
 * These tests pin BEHAVIOUR, not wording: the rendered prompt must carry a machine
 * readable state line, that state must FOLLOW the configuration, an unreadable
 * configuration must fail closed, and the secrets behind the state (the NAC token and
 * the approver's number) must never appear in the text.
 */

/** Renders /guvenlik-durumu against a fake context carrying exactly this config. */
async function guvenlikMetni(config: unknown): Promise<string> {
  const ctx: any = {
    config,
    listAccessibleCustomers: async () => ["1234567890"],
    tumHesaplar: async () => ({ liste: [] }),
    queryWithRetry: async () => [],
    mutateWithRetry: async (fn: any) => fn(),
    getCustomer: () => ({}),
  };
  const c = await baglanti(ctx);
  const res: any = await c.getPrompt({ name: "guvenlik-durumu", arguments: {} });
  return String(res.messages[0].content.text);
}

/** The declared gate state, read the way an auditor would read it. */
function durum(metin: string): string {
  const m = /AĞ KAPISI DURUMU: (.+?) —/.exec(metin);
  assert.ok(m, `metinde makine-okunur ağ kapısı durum satırı yok:\n${metin}`);
  return m![1].trim();
}

const TEMEL = { writeEnabled: true, maxDailyBudget: 500 };

test("ağ kapısı yapılandırılmamışken durum KAPALI bildirilir", async () => {
  const metin = await guvenlikMetni({ ...TEMEL });
  assert.equal(durum(metin), "KAPALI");
  // The consequence has to be spelled out, not merely labelled.
  assert.match(metin, /ağ doğrulaması YAPILMADAN/i);
  // And the limits resource's rule list must not be passed off as the whole picture.
  assert.match(metin, /TAM güvenlik resmi DEĞİL/i);
});

test("gerçek kapı açıkken durum AÇIK — ama jeton ve numara metne SIZMAZ", async () => {
  const metin = await guvenlikMetni({
    ...TEMEL,
    nacToken: "TEST-ONLY-gizli-nac-jetonu-12345",
    approverPhone: "+905551112233",
    simSwapWindowHours: 72,
  });
  assert.equal(durum(metin), "AÇIK");
  assert.ok(!metin.includes("TEST-ONLY-gizli-nac-jetonu-12345"), "NAC jetonu istem metnine sızdı");
  assert.ok(!metin.includes("+905551112233"), "onaylayıcı numarası istem metnine sızdı");
  assert.ok(!metin.includes("905551112233"), "onaylayıcı numarası (+'sız) istem metnine sızdı");
  assert.ok(!metin.includes("5551112233"), "onaylayıcı numarasının gövdesi istem metnine sızdı");
});

test("simülasyon kanalı gerçek doğrulama gibi sunulmaz", async () => {
  const metin = await guvenlikMetni({
    ...TEMEL,
    nacSimulate: "temiz",
    approverPhone: "+905551112233",
    simSwapWindowHours: 72,
  });
  assert.equal(durum(metin), "SİMÜLASYON");
  assert.match(metin, /GERÇEK ağ sorgusu YAPILMAZ/i);
});

test("jeton var ama onaylayıcı numarası yok: kapı yapılandırma hatası olarak bildirilir", async () => {
  const metin = await guvenlikMetni({ ...TEMEL, nacToken: "TEST-ONLY-gizli-nac-jetonu-12345", simSwapWindowHours: 72 });
  assert.equal(durum(metin), "EKSİK YAPILANDIRMA");
  // networkTrust.ts refuses in this state; the posture report must say so.
  assert.match(metin, /REDDED/i);
});

test("jeton ve simülasyon birlikte: çelişkili yapılandırma bildirilir", async () => {
  const metin = await guvenlikMetni({
    ...TEMEL,
    nacToken: "TEST-ONLY-gizli-nac-jetonu-12345",
    nacSimulate: "temiz",
    approverPhone: "+905551112233",
    simSwapWindowHours: 72,
  });
  assert.equal(durum(metin), "ÇELİŞKİLİ YAPILANDIRMA");
  assert.match(metin, /REDDED/i);
});

test("KAPALI ARIZA: ayarlar okunamıyorsa kapı AÇIK sayılmaz", async () => {
  const metin = await guvenlikMetni(undefined);
  assert.equal(durum(metin), "OKUNAMADI");
  assert.match(metin, /KAPALI kabul et/i);
});

test("KAPALI ARIZA: ayar okuması FIRLARSA da kapı AÇIK sayılmaz", async () => {
  const ctx: any = {
    get config() {
      throw new Error("kimlik yok");
    },
    listAccessibleCustomers: async () => ["1234567890"],
    tumHesaplar: async () => ({ liste: [] }),
    queryWithRetry: async () => [],
    mutateWithRetry: async (fn: any) => fn(),
    getCustomer: () => ({}),
  };
  const c = await baglanti(ctx);
  const res: any = await c.getPrompt({ name: "guvenlik-durumu", arguments: {} });
  assert.equal(durum(String(res.messages[0].content.text)), "OKUNAMADI");
});

test("durum satırı yapılandırmayı GERÇEKTEN izler (sabit metin değil)", async () => {
  const kapali = await guvenlikMetni({ ...TEMEL });
  const acik = await guvenlikMetni({
    ...TEMEL,
    nacToken: "TEST-ONLY-gizli-nac-jetonu-12345",
    approverPhone: "+905551112233",
    simSwapWindowHours: 72,
  });
  assert.notEqual(durum(kapali), durum(acik), "iki farklı kurulum aynı güvenlik durumunu bildiriyor");
});

test("slash komutun açıklaması ağ kapısını anar", async () => {
  const ctx: any = {
    config: { ...TEMEL },
    listAccessibleCustomers: async () => ["1234567890"],
    tumHesaplar: async () => ({ liste: [] }),
    queryWithRetry: async () => [],
    mutateWithRetry: async (fn: any) => fn(),
    getCustomer: () => ({}),
  };
  const c = await baglanti(ctx);
  const { prompts }: any = await c.listPrompts();
  const p = prompts.find((x: any) => x.name === "guvenlik-durumu");
  assert.ok(p, "guvenlik-durumu kayıtlı değil");
  assert.match(p.description, /ağ kapısı|CAMARA/i, "açıklama hâlâ eksik güvenlik resmi veriyor");
});

/* ── KADEME: "istem hiç gösterilmez" iddiası KOŞULLUDUR ──────────────────────── */

/**
 * AÇIK durumunun açıklaması, onay isteminin hiç gösterilmediğini KOŞULSUZ bir kural gibi
 * yazıyordu. Bu, `AEGIS_STEPUP=1` iken YANLIŞ: ölçüldü — SIM'i değişmiş bir onaylayıcıda
 * `agDogrula({stepUp:true}, "high")` `engel: undefined` + `kademe: {neden:"sim-degisti"}`
 * döndürüyor ve approval.ts bozuk sinyali adıyla söyleyen bir onay istemi GÖSTERİYOR.
 *
 * Bu, depoda bir kez zaten yaşanmış hatanın istem yüzeyine taşınmış hâliydi:
 * test/zincirBelgeKademe.test.ts aynı cümleleri README.md / README.tr.md / docs/DEMO.md
 * içinde YASAKLIYOR, ama taradığı dosya listesinde src/prompts.ts YOK — oysa istem metni
 * doğrudan modelin bağlamına giriyor, yani belgeden DAHA güçlü bir yüzey.
 *
 * Aşağıdaki gözcüler o dosyanın sözleşmesini bu yüzeye taşır ve ÇİFT YÖNLÜDÜR: cümle
 * koşulsuza dönerse de, kapıdaki kademe yolu ortadan kalkarsa da kırmızı olurlar.
 */
/**
 * TURKISH CASE FOLDING FIRST — the /i/ flag is not enough on this surface.
 *
 * JavaScript's /i/ flag does not fold the dotted capital İ (U+0130) onto "i". Measured:
 * `/gösterilmeden/i.test("GÖSTERİLMEDEN")` is FALSE. The rendered state line SHOUTS its
 * load-bearing verbs ("onay istemi GÖSTERİLMEDEN ÖNCE ..."), so an /i/-flag pattern walks
 * straight past the very sentence this section exists to police — which is exactly how the
 * patterns below went stale once already. Every line is folded here (İ and the dotless ı
 * onto "i") and every pattern is written in plain lower case.
 */
const kucult = (s: string) => s.replace(/[İı]/g, "i").toLowerCase();

/**
 * The absolute claim, in the wordings this surface and its sibling document watchdog use.
 * `istemi?` covers both "istem gösterilmeden" (test/zincirBelgeKademe.test.ts's wording for
 * README/docs) and "onay istemi GÖSTERİLMEDEN ÖNCE" (this prompt's wording).
 */
const MUTLAK_IDDIA = [/onay istemi hiç gösterilmez/, /istem hiç gösterilmez/, /istemi? gösterilmeden/];

/** İddiayı koşula bağlayan ifadeler — aynı SATIRDA bulunmak zorunda. */
const KADEME_KOSULU = /aegis_stepup|step-up|kademe/;

/**
 * Lines carrying the absolute claim WITHOUT naming the condition.
 *
 * FAIL CLOSED ON THE WATCHDOG ITSELF. Every caller below asserts this returns `[]`, so a
 * text in which the patterns match NOTHING would pass every one of them while measuring
 * nothing at all — the vacuum this file exists to avoid, and the failure mode that put the
 * patterns in this state. A text with no claim line therefore THROWS instead of returning
 * an empty list: a rewritten sentence must update the patterns, never silently retire them.
 *
 * Only pass renderings that are supposed to carry the claim (the AÇIK states); KAPALI /
 * SİMÜLASYON / EKSİK / ÇELİŞKİLİ / OKUNAMADI never make it, and asking those would be
 * asking the wrong question.
 */
function kosulsuzSatirlar(metin: string): string[] {
  const satirlar = metin.split(/\r?\n/).map((ham) => ({ ham, kucuk: kucult(ham) }));
  const iddiaTasiyanlar = satirlar.filter((s) => MUTLAK_IDDIA.some((d) => d.test(s.kucuk)));
  assert.ok(
    iddiaTasiyanlar.length > 0,
    "Bu metin 'istem gösterilmeden' ailesinden hiçbir cümle kurmuyor — desenler bayatladıysa " +
      "güncelle, yoksa koşulsuzluk gözcüleri hiçbir şey ölçmez:\n" +
      metin
  );
  return iddiaTasiyanlar
    .filter((s) => !KADEME_KOSULU.test(s.kucuk))
    .map((s) => s.ham.trim().slice(0, 160));
}

const KAPI_ACIK = {
  ...TEMEL,
  nacToken: "TEST-ONLY-gizli-nac-jetonu-12345",
  approverPhone: "+905551112233",
  simSwapWindowHours: 72,
};

test("kademe AÇIKKEN: 'istem hiç gösterilmez' KOŞULSUZ yazılmaz ve step-up adıyla anılır", async () => {
  const metin = await guvenlikMetni({ ...KAPI_ACIK, stepUp: true });
  assert.equal(durum(metin), "AÇIK");
  assert.deepEqual(
    kosulsuzSatirlar(metin),
    [],
    "Bu satırlar onay isteminin HİÇ gösterilmediğini koşulsuz bir kural gibi yazıyor, " +
      "oysa AEGIS_STEPUP=1 iken kapı yükseltilebilir bir arızayı insan istemine BAĞLIYOR"
  );
  // Kullanıcı, kademenin açık olduğunu ve isteminin gösterilebileceğini ÖĞRENMELİ.
  assert.match(metin, /AEGIS_STEPUP=1/, "AÇIK durumu step-up'ın açık olduğunu hiç bildirmiyor");
  assert.match(metin, /GÖSTERİLİR/, "yükseltmede insan isteminin gösterildiği söylenmiyor");
});

test("kademe KAPALIYKEN: katı cümle SÖYLENİR ama koşulu AYNI SATIRDA taşır", async () => {
  const metin = await guvenlikMetni({ ...KAPI_ACIK, stepUp: false });
  assert.equal(durum(metin), "AÇIK");
  /**
   * Proof the watchdog is not a vacuum: the patterns REALLY match this rendering. Whoever
   * rewrites the sentence has to keep the claim recognisable or update the patterns —
   * `kosulsuzSatirlar` throws on a text that carries no claim at all, and this assertion
   * names the configuration in which the strict sentence is expected to be said.
   */
  const eslesen = MUTLAK_IDDIA.filter((d) => d.test(kucult(metin)));
  assert.ok(
    eslesen.length > 0,
    "AÇIK/kademe-kapalı metni artık 'istem hiç gösterilmez' iddiasını hiç kurmuyor — " +
      "desenler bayatladıysa güncelle, yoksa koşulsuzluk gözcüsü hiçbir şey ölçmez"
  );
  assert.deepEqual(kosulsuzSatirlar(metin), [], "katı cümle koşulunu söylemiyor");
  assert.match(metin, /kademeli doğrulama KAPALI/i, "kademenin kapalı olduğu söylenmiyor");
});

test("KAPALI ARIZA: kademe durumu OKUNAMIYORSA katı garanti VERİLMEZ", async () => {
  /**
   * `stepUp` boolean değilse durum BİLİNMİYOR. Bilinmeyen, güvenlik duruşunu GÜÇLÜ
   * gösteren tarafa yuvarlanamaz: metin 'istem hiç gösterilmez' garantisini vermez,
   * kademenin açık olabileceğini söyler.
   */
  const metin = await guvenlikMetni({ ...KAPI_ACIK });
  assert.equal(durum(metin), "AÇIK");
  assert.deepEqual(kosulsuzSatirlar(metin), [], "okunamayan step-up'ta koşulsuz garanti verildi");
  assert.match(metin, /OKUNAMADI/, "step-up'ın okunamadığı söylenmiyor");
  assert.match(metin, /GÜVENME|GÖSTERİLEBİLİR/, "zayıf tarafa yuvarlanmıyor");
});

test("durum, step-up anahtarını GERÇEKTEN izler (üç kurulum, üç ayrı açıklama)", async () => {
  const acik = await guvenlikMetni({ ...KAPI_ACIK, stepUp: true });
  const kapali = await guvenlikMetni({ ...KAPI_ACIK, stepUp: false });
  const bilinmiyor = await guvenlikMetni({ ...KAPI_ACIK });
  assert.equal(
    new Set([acik, kapali, bilinmiyor]).size,
    3,
    "AÇIK açıklaması step-up anahtarından bağımsız sabit metin"
  );
});

test("ÇİFT YÖNLÜ: kapı kademeyi GEÇİRİYORSA metin katı garantiyi VERMEZ", async () => {
  /**
   * Bu gözcü iddiayı belgeden değil KODDAN türetir. Önce kapının gerçekten yükselttiği
   * ÖLÇÜLÜR (agDogrula düz retle bitmiyor, kademe kaydı düşüyor); ancak o zaman metnin
   * katı cümleyi kurmaması istenir. Kademe yolu kapıdan kalkarsa bu test kırmızı olur ve
   * metnin yeniden gözden geçirilmesi gerektiğini söyler — cümle bayatlarsa da kırmızıdır.
   */
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: ["TR"] }) });
  try {
    const ayar: AgAyar = {
      nacToken: "TEST-ONLY-token",
      approverPhone: "+905550000000",
      simSwapWindowHours: 72,
      reachCheck: true,
      devSwapCheck: false,
      callFwdCheck: false,
      expectedCountry: "TR",
      stepUp: true,
    };
    const karar = await agDogrula(ayar, "high");
    assert.equal(
      karar.engel,
      undefined,
      "kapı artık yükseltmiyor — prompts.ts'teki AÇIK metni yeniden ölçülmeli"
    );
    assert.equal(karar.kademe?.neden, "sim-degisti", "yükseltmenin nedeni kayda düşmüyor");

    const metin = await guvenlikMetni({ ...KAPI_ACIK, stepUp: true });
    assert.deepEqual(
      kosulsuzSatirlar(metin),
      [],
      "kapı bu yapılandırmada onay istemini GÖSTERİYOR (ölçüldü), ama güvenlik duruşu metni " +
        "istemin hiç gösterilmediğini koşulsuz bir kural gibi yazıyor"
    );
  } finally {
    __setSimSwapKanalForTests(undefined);
    __setErisimKanalForTests(undefined);
    __setKonumKanalForTests(undefined);
  }
});

/* ── İKİNCİ OKUMA YÜZEYİ: limits kaynağı da kapıyı ANMALI ────────────────────── */

/**
 * Bulgunun adlandırdığı üç okuma yüzeyinden yalnız istem kapanmıştı. İstemi hiç
 * kullanmayıp `aegis://accounts/{id}/limits` kaynağını doğrudan okuyan bir ajan — ki
 * kaynak kendini "Bu bağlantının güvenlik ayarları" diye tanıtıyor ve istemin KENDİSİ
 * ajana o kaynağı okumasını emrediyor — hâlâ eksik güvenlik resmi görüyordu.
 */
async function limitsKaynagi(config: unknown): Promise<any> {
  const ctx: any = {
    config,
    listAccessibleCustomers: async () => ["1466231519"],
    tumHesaplar: async () => ({ liste: [] }),
    queryWithRetry: async () => [{ customer: { id: "1466231519" } }],
    mutateWithRetry: async (fn: any) => fn(),
    getCustomer: () => ({}),
  };
  const c = await baglanti(ctx);
  const res: any = await c.readResource({ uri: "aegis://accounts/1466231519/limits" });
  return JSON.parse(String(res.contents[0].text));
}

test("limits kaynağı ağ kapısının durumunu BİLDİRİR", async () => {
  const veri = await limitsKaynagi({ ...TEMEL });
  assert.equal(veri.agKapisi?.durum, "KAPALI", "kelepçe raporu ağ kapısını hiç anmıyor");
  assert.match(String(veri.agKapisi.aciklama), /ağ doğrulaması YAPILMADAN/i);
  // Kurallar listesinin TEK BAŞINA tam resim olmadığı, listenin kendi içinde söylenir.
  assert.ok(
    veri.kurallar.some((k: string) => /agKapisi/.test(k)),
    "kurallar listesi okuyucuyu ağ kapısı alanına yönlendirmiyor"
  );
});

test("limits kaynağının kapı durumu yapılandırmayı İZLER ve istemle ÇELİŞMEZ", async () => {
  const kapali = await limitsKaynagi({ ...TEMEL });
  const acik = await limitsKaynagi({ ...KAPI_ACIK, stepUp: false });
  assert.notEqual(kapali.agKapisi.durum, acik.agKapisi.durum, "kaynak sabit metin bildiriyor");
  assert.equal(acik.agKapisi.durum, "AÇIK");

  // Tek eşleme, iki yüzey: kaynak ile istem AYNI durumu söylemek zorundadır.
  const istem = await guvenlikMetni({ ...KAPI_ACIK, stepUp: false });
  assert.equal(durum(istem), acik.agKapisi.durum, "istem ile limits kaynağı ağ kapısı durumunda ayrışmış");
});

test("limits kaynağı jetonu ve onaylayıcı numarasını SIZDIRMAZ", async () => {
  const ham = JSON.stringify(await limitsKaynagi({ ...KAPI_ACIK, stepUp: true }));
  assert.ok(!ham.includes("TEST-ONLY-gizli-nac-jetonu-12345"), "NAC jetonu kelepçe raporuna sızdı");
  assert.ok(!ham.includes("5551112233"), "onaylayıcı numarası kelepçe raporuna sızdı");
});
