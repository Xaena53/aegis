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
 *  - yayinSonucu: --yayinla yolunun sonucu (uygulama.mjs yayinaAl dönüşü). Verilmezse
 *    "Yayına Alma Denemesi" bölümü HİÇ oluşmaz. Ağ kapısının reddi bu bölümde
 *    BAŞARISIZLIK olarak değil, "güvenlik kapısı çalıştı" olarak sunulur: para
 *    hareketinin durdurulması sistemin amacıdır, arızası değil.
 */

const MARKDOWN_KACIS = /[\\\[\]()<>`!|#]/g;
const KONTROL_KARAKTERLERI = /[\u0000-\u001f\u007f-\u009f]/g;
const MUSTERI_ID_DESENI = /\b(\d{3})-?(\d{3})-?\d{4}\b/g;

/**
 * Çağrı yerindeki uzunluk tavanının İZİ: kırpılan metnin sonuna eklenen "…".
 *
 * uygulama.mjs'ten sabit/tavan import EDİLMEZ — bu modülün bağımsızlığı bilinçlidir
 * (bkz. YAYIN_ETIKETI notu) ve tavan sayısını buraya kopyalamak, tavan değiştiğinde
 * sessizce yanlış rapor üretirdi. Tek bağ, kırpmanın görünür bıraktığı işarettir.
 */
const KIRPMA_IZI = /…\s*$/;

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
  /**
   * DAMGA OTORİTEDİR, ÖZET DEĞİL.
   *
   * uygula() her adıma bir `durum` yazar ('tamam' | 'belirsiz' | 'basarisiz' |
   * 'atlandi') ve bunu HAM yanıta bakarak yapar. Rapor ise durumu `sonucOzeti`
   * metninden yeniden türetiyordu — ama o özet gorunurOzet() ile 400 karaktere
   * KIRPILIR, oysa kırpma işareti ham yanıtın 30.001. karakterindedir. Sonucu
   * doğrulanamayan gerçek bir yazma çağrısı bu yüzden denetim tablosuna "TAMAM"
   * diye geçiyor, rapor kendi içinde çelişiyordu (üstteki uyarı "yarım olabilir"
   * derken tablo "tamam" diyordu).
   *
   * Bilinmeyen bir damga da başarı sayılmaz: tanımadığımız durum 'tamam' değildir.
   */
  if (adim && typeof adim.durum === "string") return adim.durum !== "tamam";
  // Damgasız (eski ya da dış kaynaklı) adım: metinden türetme YEDEK yoldur.
  const s = String(adim?.sonucOzeti ?? "").trim();
  if (/^(reddedildi|araç hatası|hata\b|atlandı|başarısız)/iu.test(s)) return true;
  if (/(devre dışı|bulunamadı|onay gerekiyor|insan onayı gerek|sonuç kırpıldı)/iu.test(s)) return true;
  return false;
}

/**
 * Tablo etiketi: BAŞARISIZ ile BELİRSİZ ayrı gösterilir.
 *
 * "Olmadığını biliyoruz" ile "olup olmadığını bilmiyoruz" tek etikete katlanırsa
 * operatör doğrulanamamış bir yazmayı kesin başarısızlık sanıp elle geri almaya
 * kalkar (ya da tersi). Denetim tablosunun işi tam olarak bu ayrımı taşımaktır.
 */
function adimEtiketi(adim) {
  if (!adimBasarisizMi(adim)) return "TAMAM";
  return adim?.durum === "belirsiz" ? "BELİRSİZ — DOĞRULANAMADI" : "BASARISIZ/ATLANDI";
}

/**
 * Yayın denemesi durum kodları → rapor etiketi. rapor.mjs'in bağımsızlığı korunsun
 * diye uygulama.mjs'ten import edilmez; bilinmeyen kod geldiğinde ham değer
 * güvenli biçimde gösterilir (eşleşme zorunlu değildir).
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

/** Ret metnini alıntı bloğuna çevirir: her satır ayrı ayrı temizlenip kaçışlanır. */
function alintiSatirlari(metin) {
  const satirlar = String(metin ?? "")
    .split("\n")
    .map((s) => guvenli(s, ""))
    .filter((s) => s !== "");
  return satirlar.length ? satirlar.map((s) => `> ${s}`) : ["> (sunucu metni yok)"];
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
  yayinSonucu,
  dagitim,
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
  if (Array.isArray(dagitim) && dagitim.length) {
    ekle("## Kanal Bütçe Dağıtımı", "");
    /**
     * UYGULANAN ile ÖNERİLEN ayrımı burada yapılır ve yumuşatılmaz.
     *
     * Dağıtım bütçeyi kanallara böler, ama kampanya kurma yolu bugün tek kanaldan gider.
     * İkisini aynı tabloda ayırmadan göstermek, uygulanmamış bir payı uygulanmış gibi
     * okutur — raporun en kolay yalan söyleyeceği yer tam burasıdır.
     */
    ekle("| Kanal | Günlük bütçe | Durum | Gerekçe |", "|---|---|---|---|");
    dagitim.forEach((pay, i) => {
      const durum = i === 0 ? "bu koşuda planlandı" : "ÖNERİ — bu koşuda uygulanmadı";
      ekle(`| ${guvenli(pay.kanal)} | ${guvenli(String(pay.gunlukButce))} | ${durum} | ${guvenli(pay.gerekce)} |`);
    });
    ekle("");
    if (dagitim.length > 1) {
      ekle(
        "> Yalnız ilk satırdaki kanal için kampanya kuruldu/planlandı. Diğer kanalların payı " +
          "bir ÖNERİDİR: o platformda kampanya açılmadı, hiçbir çağrı yapılmadı. Uygulamak " +
          "için o kanalın kendi araçları ayrıca çalıştırılmalıdır.",
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

  // ── Yayına alma denemesi (YALNIZ --yayinla yolunda oluşur) ──
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
       * DÜRÜSTLÜK: burada "kısaltılmadı" DEMEZ, çünkü doğru değil. Metin bu rapora
       * ulaşmadan ÖNCE çağrı yerinde (uygulama.mjs) uzunluk tavanında kırpılmış olabilir,
       * ve burada raporun tekdüze hijyeninden geçer: kontrol karakteri sökülür, markdown
       * kaçışlanır, 10 haneli müşteri ID'leri maskelenir (guvenli → musteriIdMaskele).
       * Hijyeni ters yüz etmek link/görsel enjeksiyonuna tek istisna açardı; ama başlığın
       * "aynen — kısaltılmadı" demesi de raporu kendi çıktısı hakkında yalancı yapıyordu.
       *
       * Özetleme/yumuşatma YOKTUR — vaadimiz budur. Kırpma varsa saklanmaz, AÇIKÇA yazılır.
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
      ekle("**Kanıt satırları** _(onay özetine ağ katmanının eklediği satırlar dahil)_:");
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

  // ── Güvenlik durumu (her raporda zorunlu ibare) ──
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
