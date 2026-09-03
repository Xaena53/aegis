// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ağ kapısı KARAR GÜNLÜĞÜ — denetlenebilirlik izi.
 *
 * Ağ kapısı (networkTrust.ts) bir harcama artışını reddettiğinde bunu yalnızca ajana
 * söyler; hesap sahibi "geçen ay kaç kez reddedildi, hangi pencereyle, hangi kanaldan"
 * sorusunu sonradan cevaplayamaz. Bu modül risk etiketli her ağ kararını tek satırlık
 * JSONL olarak biriktirir; kapının kendisine hiç dokunmaz.
 *
 * DÖRT DEĞİŞMEZ:
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
 * 4) TUTAR ÖLÇÜLÜR, TAHMİN EDİLMEZ. "Kaç kez reddedildi" tek başına yarım cevaptır;
 *    denetçi "NE BÜYÜKLÜKTE bir harcama" diye de sorar. Bu yüzden karara konu olan
 *    günlük tutar `tutar` alanına yazılır — ama YALNIZCA çağrı yeri onu gerçekten
 *    okuyabildiyse. Okunamayan bütçe için alan HİÇ yazılmaz; 0 yazmak "bilmiyorum"u
 *    "sıfır harcama" diye kaydetmek, yani bu dosyanın var oluş nedenine aykırı olurdu.
 *
 * 5) GÜNLÜĞÜN BİR TAVANI VAR. Sınırsız büyüyen bir denetim dosyası, onay bile
 *    gerektirmeyen bir istek seliyle diski doldurulabilir; ve dolu diskte yazma hatası
 *    akışı düşürmediği için iz SESSİZCE durur. Tavana ulaşan dosya `<yol>.1` olarak
 *    devredilir (bkz. GUNLUK_AZAMI_BAYT).
 *
 * Günlük varsayılan olarak KAPALIDIR: ADSPILOT_DECISION_LOG tanımlı değilse hiçbir
 * dosya oluşturulmaz ve hiçbir şey yazılmaz (demo/compose ortamı açar).
 */
import { appendFileSync, renameSync, statSync } from "node:fs";
import type { AgKarar, AgRisk, HalkaIzi, NvIzi, RetNedeni, SimSwapIzi } from "./networkTrust.js";

/**
 * Kapının verdiği kararın SÖZLÜĞÜ — dört değer, tamamı.
 *
 * "kademeli" AYRI bir sonuçtur ve "gecti"ye katlanmaz. Denetçi için bu ayrım işin
 * kendisidir: "hiçbir sinyal bozuk değildi" ile "bir sinyal bozuktu, diğerleri temiz
 * geldiği için insana sorularak geçildi" aynı güven seviyesi değildir. Tek bir "gecti"
 * etiketi altında toplanırlarsa, kapının gevşediği anlar kapının hiç zorlanmadığı
 * anlardan ayırt edilemez — ve sonradan "kaç kez yükseltme yaptık" sorusu
 * cevaplanamaz hâle gelir.
 */
export const KARAR_SONUCLARI = ["gecti", "kademeli", "ret", "kapali"] as const;

/**
 * Sözlük DİZİDEN türetilir, tersi değil: belgelerin (docs/DEMO.md · .env.example)
 * bu değerleri saydığını sınayan gözcü, çalışma anında okunabilen bir listeye
 * ihtiyaç duyar. Elle yazılmış bir birleşim, sözlüğe sessizce dördüncü bir değer
 * eklenmesine izin veriyordu: kod "kademeli" yazarken belgelerde üç değer vardı ve
 * o sözlüğe göre sayaç kuran operatörde kapının yumuşadığı satırlar hiçbir kovaya
 * girmiyordu.
 */
