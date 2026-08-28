// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ağ kapısı KARAR GÜNLÜĞÜ — denetlenebilirlik izi.
 *
 * Ağ kapısı (networkTrust.ts) bir harcama artışını reddettiğinde bunu yalnızca ajana
 * söyler; hesap sahibi "geçen ay kaç kez reddedildi, hangi pencereyle, hangi kanaldan"
 * sorusunu sonradan cevaplayamaz. Bu modül risk etiketli her ağ kararını tek satırlık
 * JSONL olarak biriktirir; kapının kendisine hiç dokunmaz.
 *
 * ÜÇ DEĞİŞMEZ:
 *
 * 1) GÜNLÜK KAPI DEĞİL, GÖZLEMDİR. Yazma hatası (bozuk yol, salt-okunur dizin, dolu
 *    disk) onay akışını ASLA düşürmez — hata stderr'e tek satır olarak yazılır ve akış
 *    aynen sürer. Tersi, bir denetim aracını yeni bir arıza noktasına çevirirdi:
 *    yanlış yazılmış bir yol yüzünden meşru harcama onayları patlardı.
 *
 * 2) SIR YAZILMAZ. Tam onaylayıcı numarası, NaC token'ı veya ham upstream hata metni
 *    kayda ASLA girmez. Numara alanı kapının maskele() çıktısıdır ve buraya yazılmadan
 *    önce yapısal olarak da doğrulanır (en az bir '*' — maskesiz bir E.164 numara bu
 *    kapıdan geçemez). Ret nedeni serbest metin değil, networkTrust'ın SABİT RetNedeni
 *    sözlüğünden bir koddur; böylece upstream'den gelen hiçbir metin günlüğe sızamaz.
 *
 * 3) KAYIT METİNDEN DEĞİL, İZDEN ÜRETİLİR. Eskiden kanal/pencere/numara/ret nedeni
 *    ret ve kanıt METİNLERİ koklanarak tahmin ediliyordu; iki halkanın metni tek dizede
 *    birleştiği için günlük yalan söyleyebiliyordu (SIM-Swap kapalı + NV simülasyonu
 *    "gecti/simulasyon" görünüyor, gerçek CAMARA sorgusu + NV simülasyonu "gercek"
 *    yerine "simulasyon" yazılıyordu). Artık her alan AgKarar.iz'den gelir ve zincirin
 *    HER halkası AYRI alana (simSwapKanali / nvKanali / reachKanali / locKanali /
 *    devSwapKanali / callFwdKanali) yazılır — tek boolean'a ASLA ezilmez. Pencereli
 *    halkalar da ayrıdır: pencereSaat SIM-Swap'ın, devSwapPencereSaat 5. halkanındır.
 *
 *    Bu kural halka eklendikçe yeniden kazanılmak zorundadır: 3. ve 4. halka ilk
 *    yazıldığında izde vardı ama kayda geçmiyordu, dolayısıyla SİMÜLE bir halkanın
 *    ürettiği ret, kayıtta yalnız "simSwapKanali":"gercek" görünüp gerçek bir CAMARA
 *    sorgusunun ürünü sanılıyordu. Yeni halka eklerken buraya da alan eklenmeli.
 *
 * Günlük varsayılan olarak KAPALIDIR: ADSPILOT_DECISION_LOG tanımlı değilse hiçbir
 * dosya oluşturulmaz ve hiçbir şey yazılmaz (demo/compose ortamı açar).
 */
import { appendFileSync } from "node:fs";
import type { AgKarar, AgRisk, HalkaIzi, NvIzi, RetNedeni, SimSwapIzi } from "./networkTrust.js";

/** Kapının verdiği karar: geçti / reddetti / hiçbir halka sorgu yapmadı. */
export type KararSonucu = "gecti" | "ret" | "kapali";

