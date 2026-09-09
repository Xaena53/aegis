// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Growth Brain — the report module.
 *
 * The specified signature is raporOlustur({hedef, arastirma, plan, kreatif, uygulamaSonucu,
 * kuruMod}) -> a markdown string. The module is made of pure functions, with no network or
 * SDK dependency.
 *
 * Security principles, as noted for the panel:
 *  - EVERY string originating in a site or an LLM is markdown-escaped: \ [ ] ( ) < > ` ! | #
 *    That makes image markdown (`![](...)`) and link injection STRUCTURALLY impossible; the
 *    report produces no links at all, and even operator URLs stay as plain text.
 *  - Control characters and ANSI escapes are stripped, since they risk impersonating the
 *    terminal or the approval UI.
 *  - Ten-digit numbers shaped like a customer ID are masked (123-456-XXXX). Campaign IDs of
 *    11 digits or more stay outside the mask, guaranteed by the \b boundary.
 *  - The research section, derived from the site and the model, carries a "from the site,
 *    unverified" warning; rakipYaklasimlari is labelled explicitly as an unverified model
 *    hypothesis.
 *  - Failed or skipped application steps are never presented as successes; dry-run mode
 *    stamps "KURU MOD — HİÇBİR YAZMA YAPILMADI".
 *  - If kirpik:true appears on any of the input objects — the length-limit marker set by
 *    metinUret and jsonUret — the report carries a "YARIM OLABİLİR" stamp.
 *
 * Optional extra fields — shown if the orchestrator supplies them, silently skipped if not:
 *  - efektifTavanTL: the binding budget ceiling, min(the CLI ceiling, the server's
 *    maxDailyBudget)
 *  - tavanKaynagi: which source the binding ceiling came from, e.g. the server's limits
 *    resource
 *  - uygulananKanal: the name of the channel the campaign was actually created on. The
 *    allocation table stamps its row "bu koşuda planlandı" and every other row
 *    "ÖNERİ"; without it the default below is used, and a channel that is not in the
 *    allocation stamps NO row as applied (see VARSAYILAN_UYGULANAN_KANAL).
 *  - yayinSonucu: the outcome of the --yayinla path, as returned by yayinaAl in
 *    uygulama.mjs. Without it the "Yayına Alma Denemesi" section is not produced AT ALL. A
 *    refusal by the network gate is presented in that section not as a FAILURE but as the
 *    safety gate doing its job: stopping the movement of money is the system's purpose, not
 *    its malfunction.
 */

const MARKDOWN_KACIS = /[\\\[\]()<>`!|#]/g;
const KONTROL_KARAKTERLERI = /[\u0000-\u001f\u007f-\u009f]/g;
const MUSTERI_ID_DESENI = /\b(\d{3})-?(\d{3})-?\d{4}\b/g;

/**
 * The TRACE of the length cap applied at the call site: the "…" appended to truncated text.
 *
 * No constant or cap is imported from uygulama.mjs — this module's independence is deliberate
 * (see the note on YAYIN_ETIKETI), and copying the cap's value here would silently produce a
 * wrong report whenever the cap changed. The only link is the marker the truncation leaves
 * visible.
 */
const KIRPMA_IZI = /…\s*$/;

/**
 * Collapses untrusted text to a single line, strips control and ANSI characters, and
 * escapes markdown's structural characters. Non-string values are passed through String().
 */
export function metniTemizle(deger) {
  if (deger === null || deger === undefined) return "";
  let s = typeof deger === "string" ? deger : String(deger);
  s = s.replace(/[\r\n\t\v\f]+/g, " ");
  s = s.replace(KONTROL_KARAKTERLERI, "");
  s = s.replace(MARKDOWN_KACIS, (c) => "\\" + c);
  return s.trim();
}

/** Masks ten-digit numbers shaped like a Google Ads customer ID: 1234567890 ->
 * 123-456-XXXX. */
export function musteriIdMaskele(metin) {
  if (metin === null || metin === undefined) return "";
  return String(metin).replace(MUSTERI_ID_DESENI, "$1-$2-XXXX");
}

