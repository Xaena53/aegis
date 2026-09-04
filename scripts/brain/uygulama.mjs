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

/** The marker mcpBaglan leaves at its result cap, following the demo-agent.mjs
 * pattern. */
const KIRPMA_ISARETI = "[... sonuç kırpıldı ...]";

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
 * Returns { kampanyaId?, adGrubuId?, basari, adimlar:[{arac, ozet, sonucOzeti, durum}],
 *          uyarilar:[..], eksikAdimlar:[..] }
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
      adimlar.push({
        arac: "run_gaql",
        ozet: "idempotenlik kontrolü",
        sonucOzeti: Number.isFinite(satirSayisi) ? "aynı adlı kampanya yok" : gorunurOzet(metin),
        durum: "tamam",
      });
      if (!Number.isFinite(satirSayisi)) {
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

  return { kampanyaId, adGrubuId, basari, kirpik: kirpikVar, adimlar, uyarilar, eksikAdimlar };
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
 * The human-approval gate's signatures. These are checked FIRST: when the network gate
 * passes CLEANLY, its evidence lines — which can mention things like AEGIS_NAC_SIMULATE — are
 * appended to the approval gate's refusal text, and in the opposite order a clean pass would
 * be misreported as "the network refused".
 */
const INSAN_KAPISI_IZLERI = [/confirm=true ile tekrar çağır/i, /^İşlem yapılmadı:/mu];

/**
 * The refusal signatures of the network gate — networkTrust.ts plus approval.ts's risk
 * branch. The list is deliberately narrow: with no match we do NOT CLAIM "the network
 * refused", and the refusal is honestly classified as "the server refused".
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

/** The bullet lines of the approval summary — the network evidence travels in them. */
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
 * Classifies the ENABLED response honestly:
 *  'basarili'            — the campaign really was taken live,
 *  'ag-retti'            — the network gate refused; the demo's showcase, security worked,
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
   */
  const temiz = kampanyaAdi ? m.split(String(kampanyaAdi)).join(" ") : m;

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
   * The order among the refusal kinds, human before network, was kept DELIBERATELY: as the
   * note on INSAN_KAPISI_IZLERI above explains, the evidence lines of a network gate that
   * passed cleanly are appended to the approval gate's refusal text. This fix only moves the
   * success signature to the end; it does not touch the refusal kinds' order relative to one
   * another.
   */
  if (INSAN_KAPISI_IZLERI.some((d) => d.test(temiz))) return "insan-onayi-gerekli";
  const govde = maddesizGovde(temiz);
  if (AG_KAPISI_IZLERI.some((d) => d.test(govde))) return "ag-retti";
  if (sonucBasarisizMi(temiz)) return "reddedildi";
  if (YAYIN_BASARI_IZI.test(temiz)) return "basarili";
  return "hata";
}

/** The network-evidence and approval-summary lines, with the bullet stripped and the text
 * cleaned. */
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