export type KararSonucu = (typeof KARAR_SONUCLARI)[number];

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
  /**
   * Kademeli doğrulama devreye girdiyse, yükseltmeyi TAŞIYAN halkaların id'leri.
   * Yükseltme yoksa alan hiç yazılmaz — "yükseltme olmadı" ile "olduğu hâlde
   * doğrulayanı kaydedilmedi" birbirine karışmasın.
   */
  kademeDogrulayan?: string[];
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
  /**
   * RİSKTEKİ TUTAR: kararın konusu olan GÜNLÜK para büyüklüğü, hesabın KENDİ para
   * biriminde. "Geçen ay kaç kez reddedildi" sorusunun yanında duran "ne büyüklükte"
   * sorusu bu alan olmadan cevaplanamıyordu.
   *
   * ÜÇ KURAL:
   *
   * a) Para birimi alanı YOKTUR. Birim zaten hesabın bağlamıdır (hesapId + hesabın
   *    Google Ads/Meta para birimi); buraya bir `paraBirimi` uydurmak, kapının hiç
   *    ölçmediği bir bilgiyi ölçülmüş gibi kaydetmek olurdu.
   *
   * b) MICROS DEĞİL, para birimi. 50 TL "50" olarak yazılır, "50000000" olarak değil:
   *    denetçinin okuduğu sayı budur, ayrıca micros büyüklüğündeki rakam dizileri
   *    kayıttaki sır taramalarında kimlik/numara gibi görünürdü.
   *
   * c) OKUNAMAYAN TUTAR YAZILMAZ. Çağrı yeri bütçeyi okuyamadıysa alanı HİÇ geçmez;
   *    0 ya da tahmin yazmak "bilmiyorum"u "sıfır harcama" diye kaydetmek olurdu.
   *    Anlamı işleme göre değişir ve bilinçlidir: bütçe değişiminde YENİ bütçe, canlı kampanyaya reklam/kelime eklerken o kampanyanın mevcut günlük bütçesi
   *    (riske girecek tavan), yayına almada kampanyanın günlük bütçesidir.
   */
  tutar?: number;
  /** Onaylayıcı numarasının MASKELİ hâli (ör. "+905*******33"); asla tam numara. */
  maskeliNumara?: string;
  /** networkTrust'ın sabit sözlüğünden ret kodu; serbest/upstream metin DEĞİL. */
  retNedeniKisa?: RetNedeni;
  /**
   * Zincir boyunca üretilen TÜM ret nedenleri (bkz. AgIz.retNedenleri) —
   * `retNedeniKisa` yalnız kararı VEREN nedendir ve yol boyunca üzerine yazılır.
   * Bu alan olmadan "SIM değişti + çağrı yönlendirme açık" ile "yalnız çağrı
   * yönlendirme açık" birebir aynı satırı üretiyordu: saptanmış SIM değişimi izden
   * siliniyor, üstelik satır temiz bir sorgu izlenimi veriyordu. Hiçbir ret nedeni
   * üretilmediyse alan HİÇ yazılmaz.
   */
  retNedenleri?: RetNedeni[];
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
 * Riskteki tutarı kayda ALMADAN önce sayı olarak doğrular.
 *
 * NaN/Infinity, negatif değer ya da sayı olmayan bir şey, çağrı yerinde bir hatanın
 * (ör. okunamayan `amount_micros`'un sessizce NaN'a dönmesi) günlüğe sızmasıdır.
 * Böyle bir değeri yazmak denetçiye uydurma bir büyüklük göstermek olurdu: alan
 * DÜŞÜRÜLÜR, ama sessizce değil — operatör stderr'den görür.
 *
 * 0 geçerlidir ve düşürülmez: "bütçesi 0 olarak okundu" gerçek bir ölçümdür;
 * "okunamadı" ise çağrı yerinin alanı hiç geçmemesiyle ifade edilir.
 */