/** Clean and mask; returns a placeholder if nothing is left. Arrays are joined with
 * "; ". */
function guvenli(deger, bos = "(boş)") {
  const ham = Array.isArray(deger) ? deger.join("; ") : deger;
  const s = musteriIdMaskele(metniTemizle(ham));
  return s === "" ? bos : s;
}

/** Turns an untrusted array into a bullet list; when empty, a single placeholder
 * bullet. */
function maddeListesi(dizi, bos = "(yok)") {
  const d = Array.isArray(dizi) ? dizi.filter((x) => x !== null && x !== undefined) : [];
  if (!d.length) return [`- ${bos}`];
  return d.map((x) => `- ${guvenli(x)}`);
}

/**
 * A classifier for tool responses: it also catches the refusals the server returns as plain
 * text without isError — "Reddedildi: ...", "Yazma araçları ... devre dışı", "Kampanya
 * bulunamadı: ...". The word "atlandı" counts as a failure ONLY at the start of a line, so
 * the "(1 tekrar/boş atlandı)" suffix on a success message produces no false positive.
 */
function adimBasarisizMi(adim) {
  if (adim && (adim.basarili === false || adim.basari === false)) return true;
  /**
   * THE STAMP IS THE AUTHORITY, NOT THE SUMMARY.
   *
   * uygula() writes a `durum` onto every step — 'tamam', 'belirsiz', 'basarisiz' or
   * 'atlandi' — and it does so by looking at the RAW response. The report, meanwhile, was
   * re-deriving the status from the `sonucOzeti` text — but that summary is TRUNCATED to 400
   * characters by gorunurOzet(), while the truncation marker sits at character 30,001 of the
   * raw response. A real write call whose outcome could not be confirmed therefore entered
   * the audit table as "TAMAM", and the report contradicted itself: the warning above said
   * the run might be incomplete while the table said everything was fine.
   *
   * An unrecognised stamp does not count as success either: a status we do not know is not
   * 'tamam'.
   */
  if (adim && typeof adim.durum === "string") return adim.durum !== "tamam";
  // A step with no stamp, whether old or externally produced: deriving from the text is
  // the FALLBACK path.
  const s = String(adim?.sonucOzeti ?? "").trim();
  if (/^(reddedildi|araç hatası|hata\b|atlandı|başarısız)/iu.test(s)) return true;
  if (/(devre dışı|bulunamadı|onay gerekiyor|insan onayı gerek|sonuç kırpıldı)/iu.test(s)) return true;
  return false;
}

/**
 * The table's label: BAŞARISIZ and BELİRSİZ are shown separately.
 *
 * If "we know it did not happen" and "we do not know whether it happened" are folded into one
 * label, an operator takes an unconfirmed write for a definite failure and goes to undo it by
 * hand — or the reverse. Carrying exactly that distinction is the audit table's job.
 */
function adimEtiketi(adim) {
  if (!adimBasarisizMi(adim)) return "TAMAM";
  return adim?.durum === "belirsiz" ? "BELİRSİZ — DOĞRULANAMADI" : "BASARISIZ/ATLANDI";
}

/**
 * Status codes from the go-live attempt, mapped to report labels. They are not imported
 * from uygulama.mjs, so that rapor.mjs stays independent; an unrecognised code has its raw
 * value shown safely, since a match is not required.
 */
const YAYIN_ETIKETI = {
  basarili: "YAYINA ALINDI (ENABLED)",
  "ag-retti": "AĞ KAPISI REDDETTİ",
  "insan-onayi-gerekli": "DOĞRULANMIŞ İNSAN ONAYI GEREKTİ — sunucu reddetti",
  reddedildi: "SUNUCU REDDETTİ",
  hata: "HATA",
  onaysiz: "OPERATÖR ONAY VERMEDİ — çağrı hiç yapılmadı",
  atlandi: "ATLANDI — kurulum tamamlanmadığı için denenmedi",
};