export interface KararKaydi {
  /** ISO-8601 zaman damgası. */
  zaman: string;
  /** Eylemin tek cümlelik özeti (kısaltılmış; kampanya adı içerir, sır içermez). */
  eylem: string;
  /**
   * Kararın ait olduğu reklam hesabı (Google Ads müşteri ID). Hosted çok-kiracılı
   * modda tüm kiracıların kararları TEK dosyaya düştüğü için, bu alan olmadan
   * "kimin hesabında ne oldu" sorusu cevaplanamıyordu. Çağrı yeri geçmezse yazılmaz.
   */
  hesapId?: string;
  risk: AgRisk;
  karar: KararSonucu;
  /** 1. halka: gerçek CAMARA sorgusu mu, simülasyon mu, kapalı mı, hiç çalışamadı mı. */
  simSwapKanali: SimSwapIzi;
  /** 2. halka (Number Verification); halka hiç koşmadıysa alan YOKTUR. */
  nvKanali?: NvIzi;
  /** 3. halka (Device Reachability); halka hiç koşmadıysa alan YOKTUR. */
  reachKanali?: HalkaIzi;
  /** 4. halka (konum / beklenen ülke); halka hiç koşmadıysa alan YOKTUR. */
  locKanali?: HalkaIzi;
  /** 5. halka (Device Swap — yeni cihaza taşınma); halka hiç koşmadıysa alan YOKTUR. */
  devSwapKanali?: HalkaIzi;
  /** 6. halka (Call Forwarding); halka hiç koşmadıysa alan YOKTUR. */
  callFwdKanali?: HalkaIzi;
  /** Sorgulanan SIM-swap geriye bakış penceresi (saat); sorgu yapılmadıysa yok. */
  pencereSaat?: number;
  /**
   * 5. halkanın KENDİ geriye bakış penceresi (saat). pencereSaat ile birleştirilmez:
   * SIM-Swap katmanı kapalıyken bile cihaz-değişim halkası koşabilir ve o pencereyi
   * SIM-Swap'ınkiymiş gibi yazmak denetçiyi yanıltırdı.
   */
  devSwapPencereSaat?: number;
  /** Onaylayıcı numarasının MASKELİ hâli (ör. "+905*******33"); asla tam numara. */
  maskeliNumara?: string;
  /** networkTrust'ın sabit sözlüğünden ret kodu; serbest/upstream metin DEĞİL. */
  retNedeniKisa?: RetNedeni;
}

/** Kampanya adları uzun olabilir; günlük satırını sınırlı tutar. */
const EYLEM_AZAMI = 160;

/** Hesap kimliği de sınırlı yazılır: çağrı yeri ne gönderirse göndersin satır şişmez. */
const HESAP_ID_AZAMI = 32;

/**
 * Maskeli numara simgesi: en az bir '*' İÇERMEK ZORUNDA. Maskesiz bir E.164 numara
 * (yalnız '+' ve rakam) bu desene yapısal olarak giremez.
 *
 * İz zaten maskele() çıktısı taşır; bu kontrol onun yerine geçmez, ONU DOĞRULAR:
 * ileride bir katman izi ham numarayla doldurursa sır günlüğe düşmesin diye son
 * savunma hattıdır (kapalı arıza: şüpheli değer yazılmaz, düşürülür).
 */
const MASKELI_NUMARA_DESENI = /\*/;

function kisalt(metin: string, azami: number): string {
  const tek = metin.replace(/\s+/g, " ").trim();
  return tek.length <= azami ? tek : tek.slice(0, azami - 1) + "…";
}

/** Maskesiz görünen bir numarayı kayda ALMAZ; sessizce yutmaz, stderr'e söyler. */
function maskeliDogrula(numara: string | undefined): string | undefined {
  if (numara === undefined) return undefined;
  if (MASKELI_NUMARA_DESENI.test(numara)) return numara;
  console.error(
    "[adspilot] karar günlüğü: maskesiz görünen numara alanı kayda YAZILMADI (sır sızıntısı önlendi)"
  );
  return undefined;
}

