// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Growth Brain — the application (execution) step.
 *
 * It writes the approved plan into a real account through the MCP write tools, in order:
 *   create_search_campaign (born PAUSED) → add_keywords (EXACT/BROAD only)
 *   → add_campaign_negative_keywords → create_responsive_search_ad
 *
 * Security invariants:
 *  - In the uygula() flow, set_campaign_status and update_campaign_budget are PERMANENTLY
 *    blacklisted: under no condition does the creation path take a campaign live or change a
 *    budget.
 *  - Going live can leave ONLY through the separate yayinaAl() function — see the "going
 *    live" section below. That function DOES NOT USE guvenliCagirici; its own narrow wrapper,
 *    yayinCagirici, carries set_campaign_status with status='ENABLED' and nothing else. So
 *    the blacklist stands untouched on the creation path, and the ENABLED call has exactly
 *    one exit point.
 *  - No tool is ever sent a `confirm` key — both wrappers delete it unconditionally — so
 *    every operation requiring approval is refused on the server side by design. yayinaAl
 *    DOES NOT CHANGE THAT: the ENABLED call is made, and the decision belongs to the
 *    server's network gate and human-approval gate; this client can never fabricate an
 *    approval.
 *  - Tool arguments are built field by field, by hand; the plan and creative objects are
 *    never spread.
 *  - Negative keywords are attached ONLY to the campaign created in this run: campaignId is
 *    parsed by regex from the create_search_campaign result alone, and if an id, URL or
 *    customer field is seen inside the plan or the creative, it is an error up front.
 *  - If the id cannot be parsed, or the result carries a truncation marker, ALL remaining
 *    steps are cancelled; there is never a "find the newest campaign" guess.
 */

/**
 * The marker mcpBaglan leaves at its result cap — IMPORTED FROM ITS PRODUCER, never copied.
 *
 * ortak.mjs both defines the marker and appends it in sonucKirp(); this module is the
 * consumer that refuses to parse an id out of a text carrying it. The two used to be a pair
 * of hand-written literals with no link between them, and the drift ran in the fail-OPEN
 * direction: change the sentence on the producing side — say to
 * "[... sonuç kırpıldı (30000 karakter tavanı) ...]" — and the `metin.includes(...)` test
 * below never matches again. Measured on a copy of this module wired to a producer whose
 * marker had been changed: a create_search_campaign response cut off at the cap came back
 * kirpik=false, the step was stamped 'tamam' instead of 'belirsiz', the remaining steps were
 * NOT cancelled, and kimlikAyikla() went on to regex an id out of the truncated text. One
 * import removes the failure mode; a local copy could only ever be checked by a human
 * noticing two files at once.
 */
import { KIRPMA_ISARETI } from "./ortak.mjs";

/** The write tools this module may call — a fixed allowlist. */
export const YAZMA_IZINLI = Object.freeze([
  "create_search_campaign",
  "add_keywords",
  "add_campaign_negative_keywords",
  "create_responsive_search_ad",
]);

/** The read tool allowed solely for the idempotency pre-check. */
export const OKUMA_IZINLI = Object.freeze(["run_gaql"]);

/**
 * The permanent blacklist: the tools that start or increase spending. Even if one is added
 * to the allowlist by mistake later, the wrapper checks here first and refuses.
 *
 * NOTE: this is the blacklist of the CREATION path, uygula → guvenliCagirici, and it has not
 * been loosened. The go-live path uses a separate wrapper, yayinCagirici, and that wrapper in
 * turn carries a SINGLE tool with a single status.
 */
export const KARA_LISTE = Object.freeze(["set_campaign_status", "update_campaign_budget"]);

/** The go-live path's ONLY permitted tool — no other tool can pass this way. */
export const YAYIN_ARACI = "set_campaign_status";

/** Control characters and the C1 range, against ANSI and terminal injection. */
const KONTROL_KARAKTERI = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Field names forbidden in objects that are not operator input, meaning the plan and the
 * creative: identity and destination values come ONLY from the operator, never from an LLM's
 * output.
 */
const YASAK_ALANLAR = new Set([
  "finalurl",
  "musteriid",
  "customerid",
  "campaignid",
  "kampanyaid",
  "adgroupid",
  "confirm",
]);

/* ── Helpers ─────────────────────────────────────────────────────────────────── */

/** A summary bound for the report or the terminal: ANSI and control characters are stripped
 * and the length is capped. */