/**
 * The channel the campaign-creation path writes to when the caller does not name one.
 *
 * WHICH CHANNEL WAS APPLIED IS A FACT OF THE RUN, so raporOlustur takes it as
 * `uygulananKanal`; this default only covers callers that do not pass it yet. It is not
 * imported from growth-brain.mjs — this module's independence is deliberate (see the note on
 * YAYIN_ETIKETI) — and the guard in the allocation table is what stops the copy from lying:
 * a channel that is NOT in the allocation stamps NO row as applied.
 *
 * IF THE CREATION PATH EVER WRITES TO ANOTHER CHANNEL, THE CALLER MUST PASS
 * `uygulananKanal`; otherwise the table would name the channel this constant remembers.
 */
const VARSAYILAN_UYGULANAN_KANAL = "google";

/** Compares channel names normalised — dagitimDogrula already trims and lowercases them. */
function kanalEsit(kanal, hedef) {
  return String(kanal ?? "").trim().toLowerCase() === hedef;
}

/** Turns refusal text into a quote block, cleaning and escaping each line
 * separately. */
function alintiSatirlari(metin) {
  const satirlar = String(metin ?? "")
    .split("\n")
    .map((s) => guvenli(s, ""))
    .filter((s) => s !== "");
  return satirlar.length ? satirlar.map((s) => `> ${s}`) : ["> (sunucu metni yok)"];
}

/**
 * Produces the markdown report for a Growth Brain run.
 * Every input may be missing or malformed; the function does not throw, it degrades to
 * placeholders.
 */