/**
 * Hiçbir halka SORGU YAPMADI mı? Engel yokken bu, "geçti" değil "kapalı"dır —
 * hiç sorulmamış bir kontrolü geçmiş göstermek denetimi yalanlar.
 *
 * Ölçüt yalnız 1. halkadır ve bu bilinçlidir: SIM-Swap halkası bir SIM-değişim
 * yargısı üretir (gerçek CAMARA sorgusuyla ya da demoda simüle kanalla). 2. halka
 * (Number Verification) ise YAPISAL OLARAK sorgu yapamaz — gerçek NV cihaz-taraflı
 * OIDC ister, sunucu onu tek başına çağıramaz (bkz. networkTrust.ts dosya başı).
 * Dolayısıyla NV bir kararı REDDEDEBİLİR ama "kapalı"yı asla "geçti"ye çeviremez:
 * SIM-Swap kapalıyken NV simülasyonunun tek başına işlemi doğrulanmış göstermesi,
 * bu günlüğün düzeltmek için var olduğu yalanın ta kendisiydi.
 */
function hicSorguYok(simSwap: SimSwapIzi): boolean {
  return simSwap !== "gercek" && simSwap !== "simulasyon";
}

/**
 * Ağ kapısının kararını günlük kaydına çevirir. Tüm alanlar kapının YAPISAL izinden
 * (AgKarar.iz) gelir; ret/kanıt metinleri artık hiç okunmaz.
 */
export function agKararKaydiOlustur(
  eylem: string,
  risk: AgRisk,
  ag: AgKarar,
  hesapId?: string
): KararKaydi {
  const iz = ag.iz;
  return {
    zaman: new Date().toISOString(),
    eylem: kisalt(eylem, EYLEM_AZAMI),
    hesapId: hesapId?.trim() ? kisalt(hesapId, HESAP_ID_AZAMI) : undefined,
    risk,
    karar: ag.engel ? "ret" : hicSorguYok(iz.simSwap) ? "kapali" : "gecti",
    simSwapKanali: iz.simSwap,
    nvKanali: iz.nv,
    reachKanali: iz.reach,
    locKanali: iz.loc,
    devSwapKanali: iz.devSwap,
    callFwdKanali: iz.callFwd,
    pencereSaat: iz.pencereSaat,
    devSwapPencereSaat: iz.devSwapPencereSaat,
    maskeliNumara: maskeliDogrula(iz.maskeliNumara),
    retNedeniKisa: ag.engel ? iz.retNedeni : undefined,
  };
}

/**
 * Kaydı JSONL olarak ekler. ADSPILOT_DECISION_LOG tanımsızsa GÜNLÜK KAPALIDIR:
 * dosya oluşturulmaz, hiçbir yan etki üretilmez.
 *
 * Env karar anında okunur (modül yüklenirken değil): tek bir süreçte günlüğü açıp
 * kapatabilmek hem operatör hem test için gerekir.
 */
export function kararYaz(kayit: KararKaydi): void {
  const hedef = process.env.ADSPILOT_DECISION_LOG?.trim();
  if (!hedef) return;
  try {
    // Alan sırası bilinçli: JSON.stringify undefined alanları düşürür, böylece
    // "ölçülemedi" ile "boş" karışmaz.
    const satir = JSON.stringify({
      zaman: kayit.zaman,
      eylem: kayit.eylem,
      hesapId: kayit.hesapId,
      risk: kayit.risk,
      karar: kayit.karar,
      simSwapKanali: kayit.simSwapKanali,
      nvKanali: kayit.nvKanali,
      reachKanali: kayit.reachKanali,
      locKanali: kayit.locKanali,
      devSwapKanali: kayit.devSwapKanali,
      callFwdKanali: kayit.callFwdKanali,
      pencereSaat: kayit.pencereSaat,
      devSwapPencereSaat: kayit.devSwapPencereSaat,
      maskeliNumara: kayit.maskeliNumara,
      retNedeniKisa: kayit.retNedeniKisa,
    });
    appendFileSync(hedef, satir + "\n", "utf8");
  } catch (e: any) {
    /**
     * Sessiz yutmak da düşürmek kadar kötü olurdu: operatör, denetim izinin
     * tutulmadığını fark edemezdi. Tek satır, akış etkilenmeden devam eder.
     */
    console.error(
      `[adspilot] karar günlüğü yazılamadı (${hedef}): ${e?.message ?? e} — onay akışı etkilenmedi`
    );
  }
}
