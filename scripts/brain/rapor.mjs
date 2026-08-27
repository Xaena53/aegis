// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Growth Brain — rapor modülü.
 *
 * Spec imzası: raporOlustur({hedef, arastirma, plan, kreatif, uygulamaSonucu, kuruMod})
 * -> Türkçe markdown string. Modül saf fonksiyonlardan oluşur; ağ/SDK bağımlılığı yoktur.
 *
 * Güvenlik ilkeleri (panel notları):
 *  - Site/LLM kaynaklı TÜM dizeler markdown-kaçışlanır: \ [ ] ( ) < > ` ! | #
 *    Böylece görsel-markdown (`![](...)`) ve link enjeksiyonu YAPISAL olarak imkânsızdır;
 *    rapor hiçbir link üretmez (operatör URL'leri bile düz metin kalır).
 *  - Kontrol karakterleri ve ANSI kaçışları (terminal/onay arayüzü taklidi riski) silinir.
 *  - Müşteri ID biçimindeki 10 haneli sayılar maskelenir (123-456-XXXX). 11+ haneli
 *    kampanya ID'leri maske dışında kalır (sınır \b ile garanti).
 *  - Siteden/modelden türetilen araştırma bölümü "site kaynaklı, doğrulanmadı" uyarısı
 *    taşır; rakipYaklasimlari açıkça "model hipotezi — doğrulanmamış" etiketlenir.
 *  - Başarısız/atlanmış uygulama adımları asla başarı gibi sunulmaz; kuru mod
 *    "KURU MOD — HİÇBİR YAZMA YAPILMADI" damgası basar.
 *  - Girdi nesnelerinden herhangi birinde kirpik:true varsa (metinUret/jsonUret
 *    uzunluk-sınırı işareti) rapor "YARIM OLABİLİR" damgası taşır.
 *
 * İsteğe bağlı ek alanlar (orkestratör verirse gösterilir, vermezse sessizce atlanır):
 *  - efektifTavanTL: bağlayıcı bütçe tavanı (min(CLI tavanı, sunucu maxDailyBudget))
 *  - tavanKaynagi: tavanın hangi kaynaktan bağlayıcı olduğu (ör. "sunucu limits kaynağı")
 */

const MARKDOWN_KACIS = /[\\\[\]()<>`!|#]/g;
const KONTROL_KARAKTERLERI = /[\u0000-\u001f\u007f-\u009f]/g;
const MUSTERI_ID_DESENI = /\b(\d{3})-?(\d{3})-?\d{4}\b/g;

/**
 * Güvenilmez metni tek satıra indirir, kontrol/ANSI karakterlerini siler ve
 * markdown yapı karakterlerini kaçışlar. Dize olmayan değerler String()'e çevrilir.
 */
export function metniTemizle(deger) {
  if (deger === null || deger === undefined) return "";
  let s = typeof deger === "string" ? deger : String(deger);
  s = s.replace(/[\r\n\t\v\f]+/g, " ");
  s = s.replace(KONTROL_KARAKTERLERI, "");
  s = s.replace(MARKDOWN_KACIS, (c) => "\\" + c);
  return s.trim();
}

/** Google Ads müşteri ID biçimindeki 10 haneli sayıları maskeler: 1234567890 -> 123-456-XXXX. */
export function musteriIdMaskele(metin) {
  if (metin === null || metin === undefined) return "";
  return String(metin).replace(MUSTERI_ID_DESENI, "$1-$2-XXXX");
}

/** Temizle + maskele; boş kalırsa yer tutucu döner. Diziler "; " ile birleştirilir. */
function guvenli(deger, bos = "(boş)") {
  const ham = Array.isArray(deger) ? deger.join("; ") : deger;
  const s = musteriIdMaskele(metniTemizle(ham));
  return s === "" ? bos : s;
}

/** Güvenilmez diziyi madde listesine çevirir; boşsa tek yer tutucu madde döner. */
function maddeListesi(dizi, bos = "(yok)") {
  const d = Array.isArray(dizi) ? dizi.filter((x) => x !== null && x !== undefined) : [];
  if (!d.length) return [`- ${bos}`];
  return d.map((x) => `- ${guvenli(x)}`);
}

/**
 * Araç yanıtı sınıflandırıcısı: sunucunun isError'suz düz metinle döndürdüğü
 * retleri de yakalar ("Reddedildi: ...", "Yazma araçları ... devre dışı",
 * "Kampanya bulunamadı: ..."). "atlandı" YALNIZ satır başında başarısızlık sayılır —
 * başarı mesajındaki "(1 tekrar/boş atlandı)" eki yanlış pozitif üretmez.
 */
function adimBasarisizMi(adim) {
  if (adim && (adim.basarili === false || adim.basari === false)) return true;
  const s = String(adim?.sonucOzeti ?? "").trim();
  if (/^(reddedildi|araç hatası|hata\b|atlandı|başarısız)/iu.test(s)) return true;
  if (/(devre dışı|bulunamadı|onay gerekiyor|insan onayı gerek|sonuç kırpıldı)/iu.test(s)) return true;
  return false;
}

/**
 * Growth Brain çalıştırmasının Türkçe markdown raporunu üretir.
 * Tüm girdiler eksik/bozuk olabilir; fonksiyon fırlatmaz, yer tutucularla düşer.
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

  // ── Hedef (operatör girdisi; yine de aynı hijyenden geçirilir) ──
  ekle("## Hedef", "", guvenli(hedef, "(hedef girilmedi)"), "");

  // ── Araştırma: site + model türevi, güvenilmez blok ──
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

  // ── Uygulama adımları ──
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
        const durum = adimBasarisizMi(a) ? "BASARISIZ/ATLANDI" : "TAMAM";
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

  // ── Güvenlik durumu (her raporda zorunlu ibare) ──
  ekle(
    "## Güvenlik Durumu",
    "",
    "- Kampanya DURAKLATILMIŞ (PAUSED) durumda; kendiliğinden hiçbir harcama başlamaz.",
    "- Yayına alma (ENABLED) ve bütçe artışı, insan onayı + ağ onayı (CAMARA SIM-swap doğrulaması) ister; Growth Brain bu çağrıları hiçbir koşulda kendiliğinden yapmaz.",
    ""
  );

  return satirlar.join("\n");
}