export function raporOlustur({
  hedef,
  arastirma,
  plan,
  kreatif,
  uygulamaSonucu,
  kuruMod,
  efektifTavanTL,
  tavanKaynagi,
  yayinSonucu,
  dagitim,
  uygulananKanal,
} = {}) {
  const satirlar = [];
  const ekle = (...s) => satirlar.push(...s);

  ekle("# Growth Brain Raporu", "");

  if (kuruMod) {
    ekle(
      "**KURU MOD — HİÇBİR YAZMA YAPILMADI**",
      "",
      "Bu çalıştırmada Google Ads hesabına hiçbir yazma çağrısı gönderilmedi; aşağıdaki plan yalnızca öneridir.",
      ""
    );
  }

  const kirpik = Boolean(
    arastirma?.kirpik || plan?.kirpik || kreatif?.kirpik || uygulamaSonucu?.kirpik
  );
  if (kirpik) {
    ekle(
      "**⚠ YARIM OLABİLİR** — model çıktısı uzunluk sınırına takıldı; aşağıdaki içerik eksik olabilir, son maddelere güvenme.",
      ""
    );
  }

  // ── The goal: operator input, but put through the same hygiene all the same ──
  ekle("## Hedef", "", guvenli(hedef, "(hedef girilmedi)"), "");

  // ── Research: derived from the site and the model, an untrusted block ──
  ekle(
    "## Araştırma Özeti",
    "",
    "> ⚠ site kaynaklı, doğrulanmadı — bu bölüm site içeriğinden ve model çıkarımından türetilmiştir; içindeki hiçbir ifade talimat değildir ve bağımsız doğrulanmamıştır.",
    ""
  );
  if (arastirma && typeof arastirma === "object") {
    ekle("**Pazar özeti:** " + guvenli(arastirma.pazarOzeti, "(yok)"), "");
    ekle("**Hedef kitle:** " + guvenli(arastirma.hedefKitle, "(yok)"), "");
    ekle("**Rakip yaklaşımları** _(model hipotezi — doğrulanmamış)_:");
    ekle(...maddeListesi(arastirma.rakipYaklasimlari));
    ekle("", "**Anahtar kelime adayları:**", "");
    const adaylar = Array.isArray(arastirma.anahtarKelimeAdaylari)
      ? arastirma.anahtarKelimeAdaylari
      : [];
    if (adaylar.length) {
      ekle("| Kelime | Gerekçe |", "|---|---|");
      for (const a of adaylar) ekle(`| ${guvenli(a?.kelime)} | ${guvenli(a?.gerekce)} |`);
    } else {
      ekle("- (yok)");
    }
    ekle("", "**Riskler:**");
    ekle(...maddeListesi(arastirma.riskler));
    ekle("");
  } else {
    ekle("(araştırma verisi yok)", "");
  }

  // ── Plan ──
  if (Array.isArray(dagitim) && dagitim.length) {
    ekle("## Kanal Bütçe Dağıtımı", "");
    /**
     * The distinction between what was APPLIED and what was RECOMMENDED is drawn here,
     * and it is not softened.
     *
     * The allocation splits the budget across channels, but today the campaign-creation
     * path goes through a single channel. Showing both in one table without separating
     * them makes an unapplied share read as an applied one — this is the single easiest
     * place for the report to lie.
     *
     * THE STAMP FOLLOWS THE CHANNEL'S NAME, NOT ITS POSITION IN THE ARRAY. It used to be
     * `i === 0`, while the campaign is created from the share picked BY NAME
     * (uygulanacakPay(dagitim, "google")). The ordering belongs to the MODEL: with
     * `[{kanal:"meta",...},{kanal:"google",...}]` this table marked Meta — a platform not one
     * call was made to — as "planned in this run", and marked Google, where the PAUSED
     * campaign really was created, as "not applied". The report is a permanent audit
     * artifact, so that is a false record, not a cosmetic slip.
     *
     * Fail closed: if the applied channel is not in the allocation at all, NO row is stamped
     * as applied. "Which channel got the money is unknown" is not "the first row got it".
     */
    const hedefKanal =
      typeof uygulananKanal === "string" && uygulananKanal.trim() !== ""
        ? uygulananKanal.trim().toLowerCase()
        : VARSAYILAN_UYGULANAN_KANAL;
    const uygulananSatirVar = dagitim.some((pay) => kanalEsit(pay?.kanal, hedefKanal));
    ekle("| Kanal | Günlük bütçe | Durum | Gerekçe |", "|---|---|---|---|");
    for (const pay of dagitim) {
      const durum = !uygulananSatirVar
        ? "BELİRSİZ — uygulandığı DOĞRULANMADI"
        : kanalEsit(pay?.kanal, hedefKanal)
          ? "bu koşuda planlandı"
          : "ÖNERİ — bu koşuda uygulanmadı";
      ekle(
        `| ${guvenli(pay?.kanal)} | ${guvenli(String(pay?.gunlukButce))} | ${durum} | ${guvenli(pay?.gerekce)} |`
      );
    }
    ekle("");
    if (!uygulananSatirVar) {
      ekle(
        `> ⚠ HANGİ KANALA UYGULANDIĞI BU RAPORDAN OKUNAMAZ: kampanyanın kurulduğu kanal ` +
          `('${guvenli(hedefKanal)}') yukarıdaki dağıtımda yok. Satırların HİÇBİRİ uygulanmış ` +
          "SAYILMAZ; hangi platforma yazıldığı hesaptan doğrulanmalıdır.",
        ""
      );
    } else if (dagitim.length > 1) {
      ekle(
        `> Yalnız '${guvenli(hedefKanal)}' kanalı için kampanya kuruldu/planlandı. Diğer ` +
          "kanalların payı bir ÖNERİDİR: o platformda kampanya açılmadı, hiçbir çağrı " +
          "yapılmadı. Uygulamak için o kanalın kendi araçları ayrıca çalıştırılmalıdır.",
        ""
      );
    }
  }

  ekle("## Plan", "");
  if (plan && typeof plan === "object") {
    const butce = Number.isFinite(plan.butceGunlukTL)
      ? `${plan.butceGunlukTL} TL/gün`
      : guvenli(plan.butceGunlukTL, "(geçersiz)");
    ekle("| Alan | Değer |", "|---|---|");
    ekle(`| Kampanya adı | ${guvenli(plan.kampanyaAdi)} |`);
    ekle(`| Hedef ülke | ${guvenli(plan.hedefUlke)} |`);
    ekle(`| Dil | ${guvenli(plan.dil)} |`);
    ekle(`| Günlük bütçe | ${butce} |`);
    if (Number.isFinite(efektifTavanTL)) {
      ekle(
        `| Bağlayıcı bütçe tavanı | ${efektifTavanTL} TL${tavanKaynagi ? ` — ${guvenli(tavanKaynagi)}` : ""} |`
      );
    }
    ekle("", "**Reklam grupları:**", "");
    const gruplar = Array.isArray(plan.adGruplari) ? plan.adGruplari : [];
    if (gruplar.length) {
      ekle("| Grup | Eşleme | Kelime sayısı | Anahtar kelimeler |", "|---|---|---|---|");
      for (const g of gruplar) {
        const kelimeler = Array.isArray(g?.anahtarKelimeler) ? g.anahtarKelimeler : [];
        ekle(
          `| ${guvenli(g?.ad)} | ${guvenli(g?.eslesmeTipi)} | ${kelimeler.length} | ${guvenli(kelimeler.join(", "), "(yok)")} |`
        );
      }
    } else {
      ekle("- (reklam grubu yok)");
    }
    ekle("", "**Negatif kelimeler:**");
    ekle(...maddeListesi(plan.negatifKelimeler));
    ekle("", "**Başarı metrikleri:**");
    ekle(...maddeListesi(plan.basariMetrikleri));
    ekle("");
  } else {
    ekle("(plan yok)", "");
  }

  // ── Kreatifler ──
  ekle("## Kreatifler", "");
  if (kreatif && typeof kreatif === "object") {
    ekle("**Başlıklar** _(sınır 30 karakter)_:");
    const basliklar = Array.isArray(kreatif.basliklar) ? kreatif.basliklar : [];
    if (basliklar.length) {
      for (const b of basliklar) ekle(`- ${guvenli(b)} _· ${String(b ?? "").length} karakter_`);
    } else {
      ekle("- (yok)");
    }
    ekle("", "**Açıklamalar** _(sınır 90 karakter)_:");
    const aciklamalar = Array.isArray(kreatif.aciklamalar) ? kreatif.aciklamalar : [];
    if (aciklamalar.length) {
      for (const a of aciklamalar) ekle(`- ${guvenli(a)} _· ${String(a ?? "").length} karakter_`);
    } else {
      ekle("- (yok)");
    }
    if (kreatif.yol1 || kreatif.yol2) {
      ekle(
        "",
        `**Görünen yol:** /${guvenli(kreatif.yol1, "")}${kreatif.yol2 ? "/" + guvenli(kreatif.yol2, "") : ""}`
      );
    }
    ekle("");
  } else {
    ekle("(kreatif yok)", "");
  }

  // ── The application steps ──
  ekle("## Uygulama Adımları", "");
  if (kuruMod) {
    ekle("KURU MOD — HİÇBİR YAZMA YAPILMADI. Uygulama adımı çalıştırılmadı.", "");
  } else if (uygulamaSonucu && typeof uygulamaSonucu === "object") {
    const adimlar = Array.isArray(uygulamaSonucu.adimlar) ? uygulamaSonucu.adimlar : [];
    const basarisizVar =
      uygulamaSonucu.basari === false || adimlar.some((a) => adimBasarisizMi(a));
    if (uygulamaSonucu.kampanyaId) {
      ekle(`Kampanya ID: ${guvenli(uygulamaSonucu.kampanyaId)}`, "");
    }
    if (adimlar.length) {
      ekle("| No | Araç | Özet | Sonuç | Durum |", "|---|---|---|---|---|");
      adimlar.forEach((a, i) => {
        const durum = adimEtiketi(a);
        ekle(
          `| ${i + 1} | ${guvenli(a?.arac)} | ${guvenli(a?.ozet)} | ${guvenli(a?.sonucOzeti)} | ${durum} |`
        );
      });
    } else {
      ekle("- (adım kaydı yok)");
    }
    ekle("");
    const uyarilar = Array.isArray(uygulamaSonucu.uyarilar) ? uygulamaSonucu.uyarilar : [];
    if (uyarilar.length) {
      ekle("**Uyarılar:**");
      ekle(...maddeListesi(uyarilar));
      ekle("");
    }
    if (basarisizVar) {
      ekle(
        "**⚠ UYGULAMA KISMEN BAŞARISIZ** — en az bir adım tamamlanamadı veya atlandı; kampanya YARIM kalmış olabilir. Bu kurulum tamamlanmış SAYILMAZ; eksik adımlar giderilmeden yayına alma değerlendirilmemelidir.",
        ""
      );
    } else {
      ekle("Tüm adımlar tamamlandı.", "");
    }
  } else {
    ekle("Uygulama çalıştırılmadı — yalnızca plan ve rapor üretildi.", "");
  }

  // ── The go-live attempt: produced ONLY on the --yayinla path ──
  if (yayinSonucu && typeof yayinSonucu === "object") {
    const durum = String(yayinSonucu.durum ?? "");
    const etiket = YAYIN_ETIKETI[durum] ?? guvenli(durum, "(bilinmiyor)");
    const denendi = yayinSonucu.denendi === true;
    ekle("## Yayına Alma Denemesi", "");
    ekle(
      "Bu adımda `set_campaign_status` → ENABLED çağrısı denendi. Sunucuda bu çağrı HIGH risk",
      "etiketlidir: ağ kapısı (CAMARA SIM-swap zinciri) insan onayı isteminden ÖNCE çalışır.",
      ""
    );
    ekle("| Alan | Değer |", "|---|---|");
    ekle(`| Çağrı yapıldı mı | ${denendi ? "evet" : "hayır"} |`);
    ekle(`| Karar | ${etiket} |`);
    if (yayinSonucu.kampanyaId) ekle(`| Kampanya ID | ${guvenli(yayinSonucu.kampanyaId)} |`);
    ekle("");

    if (yayinSonucu.sonucMetni) {
      /**
       * HONESTY: this does NOT claim the text was left unabridged, because that is not
       * true. BEFORE reaching this report the text may already have been truncated at the
       * length cap at the call site in uygulama.mjs, and here it goes through the report's
       * uniform hygiene: control characters removed, markdown escaped, ten-digit customer
       * IDs masked (guvenli → musteriIdMaskele). Turning that hygiene off would open the
       * one exception link and image injection needs; but a heading claiming "verbatim,
       * unabridged" made the report a liar about its own output.
       *
       * There is NO summarising and NO softening — that is the promise. If there was
       * truncation it is not hidden, it is stated PLAINLY.
       */
      const kirpik = KIRPMA_IZI.test(String(yayinSonucu.sonucMetni));
      ekle(
        kirpik
          ? "**Sunucunun cevabı (özetlenmedi — ama uzunluk tavanında KIRPILDI; müşteri ID'leri maskeli, kontrol karakteri sökülüp markdown kaçışlandı):**"
          : "**Sunucunun cevabı (özetlenmedi; uzun cevaplar çağrı yerinde kırpılabilir — müşteri ID'leri maskeli, kontrol karakteri sökülüp markdown kaçışlandı):**",
        ""
      );
      ekle(...alintiSatirlari(yayinSonucu.sonucMetni));
      if (kirpik) {
        ekle(
          "",
          "_Alıntının sonundaki … uzunluk tavanının izidir: yukarıdaki metin sunucu cevabının TAMAMI DEĞİLDİR._"
        );
      }
      ekle("");
    }

    const kanitlar = Array.isArray(yayinSonucu.kanitSatirlari) ? yayinSonucu.kanitSatirlari : [];
    if (kanitlar.length) {
      /**
       * THE HEADING NAMES WHAT THE BLOCK REALLY HOLDS.
       *
       * It used to read "_(onay özetine ağ katmanının eklediği satırlar dahil)_", and that
       * sentence was MEASURED false: src/approval.ts spreads the network gate evidence
       * (`ag.kanit`) into `insanSatirlari` — the human elicitation prompt channel alone —
       * and Growth Brain's client does not advertise elicitation, so the refusal it receives
       * is built from `ozet.satirlar` only. Measured against the real gate (clean CAMARA
       * chain, weak client): the three evidence lines it produced ("Ağ doğrulaması: SIM
       * değişimi yok…", "Cihaz erişilebilirliği…", "Cihaz değişimi…") appear NOWHERE in this
       * report, while the block printed below the heading carried the approval summary's own
       * bullets ("Hesap/Kampanya", "Günlük bütçe", "Coğrafi hedef"). A heading promising
       * CAMARA evidence over an account-and-budget summary is the cheapest possible loss of
       * trust in a report whose whole claim is auditability.
       */
      ekle(
        "**Kanıt satırları** _(sunucunun AJANA gönderdiği onay özetinin maddeleri; ağ " +
          "kapısının kanıt satırları bu kanala GELMEZ — onlar yalnız insana gösterilen " +
          "isteme yazılır)_:"
      );
      ekle(...maddeListesi(kanitlar));
      ekle("");
    }

    if (durum === "ag-retti") {
      ekle(
        "**✔ GÜVENLİK KAPISI ÇALIŞTI — BU BİR BAŞARISIZLIK DEĞİLDİR.** Ağ doğrulaması yayına alma",
        "isteğini reddetti; kampanya DURAKLATILMIŞ kaldı ve hiç para harcanmadı. Sistemin var oluş",
        "amacı tam olarak budur: LLM planlar, ama her para hareketi ağ kapısından geçmek zorundadır.",
        ""
      );
    } else if (durum === "insan-onayi-gerekli") {
      ekle(
        "**✔ İKİNCİ KAPI ÇALIŞTI — BU BİR BAŞARISIZLIK DEĞİLDİR.** Ağ kapısı bu çağrıyı durdurmadı,",
        "ancak sunucu DOĞRULANMIŞ insan onayı istedi ve Growth Brain onayı yapısal olarak uyduramaz",
        "(elicitation ilan edilmez, `confirm` bayrağı koşulsuz silinir). Kampanya DURAKLATILMIŞ kaldı.",
        ""
      );
    } else if (durum === "basarili") {
      ekle(
        "**⚠ KAMPANYA YAYINDA — GERÇEK HARCAMA BAŞLADI.** Ağ kapısı ve onay kapısı geçildi.",
        "Harcamayı hemen izlemeye al; durdurmak için kampanyayı PAUSED'a çek.",
        ""
      );
    } else if (durum === "hata") {
      ekle(
        "**⚠ YAYIN DENEMESİ SONUÇSUZ** — sunucudan anlaşılır bir karar alınamadı. Kampanyanın gerçek",
        "durumu bu rapordan OKUNAMAZ; hesaptan doğrulanmadan yayına alındığı ya da alınmadığı varsayılmamalıdır.",
        ""
      );
    } else if (denendi) {
      ekle(
        "Sunucu bu çağrıyı reddetti; kampanya DURAKLATILMIŞ kaldı ve hiç para harcanmadı.",
        ""
      );
    } else {
      ekle("Çağrı hiç yapılmadı; kampanya DURAKLATILMIŞ kaldı ve hiç para harcanmadı.", "");
    }
  }

  // ── The security posture: a mandatory statement in every report ──
  ekle("## Güvenlik Durumu", "");
  if (yayinSonucu && yayinSonucu.durum === "basarili") {
    ekle("- Kampanya YAYINDA (ENABLED); harcama başlamış durumda — bu rapordaki tek istisna budur.");
  } else {
    ekle("- Kampanya DURAKLATILMIŞ (PAUSED) durumda; kendiliğinden hiçbir harcama başlamaz.");
  }
  ekle(
    "- Yayına alma (ENABLED) ve bütçe artışı, insan onayı + ağ onayı (CAMARA SIM-swap doğrulaması) ister; Growth Brain bu çağrıları hiçbir koşulda kendiliğinden yapmaz.",
    ""
  );

  return satirlar.join("\n");
}