function tutarDogrula(tutar: number | undefined): number | undefined {
  if (tutar === undefined) return undefined;
  if (typeof tutar === "number" && Number.isFinite(tutar) && tutar >= 0) return tutar;
  console.error(
    "[adspilot] karar günlüğü: geçersiz riskteki tutar kayda YAZILMADI (uydurma büyüklük önlendi)"
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
  hesapId?: string,
  /** Riskteki günlük tutar; çağrı yeri OKUYABİLDİYSE geçer, okuyamadıysa hiç geçmez. */
  tutar?: number
): KararKaydi {
  const iz = ag.iz;
  return {
    zaman: new Date().toISOString(),
    eylem: kisalt(eylem, EYLEM_AZAMI),
    hesapId: hesapId?.trim() ? kisalt(hesapId, HESAP_ID_AZAMI) : undefined,
    risk,
    karar: ag.engel ? "ret" : iz.kademe === "yukseltildi" ? "kademeli" : hicSorguYok(iz.simSwap) ? "kapali" : "gecti",
    simSwapKanali: iz.simSwap,
    nvKanali: iz.nv,
    reachKanali: iz.reach,
    locKanali: iz.loc,
    devSwapKanali: iz.devSwap,
    callFwdKanali: iz.callFwd,
    pencereSaat: iz.pencereSaat,
    devSwapPencereSaat: iz.devSwapPencereSaat,
    tutar: tutarDogrula(tutar),
    maskeliNumara: maskeliDogrula(iz.maskeliNumara),
    /**
     * Yükseltilen kararda da yazılır. Ret nedeni burada "neden reddedildi"nin değil,
     * "hangi sinyal bozuktu"nun adıdır; yükseltme kaydında o ad olmazsa denetçi
     * kademenin NEDEN devreye girdiğini hiç öğrenemez.
     */
    retNedeniKisa: ag.engel || iz.kademe === "yukseltildi" ? iz.retNedeni : undefined,
    kademeDogrulayan: iz.kademe === "yukseltildi" ? iz.kademeDogrulayan : undefined,
    /**
     * Boş dizi alanı AÇMAZ: "bakıldı, bozuk sinyal yoktu" ile "hiç bakılmadı" ayrımı
     * bu dosyanın her yerindeki kuralın aynısıdır — bilinmeyen alan hiç yazılmaz.
     */
    retNedenleri: iz.retNedenleri?.length ? [...iz.retNedenleri] : undefined,
  };
}

/**
 * Kaydı JSONL olarak ekler. ADSPILOT_DECISION_LOG tanımsızsa GÜNLÜK KAPALIDIR:
 * dosya oluşturulmaz, hiçbir yan etki üretilmez.
 *
 * Env karar anında okunur (modül yüklenirken değil): tek bir süreçte günlüğü açıp
 * kapatabilmek hem operatör hem test için gerekir.
 */
/**
 * GÜNLÜK DOSYASININ BAYT TAVANI ve tek yedek kuşağı.
 *
 * Kayıt yazmanın hiçbir üst sınırı yoktu: her riskli karar bir satır ekliyor, dosya
 * yalnızca büyüyordu. Tek bir kötü niyetli (ya da hatalı) ajan, onay bile gerektirmeyen
 * — çünkü kapı zaten reddediyor — istek seliyle diski doldurabilirdi. Ve dolu disk bu
 * modülün en kötü arıza biçimidir: yazma hatası akışı düşürmediği için kimse fark
 * etmez, denetim izi sessizce durur.
 *
 * Tavana ulaşıldığında dosya `<yol>.1` olarak devredilir ve yeni dosya açılır. Tek
 * kuşak bilinçli: iki dosyalık sabit bir tavan, "sınırsız büyüme" ile "hiç iz yok"
 * arasındaki tek dürüst orta noktadır. Uzun süreli saklama operatörün log toplayıcısının
 * işidir, bu modülün değil.
 */
const GUNLUK_AZAMI_BAYT = 16 * 1024 * 1024;

/**
 * Tavana ulaşan dosyayı devreder. HATA YUTULMAZ ama YÜKSELTİLMEZ de: devretme
 * başarısız olursa (dosya kilitli, dizin salt-okunur) satır yine de eklenir —
 * "döndüremedim" yüzünden denetim izini kesmek, tavanın çözdüğünden büyük bir sorundur.
 */
function dosyayiDevret(hedef: string): void {
  try {
    if (statSync(hedef).size < GUNLUK_AZAMI_BAYT) return;
    renameSync(hedef, `${hedef}.1`);
  } catch (e: any) {
    // ENOENT = dosya henüz yok: devredilecek bir şey de yok, sessiz geçilir.
    if (e?.code === "ENOENT") return;
    console.error(
      `[adspilot] karar günlüğü devredilemedi (${hedef}): ${e?.message ?? e} — satır yine de eklenecek`
    );
  }
}

export function kararYaz(kayit: KararKaydi): void {
  const hedef = process.env.ADSPILOT_DECISION_LOG?.trim();
  if (!hedef) return;
  dosyayiDevret(hedef);
  try {
    /**
     * Alan sırası bilinçli: JSON.stringify undefined alanları düşürür, böylece
     * "ölçülemedi" ile "boş" karışmaz.
     *
     * DİKKAT — bu liste ELLE yazılır ve eksikliği SESSİZDİR: kayıt nesnesinde
     * bulunan bir alan burada unutulursa satır yine geçerli JSON'dur, hiçbir tip
     * hatası çıkmaz ve alan diske hiç düşmez. `kademeDogrulayan` tam olarak böyle
     * kaçmıştı: yükseltmeyi taşıyan kefil halkalar üretiliyor ama yazılmıyordu, yani
     * "yükseltme olmadı" ile "kefili kaydedilmedi" kalıcı olarak karışıyordu.
     * test/kararGunlugu.test.ts bu listeyi ÇİFT YÖNLÜ sınar: kayıttaki her dolu alan
     * satırda da bulunmak zorundadır.
     */
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
      tutar: kayit.tutar,
      maskeliNumara: kayit.maskeliNumara,
      retNedeniKisa: kayit.retNedeniKisa,
      retNedenleri: kayit.retNedenleri,
      kademeDogrulayan: kayit.kademeDogrulayan,
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