function gorunurOzet(metin, tavan = 400) {
  const temiz = String(metin ?? "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // ANSI escape sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "") // keep \n and \t
    .trim();
  return temiz.length > tavan ? temiz.slice(0, tavan) + "…" : temiz;
}

/**
 * The server's SUCCESS signatures — tool by tool, taken from write.ts's CURRENT text.
 *
 * These are the SOLE basis for a claim of "success": only the server's own affirmative
 * sentence can say that a write really happened. If that text changes, these patterns have to
 * change with it — and until they do, steps are stamped 'belirsiz' rather than 'tamam', so
 * the error falls on the CLOSED side and a half-finished setup is not taken live.
 */
const BASARI_IZLERI = [
  /Kampanya PAUSED olarak oluşturuldu/u, // create_search_campaign
  /anahtar kelime eklendi \[/u, // add_keywords (negatif varyantı dahil)
  /anahtar kelime KAMPANYA seviyesinde eklendi \[/u, // add_campaign_negative_keywords
  /RSA oluşturuldu:/u, // create_responsive_search_ad
  /YAYINDA \(ENABLED\)/u, // set_campaign_status (yalnız yayinaAl yolundan)
  /^\d+\s+satır/mu, // run_gaql (idempotenlik ön-kontrolü)
];

/** The KNOWN refusal signatures the server returns as plain text, WITHOUT isError. */
const RET_IZLERI = [
  /^(Reddedildi|Araç hatası|Yazma araçları|İşlem yapılmadı)/iu,
  /devre dışı|bulunamadı/iu,
];

/**
 * Classifies a tool response with THREE values, not two, because "I know it failed" and "I
 * do not know what happened" are not the same thing:
 *
 *   'basarisiz' — a KNOWN refusal text from the server,
 *   'tamam'     — a POSITIVE success signature from the server,
 *   'belirsiz'  — neither: whether the write happened COULD NOT BE CONFIRMED.
 *
 * FAILS CLOSED. It used to check only "does one of the refusal patterns match", and with no
 * match the step was stamped 'tamam'. So every server response we did not recognise — a raw
 * "429", "PERMISSION_DENIED", "Geçersiz kampanya ID", the "İşlem yapılmadı: ..." text
 * returned when the user declines approval — wrote a write THAT NEVER HAPPENED into the audit
 * trail as OK; the process exited 0, and the --yayinla gate opened for a half-finished
 * campaign. Success is now declared only by a positive signature; an unrecognised response is
 * not a victory but an unknown, and it stops the rest.
 */
export function sonucDurumu(metin) {
  const m = String(metin ?? "").trim();
  if (!m || m === "(boş yanıt)") return "basarisiz";
  // A refusal always beats a success: if one text carries both, that text is a refusal.
  if (RET_IZLERI.some((d) => d.test(m))) return "basarisiz";
  return BASARI_IZLERI.some((d) => d.test(m)) ? "tamam" : "belirsiz";
}

/**
 * "Is this response a KNOWN refusal?" — 'belirsiz' returns false here.
 *
 * yayinSonucuSinifla wants exactly that distinction: on the go-live path an unrecognised
 * response must be classified as 'hata', not as 'reddedildi'. That path fails closed too,
 * because it declares success by its own positive signature, YAYIN_BASARI_IZI. For the step's
 * stamp, sonucDurumu is what is used; this helper is derived from it.
 */
export function sonucBasarisizMi(metin) {
  return sonucDurumu(metin) === "basarisiz";
}

/** Identifiers are parsed only from the create_search_campaign result text, with a
 * full-path regex. */
export function kimlikAyikla(metin) {
  const m = String(metin ?? "");
  return {
    kampanyaId: /customers\/\d+\/campaigns\/(\d+)/.exec(m)?.[1],
    adGrubuId: /customers\/\d+\/adGroups\/(\d+)/.exec(m)?.[1],
  };
}

/**
 * The cagir wrapper — defence in depth:
 *  - a blacklisted tool is refused with an error under every condition,
 *  - any tool name outside the allowlist is refused,
 *  - the `confirm` key is deleted unconditionally, so the human-approval flag is never sent
 *    from this client,
 *  - the return value is always coerced to a string.
 */
export function guvenliCagirici(cagir) {
  if (typeof cagir !== "function") {
    throw new Error("uygula: 'cagir' fonksiyonu zorunlu — mcpBaglan() ile alınır.");
  }
  return async function guvenliCagir(arac, args) {
    if (KARA_LISTE.includes(arac)) {
      throw new Error(
        `Güvenlik: '${arac}' Growth Brain için kalıcı olarak yasak — yayına alma ve bütçe artışı yalnız insan onaylı ayrı akışta yapılır.`
      );
    }
    if (!YAZMA_IZINLI.includes(arac) && !OKUMA_IZINLI.includes(arac)) {
      throw new Error(`Güvenlik: '${arac}' izinli araç listesinde yok — çağrı reddedildi.`);
    }
    const temiz = {};
    for (const [anahtar, deger] of Object.entries(args ?? {})) {
      if (anahtar === "confirm") continue;
      temiz[anahtar] = deger;
    }
    return String((await cagir(arac, temiz)) ?? "");
  };
}

/** A scan for forbidden fields inside the plan and the creative, nested objects included,
 * to a bounded depth. */
function yasakAlanTara(deger, kaynak, derinlik = 0) {
  if (derinlik > 6 || deger === null || typeof deger !== "object") return;
  for (const [anahtar, alt] of Object.entries(deger)) {
    if (YASAK_ALANLAR.has(anahtar.toLowerCase())) {
      throw new Error(
        `Güvenlik: '${kaynak}' nesnesi '${anahtar}' alanı taşıyamaz — kimlik/hedef değerleri yalnız operatör girdisinden gelir.`
      );
    }
    yasakAlanTara(alt, kaynak, derinlik + 1);
  }
}

/** A required text field, free of control characters; the trimmed value is returned. */
function guvenliDize(deger, alanAdi, { max } = {}) {
  if (typeof deger !== "string") throw new Error(`${alanAdi} metin (string) olmalı.`);
  if (KONTROL_KARAKTERI.test(deger)) throw new Error(`${alanAdi} kontrol karakteri içeremez.`);
  const d = deger.trim();
  if (!d) throw new Error(`${alanAdi} boş olamaz.`);
  if (max && d.length > max) {
    throw new Error(`${alanAdi} en fazla ${max} karakter olabilir (${d.length} verildi).`);
  }
  return d;
}

/** Keyword validation: a string of at most 80 characters, with no URL and no control
 * characters. */
function kelimeDogrula(kelime, kaynak) {
  const k = guvenliDize(kelime, `${kaynak} anahtar kelimesi`, { max: 80 });
  if (/https?:\/\//i.test(k)) throw new Error(`${kaynak} anahtar kelimesi URL içeremez: '${gorunurOzet(k, 60)}'`);
  return k;
}

function tekrarsiz(liste) {
  const gorulen = new Set();
  const sonuc = [];
  for (const eleman of liste) {
    const anahtar = eleman.toLowerCase();
    if (gorulen.has(anahtar)) continue;
    gorulen.add(anahtar);
    sonuc.push(eleman);
  }
  return sonuc;
}

/** Escaping for a GAQL string literal, used by the idempotency query. */
function gaqlKacir(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** A run stamp: running the same plan again produces a new name, so a clash is caught
 * early. */
function calistirmaDamgasi(simdi = new Date()) {
  const p = (n, hane = 2) => String(n).padStart(hane, "0");
  return `GB-${simdi.getFullYear()}${p(simdi.getMonth() + 1)}${p(simdi.getDate())}-${p(simdi.getHours())}${p(simdi.getMinutes())}`;
}

/* ── The main flow ───────────────────────────────────────────────────────────── */

/**
 * Applies the plan and the creative to a real account.
 * Returns { kampanyaId?, adGrubuId?, kampanyaAdi, basari, kirpik,
 *          adimlar:[{arac, ozet, sonucOzeti, durum}], uyarilar:[..], eksikAdimlar:[..] }
 * Under no condition does it call set_campaign_status(ENABLED) or
 * update_campaign_budget.
 */
export async function uygula({ plan, kreatif, musteriId, finalUrl }, { cagir }) {
  const guvenliCagir = guvenliCagirici(cagir);
  const uyarilar = [];
  const adimlar = [];
  const eksikAdimlar = [];

  /* 1) Validating operator input — finalUrl and musteriId come ONLY from here. */
  const musteri = guvenliDize(musteriId, "musteriId", { max: 20 });
  if (!/^[0-9-]+$/.test(musteri)) {
    throw new Error("musteriId yalnız rakam ve tire içerebilir (örn. 1234567890).");
  }
  const hedefUrl = guvenliDize(finalUrl, "finalUrl", { max: 2048 });
  if (!/^https?:\/\//i.test(hedefUrl)) {
    throw new Error("finalUrl yalnız http/https ile başlayabilir.");
  }

  /* 2) Provenance safety: the plan and the creative may carry no identity or destination
     field. */
  if (!plan || typeof plan !== "object") throw new Error("plan nesnesi zorunlu.");
  if (!kreatif || typeof kreatif !== "object") throw new Error("kreatif nesnesi zorunlu.");
  yasakAlanTara(plan, "plan");
  yasakAlanTara(kreatif, "kreatif");

  /* 3) Validating the plan's content — a second belt on top of planDogrula, fail-closed. */
  const planAdi = guvenliDize(plan.kampanyaAdi, "plan.kampanyaAdi", { max: 200 });
  const butce = plan.butceGunlukTL;
  if (!(typeof butce === "number" && Number.isFinite(butce) && butce > 0)) {
    throw new Error("plan.butceGunlukTL geçersiz: 0'dan büyük sonlu bir sayı olmalı (metin/NaN kabul edilmez).");
  }
  if (typeof plan.hedefUlke !== "string" || !/^[A-Z]{2}$/.test(plan.hedefUlke)) {
    throw new Error("plan.hedefUlke tam 2 büyük harfli ISO alpha-2 kod olmalı (örn. 'TR').");
  }
  const hedefUlke = plan.hedefUlke;
  if (!Array.isArray(plan.adGruplari) || plan.adGruplari.length === 0) {
    throw new Error("plan.adGruplari boş olamaz.");
  }

  const gruplar = plan.adGruplari;
  if (gruplar.length > 1) {
    uyarilar.push("Çok reklam grubu desteklenmiyor — tüm gruplar tek reklam grubunda düzleştirildi.");
  }

  const GECERLI_ESLESME = new Set(["PHRASE", "EXACT", "BROAD"]);
  const tumKelimeler = [];
  const ekstraEslesmeler = new Map(); // matchType -> kelime listesi (EXACT/BROAD)
  for (const grup of gruplar) {
    if (!grup || typeof grup !== "object") throw new Error("plan.adGruplari içindeki her grup nesne olmalı.");
    const tip = grup.eslesmeTipi ?? "PHRASE";
    if (!GECERLI_ESLESME.has(tip)) {
      throw new Error(`Geçersiz eşleme tipi: '${gorunurOzet(String(tip), 30)}' — yalnız PHRASE/EXACT/BROAD.`);
    }
    if (!Array.isArray(grup.anahtarKelimeler) || grup.anahtarKelimeler.length === 0) {
      throw new Error("Boş anahtar kelime listesi olan reklam grubu kabul edilmez.");
    }
    const kelimeListesi = grup.anahtarKelimeler.map((k) => kelimeDogrula(k, "plan"));
    tumKelimeler.push(...kelimeListesi);
    if (tip !== "PHRASE") {
      const eldeki = ekstraEslesmeler.get(tip) ?? [];
      ekstraEslesmeler.set(tip, eldeki.concat(kelimeListesi));
    }
  }
  const kelimeler = tekrarsiz(tumKelimeler);
  if (kelimeler.length > 50) {
    throw new Error(`Toplam ${kelimeler.length} anahtar kelime — create_search_campaign sınırı 50.`);
  }
  if (ekstraEslesmeler.size > 0) {
    uyarilar.push(
      "create_search_campaign kelimeleri PHRASE ekler; EXACT/BROAD kelimeler ayrıca kendi eşleme türüyle eklendi — yayına almadan önce PAUSED taslaktaki PHRASE kopyalarını gözden geçirin."
    );
  }

  let negatifler = [];
  if (plan.negatifKelimeler !== undefined) {
    if (!Array.isArray(plan.negatifKelimeler)) throw new Error("plan.negatifKelimeler bir dizi olmalı.");
    negatifler = tekrarsiz(plan.negatifKelimeler.map((k) => kelimeDogrula(k, "negatif")));
    if (negatifler.length > 100) {
      throw new Error(`Toplam ${negatifler.length} negatif kelime — add_campaign_negative_keywords sınırı 100.`);
    }
  }

  /* 4) Validating the creative — a second belt on top of kreatifDogrula. */
  if (!Array.isArray(kreatif.basliklar)) throw new Error("kreatif.basliklar bir dizi olmalı.");
  const basliklar = tekrarsiz(kreatif.basliklar.map((b, i) => guvenliDize(b, `kreatif.basliklar[${i}]`, { max: 30 })));
  if (basliklar.length < 3 || basliklar.length > 15) {
    throw new Error(`Tekrarsız başlık sayısı ${basliklar.length} — 3 ile 15 arasında olmalı.`);
  }
  if (!Array.isArray(kreatif.aciklamalar)) throw new Error("kreatif.aciklamalar bir dizi olmalı.");
  const aciklamalar = tekrarsiz(
    kreatif.aciklamalar.map((a, i) => guvenliDize(a, `kreatif.aciklamalar[${i}]`, { max: 90 }))
  );
  if (aciklamalar.length < 2 || aciklamalar.length > 4) {
    throw new Error(`Tekrarsız açıklama sayısı ${aciklamalar.length} — 2 ile 4 arasında olmalı.`);
  }
  for (const metin of [...basliklar, ...aciklamalar]) {
    if (/https?:\/\//i.test(metin)) throw new Error("Başlık/açıklama içinde URL olamaz.");
  }

  /**
   * THE DISPLAY PATH (yol1/yol2) IS NOT APPLIED — AND NOW SAYS SO.
   *
   * kreatif.mjs produces, validates and reports yol1/yol2, but create_responsive_search_ad's
   * inputSchema in write.ts carries NO path1/path2 field, so the value reaches no ad: the
   * args() below is built field by field and has nowhere to put it. The drop was SILENT while
   * rapor.mjs went on printing a "Görünen yol: /…" line — an audit trail claiming something
   * that never happened, and an operator checking the report against the real account finds
   * an EMPTY display path. Carrying the path for real means adding the field to write.ts,
   * which is outside this module; what this module owes is honesty, so the drop is no longer
   * silent — the warning is recorded on uygulamaSonucu.uyarilar, and that list has EXACTLY
   * ONE reader: rapor.mjs, which prints it under "**Uyarılar:**" in the written report.
   * IT DOES NOT REACH THE TERMINAL. This module makes no console call at all, and
   * growth-brain.mjs prints the report's PATH, never its warnings — so an operator watching
   * only the screen sees nothing here and has to open the report file. Saying it on screen
   * as well takes a print in growth-brain.mjs, which is outside this module; what is inside
   * it is naming the surface the warning actually reaches. test/onarim2Uygulama.test.ts
   * pins both halves: uygula() writes zero bytes to stdout/stderr, and the sentence is
   * present in raporOlustur()'s output.
   */
  if (kreatif.yol1 !== undefined || kreatif.yol2 !== undefined) {
    uyarilar.push(
      "Görünen yol (yol1/yol2) UYGULANMADI: create_responsive_search_ad aracı path1/path2 alanı taşımıyor — reklamın görünen yolu BOŞ kalır. Rapordaki 'Görünen yol' satırı yalnız model önerisidir, uygulanmış bir ayar değildir."
    );
  }

  /* 5) Idempotency: a stamped campaign name plus a pre-check for a campaign of the same
     name. */
  const kampanyaAdi = `${calistirmaDamgasi()} — ${planAdi}`.slice(0, 255);
  let kampanyaId;
  let adGrubuId;
  let basari = true;
  let devam = true;
  /**
   * Did a tool response hit the result cap? The reporting layer reads this flag and prints
   * the "⚠ YARIM OLABİLİR" stamp — see rapor.mjs and uygulamaSonucu.kirpik.
   *
   * The field was added here AFTERWARDS, and its absence was silent: the report side had
   * long been reading `uygulamaSonucu?.kirpik` while the producing side NEVER wrote it. So a
   * documented invariant could never fire in production — even on a response of 94,000
   * characters the stamp was not printed and the step looked OK.
   */
  let kirpikVar = false;

  try {
    const sorgu =
      `SELECT campaign.id, campaign.name FROM campaign ` +
      `WHERE campaign.name = '${gaqlKacir(kampanyaAdi)}' AND campaign.status != 'REMOVED' LIMIT 1`;
    const metin = await guvenliCagir("run_gaql", { customerId: musteri, query: sorgu, limit: 1 });
    const satirSayisi = Number(/^(\d+)\s+satır/.exec(metin.trim())?.[1]);
    if (Number.isFinite(satirSayisi) && satirSayisi > 0) {
      adimlar.push({ arac: "run_gaql", ozet: "idempotenlik kontrolü", sonucOzeti: gorunurOzet(metin), durum: "tamam" });
      uyarilar.push(`"${kampanyaAdi}" adlı kampanya zaten var — tekrar kurulum yapılmadı, tüm adımlar iptal edildi.`);
      devam = false;
      basari = false;
    } else {
      /**
       * THE STAMP TELLS THE TRUTH ABOUT THE CHECK, NOT ABOUT THE DECISION TO CARRY ON.
       *
       * The row count is the ONLY thing that makes this step meaningful: without it we do
       * not know whether a campaign of the same name is already standing in the account.
       * The stamp used to be the constant "tamam" here, so a run_gaql answer that carried
       * no isError but did not match `^\d+ satır` — "(boş yanıt)", or read.ts's output
       * format changing under us — entered the audit table as TAMAM while the very next
       * line pushed the warning "sonucu çözümlenemedi". The table then said the
       * duplicate-name check had run successfully at the same moment the module admitted it
       * could not read the answer. Measured before the fix: durum "tamam", sonucOzeti
       * "(boş yanıt)", and rapor.mjs printed TAMAM for a check that never happened.
       *
       * 'belirsiz' is this module's word for exactly that state (see sonucDurumu): not "it
       * failed", but "whether it happened COULD NOT BE CONFIRMED". Carrying on is still the
       * right call — the run stamp already makes the name near-unique — but "we carried on"
       * and "the check was fine" are not the same sentence, and only the second one is a
       * lie. The stamp is what rapor.mjs reads (adimBasarisizMi treats anything other than
       * 'tamam' as not-successful), so the report now flags the setup instead of blessing
       * it. The go-live gate is untouched: growth-brain.mjs looks at uygulamaSonucu.basari,
       * which this branch does not change.
       */
      const olculdu = Number.isFinite(satirSayisi);
      adimlar.push({
        arac: "run_gaql",
        ozet: "idempotenlik kontrolü",
        sonucOzeti: olculdu ? "aynı adlı kampanya yok" : gorunurOzet(metin),
        durum: olculdu ? "tamam" : "belirsiz",
      });
      if (!olculdu) {
        uyarilar.push("İdempotenlik kontrolü sonucu çözümlenemedi — damgalı ad benzersiz varsayılarak devam edildi.");
      }
    }
  } catch (e) {
    adimlar.push({
      arac: "run_gaql",
      ozet: "idempotenlik kontrolü",
      sonucOzeti: `Araç hatası: ${gorunurOzet(e?.message ?? "bilinmeyen hata")}`,
      durum: "basarisiz",
    });
    uyarilar.push("İdempotenlik kontrolü yapılamadı — damgalı ad benzersiz varsayılarak devam edildi.");
  }

  /* 6) The write steps — arguments are built field by field, never spread. */
  const grupAdi =
    typeof gruplar[0]?.ad === "string" && gruplar[0].ad.trim() && !KONTROL_KARAKTERI.test(gruplar[0].ad)
      ? gruplar[0].ad.trim().slice(0, 255)
      : undefined;

  const kuyruk = [];
  kuyruk.push({
    arac: "create_search_campaign",
    ozet: `kampanya taslağı (PAUSED): "${gorunurOzet(kampanyaAdi, 120)}", günlük ${butce}, hedef ${hedefUlke}, ${kelimeler.length} kelime`,
    args: () => {
      const a = {
        customerId: musteri,
        name: kampanyaAdi,
        dailyBudget: butce,
        keywords: kelimeler,
        countryCodes: [hedefUlke],
      };
      if (grupAdi) a.adGroupName = grupAdi;
      return a;
    },
    sonra: (metin) => {
      const kimlikler = kimlikAyikla(metin);
      if (!kimlikler.kampanyaId || !kimlikler.adGrubuId) {
        uyarilar.push(
          "Kampanya/reklam grubu ID'si sonuç metninden ayrıştırılamadı — kalan adımlar iptal edildi (tahmin yapılmaz)."
        );
        return false;
      }
      kampanyaId = kimlikler.kampanyaId;
      adGrubuId = kimlikler.adGrubuId;
      return true;
    },
  });
  for (const [tip, ham] of ekstraEslesmeler) {
    const liste = tekrarsiz(ham);
    kuyruk.push({
      arac: "add_keywords",
      ozet: `${liste.length} anahtar kelime [${tip}] yeni reklam grubuna`,
      args: () => ({ customerId: musteri, adGroupId: adGrubuId, keywords: liste, matchType: tip }),
    });
  }
  if (negatifler.length > 0) {
    kuyruk.push({
      arac: "add_campaign_negative_keywords",
      ozet: `${negatifler.length} negatif kelime (kampanya seviyesi)`,
      // campaignId is ONLY the value parsed out of the create_search_campaign result.
      args: () => ({ customerId: musteri, campaignId: kampanyaId, keywords: negatifler, matchType: "PHRASE" }),
    });
  }
  kuyruk.push({
    arac: "create_responsive_search_ad",
    ozet: `RSA: ${basliklar.length} başlık / ${aciklamalar.length} açıklama → ${gorunurOzet(hedefUrl, 80)}`,
    args: () => ({
      customerId: musteri,
      adGroupId: adGrubuId,
      finalUrl: hedefUrl,
      headlines: basliklar,
      descriptions: aciklamalar,
    }),
  });

  for (const adim of kuyruk) {
    if (!devam) {
      adimlar.push({ arac: adim.arac, ozet: adim.ozet, sonucOzeti: "atlandı (önceki adım başarısız)", durum: "atlandi" });
      eksikAdimlar.push(adim.arac);
      continue;
    }
    let metin;
    try {
      metin = await guvenliCagir(adim.arac, adim.args());
    } catch (e) {
      adimlar.push({
        arac: adim.arac,
        ozet: adim.ozet,
        sonucOzeti: `Araç hatası: ${gorunurOzet(e?.message ?? "bilinmeyen hata")}`,
        durum: "basarisiz",
      });
      eksikAdimlar.push(adim.arac);
      devam = false;
      basari = false;
      continue;
    }
    const kirpik = metin.includes(KIRPMA_ISARETI);
    /**
     * A truncated response is 'belirsiz' in every case: the truncation marker sits at the
     * END of the text, so even when a success signature is visible, the rest went
     * unread.
     */
    const ham = sonucDurumu(metin);
    const durum = ham === "basarisiz" ? "basarisiz" : kirpik ? "belirsiz" : ham;
    if (kirpik) kirpikVar = true;
    adimlar.push({
      arac: adim.arac,
      ozet: adim.ozet,
      sonucOzeti: gorunurOzet(metin),
      durum,
    });
    if (durum !== "tamam") {
      /**
       * Both 'basarisiz' and 'belirsiz' cancel the remaining steps — fail-closed. The
       * distinction is carried only by the stamp and the warning text: one says "we know it
       * did not happen", the other "we do not know whether it happened", and neither of
       * them is "it happened".
       */
      eksikAdimlar.push(adim.arac);
      devam = false;
      basari = false;
      if (durum === "belirsiz") {
        uyarilar.push(
          kirpik
            ? `'${adim.arac}' sonucu kırpılmış — doğrulanamadığı için kalan adımlar iptal edildi.`
            : `'${adim.arac}' yanıtı tanınmadı — yazmanın gerçekleşip gerçekleşmediği DOĞRULANAMADI; kalan adımlar iptal edildi.`
        );
      }
      continue;
    }
    if (adim.sonra && !adim.sonra(metin)) {
      devam = false;
      basari = false;
    }
  }

  /**
   * kampanyaAdi comes back AS WRITTEN, not as the model wrote it: guvenliDize trims the
   * plan's name and the run stamp is prefixed, so the two strings differ. yayinaAl strips this
   * name out of the text it classifies, and a name that does not match the one standing in
   * the server's refusal strips nothing — which is how an ordinary refusal could be dressed
   * up as a network-gate refusal. The caller should hand THIS value to yayinaAl, never
   * plan.kampanyaAdi.
   */
  return {
    kampanyaId,
    adGrubuId,
    kampanyaAdi,
    basari,
    kirpik: kirpikVar,
    adimlar,
    uyarilar,
    eksikAdimlar,
  };
}

/* ── Going live (ONLY from growth-brain.mjs's --yayinla path) ────────────────── */

/**
 * The go-live path's narrow wrapper. It is NOT A RELATIVE of guvenliCagirici: the creation
 * path's blacklist stands untouched over there, while here the permitted set has exactly one
 * member.
 *
 *  - The tool name may ONLY be set_campaign_status; every other name is refused.
 *  - The status may ONLY be 'ENABLED': if this wrapper also opened a path for "pause", its
 *    claim to serve a single purpose could not be verified at the level of the code.
 *  - The `confirm` key is deleted unconditionally — this client cannot fabricate human
 *    approval; the decision belongs to the server's network gate and approval gate.
 */
export function yayinCagirici(cagir) {
  if (typeof cagir !== "function") {
    throw new Error("yayinaAl: 'cagir' fonksiyonu zorunlu — mcpBaglan() ile alınır.");
  }
  return async function yayinCagir(arac, args) {
    if (arac !== YAYIN_ARACI) {
      throw new Error(
        `Güvenlik: yayın sarmalayıcısı yalnız '${YAYIN_ARACI}' aracını taşır — '${arac}' reddedildi.`
      );
    }
    if (args?.status !== "ENABLED") {
      throw new Error("Güvenlik: yayın sarmalayıcısı yalnız status='ENABLED' çağrısı taşır.");
    }
    const temiz = {};
    for (const [anahtar, deger] of Object.entries(args ?? {})) {
      if (anahtar === "confirm") continue;
      temiz[anahtar] = deger;
    }
    return String((await cagir(arac, temiz)) ?? "");
  };
}

/**
 * The success signature in the server's ENABLED response, per write.ts's current text.
 * Success is declared ONLY by this signature; the inference "I found no refusal text, so it
 * must have worked" is never made — it fails closed.
 */
const YAYIN_BASARI_IZI = /YAYINDA \(ENABLED\)/;

/**
 * The human-approval gate's signatures, checked FIRST — a refusal from the human gate must
 * never be reported as a refusal from the network gate.
 *
 * THE ORIGINAL REASON FOR THAT ORDER NO LONGER HOLDS, and saying so matters more than the
 * order itself. It used to read: "when the network gate passes cleanly, its evidence lines —
 * which can mention things like AEGIS_NAC_SIMULATE — are appended to the approval gate's
 * refusal text". src/approval.ts does not do that any more. The gate's evidence (`ag.kanit`)
 * is spread into `insanSatirlari`, which is the HUMAN's channel alone: it is rendered into
 * the elicitation prompt and nowhere else. Every refusal text this client can receive is
 * built from `ozet.satirlar` or from a fixed sentence, so no masked approver number, no
 * look-back window and no expected country reaches the agent — deliberately, so that anyone
 * probing the gate cannot read off its dimensions. On this client the point is moot twice
 * over: mcpBaglan does not advertise elicitation, so the prompt is never shown here at all.
 *
 * The order is kept anyway, on the narrower ground stated in the first line, and
 * yayinSonucuSinifla additionally runs the network patterns over the BULLET-FREE body
 * (maddesizGovde), so a summary line could not reach them even if one carried network words.
 */
const INSAN_KAPISI_IZLERI = [/confirm=true ile tekrar çağır/i, /^İşlem yapılmadı:/mu];

/**
 * The refusal signatures of the network gate — networkTrust.ts, plus approval.ts's risk
 * branch AND its step-up branch. The list is deliberately narrow: with no match we do NOT
 * CLAIM "the network refused", and the refusal is honestly classified as "the server
 * refused".
 */
const AG_KAPISI_IZLERI = [
  /AĞ DOĞRULAMASI BAŞARISIZ/u,
  /NUMARA DOĞRULAMASI BAŞARISIZ/u,
  /CİHAZ ERİŞİLEBİLİRLİĞİ ANORMAL/u,
  /KONUM BEKLENMEDİK/u,
  // The SIMULATED refusal headings of links 5 and 6. They were missing: the real channel's
  // refusal is caught because it begins with "AĞ DOĞRULAMASI BAŞARISIZ", while the simulated
  // refusal carries its OWN heading and matched no pattern — so device-swap and
  // call-forwarding refusals were classified as "reddedildi" instead of "ag-retti", and the
  // report never printed its "GÜVENLİK KAPISI ÇALIŞTI" block. The work the network gate did
  // looked like an ordinary server refusal.
  /CİHAZ DEĞİŞİMİ SAPTANDI/u,
  /ÇAĞRI YÖNLENDİRME AÇIK/u,
  // THE STEP-UP REFUSAL'S OWN HEADINGS — the same omission as the two lines above, one
  // layer higher. With AEGIS_STEPUP on, a degraded signal that a clean real link can vouch
  // for is no longer refused by networkTrust.ts; it is handed to approval.ts as an
  // escalation, and on a client that cannot show a human prompt — Growth Brain's only
  // client — approval.ts refuses it with kanal:"ag". Measured: that refusal text carries
  // NO link heading and NO AEGIS_* variable name. Its own wording is all there is ("⚠ AĞ
  // SİNYALİ BOZUK — onaylayıcının SIM kartı yakın zamanda değişmiş."), the link's detection
  // sentence sits in prose the patterns below do not match ("cihaz erişilebilirlik
  // kontrolünden…" is not "cihaz erişilebilirliği kontrolü"), so a real SIM change caught by
  // the CAMARA chain came out as 'reddedildi' and the report skipped its "GÜVENLİK KAPISI
  // ÇALIŞTI" block. Both strings are produced ONLY in approval.ts's step-up branch, so
  // neither can dress an ordinary server refusal up as a network refusal.
  /AĞ SİNYALİ BOZUK/u,
  /BU İSTEMCİDE YÜKSELTME YAPILAMAZ/u,
  /ağ doğrulaması tamamlanamadı/iu,
  /ağ doğrulaması yapılandırması eksik/iu,
  /ağ doğrulama yapılandırması onay kapısına ulaşmadı/iu,
  /konum doğrulaması (aktif|yapılandırılmış)/iu,
  /numara doğrulaması aktif/iu,
  /cihaz erişilebilirliği kontrolü/iu,
  /cihaz değişimi kontrolü/iu,
  /çağrı yönlendirme kontrolü/iu,
  /simülasyon kanalı aktif/iu,
  // A new link's name is added HERE as well: if its environment variable is missing from
  // the pattern, that link's configuration and contradiction refusals fall outside the
  // classifier, since their text carries no network trace other than the variable's name.
  // DEVICESWAP and CALLFWD escaped in exactly that way.
  /AEGIS_(NAC|NV|REACH|LOC|DEVICESWAP|CALLFWD)_[A-Z_]+/u,
  /AEGIS_(APPROVER_PHONE|EXPECTED_COUNTRY)/u,
];

/**
 * The bullet lines of the approval summary. THE NETWORK GATE'S EVIDENCE IS NOT AMONG THEM —
 * approval.ts keeps `ag.kanit` in `insanSatirlari`, the human prompt's channel, and this
 * client never sees it.
 */
function maddeSatirlari(metin) {
  return String(metin ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("•"));
}

/** The body with the bullet lines removed — network traces are looked for in the body
 * ONLY. */
function maddesizGovde(metin) {
  return String(metin ?? "")
    .split("\n")
    .filter((s) => !s.trim().startsWith("•"))
    .join("\n");
}

/**
 * Every form of the campaign name that can appear in a server text, longest first.
 *
 * The value handed to the classifier is the name the MODEL chose; the name uygula() actually
 * writes to the account is that value TRIMMED (guvenliDize) behind a run stamp. The two are
 * not the same string whenever the model put whitespace at either end, so both forms have to
 * be stripped — otherwise the model's own words survive into the text the network patterns
 * run over. Longest first so that stripping the longer form cannot leave a fragment of the
 * shorter one behind.
 */
function adAdaylari(kampanyaAdi) {
  if (!kampanyaAdi) return [];
  const ham = String(kampanyaAdi);
  const adaylar = new Set([ham, ham.trim()]);
  adaylar.delete("");
  return [...adaylar].sort((a, b) => b.length - a.length);
}

/**
 * Classifies the ENABLED response honestly:
 *  'basarili'            — the campaign really was taken live,
 *  'ag-retti'            — the network gate refused; the demo's showcase, security worked.
 *                          It covers the STEP-UP refusal too (AEGIS_STEPUP on, degraded
 *                          signal, no prompt showable here): approval.ts returns that one on
 *                          kanal "ag" and its cause is a signal networkTrust.ts really
 *                          measured, so calling it an ordinary server refusal would hide the
 *                          gate's work,
 *  'insan-onayi-gerekli' — the network passed or was off, and the server refused for want of
 *                          VERIFIED human approval, which this client structurally cannot
 *                          fabricate,
 *  'reddedildi'          — some other server refusal: the budget ceiling, no servable ad, the
 *                          campaign not found, writes disabled, and so on,
 *  'hata'                — an empty or unintelligible response, or a tool error.
 */
export function yayinSonucuSinifla(metin, kampanyaAdi) {
  const m = String(metin ?? "").trim();
  if (!m || m === "(boş yanıt)") return "hata";

  /**
   * THE CAMPAIGN NAME THE MODEL CHOSE IS REMOVED FROM THE CLASSIFICATION.
   *
   * The server puts the campaign's name into its refusal text — `Reddedildi: "X"
   * kampanyası…` — and that name was produced by the MODEL. So part of the text these
   * patterns match against is not the gate's own output but free text the model wrote. Create
   * a campaign whose name contains "AĞ DOĞRULAMASI BAŞARISIZ" or "AEGIS_NAC_SIMULATE", and an
   * ordinary server refusal — the budget ceiling, no servable ad — was classified as
   * 'ag-retti', with the report printing "GÜVENLİK KAPISI ÇALIŞTI" for a CAMARA gate THAT
   * NEVER RAN. In a demo that means the very moment meant to prove the gate works is
   * fabricable.
   *
   * The name is stripped from the text being classified — the `sonucMetni` that goes to the
   * report is UNCHANGED, and the server's answer stands there verbatim. What is stripped is
   * only the copy the pattern search sees.
   *
   * EVERY FORM THE NAME CAN REACH THE ACCOUNT IN IS STRIPPED, not only the form the model
   * wrote. uygula() does not write plan.kampanyaAdi verbatim: guvenliDize TRIMS it before the
   * run stamp is prefixed. A single leading or trailing space — or a NBSP, which String.trim()
   * removes as well while this module's KONTROL_KARAKTERI guard (the C0 range plus DEL and C1)
   * does not reject — was enough for split() to match NOTHING: the name stayed inside the
   * classified copy and matched the network patterns all over again. A campaign named
   * " AĞ DOĞRULAMASI BAŞARISIZ " turned an ordinary budget-ceiling refusal into 'ag-retti',
   * which is precisely the fabrication this block exists to prevent.
   */
  let temiz = m;
  for (const ad of adAdaylari(kampanyaAdi)) temiz = temiz.split(ad).join(" ");

  /**
   * THE SUCCESS SIGNATURE IS CHECKED LAST — the order is not a matter of style.
   *
   * Check the success signature first and a REFUSAL that happens to CONTAIN that signature
   * comes out as 'basarili'. This is not theoretical: the campaign's NAME enters the refusal
   * text, because the server puts it into the approval summary, and the campaign's name is
   * chosen by the MODEL — so a name can be produced that slips a phrase like "YAYINDA" inside
   * the refusal. The result is the report printing "⚠ KAMPANYA YAYINDA — GERÇEK HARCAMA
   * BAŞLADI" and NEVER printing its "GÜVENLİK KAPISI ÇALIŞTI" block: the moment the gate
   * worked is reported as the moment it did not.
   *
   * A refusal always beats a success. If one text carries both a refusal and a success
   * marker, that text is a refusal.
   *
   * The order among the refusal kinds, human before network, is kept DELIBERATELY: a
   * refusal from the human gate must not be reported as a refusal from the network gate.
   * (The note on INSAN_KAPISI_IZLERI above gives the fuller story — the reason ORIGINALLY
   * written here, that a cleanly-passing network gate's evidence lines ride along in the
   * approval gate's refusal text, stopped being true when approval.ts moved that evidence
   * into the human-only channel.) Moving the success signature to the end did not touch the
   * refusal kinds' order relative to one another.
   */
  if (INSAN_KAPISI_IZLERI.some((d) => d.test(temiz))) return "insan-onayi-gerekli";
  const govde = maddesizGovde(temiz);
  if (AG_KAPISI_IZLERI.some((d) => d.test(govde))) return "ag-retti";
  if (sonucBasarisizMi(temiz)) return "reddedildi";
  if (YAYIN_BASARI_IZI.test(temiz)) return "basarili";
  return "hata";
}

/**
 * THE APPROVAL SUMMARY'S bullet lines, with the bullet stripped and the text cleaned.
 *
 * IT DOES NOT RETURN NETWORK EVIDENCE, and it cannot: the summary is all this client is
 * given. approval.ts spreads the gate's evidence into `insanSatirlari`, which is rendered
 * only into the human's elicitation prompt — a client without elicitation, and mcpBaglan is
 * one, receives a refusal built from `ozet.satirlar` alone. So what comes back here on the
 * --yayinla path is "Hesap: … · Kampanya: …", "Günlük bütçe: …", "Coğrafi hedef: …" and
 * their siblings; the masked approver number, the look-back window and the expected country
 * are withheld from the agent ON PURPOSE. Nothing here can widen that channel: this is a
 * READER of whatever the server chose to send, and putting the CAMARA evidence in front of
 * the operator would take a decision on the server about what may cross to the agent, not a
 * change in this file.
 *
 * THE HEADING OVER THE BLOCK NO LONGER CONTRADICTS THAT. rapor.mjs used to print these lines
 * under "**Kanıt satırları** _(onay özetine ağ katmanının eklediği satırlar dahil)_", which
 * was measured false: running the real gate (clean CAMARA chain, a client without
 * elicitation) produced three evidence lines — "Ağ doğrulaması: SIM değişimi yok…", "Cihaz
 * erişilebilirliği…", "Cihaz değişimi…" — and NONE of them reached the report, while the
 * block underneath the heading held the approval summary's own bullets. The heading now says
 * what the block is and states that the gate's evidence does not cross to this channel.
 *
 * The return field's NAME (`kanitSatirlari`) is older than that server decision and still
 * reads like a promise of network evidence. It is kept: renaming it would ripple through
 * growth-brain.mjs, rapor.mjs and four test files without making a single sentence truer,
 * and what the operator actually READS is the heading.
 */
export function kanitSatirlariniAyikla(metin) {
  return maddeSatirlari(metin)
    .map((s) => gorunurOzet(s.replace(/^•\s*/u, ""), 300))
    .filter((s) => s !== "");
}

/**
 * ATTEMPTS TO TAKE a created (PAUSED) campaign LIVE — set_campaign_status → ENABLED.
 * The call is labelled HIGH risk on the server: the network gate, the CAMARA SIM-swap chain,
 * runs FIRST, and the human-approval gate comes after it.
 *
 * This function is called only from growth-brain.mjs's --yayinla path, and only AFTER the
 * operator's separate, explicit second 'Evet'. That approval cannot be sent from this client
 * to the server — confirm is deleted and elicitation is not advertised — so even on a clean
 * network signal the server may refuse with 'insan-onayi-gerekli'. That is not a bug, it is
 * the proof of the invariant that the Growth Brain never goes live on its own.
 *
 * kampanyaId must come ONLY from uygula()'s result, as the value parsed out of
 * create_search_campaign's output; an id from the plan or the model is not accepted.
 *
 * Returns { denendi, kampanyaId, durum, sonucMetni, kanitSatirlari }
 * It does not throw — a tool error is classified as the 'hata' status too, so the report
 * cannot lie.
 */
export async function yayinaAl({ kampanyaId, musteriId, kampanyaAdi }, { cagir }) {
  const yayinCagir = yayinCagirici(cagir);

  const kampanya = guvenliDize(kampanyaId, "kampanyaId", { max: 20 });
  if (!/^\d+$/.test(kampanya)) {
    throw new Error(
      "kampanyaId yalnız rakam içerebilir — bu değer create_search_campaign sonucundan ayrıştırılır, plandan/modelden ASLA alınmaz."
    );
  }
  const musteri = guvenliDize(musteriId, "musteriId", { max: 20 });
  if (!/^[0-9-]+$/.test(musteri)) {
    throw new Error("musteriId yalnız rakam ve tire içerebilir (örn. 1234567890).");
  }

  let metin;
  try {
    metin = await yayinCagir(YAYIN_ARACI, {
      customerId: musteri,
      campaignId: kampanya,
      status: "ENABLED",
    });
  } catch (e) {
    return {
      denendi: true,
      kampanyaId: kampanya,
      durum: "hata",
      sonucMetni: `Araç hatası: ${gorunurOzet(e?.message ?? "bilinmeyen hata")}`,
      kanitSatirlari: [],
    };
  }

  return {
    denendi: true,
    kampanyaId: kampanya,
    durum: yayinSonucuSinifla(metin, kampanyaAdi),
    // The server's answer is carried VERBATIM, with only ANSI and control characters
    // stripped: the refusal text is the demo's showcase moment, and it is neither summarised
    // nor softened.
    sonucMetni: gorunurOzet(metin, 2000),
    kanitSatirlari: kanitSatirlariniAyikla(metin),
  };
}
