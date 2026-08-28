// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Network-verified approval: CAMARA signals as a trust anchor for spending consent.
 *
 * MCP elicitation proves a human clicked "approve"; it cannot prove the human is the
 * account owner. A stolen session answers the prompt just as convincingly. The mobile
 * network holds evidence no application layer can fake: the operator knows whether the
 * owner's SIM was swapped recently — the signature move of account-takeover fraud.
 *
 * Before a spend-increasing action reaches the human prompt, this module consults the
 * GSMA Open Gateway SIM Swap API (CAMARA, via the Nokia Network-as-Code platform) for
 * the configured approver number. A recent swap refuses the action outright — the
 * prompt is never shown, because the person who would answer it may be the attacker.
 *
 * Fail-closed contract, same as every money gate in this codebase:
 *   - Feature unconfigured (no ADSPILOT_NAC_TOKEN): pass-through, evidence line says so.
 *   - Configured but incomplete (token without approver phone): refuse with a config error.
 *   - Network API unreachable or throws: refuse. If the trust anchor cannot answer,
 *     the spend does not happen.
 *
 * Risk tiers widen the lookback window rather than change the decision logic:
 * "medium" (budget increases) checks the last 24h; "high" (go-live, changes to a
 * serving campaign) checks the configured window, 72h by default.
 *
 * ── Link 2 of the trust chain: Number Verification (SIMULATION ONLY) ──────────
 *
 * SIM Swap answers "was the owner's line taken over recently?". It cannot answer the
 * next question: "is this approval request coming from the owner's own device?".
 * CAMARA Number Verification answers that one — the operator matches the number
 * against the very mobile data connection the request travels over.
 *
 * HONEST LIMITATION, stated up front: this module can only SIMULATE that link.
 * Number Verification is a device-side OIDC flow — the check is bound to the
 * device's own mobile-data connection, so the operator authenticates through the
 * device (authorization-code flow in the device's context), not through a token a
 * back-end server holds. A stdio MCP server sitting next to the agent has no such
 * connection and CANNOT call the API on its own, no matter which credentials it
 * holds. Anything this file emits for that link is therefore explicitly labelled
 * SİMÜLASYON and says that no network query was made.
 *
 * Roadmap for the real integration: the approval leaves the server and reaches an
 * approver-side companion (mobile app or device-flow web page) over mobile data;
 * THAT client runs the CAMARA Number Verification OIDC flow and returns a signed
 * result, which this gate then verifies. Until that companion exists, only the
 * simulated channel below runs — and only where the code says so.
 *
 * Chain order is fixed and one-directional: SIM Swap first, Number Verification
 * second. A swapped SIM already refuses the action, so the second link never gets
 * the chance to soften that verdict; it can only add another reason to refuse.
 * The second link runs ONLY on the "high" tier (go-live and changes to a serving
 * campaign) — the demo narrative is "go-live gets the full chain".
 *
 * ── Halka 3: Device Reachability (GERÇEK sorgu yapılabilir) ───────────────────
 *
 * Sorduğu soru: "onaylayıcının hattı şu an ağdan erişilebilir durumda mı?".
 * CAMARA Device Status / Reachability uç noktası bunu sunucudan cevaplayabilir —
 * tek tanımlayıcı olarak telefon numarası yeter, cihaz-taraflı akış GEREKMEZ.
 * Bu yüzden NV'nin aksine burada gerçek SDK kanalı VARDIR; simülasyon kanalı
 * (ADSPILOT_REACH_SIMULATE) yalnızca token'sız demo içindir.
 *
 * DÜRÜST TAKAS — bilerek yazıyoruz: erişilebilirlik MEŞRU olarak dalgalanır
 * (uçak modu, kapsama boşluğu, kapalı telefon). Kapalı arıza ilkesi gereği
 * "erişilemez" yanıtı RET üretir; fikir başvurusundaki "kademeli doğrulama"nın
 * bu kapıdaki karşılığı budur, çünkü stdio MCP sunucusunun ikinci bir doğrulama
 * kanalı yoktur ve belirsizlikte harcama YAPILMAZ. Yanlış-pozitif riski iki
 * biçimde sınırlanır: (1) halka YALNIZ "high" katmanda koşar, (2) gerçek kanal
 * OPT-IN'dir — ADSPILOT_REACH_CHECK açıkça açılmadıkça, NaC token'ı olsa bile
 * sorgu yapılmaz ve iz "kapali" yazar. Böylece SIM-Swap için token tanımlayan
 * bir operatör, hiç istemediği bir erişilebilirlik retiyle karşılaşmaz.
 *
 * ── Halka 4: Location Verification (beklenen ülke) ────────────────────────────
 *
 * Sorduğu soru: "onaylayıcının hattı beklenen ülkenin DIŞINDA bir ülkede mi?".
 * Beklenti UYDURULMAZ: ADSPILOT_EXPECTED_COUNTRY (ISO 3166-1 alpha-2) tanımlı
 * değilse halka hiç koşmaz ve izine "kapali" yazar. "Bugünün değeri" tipi bir
 * varsayılan üretmek, cevabı her zaman "temiz" çıkaran sessiz bir güvenlik kaybı
 * olurdu.
 *
 * NEDEN ROAMING ÜLKESİ, NEDEN CAMARA Location Verification DEĞİL: SDK'nın
 * ürettiği `Area` tipi yalnızca `{ areaType: "CIRCLE" }` taşır — merkez koordinatı
 * ve yarıçap alanları tip tanımlarında HİÇ YOK. Sorgulanacak alanı tip güvenli
 * kuramadığımız için o uç nokta bilerek ERTELENDİ (`as any` ile şema uydurmak,
 * yanlış gövdeyle 400 alıp halkayı kalıcı RET'e çevirirdi). Ülke sorusunu tip
 * güvenli cevaplayan uç nokta Device Status / Roaming'dir: `roaming` boolean'ı
 * ve MCC'den eşlenen ISO-2 ülke listesi. Halkanın kapsamı bu yüzden "ülke
 * düzeyi"dir; şehir/yarıçap düzeyi coğrafya bu kapının BUGÜN vaadi değildir.
 *
 * HAM DEĞER YANKILANMAZ: operatörün bildirdiği ülke listesi (upstream veri)
 * ne kanıt satırına ne ret metnine ne de ize girer. Dışarı çıkan tek şey
 * TÜRETİLMİŞ karardır ("beklenen ülkede" / "beklenen ülke dışında") ve
 * yapılandırmadan gelen, doğrulanmış-normalize edilmiş beklenen ülke kodudur.
 *
 * ── Halka 5: Device Swap (SIM Swap'ın YAPISAL İKİZİ) ─────────────────────────
 *
 * Sorduğu soru: "hat son N saatte YENİ BİR CİHAZA mı taşındı?". SIM Swap kartın,
 * bu halka CİHAZIN değişimini görür: saldırgan kartı taşımadan hattı kendi
 * telefonuna aldıysa 1. halka temiz cevap verir, bu halka vermez.
 *
 * `deviceSwap.check` SIM Swap'ın ikizidir: aynı auth, aynı gövde şekli
 * ({ phoneNumber, maxAge }), saat bazlı pencere, tek boolean çıktı ({ swapped }).
 * Bu yüzden pencere hesabı aynı koddan (pencereSec) geçer ve aynı CAMARA aralığına
 * (1–2400 saat) kelepçelenir; ayrı bir pencere değişkeni UYDURULMAZ, halka
 * ADSPILOT_SIMSWAP_WINDOW_HOURS'u paylaşır.
 *
 * Tek DÜRÜST FARK: yanıt okunamazsa "değişmedi" varsayılmaz. Tipte `swapped`
 * zorunlu boolean'dır ama tip garantisi çalışma zamanı garantisi değildir; okunamayan
 * alan sessiz gevşeme değil, kapalı arızadır (halka 3'teki aynı gerekçe).
 *
 * ── Halka 6: Call Forwarding (koşulsuz çağrı yönlendirme) ────────────────────
 *
 * Sorduğu soru: "onaylayıcının hattında KOŞULSUZ çağrı yönlendirme açık mı?".
 * Açık yönlendirme, OTP/sesli doğrulamayı ele geçirmenin klasik yoludur: hat
 * sahibinde kalır, SIM değişmez, cihaz değişmez — ama doğrulama çağrısı saldırgana
 * gider. Önceki beş halkanın hiçbiri bu senaryoyu göremez.
 *
 * Yanıtta PII YOKTUR: uç nokta yalnız `active` boolean'ı döner — yönlendirmenin
 * HANGİ numaraya yapıldığı sorulmaz, alınmaz, hiçbir metne yazılmaz.
 *
 * İKİ KAPALI ARIZA TUZAĞI, tip tanımlarından okunarak baştan kapatıldı:
 *   (1) `active` tipte OPSİYONELDİR (`active?: boolean`). Okunamayan alan
 *       "yönlendirme yok" DEĞİL "bilinmiyor"dur ve RET üretir.
 *   (2) SDK belgesi kardeş uç nokta için "501 dönebilir" diyor; her fırlatma
 *       (NotImplementedError dahil) kapalı arızaya, yani RET'e gider.
 *
 * ── Halka sayısı ve GECİKME (her halka kendi anahtarını ister) ────────────────
 *
 * Zincir uzadıkça HIGH katmandaki her onay, koşan her gerçek halka için bir CAMARA
 * gidiş-dönüşü daha bekler (halka başına 10 sn timeout). Bu yüzden HİÇBİR halka
 * varsayılan olarak açılmaz: 3., 5. ve 6. halkaların gerçek kanalları AYRI AYRI
 * opt-in anahtarlar (ADSPILOT_REACH_CHECK / ADSPILOT_DEVICESWAP_CHECK /
 * ADSPILOT_CALLFWD_CHECK) ister, 4. halka beklenen ülke tanımını ister. Yalnızca
 * SIM-Swap için token tanımlayan bir operatör, ne istemediği gecikmeyi ne de
 * istemediği yanlış-pozitif retleri üstlenir; kapalı halka sorgu yapmaz ve izine
 * "kapali" yazar.
 *
 * ── Yapısal denetim izi (AgIz) ────────────────────────────────────────────────
 *
 * Her karar, metinlerinin yanında MAKİNE OKUNUR bir iz taşır: hangi halka koştu,
 * gerçek miydi simüle miydi, hangi pencereyle sorguldu, ret nedeni hangi sabit kod.
 * Aşağı akıştaki denetim günlüğü bunları ret/kanıt metnini koklayarak TAHMİN ETMEZ —
 * kapının kendi beyanını yazar. Metin koklamak iki halkanın metnini tek dizede
 * birleştirdiği için "SIM-Swap kapalı + NV simülasyon" ile "gerçek sorgu + NV
 * simülasyon" ayrımını kaybediyordu; iz o ayrımı taşıyan tek yapıdır.
 */

/** The single network capability this gate needs; the SDK client is adapted to it. */
export interface SimSwapKanali {
  /** True when the SIM changed within the last `maxAgeHours` hours. */
  verifySimSwap(maxAgeHours: number): Promise<boolean>;
}

/**
 * Halka 3'ün ihtiyacı: onaylayıcının cihazı şu an ağdan erişilebilir mi?
 *
 * `undefined` bilerek vardır ve "hayır" ile aynı şey DEĞİLDİR: CAMARA yanıtı gelip de
 * alan okunamadıysa (tip garantisine rağmen boş/başka tipte geldiyse) karar "erişilemez"
 * değil "yanıt okunamadı"dır — ikisi ayrı ret kodlarına gider, ikisi de kapalı arızadır.
 */
export interface ErisilebilirlikKanali {
  cihazErisilebilirMi(): Promise<boolean | undefined>;
}

/**
 * Halka 4'ün ihtiyacı: hattın şu an hangi ülkede olduğu.
 *
 * `yurtDisinda` CAMARA'nın roaming boolean'ı, `ulkeler` MCC'den eşlenen ISO-2 listesidir.
 * Her iki alan da opsiyoneldir çünkü SDK tipinde öyledir; okunamayan alan kapalı arızaya
 * gider (bkz. ErisilebilirlikKanali'ndeki aynı gerekçe).
 */
export interface KonumKanali {
  ulkeDurumu(): Promise<{ yurtDisinda?: boolean; ulkeler?: string[] }>;
}

/**
 * Halka 5'in ihtiyacı: hat son `maxAgeHours` saatte yeni bir cihaza taşındı mı?
 *
 * SimSwapKanali'nin ikizi ama dönüşü BİLEREK `boolean | undefined`: SDK tipinde
 * `swapped` zorunlu boolean olsa da okunamayan bir alanı "değişmedi" saymak sessiz
 * gevşeme olurdu (bkz. ErisilebilirlikKanali'ndeki aynı gerekçe).
 */
export interface CihazDegisimKanali {
  cihazDegistiMi(maxAgeHours: number): Promise<boolean | undefined>;
}

/**
 * Halka 6'nın ihtiyacı: hatta koşulsuz çağrı yönlendirme açık mı?
 *
 * `undefined` burada tipin KENDİSİNDEN gelir — CAMARA yanıtında `active` opsiyoneldir
 * ve "bilinmiyor" demektir; "kapalı" ile ASLA aynı şey değildir, ikisi ayrı ret
 * kodlarına gider.
 */
export interface CagriYonlendirmeKanali {
  kosulsuzYonlendirmeAcikMi(): Promise<boolean | undefined>;
}

export type AgRisk = "medium" | "high";

/**
 * SIM-Swap halkasının İZİ — ne olduğunu KARAR NOKTASI söyler, metin değil.
 *
 * "gercek"     : CAMARA sorgusu gerçekten yapıldı (ya da denendi ve yanıtsız kaldı).
 * "simulasyon" : simüle kanal karar verdi; hiçbir ağ sorgusu yapılmadı.
 * "kapali"     : katman BİLEREK devre dışı (token yok) — yapılandırma hatası değil.
 * "calismadi"  : yapılandırma hatası yüzünden sorgu HİÇ yapılamadı.
 */
export type SimSwapIzi = "gercek" | "simulasyon" | "kapali" | "calismadi";

/**
 * Number Verification halkasının izi. Gerçek CAMARA NV cihaz-taraflı OIDC ister
 * (bkz. dosya başı), bu yüzden "gercek" değeri BİLEREK yoktur: halka ya simüle
 * karar verir ya da yapılandırma hatasıyla hiç çalışamaz.
 */
export type NvIzi = "simulasyon" | "calismadi";

/**
 * Halka 3 (Reachability), 4 (Location), 5 (Device Swap) ve 6 (Call Forwarding) izi.
 * Değer kümesi SIM-Swap ile aynıdır çünkü dördünün de gerçek SDK kanalı VARDIR
 * (NV'nin aksine — bkz. dosya başı):
 *
 * "gercek"     : CAMARA sorgusu gerçekten yapıldı (ya da denendi ve yanıtsız kaldı).
 * "simulasyon" : simüle kanal karar verdi; hiçbir ağ sorgusu yapılmadı.
 * "kapali"     : halka BİLEREK koşmadı — reach için ADSPILOT_REACH_CHECK, devSwap için
 *                ADSPILOT_DEVICESWAP_CHECK, callFwd için ADSPILOT_CALLFWD_CHECK
 *                açılmamış; loc için ADSPILOT_EXPECTED_COUNTRY tanımsız. Yapılandırma hatası
 *                DEĞİLDİR (o "calismadi"dir) ve ret de üretmez; kapının "sormadım"
 *                beyanıdır — sessiz kalmak, denetimde "sordum ve geçti" ile karışırdı.
 * "calismadi"  : yapılandırma hatası yüzünden sorgu HİÇ yapılamadı (ret eşlik eder).
 *
 * Halka hiç YAPILANDIRILMAMIŞSA (ne simülasyon ne token) alan HİÇ YAZILMAZ: "kapali"
 * bilinçli bir kapatma beyanıdır, hiç istenmemiş bir halkanın sessizliği değil.
 */
export type HalkaIzi = "gercek" | "simulasyon" | "kapali" | "calismadi";

/**
 * Ret nedenleri SABİT sözlük. Upstream metin (SDK hata gövdesi, env değeri, CAMARA
 * yanıtı) bu kümeye ASLA giremez: denetim izi serbest metin taşımaz, kod taşır.
 */
export type RetNedeni =
  | "sim-degisti"
  | "nv-uyusmadi"
  | "cihaz-erisilemez"
  | "konum-beklenmedik"
  /** Halka 5: hat pencerede YENİ BİR CİHAZA taşınmış. "sim-degisti" ile karıştırılamaz. */
  | "cihaz-degisti"
  /** Halka 6: hatta koşulsuz çağrı yönlendirme AÇIK (OTP/sesli doğrulama ele geçirme yolu). */
  | "cagri-yonlendirme-acik"
  | "beklenen-ulke-gecersiz"
  | "ag-yanitsiz"
  | "yapilandirma-celiskili"
  | "simulasyon-degeri-tanimsiz"
  | "onaylayici-numarasi-yok"
  | "ag-ayari-kapiya-ulasmadi";

/**
 * YAPISAL DENETİM İZİ. Kararın nasıl oluştuğunu kapının KENDİSİ bildirir; aşağı akışta
 * hiç kimse (özellikle karar günlüğü) ret/kanıt metnini koklayarak bunu tahmin etmez.
 *
 * İki halka ASLA tek alana ezilmez: `simSwap` ve `nv` ayrı ayrı yazılır, çünkü
 * "gerçek SIM-Swap sorgusu + NV simülasyonu" ile "her ikisi de simülasyon" farklı
 * güven seviyeleridir ve denetim izinin tek işi bu ayrımı kanıtlamaktır.
 */
export interface AgIz {
  simSwap: SimSwapIzi;
  /** Halka hiç koşmadıysa (medium katman ya da ADSPILOT_NV_SIMULATE yok) alan YOKTUR. */
  nv?: NvIzi;
  /**
   * Halka 3 (Device Reachability). Medium katmanda ya da halka hiç yapılandırılmamışsa
   * alan YOKTUR; token varken ADSPILOT_REACH_CHECK kapalıysa "kapali" yazar.
   */
  reach?: HalkaIzi;
  /**
   * Halka 4 (Location / beklenen ülke). Medium katmanda ya da halka hiç
   * yapılandırılmamışsa alan YOKTUR; ADSPILOT_EXPECTED_COUNTRY tanımsızsa "kapali" yazar.
   */
  loc?: HalkaIzi;
  /**
   * Halka 5 (Device Swap). Medium katmanda ya da halka hiç yapılandırılmamışsa alan
   * YOKTUR; token varken ADSPILOT_DEVICESWAP_CHECK kapalıysa "kapali" yazar.
   */
  devSwap?: HalkaIzi;
  /**
   * Halka 6 (Call Forwarding). Medium katmanda ya da halka hiç yapılandırılmamışsa alan
   * YOKTUR; token varken ADSPILOT_CALLFWD_CHECK kapalıysa "kapali" yazar.
   */
  callFwd?: HalkaIzi;
  /** YALNIZ SIM-Swap halkasının geriye bakış penceresi (saat); sorgu yoksa yok. */
  pencereSaat?: number;
  /**
   * Halka 5'in KENDİ geriye bakış penceresi (saat).
   *
   * `pencereSaat`e YAZILMAZ, çünkü iki halka tek alana ezilmez: SIM-Swap katmanı
   * kapalıyken (token yok, simülasyon yok) `pencereSaat` boştur ve oraya cihaz-değişim
   * penceresini yazmak, denetçiye hiç yapılmamış bir SIM-Swap sorgusunun penceresi gibi
   * okunurdu. Değer aynı yapılandırmadan (ADSPILOT_SIMSWAP_WINDOW_HOURS) türese bile
   * hangi halkanın sorusuna ait olduğu ayrı durur.
   */
  devSwapPencereSaat?: number;
  /** maskele() çıktısı; numarayı gerçekten değerlendiren bir halka koştuysa vardır. */
  maskeliNumara?: string;
  retNedeni?: RetNedeni;
}

export interface AgKarar {
  /** Refusal text for the agent; undefined when the action may proceed. */
  engel?: string;
  /** Evidence lines appended to the human approval prompt. */
  kanit: string[];
  /** Kararın yapısal izi — HER dönüş noktası doldurur (bkz. AgIz). */
  iz: AgIz;
}

/** NV halkasının kendi sonucu; zincir birleşiminde AgIz'e katılır. */
interface NvSonuc {
  engel?: string;
  kanit: string[];
  nv: NvIzi;
  maskeliNumara?: string;
  retNedeni?: RetNedeni;
}

/**
 * Halka 3 ve 4'ün ortak sonuç şekli. Halkanın KENDİ iz değerini taşır; hangi AgIz
 * alanına yazılacağını zincir birleşimi bilir — böylece iki halka tek alana ezilemez.
 *
 * Halka hiç koşmadıysa katman fonksiyonu `undefined` döner (bu tip hiç üretilmez).
 */
interface HalkaSonuc {
  engel?: string;
  kanit: string[];
  halka: HalkaIzi;
  maskeliNumara?: string;
  retNedeni?: RetNedeni;
  /** Yalnız pencereli halka (5) doldurur; zincir birleşimi devSwapPencereSaat'e yazar. */
  pencereSaat?: number;
}

/** The subset of AdsPilotConfig this module reads (kept narrow for testability). */
export interface AgAyar {
  nacToken?: string;
  approverPhone?: string;
  simSwapWindowHours: number;
  /**
   * SİMÜLASYON kanalı (ADSPILOT_NAC_SIMULATE): "temiz" | "degisti". Tanımlıysa gerçek
   * SDK hiç kullanılmaz — jüri demoları NaC token'sız çalışır. Değer burada tip olarak
   * dar tutulmaz: doğrulama KARAR ANINDA yapılır ki bozuk bir env değeri sunucuyu
   * başlangıçta düşürmesin, sadece harcama kapısını kapalı arızaya götürsün.
   */
  nacSimulate?: string;
  /**
   * Number Verification SİMÜLASYON kanalı (ADSPILOT_NV_SIMULATE):
   * "dogrulandi" | "uyusmadi". Zincirin 2. halkası; YALNIZ simülasyon (gerçek CAMARA
   * NV cihaz-taraflı OIDC ister, sunucudan tek başına çağrılamaz — bkz. dosya başı).
   *
   * nacSimulate'ten BAĞIMSIZDIR: gerçek SIM-Swap token'ıyla da, kapalı SIM-Swap
   * katmanıyla da birleşebilir. Değer burada tip olarak dar tutulmaz; doğrulama
   * karar anında yapılır (aynı kapalı-arıza gerekçesi).
   */
  nvSimulate?: string;
  /**
   * Device Reachability SİMÜLASYON kanalı (ADSPILOT_REACH_SIMULATE):
   * "erisilebilir" | "anormal". Zincirin 3. halkası; tanımlıysa gerçek SDK'ya HİÇ
   * dokunulmaz. Değer burada tip olarak dar tutulmaz — doğrulama karar anında yapılır.
   */
  reachSimulate?: string;
  /**
   * Halka 3'ün GERÇEK kanalının açma/kapama anahtarı (ADSPILOT_REACH_CHECK).
   *
   * Bilerek OPT-IN: erişilebilirlik meşru olarak dalgalanır (uçak modu, kapsama), bu
   * yüzden yalnızca NaC token'ının varlığına bakıp sorguyu açmak, SIM-Swap için token
   * tanımlamış bir operatöre hiç istemediği yanlış-pozitif retleri dayatırdı. Kapalıyken
   * halka sorgu yapmaz ve izine "kapali" yazar (bkz. dosya başı, Halka 3).
   */
  reachCheck?: boolean;
  /**
   * Location SİMÜLASYON kanalı (ADSPILOT_LOC_SIMULATE): "beklenen" | "beklenmedik".
   * Zincirin 4. halkası; aynı kapalı-arıza gerekçesiyle değer karar anında doğrulanır.
   */
  locSimulate?: string;
  /**
   * Halka 4'ün beklentisi (ADSPILOT_EXPECTED_COUNTRY, ISO 3166-1 alpha-2).
   *
   * TANIMSIZSA HALKA KOŞMAZ ("kapali" izi): beklenen ülke UYDURULMAZ. Tanımlı ama iki
   * harfli kod değilse bu bir yapılandırma hatasıdır ve kapalı arızaya (RET) gider —
   * operatör halkayı istemiş ama anlaşılmayan bir değer vermiştir.
   */
  expectedCountry?: string;
  /**
   * Device Swap SİMÜLASYON kanalı (ADSPILOT_DEVICESWAP_SIMULATE):
   * "temiz" | "degisti". Zincirin 5. halkası; tanımlıysa gerçek SDK'ya HİÇ dokunulmaz.
   * Değer burada tip olarak dar tutulmaz — doğrulama karar anında yapılır.
   */
  devSwapSimulate?: string;
  /**
   * Halka 5'in GERÇEK kanalının açma/kapama anahtarı (ADSPILOT_DEVICESWAP_CHECK).
   *
   * Halka 3'le aynı gerekçeyle OPT-IN, artı GECİKME gerekçesi: HIGH katmandaki her onay,
   * koşan her gerçek halka için bir CAMARA gidiş-dönüşü daha bekler. Yalnızca token'ın
   * varlığına bakıp sorguyu açmak, SIM-Swap için token tanımlamış bir operatöre hiç
   * istemediği gecikmeyi (ve telefonunu yenileyen kullanıcıda yanlış-pozitif reti)
   * dayatırdı. Kapalıyken halka sorgu yapmaz ve izine "kapali" yazar.
   */
  devSwapCheck?: boolean;
  /**
   * Call Forwarding SİMÜLASYON kanalı (ADSPILOT_CALLFWD_SIMULATE):
   * "kapali" | "acik". Zincirin 6. halkası; aynı kapalı-arıza gerekçesiyle değer karar
   * anında doğrulanır.
   *
   * NOT: buradaki "kapali" YÖNLENDİRMENİN kapalı (yani temiz) olduğunu söyler; iz
   * alanındaki "kapali" (halka koşmadı) ile aynı kelime, ayrı sözlüktür.
   */
  callFwdSimulate?: string;
  /**
   * Halka 6'nın GERÇEK kanalının açma/kapama anahtarı (ADSPILOT_CALLFWD_CHECK).
   * Halka 5'le aynı gerekçe: hiçbir halka varsayılan olarak açılmaz — gecikme ve ret
   * riski operatörün AÇIK niyetini ister.
   */
  callFwdCheck?: boolean;
}

/**
 * Bir zincir halkasının AŞAĞI AKIŞTAKİ tüm bağlantı noktaları — tek satırda.
 *
 * `izAlani` ve `ayarAlanlari` DERLEYİCİ tarafından bağlanır (`keyof AgIz` /
 * `keyof AgAyar`): AgIz'de bir alan yeniden adlandırılırsa kayıt DERLENMEZ.
 * `gunlukAlani`, `retIsaretleri` ve `envler` başka dosyalara (kararGunlugu.ts,
 * bu dosyanın ret metinleri, config.ts) işaret ettiği için tipten bağlanamaz;
 * onları test/zincirButunlugu.test.ts çalışma anında doğrular.
 */
export interface ZincirHalkasi {
  /** Halkanın kısa kimliği (CAMARA sinyal adına yakın; yalnız kayıt/rapor içindir). */
  readonly id: string;
  /** Halkanın AgIz üzerindeki KENDİ alanı — iki halka tek alana ASLA ezilmez. */
  readonly izAlani: keyof AgIz;
  /** Halkanın KararKaydi (kararGunlugu.ts) üzerindeki KENDİ alanı. */
  readonly gunlukAlani: string;
  /**
   * Bu halkanın ret metninde GERÇEKTEN geçen ayırt edici ifadeler. Aşağı akıştaki
   * sınıflandırıcı (scripts/brain/uygulama.mjs · AG_KAPISI_IZLERI) bunlardan en az
   * birini tanımak ZORUNDADIR; tanımazsa ağ kapısının reti sıradan bir sunucu reddi
   * gibi görünür ve raporda "GÜVENLİK KAPISI ÇALIŞTI" bloğu hiç basılmaz.
   */
  readonly retIsaretleri: readonly string[];
  /** Halkanın KENDİ env adları — config.ts'te process.env ile GERÇEKTEN okunanlar. */
  readonly envler: readonly string[];
  /** Halkanın AgAyar alanları — http.ts'teki contextFor önbellek anahtarına girmek ZORUNDA. */
  readonly ayarAlanlari: readonly (keyof AgAyar)[];
}

/**
 * ZİNCİRİN TEK KAYNAĞI (six links, one registry).
 *
 * NEDEN VAR: bu depoda dört tur üst üste aynı hata sınıfı tekrarladı — kapıya yeni bir
 * halka eklendi, ama AŞAĞI AKIŞTAKİ tüketiciler (karar günlüğü alanları, http.ts'in
 * contextFor önbellek anahtarı, Growth Brain'in ret sınıflandırıcısı, env belgeleri)
 * güncellenmeden kaldı. Sonuç her seferinde SESSİZ oldu: günlük yalan söyledi, açılan
 * bir halka önbellekten kapalı sunuldu, ağ kapısının reti "sıradan sunucu reddi" gibi
 * göründü. Testi olan bağlantılar tuttu, testsiz olanlar kaçtı.
 *
 * Bu yüzden halkanın kimliği artık altı ayrı dosyaya dağılmış örtük bilgi değil, tek bir
 * kayıt: yeni halka BURAYA eklenir ve test/zincirButunlugu.test.ts her tüketiciyi bu
 * kayda karşı doğrular — eksik bağlantı derlemede ya da testte KIRMIZI olur, sessiz
 * kalamaz.
 *
 * DİKKAT: kayıt bir DAVRANIŞ anahtarı DEĞİLDİR. Kapı mantığı (agDogrula ve halka
 * katmanları) bu diziyi okumaz; sıra, opt-in kuralları ve fail-closed yolları eskisi
 * gibi kodun kendisindedir. Buraya bir satır eklemek bir halkayı ÇALIŞTIRMAZ; yalnız
 * mevcut halkanın aşağı akıştaki borçlarını beyan eder.
 */
export const ZINCIR_HALKALARI: readonly ZincirHalkasi[] = [
  {
    id: "simSwap",
    izAlani: "simSwap",
    gunlukAlani: "simSwapKanali",
    retIsaretleri: ["AĞ DOĞRULAMASI BAŞARISIZ", "GSMA Open Gateway SIM Swap"],
    envler: ["ADSPILOT_NAC_TOKEN", "ADSPILOT_NAC_SIMULATE"],
    ayarAlanlari: ["nacToken", "nacSimulate"],
  },
  {
    id: "numberVerification",
    izAlani: "nv",
    gunlukAlani: "nvKanali",
    retIsaretleri: ["NUMARA DOĞRULAMASI BAŞARISIZ", "numara doğrulaması aktif"],
    // YALNIZ simülasyon: gerçek CAMARA NV cihaz-taraflı OIDC ister (bkz. dosya başı),
    // bu yüzden halkanın bir token/opt-in env'i YOKTUR.
    envler: ["ADSPILOT_NV_SIMULATE"],
    ayarAlanlari: ["nvSimulate"],
  },
  {
    id: "deviceStatusReachability",
    izAlani: "reach",
    gunlukAlani: "reachKanali",
    retIsaretleri: [
      "CİHAZ ERİŞİLEBİLİRLİĞİ ANORMAL",
      "GSMA Open Gateway Device Reachability Status",
      "cihaz erişilebilirlik kontrolünden",
    ],
    envler: ["ADSPILOT_REACH_SIMULATE", "ADSPILOT_REACH_CHECK"],
    ayarAlanlari: ["reachSimulate", "reachCheck"],
  },
  {
    id: "deviceStatusRoaming",
    izAlani: "loc",
    gunlukAlani: "locKanali",
    retIsaretleri: [
      "KONUM BEKLENMEDİK",
      "GSMA Open Gateway Device Roaming Status",
      "konum kontrolünden",
    ],
    envler: ["ADSPILOT_LOC_SIMULATE", "ADSPILOT_EXPECTED_COUNTRY"],
    ayarAlanlari: ["locSimulate", "expectedCountry"],
  },
  {
    id: "deviceSwap",
    izAlani: "devSwap",
    gunlukAlani: "devSwapKanali",
    retIsaretleri: [
      "CİHAZ DEĞİŞİMİ SAPTANDI",
      "GSMA Open Gateway Device Swap",
      "cihaz değişimi kontrolünden",
    ],
    envler: ["ADSPILOT_DEVICESWAP_SIMULATE", "ADSPILOT_DEVICESWAP_CHECK"],
    ayarAlanlari: ["devSwapSimulate", "devSwapCheck"],
  },
  {
    id: "callForwardingSignal",
    izAlani: "callFwd",
    gunlukAlani: "callFwdKanali",
    retIsaretleri: [
      "ÇAĞRI YÖNLENDİRME AÇIK",
      "GSMA Open Gateway Call Forwarding Signal",
      "çağrı yönlendirme kontrolünden",
    ],
    envler: ["ADSPILOT_CALLFWD_SIMULATE", "ADSPILOT_CALLFWD_CHECK"],
    ayarAlanlari: ["callFwdSimulate", "callFwdCheck"],
  },
] as const;

/**
 * Halkaya DEĞİL, zincirin tamamına ait ayarlar. Ayrı durmalarının sebebi kayıt hijyeni:
 * bunları herhangi bir halkanın altına yazmak, o halkanın "kendi" env'iymiş gibi
 * okunmasına ve halka kaldırıldığında zincir genelindeki bir ayarın onunla birlikte
 * silinmesine yol açardı.
 *
 * `simSwapWindowHours` bilerek burada: pencereyi 1. VE 5. halka paylaşır (ama izde ayrı
 * alanlara yazar — bkz. AgIz.devSwapPencereSaat).
 */
export const ZINCIR_ORTAK_AYARLARI: readonly (keyof AgAyar)[] = [
  "approverPhone",
  "simSwapWindowHours",
] as const;

/** ZINCIR_ORTAK_AYARLARI'nın env karşılıkları (config.ts'te okunan adlar). */
export const ZINCIR_ORTAK_ENVLERI: readonly string[] = [
  "ADSPILOT_APPROVER_PHONE",
  "ADSPILOT_SIMSWAP_WINDOW_HOURS",
] as const;

const MEDIUM_WINDOW_HOURS = 24;

/**
 * Test seam. Production builds the channel from the Nokia SDK; tests inject a fake so
 * the refusal paths can be exercised (and mutation-tested) without network access.
 */
let kanalOverride: SimSwapKanali | "reset" | undefined;
export function __setSimSwapKanalForTests(k: SimSwapKanali | undefined): void {
  kanalOverride = k ?? "reset";
  gercekKanal = undefined;
  gercekKanalAnahtari = undefined;
}

let gercekKanal: SimSwapKanali | undefined;
let gercekKanalAnahtari: string | undefined;

/**
 * The SDK is imported lazily: deployments without a NaC token never load it, and a
 * broken optional dependency cannot take down the stdio server at startup.
 *
 * The cached channel is keyed on token + phone. An unkeyed singleton would bake the
 * FIRST caller's phone number into the closure forever, so rotating the approver
 * number (or any future per-tenant config) would silently keep verifying the old SIM.
 */
async function kanalGetir(ayar: AgAyar): Promise<SimSwapKanali> {
  if (kanalOverride && kanalOverride !== "reset") return kanalOverride;
  const anahtar = `${ayar.nacToken}\u0000${ayar.approverPhone}`;
  if (gercekKanal && gercekKanalAnahtari === anahtar) return gercekKanal;
  const { NetworkAsCodeApiClient } = await import("network-as-code");
  const client = new NetworkAsCodeApiClient({ apiKey: ayar.nacToken! });
  const phoneNumber = ayar.approverPhone!;
  gercekKanal = {
    verifySimSwap: async (maxAgeHours: number) => {
      // CAMARA sim-swap check: maxAge is in hours (1–2400). Bounded tightly: the SDK's
      // defaults (60s timeout × 3 attempts) would stall an approval for ~3 minutes when
      // the NaC endpoint is unreachable — fail closed FAST instead.
      const res = await client.simSwap.check(
        { phoneNumber, maxAge: maxAgeHours },
        { timeoutInSeconds: 10, maxRetries: 1 }
      );
      return res.swapped === true;
    },
  };
  gercekKanalAnahtari = anahtar;
  return gercekKanal;
}

/* ── Halka 3: gerçek kanal (Device Reachability) ──────────────────────────────── */

let erisimOverride: ErisilebilirlikKanali | "reset" | undefined;
export function __setErisimKanalForTests(k: ErisilebilirlikKanali | undefined): void {
  erisimOverride = k ?? "reset";
  gercekErisimKanal = undefined;
  gercekErisimAnahtari = undefined;
}

let gercekErisimKanal: ErisilebilirlikKanali | undefined;
let gercekErisimAnahtari: string | undefined;

/**
 * SIM-Swap kanalıyla BİREBİR aynı iskelet: tembel import (token'sız kurulumlar SDK'yı hiç
 * yüklemez), token+telefon ile anahtarlanmış önbellek (anahtarsız tekil, İLK çağıranın
 * numarasını kapanışa gömer ve numara döndürüldüğünde sessizce eski hattı sorgular),
 * 10 sn timeout / 1 retry (SDK varsayılanı 60 sn × 3 deneme; bir onayı ~3 dakika
 * askıda bırakır — kapalı arızaya HIZLI gitmek gerekir).
 */
async function erisimKanaliGetir(ayar: AgAyar): Promise<ErisilebilirlikKanali> {
  if (erisimOverride && erisimOverride !== "reset") return erisimOverride;
  const anahtar = `${ayar.nacToken}\u0000${ayar.approverPhone}`;
  if (gercekErisimKanal && gercekErisimAnahtari === anahtar) return gercekErisimKanal;
  const { NetworkAsCodeApiClient } = await import("network-as-code");
  const client = new NetworkAsCodeApiClient({ apiKey: ayar.nacToken! });
  const phoneNumber = ayar.approverPhone!;
  gercekErisimKanal = {
    cihazErisilebilirMi: async () => {
      const res = await client.deviceStatus.retrieveReachabilityStatus(
        { device: { phoneNumber } },
        { timeoutInSeconds: 10, maxRetries: 1 }
      );
      /**
       * `reachable` SDK tipinde zorunlu boolean, ama tip garantisi bir ÇALIŞMA ZAMANI
       * garantisi değildir: gövde beklenenden başka gelirse "erişilemez" varsaymak da
       * "erişilebilir" varsaymak da yanlış olur. undefined = "yanıt okunamadı".
       */
      return typeof res.reachable === "boolean" ? res.reachable : undefined;
    },
  };
  gercekErisimAnahtari = anahtar;
  return gercekErisimKanal;
}

/* ── Halka 4: gerçek kanal (Location — roaming ülkesi) ────────────────────────── */

let konumOverride: KonumKanali | "reset" | undefined;
export function __setKonumKanalForTests(k: KonumKanali | undefined): void {
  konumOverride = k ?? "reset";
  gercekKonumKanal = undefined;
  gercekKonumAnahtari = undefined;
}

let gercekKonumKanal: KonumKanali | undefined;
let gercekKonumAnahtari: string | undefined;

/** Halka 3'ün kanalıyla aynı sözleşme; yalnız sorulan uç nokta farklı. */
async function konumKanaliGetir(ayar: AgAyar): Promise<KonumKanali> {
  if (konumOverride && konumOverride !== "reset") return konumOverride;
  const anahtar = `${ayar.nacToken}\u0000${ayar.approverPhone}`;
  if (gercekKonumKanal && gercekKonumAnahtari === anahtar) return gercekKonumKanal;
  const { NetworkAsCodeApiClient } = await import("network-as-code");
  const client = new NetworkAsCodeApiClient({ apiKey: ayar.nacToken! });
  const phoneNumber = ayar.approverPhone!;
  gercekKonumKanal = {
    ulkeDurumu: async () => {
      const res = await client.deviceStatus.checkRoaming(
        { device: { phoneNumber } },
        { timeoutInSeconds: 10, maxRetries: 1 }
      );
      return {
        yurtDisinda: typeof res.roaming === "boolean" ? res.roaming : undefined,
        // Ham liste BURADAN ÖTEYE GEÇMEZ: karar mantığı onu yalnız karşılaştırmada
        // kullanır, hiçbir metne ve ize yazmaz (bkz. dosya başı, Halka 4).
        ulkeler: Array.isArray(res.countryName) ? res.countryName : undefined,
      };
    },
  };
  gercekKonumAnahtari = anahtar;
  return gercekKonumKanal;
}

/* ── Halka 5: gerçek kanal (Device Swap) ──────────────────────────────────────── */

let cihazDegisimOverride: CihazDegisimKanali | "reset" | undefined;
export function __setCihazDegisimKanalForTests(k: CihazDegisimKanali | undefined): void {
  cihazDegisimOverride = k ?? "reset";
  gercekCihazDegisimKanal = undefined;
  gercekCihazDegisimAnahtari = undefined;
}

let gercekCihazDegisimKanal: CihazDegisimKanali | undefined;
let gercekCihazDegisimAnahtari: string | undefined;

/**
 * SIM-Swap kanalıyla BİREBİR aynı iskelet ve aynı gerekçeler: tembel import,
 * token+telefon ile anahtarlanmış önbellek, 10 sn timeout / 1 retry (SDK varsayılanı
 * 60 sn × 3 deneme bir onayı ~3 dakika askıda bırakır).
 *
 * Uç nokta gerçekten ikiz: `deviceSwap.check({ phoneNumber, maxAge })` → `{ swapped }`.
 */
async function cihazDegisimKanaliGetir(ayar: AgAyar): Promise<CihazDegisimKanali> {
  if (cihazDegisimOverride && cihazDegisimOverride !== "reset") return cihazDegisimOverride;
  const anahtar = `${ayar.nacToken}\u0000${ayar.approverPhone}`;
  if (gercekCihazDegisimKanal && gercekCihazDegisimAnahtari === anahtar) return gercekCihazDegisimKanal;
  const { NetworkAsCodeApiClient } = await import("network-as-code");
  const client = new NetworkAsCodeApiClient({ apiKey: ayar.nacToken! });
  const phoneNumber = ayar.approverPhone!;
  gercekCihazDegisimKanal = {
    cihazDegistiMi: async (maxAgeHours: number) => {
      const res = await client.deviceSwap.check(
        { phoneNumber, maxAge: maxAgeHours },
        { timeoutInSeconds: 10, maxRetries: 1 }
      );
      /**
       * `swapped` SDK tipinde zorunlu boolean, ama tip garantisi ÇALIŞMA ZAMANI garantisi
       * değildir. Burada SIM-Swap kanalındaki `=== true` kısayolu BİLEREK kullanılmaz:
       * o kısayol okunamayan bir gövdeyi sessizce "değişmedi"ye çevirirdi ve halkanın
       * tek işi olan reti yutardı. undefined = "yanıt okunamadı" → kapalı arıza.
       */
      return typeof res.swapped === "boolean" ? res.swapped : undefined;
    },
  };
  gercekCihazDegisimAnahtari = anahtar;
  return gercekCihazDegisimKanal;
}

/* ── Halka 6: gerçek kanal (Call Forwarding) ──────────────────────────────────── */

let cagriYonlendirmeOverride: CagriYonlendirmeKanali | "reset" | undefined;
export function __setCagriYonlendirmeKanalForTests(k: CagriYonlendirmeKanali | undefined): void {
  cagriYonlendirmeOverride = k ?? "reset";
  gercekCagriYonlendirmeKanal = undefined;
  gercekCagriYonlendirmeAnahtari = undefined;
}

let gercekCagriYonlendirmeKanal: CagriYonlendirmeKanali | undefined;
let gercekCagriYonlendirmeAnahtari: string | undefined;

/**
 * Diğer halkalarla aynı sözleşme; yalnız sorulan uç nokta farklı.
 *
 * BİLEREK `retrieveUnconditionalCallForwarding` çağrılır, kardeşi
 * `retrieveCallForwarding` DEĞİL: kardeş uç nokta bir dizi döner, SDK belgesi onun için
 * "ana kapsamı aşar, 501 dönebilir" diyor ve dizinin tanınmayan bir üyesi yeni bir
 * kapalı-arıza yolu açardı. Sorduğumuz soru zaten tek boolean'lık: koşulsuz yönlendirme
 * açık mı? Yönlendirmenin HANGİ numaraya yapıldığı ne sorulur ne alınır (PII yok).
 */
async function cagriYonlendirmeKanaliGetir(ayar: AgAyar): Promise<CagriYonlendirmeKanali> {
  if (cagriYonlendirmeOverride && cagriYonlendirmeOverride !== "reset") return cagriYonlendirmeOverride;
  const anahtar = `${ayar.nacToken}\u0000${ayar.approverPhone}`;
  if (gercekCagriYonlendirmeKanal && gercekCagriYonlendirmeAnahtari === anahtar) {
    return gercekCagriYonlendirmeKanal;
  }
  const { NetworkAsCodeApiClient } = await import("network-as-code");
  const client = new NetworkAsCodeApiClient({ apiKey: ayar.nacToken! });
  const phoneNumber = ayar.approverPhone!;
  gercekCagriYonlendirmeKanal = {
    kosulsuzYonlendirmeAcikMi: async () => {
      const res = await client.callForwardingSignal.retrieveUnconditionalCallForwarding(
        { phoneNumber },
        { timeoutInSeconds: 10, maxRetries: 1 }
      );
      // `active` tipte OPSİYONEL: yokluğu "yönlendirme kapalı" değil "bilinmiyor"dur.
      return typeof res.active === "boolean" ? res.active : undefined;
    },
  };
  gercekCagriYonlendirmeAnahtari = anahtar;
  return gercekCagriYonlendirmeKanal;
}

/**
 * Beklenen ülkeyi normalize eder: yalnız ISO 3166-1 alpha-2 (iki harf) kabul edilir.
 * `undefined` = değer kullanılamaz; çağıran bunu kapalı arızaya çevirir. Ham değer
 * hiçbir yere yazılmaz, yalnız normalize edilmiş kod dışarı çıkabilir.
 */
function ulkeNormalize(ham: string | undefined): string | undefined {
  const t = ham?.trim();
  return t && /^[A-Za-z]{2}$/.test(t) ? t.toUpperCase() : undefined;
}

/**
 * Masks all but the edges of the approver number, so prompts never leak it in full.
 * The guard covers up to 6 characters: at 5–6 the head and tail slices would overlap
 * and reveal every digit.
 */
function maskele(phone: string): string {
  return phone.length <= 6 ? "***" : phone.slice(0, 4) + "*".repeat(phone.length - 6) + phone.slice(-2);
}

/**
 * CAMARA accepts maxAge of 1–2400 hours. Out-of-range or malformed configuration must
 * not become a permanent opaque refusal (a 5000h window would 400 on every approval),
 * nor a silent near-zero window (0.01h would wave a 2-hour-old swap through) — clamp
 * to the API's own range and fall back to the 72h default when the value is unusable.
 */
function pencereNormalize(ham: number | undefined): number {
  if (!Number.isFinite(ham as number) || (ham as number) < 1) return 72;
  return Math.min(2400, Math.round(ham as number));
}

/** Risk tier → lookback window: "medium" tightens to 24h, "high" uses the configured window. */
function pencereSec(ayar: AgAyar, risk: AgRisk): number {
  const yapilandirilan = pencereNormalize(ayar.simSwapWindowHours);
  return risk === "medium" ? Math.min(MEDIUM_WINDOW_HOURS, yapilandirilan) : yapilandirilan;
}

/**
 * SİMÜLASYON kanalı: jüri/demo ortamı NaC token'sız çalışsın diye. Gerçek SDK'ya HİÇ
 * dokunulmaz (import bile edilmez).
 *
 * Ürettiği HER metin — kanıt satırı, ret mesajı, stderr uyarısı — açıkça "SİMÜLASYON"
 * ibaresi taşır ve gerçek ağ sorgusu yapılmadığını söyler; çıktı hiçbir zaman gerçek
 * ağ doğrulaması gibi sunulamaz.
 *
 * Fail-closed sözleşmesi aynen geçerlidir: onaylayıcı numarası simülasyonda da zorunlu
 * (maskeleme yolları gerçek akışla birebir), tanınmayan simülasyon değeri karar anında
 * Türkçe hatayla RET. Pencere hesabı (medium 24s / high yapılandırılan) gerçek akışla
 * aynı koddan geçer, böylece demo metinleri gerçek katman davranışını gösterir.
 */
function simDogrula(ayar: AgAyar, risk: AgRisk, sim: string): AgKarar {
  if (ayar.nacToken) {
    /**
     * Çelişkili yapılandırma: gerçek token VE simülasyon birlikte. Fail-closed ilkesi
     * gereği belirsizlikte gevşek kanal SEÇİLMEZ — reddedilir. (Uyarı-verip-devam
     * modeli, demodan kalan bir env kalıntısının gerçek ağ doğrulamasını sessizce
     * tiyatroya çevirmesine izin veriyordu.)
     */
    return {
      engel:
        "Reddedildi [SİMÜLASYON]: ADSPILOT_NAC_TOKEN ve ADSPILOT_NAC_SIMULATE birlikte tanımlı — " +
        "çelişkili yapılandırma. Gerçek ağ doğrulaması isteniyorsa ADSPILOT_NAC_SIMULATE kaldırılmalı, " +
        "demo isteniyorsa token kaldırılmalı. Güvenlik gereği belirsiz yapılandırmada harcama artışı uygulanmaz.",
      kanit: [],
      // Hiçbir kanal sorgulanmadı: yapılandırma çeliştiği için karar hiç verilemedi.
      iz: { simSwap: "calismadi", retNedeni: "yapilandirma-celiskili" },
    };
  }
  if (sim !== "temiz" && sim !== "degisti") {
    return {
      engel:
        `Reddedildi [SİMÜLASYON]: ADSPILOT_NAC_SIMULATE değeri tanınmadı (değer, sır ihtimaline karşı burada gösterilmez) — geçerli değerler ` +
        `"temiz" | "degisti". Güvenlik gereği anlaşılamayan yapılandırmada harcama artışı uygulanmaz ` +
        `(kapalı arıza).`,
      kanit: [],
      iz: { simSwap: "calismadi", retNedeni: "simulasyon-degeri-tanimsiz" },
    };
  }
  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi [SİMÜLASYON]: simülasyon kanalı aktif ama ADSPILOT_APPROVER_PHONE boş. " +
        "Onaylayıcının numarası simülasyonda da zorunludur; güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      iz: { simSwap: "calismadi", retNedeni: "onaylayici-numarasi-yok" },
    };
  }
  const pencere = pencereSec(ayar, risk);
  const maskeli = maskele(ayar.approverPhone);
  if (sim === "degisti") {
    return {
      engel:
        `Reddedildi [SİMÜLASYON]: AĞ DOĞRULAMASI BAŞARISIZ (SİMÜLE) — onaylayıcının ` +
        `(${maskeli}) SIM kartı son ${pencere} saat içinde değişmiş SAYILDI ` +
        `(ADSPILOT_NAC_SIMULATE=degisti; gerçek ağ sorgusu YAPILMADI). Gerçek akışta bu, hesap ele ` +
        `geçirme saldırılarının tipik işaretidir; onay istemi hiç gösterilmedi ve harcama artışı ` +
        `uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON olduğunu MUTLAKA bildir.`,
      kanit: [],
      iz: { simSwap: "simulasyon", pencereSaat: pencere, maskeliNumara: maskeli, retNedeni: "sim-degisti" },
    };
  }
  return {
    kanit: [
      `Ağ doğrulaması [SİMÜLASYON]: SIM değişimi yok (son ${pencere} saat, ` +
        `${maskeli}) — simüle kanal (ADSPILOT_NAC_SIMULATE=temiz), ` +
        `gerçek ağ sorgusu YAPILMADI`,
    ],
    iz: { simSwap: "simulasyon", pencereSaat: pencere, maskeliNumara: maskeli },
  };
}

/**
 * Zincirin 2. halkası: Number Verification — YALNIZ SİMÜLASYON.
 *
 * Ne zaman koşar: SADECE "high" katmanda ve SADECE ADSPILOT_NV_SIMULATE tanımlıysa.
 * Koşmadığında `undefined` döner (kanıt satırı bile üretmez) — medium katmanda halka
 * hiç yoktur, dolayısıyla değeri de doğrulanmaz; bu bir gevşeme değildir, çünkü o
 * katmanda halkanın verebileceği tek karar zaten yoktur.
 *
 * Kapalı arıza sözleşmesi SIM-Swap halkasıyla aynıdır: onaylayıcı numarası zorunlu,
 * tanınmayan değer karar anında RET (ham değer, sır olabileceği için metne
 * YANKILANMAZ). Ürettiği her metin "SİMÜLASYON" ibaresi taşır ve gerçek sorgu
 * yapılmadığını açıkça söyler.
 */
function nvKatmani(ayar: AgAyar, risk: AgRisk): NvSonuc | undefined {
  const nv = ayar.nvSimulate?.trim();
  if (!nv || risk !== "high") return undefined;

  if (nv !== "dogrulandi" && nv !== "uyusmadi") {
    return {
      engel:
        `Reddedildi [SİMÜLASYON]: ADSPILOT_NV_SIMULATE değeri tanınmadı (değer, sır ihtimaline karşı ` +
        `burada gösterilmez) — geçerli değerler "dogrulandi" | "uyusmadi". Güvenlik gereği ` +
        `anlaşılamayan yapılandırmada harcama artışı uygulanmaz (kapalı arıza).`,
      kanit: [],
      nv: "calismadi",
      retNedeni: "simulasyon-degeri-tanimsiz",
    };
  }
  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi [SİMÜLASYON]: numara doğrulaması aktif ama ADSPILOT_APPROVER_PHONE boş. " +
        "Doğrulanacak numara olmadan bu halka çalışamaz; güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      nv: "calismadi",
      retNedeni: "onaylayici-numarasi-yok",
    };
  }
  const maskeli = maskele(ayar.approverPhone);
  if (nv === "uyusmadi") {
    return {
      engel:
        `Reddedildi [SİMÜLASYON]: NUMARA DOĞRULAMASI BAŞARISIZ (SİMÜLE) — onay isteği sahibin ` +
        `gerçek cihazından gelmiyor SAYILDI (${maskeli}; ` +
        `ADSPILOT_NV_SIMULATE=uyusmadi, gerçek ağ sorgusu YAPILMADI). Gerçek akışta bu, onayı ` +
        `cevaplayanın hattın sahibi olmadığı anlamına gelir — SIM Swap kontrolü temiz olsa bile ` +
        `onay istemi gösterilmez ve harcama artışı uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON ` +
        `olduğunu MUTLAKA bildir.`,
      kanit: [],
      nv: "simulasyon",
      maskeliNumara: maskeli,
      retNedeni: "nv-uyusmadi",
    };
  }
  return {
    kanit: [
      `Numara doğrulaması [SİMÜLASYON]: onay isteği hat sahibinin cihazından geliyor SAYILDI ` +
        `(${maskeli}) — simüle kanal (ADSPILOT_NV_SIMULATE=dogrulandi), ` +
        `gerçek CAMARA Number Verification sorgusu YAPILMADI (cihaz-taraflı OIDC gerektirir)`,
    ],
    nv: "simulasyon",
    maskeliNumara: maskeli,
  };
}

/**
 * Zincirin 3. halkası: Device Reachability.
 *
 * Ne zaman koşar: SADECE "high" katmanda ve SADECE bir kanal yapılandırılmışsa
 * (ADSPILOT_REACH_SIMULATE ya da NaC token'ı). Hiç yapılandırılmamışsa `undefined`
 * döner — iz alanı bile yazılmaz, çünkü "kapali" bilinçli bir kapatma beyanıdır,
 * hiç istenmemiş bir halkanın sessizliği değil.
 *
 * Fail-closed sözleşmesi diğer halkalarla aynıdır: onaylayıcı numarası zorunlu,
 * tanınmayan simülasyon değeri RET (ham değer YANKILANMAZ), yanıtsız/okunamayan
 * CAMARA cevabı RET, "erişilemez" RET.
 */
async function erisilebilirlikKatmani(ayar: AgAyar, risk: AgRisk): Promise<HalkaSonuc | undefined> {
  if (risk !== "high") return undefined;
  const sim = ayar.reachSimulate?.trim();
  const gercekAcik = Boolean(ayar.nacToken && ayar.reachCheck);
  if (!sim && !ayar.nacToken) return undefined;

  if (sim) {
    /**
     * Çelişki ölçütü bilerek "token var mı" DEĞİL, "gerçek kanal AÇIK mı"dır: halka
     * opt-in olduğu için ADSPILOT_REACH_CHECK kapalıyken sorgulanacak gerçek bir kanal
     * yoktur, dolayısıyla simülasyon hiçbir gerçek doğrulamayı tiyatroya çevirmez.
     * Gerçek kanal açıkken ikisi birden tanımlıysa belirsizlikte gevşek kanal SEÇİLMEZ.
     */
    if (gercekAcik) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: ADSPILOT_REACH_CHECK açık (gerçek erişilebilirlik sorgusu) ve " +
          "ADSPILOT_REACH_SIMULATE birlikte tanımlı — çelişkili yapılandırma. Gerçek sorgu isteniyorsa " +
          "simülasyon kaldırılmalı, demo isteniyorsa ADSPILOT_REACH_CHECK kapatılmalı. Güvenlik gereği " +
          "belirsiz yapılandırmada harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "yapilandirma-celiskili",
      };
    }
    if (sim !== "erisilebilir" && sim !== "anormal") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: ADSPILOT_REACH_SIMULATE değeri tanınmadı (değer, sır ihtimaline ` +
          `karşı burada gösterilmez) — geçerli değerler "erisilebilir" | "anormal". Güvenlik gereği ` +
          `anlaşılamayan yapılandırmada harcama artışı uygulanmaz (kapalı arıza).`,
        kanit: [],
        halka: "calismadi",
        retNedeni: "simulasyon-degeri-tanimsiz",
      };
    }
    if (!ayar.approverPhone) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: cihaz erişilebilirliği kontrolü aktif ama ADSPILOT_APPROVER_PHONE boş. " +
          "Sorgulanacak numara olmadan bu halka çalışamaz; güvenlik gereği harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "onaylayici-numarasi-yok",
      };
    }
    const maskeli = maskele(ayar.approverPhone);
    if (sim === "anormal") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: CİHAZ ERİŞİLEBİLİRLİĞİ ANORMAL (SİMÜLE) — onaylayıcının ` +
          `(${maskeli}) cihazı ağdan erişilemez SAYILDI (ADSPILOT_REACH_SIMULATE=anormal; gerçek ağ ` +
          `sorgusu YAPILMADI). Gerçek akışta bu, onayı cevaplayan tarafın hattıyla ulaşılamadığı ` +
          `anlamına gelir; kademeli doğrulama mümkün olmadığı için onay istemi gösterilmez ve harcama ` +
          `artışı uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON olduğunu MUTLAKA bildir.`,
        kanit: [],
        halka: "simulasyon",
        maskeliNumara: maskeli,
        retNedeni: "cihaz-erisilemez",
      };
    }
    return {
      kanit: [
        `Cihaz erişilebilirliği [SİMÜLASYON]: onaylayıcının hattı ağdan erişilebilir SAYILDI ` +
          `(${maskeli}) — simüle kanal (ADSPILOT_REACH_SIMULATE=erisilebilir), gerçek ağ sorgusu YAPILMADI`,
      ],
      halka: "simulasyon",
      maskeliNumara: maskeli,
    };
  }

  /**
   * Token var ama halka açılmamış: BİLEREK sorgu yapılmaz. Ret de üretilmez, kanıt
   * satırı da yazılmaz — insan istemine "kontrol etmediğim şey" satırı koymak gürültü
   * olurdu. Beyan yalnız yapısal ize düşer (bkz. HalkaIzi, "kapali").
   */
  if (!gercekAcik) return { kanit: [], halka: "kapali" };

  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi: cihaz erişilebilirliği kontrolü açık (ADSPILOT_REACH_CHECK) ama " +
        "ADSPILOT_APPROVER_PHONE boş. Onaylayıcının numarası olmadan ağ kontrolü yapılamaz; " +
        "güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      halka: "calismadi",
      retNedeni: "onaylayici-numarasi-yok",
    };
  }
  const maskeli = maskele(ayar.approverPhone);
  try {
    const kanal = await erisimKanaliGetir(ayar);
    const erisilebilir = await kanal.cihazErisilebilirMi();
    if (erisilebilir === true) {
      return {
        kanit: [
          `Cihaz erişilebilirliği: onaylayıcının hattı ağdan erişilebilir durumda (${maskeli}) — ` +
            `GSMA Open Gateway Device Reachability Status`,
        ],
        halka: "gercek",
        maskeliNumara: maskeli,
      };
    }
    if (erisilebilir === false) {
      return {
        engel:
          `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (${maskeli}) cihazı şu an ağdan ` +
          `ERİŞİLEMİYOR (GSMA Open Gateway Device Reachability Status). Onayı cevaplayan tarafa hattı ` +
          `üzerinden ulaşılamadığı için kademeli doğrulama yapılamaz; onay istemi hiç gösterilmedi ve ` +
          `harcama artışı uygulanmaz. Cihaz ağa döndüğünde tekrar dene.`,
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "cihaz-erisilemez",
      };
    }
    /**
     * Yanıt geldi ama okunamadı. "Erişilemez" demek yanlış suçlama, "erişilebilir"
     * demek sessiz gevşeme olurdu; ikisi de değil — kontrol cevaplanamadı.
     */
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — cihaz erişilebilirlik kontrolünden okunabilir " +
        "yanıt alınamadı. Güvenlik gereği cevaplanamayan kontrolde harcama artışı uygulanmaz; " +
        "daha sonra tekrar dene.",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
    };
  } catch (e: any) {
    // Upstream metin ASLA ret mesajına girmez; ayrıntı numara maskelenerek stderr'e.
    const detay = String(e?.message ?? e).split(ayar.approverPhone).join(maskeli);
    console.error(`[adspilot] cihaz erişilebilirlik hatası (${maskeli}): ${detay}`);
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — cihaz erişilebilirlik kontrolünden yanıt " +
        "alınamadı. Güvenlik gereği yanıtsız kontrolde harcama artışı uygulanmaz; daha sonra tekrar " +
        "dene. Sorun sürerse operatör sunucu günlüklerine bakmalı (ayrıntı oraya yazıldı).",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
    };
  }
}

/**
 * Zincirin 4. halkası: Location — "hat beklenen ülkenin dışında mı?".
 *
 * Beklenti UYDURULMAZ: ADSPILOT_EXPECTED_COUNTRY yoksa halka koşmaz ve "kapali" yazar.
 * Bugünün tarihi/varsayılan bir ülke türetmek, cevabı her zaman "temiz" çıkaran sessiz
 * bir güvenlik kaybı olurdu.
 *
 * Sıra bilinçlidir: beklenti YOKSA halka zaten karar veremez, bu yüzden çelişki ve
 * simülasyon-değeri doğrulamaları o durumda hiç çalıştırılmaz — koşmayan bir halkanın
 * yapılandırmasına bakıp harcamayı reddetmek, hiçbir güvenlik kazancı olmayan bir ret
 * üretirdi (aynı gerekçeyle NV de medium katmanda değerini doğrulamaz).
 */
async function konumKatmani(ayar: AgAyar, risk: AgRisk): Promise<HalkaSonuc | undefined> {
  if (risk !== "high") return undefined;
  const sim = ayar.locSimulate?.trim();
  if (!sim && !ayar.nacToken) return undefined;

  const hamUlke = ayar.expectedCountry?.trim();
  if (!hamUlke) {
    if (sim) {
      // Operatör halkayı açıkça istemiş ama beklentiyi vermemiş: sessiz kalmak, demoyu
      // sessizce çalışmaz hâle getirirdi. Karar akışı ETKİLENMEZ, yalnız stderr'e yazılır.
      console.error(
        "[adspilot] ADSPILOT_LOC_SIMULATE tanımlı ama ADSPILOT_EXPECTED_COUNTRY yok — " +
          "konum halkası KOŞMADI (beklenen ülke uydurulmaz)."
      );
    }
    return { kanit: [], halka: "kapali" };
  }

  if (sim && ayar.nacToken) {
    return {
      engel:
        "Reddedildi [SİMÜLASYON]: ADSPILOT_NAC_TOKEN ve ADSPILOT_LOC_SIMULATE birlikte tanımlı — " +
        "çelişkili yapılandırma. Gerçek konum doğrulaması isteniyorsa ADSPILOT_LOC_SIMULATE " +
        "kaldırılmalı, demo isteniyorsa token kaldırılmalı. Güvenlik gereği belirsiz yapılandırmada " +
        "harcama artışı uygulanmaz.",
      kanit: [],
      halka: "calismadi",
      retNedeni: "yapilandirma-celiskili",
    };
  }

  const beklenen = ulkeNormalize(hamUlke);
  if (!beklenen) {
    return {
      engel:
        "Reddedildi: ADSPILOT_EXPECTED_COUNTRY değeri ISO 3166-1 alpha-2 (iki harf, ör. TR) " +
        "biçiminde değil (değer, sır ihtimaline karşı burada gösterilmez). Beklenen ülke " +
        "anlaşılamadığı için konum halkası çalışamaz; güvenlik gereği harcama artışı uygulanmaz " +
        "(kapalı arıza).",
      kanit: [],
      halka: "calismadi",
      retNedeni: "beklenen-ulke-gecersiz",
    };
  }

  if (sim) {
    if (sim !== "beklenen" && sim !== "beklenmedik") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: ADSPILOT_LOC_SIMULATE değeri tanınmadı (değer, sır ihtimaline ` +
          `karşı burada gösterilmez) — geçerli değerler "beklenen" | "beklenmedik". Güvenlik gereği ` +
          `anlaşılamayan yapılandırmada harcama artışı uygulanmaz (kapalı arıza).`,
        kanit: [],
        halka: "calismadi",
        retNedeni: "simulasyon-degeri-tanimsiz",
      };
    }
    if (!ayar.approverPhone) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: konum doğrulaması aktif ama ADSPILOT_APPROVER_PHONE boş. " +
          "Sorgulanacak numara olmadan bu halka çalışamaz; güvenlik gereği harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "onaylayici-numarasi-yok",
      };
    }
    const maskeliSim = maskele(ayar.approverPhone);
    if (sim === "beklenmedik") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: KONUM BEKLENMEDİK (SİMÜLE) — onaylayıcının (${maskeliSim}) hattı ` +
          `beklenen ülkenin (${beklenen}) DIŞINDA SAYILDI (ADSPILOT_LOC_SIMULATE=beklenmedik; gerçek ağ ` +
          `sorgusu YAPILMADI). Gerçek akışta bu, harcamayı onaylayan hattın beklenmedik bir coğrafyada ` +
          `olduğu anlamına gelir; onay istemi gösterilmez ve harcama artışı uygulanmaz. Kullanıcıya ` +
          `bunun bir SİMÜLASYON olduğunu MUTLAKA bildir.`,
        kanit: [],
        halka: "simulasyon",
        maskeliNumara: maskeliSim,
        retNedeni: "konum-beklenmedik",
      };
    }
    return {
      kanit: [
        `Konum doğrulaması [SİMÜLASYON]: onaylayıcının hattı beklenen ülkede (${beklenen}) SAYILDI ` +
          `(${maskeliSim}) — simüle kanal (ADSPILOT_LOC_SIMULATE=beklenen), gerçek ağ sorgusu YAPILMADI`,
      ],
      halka: "simulasyon",
      maskeliNumara: maskeliSim,
    };
  }

  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi: konum doğrulaması yapılandırılmış (ADSPILOT_EXPECTED_COUNTRY) ama " +
        "ADSPILOT_APPROVER_PHONE boş. Onaylayıcının numarası olmadan ağ kontrolü yapılamaz; " +
        "güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      halka: "calismadi",
      retNedeni: "onaylayici-numarasi-yok",
    };
  }
  const maskeli = maskele(ayar.approverPhone);
  try {
    const kanal = await konumKanaliGetir(ayar);
    const durum = await kanal.ulkeDurumu();
    if (typeof durum.yurtDisinda !== "boolean") {
      return {
        engel:
          "Reddedildi: ağ doğrulaması tamamlanamadı — konum kontrolünden okunabilir yanıt alınamadı. " +
          "Güvenlik gereği cevaplanamayan kontrolde harcama artışı uygulanmaz; daha sonra tekrar dene.",
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "ag-yanitsiz",
      };
    }
    if (durum.yurtDisinda === false) {
      /**
       * Hat kendi ana şebekesinde: beklenmedik YURT DIŞI coğrafya anomalisi YOK.
       * Halkanın kapsamı bilerek burada biter — CAMARA bu durumda ülke döndürmez ve
       * ülke-altı (şehir/yarıçap) doğrulama bu kapının bugünkü vaadi değildir
       * (bkz. dosya başı, Halka 4: SDK'nın Area tipinde koordinat alanı yok).
       */
      return {
        kanit: [
          `Konum doğrulaması: onaylayıcının hattı yurt dışında değil, beklenen ülkeyle (${beklenen}) ` +
            `çelişen bir coğrafya yok (${maskeli}) — GSMA Open Gateway Device Roaming Status`,
        ],
        halka: "gercek",
        maskeliNumara: maskeli,
      };
    }
    const ulkeler = (durum.ulkeler ?? [])
      .map((u) => String(u).trim().toUpperCase())
      .filter((u) => u.length > 0);
    if (!ulkeler.length) {
      // Yurt dışında ama hangi ülkede belli değil: beklentiyle karşılaştırılamaz → kapalı arıza.
      return {
        engel:
          "Reddedildi: ağ doğrulaması tamamlanamadı — onaylayıcının hattı yurt dışında görünüyor ama " +
          "bulunduğu ülke ağdan okunamadı, dolayısıyla beklenen ülkeyle karşılaştırılamadı. Güvenlik " +
          "gereği cevaplanamayan kontrolde harcama artışı uygulanmaz.",
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "ag-yanitsiz",
      };
    }
    if (!ulkeler.includes(beklenen)) {
      /**
       * GÖZLENEN ülke ASLA yazılmaz — ne ret metnine, ne ize. Dışarı çıkan tek şey
       * türetilmiş karar ve YAPILANDIRMADAN gelen beklenen ülke kodudur.
       */
      return {
        engel:
          `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (${maskeli}) hattı beklenen ülkenin ` +
          `(${beklenen}) DIŞINDA bir ülkede (GSMA Open Gateway Device Roaming Status; gözlenen ülke ` +
          `güvenlik gereği burada gösterilmez). Harcama onayının beklenmedik bir coğrafyadan gelmesi ` +
          `hesap ele geçirmenin tipik işaretidir; onay istemi hiç gösterilmedi ve harcama artışı ` +
          `uygulanmaz. Hesap sahibi durumu doğrulayana kadar tekrar deneme.`,
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "konum-beklenmedik",
      };
    }
    return {
      kanit: [
        `Konum doğrulaması: onaylayıcının hattı beklenen ülkede (${beklenen}) — ` +
          `GSMA Open Gateway Device Roaming Status (${maskeli})`,
      ],
      halka: "gercek",
      maskeliNumara: maskeli,
    };
  } catch (e: any) {
    const detay = String(e?.message ?? e).split(ayar.approverPhone).join(maskeli);
    console.error(`[adspilot] konum doğrulaması hatası (${maskeli}): ${detay}`);
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — konum kontrolünden yanıt alınamadı. Güvenlik " +
        "gereği yanıtsız kontrolde harcama artışı uygulanmaz; daha sonra tekrar dene. Sorun sürerse " +
        "operatör sunucu günlüklerine bakmalı (ayrıntı oraya yazıldı).",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
    };
  }
}

/**
 * Zincirin 5. halkası: Device Swap — "hat son N saatte YENİ BİR CİHAZA mı taşındı?".
 *
 * SIM Swap'ın yapısal ikizi (bkz. dosya başı, Halka 5) ve fail-closed sözleşmesi
 * diğer halkalarla aynıdır: onaylayıcı numarası zorunlu, tanınmayan simülasyon değeri
 * RET (ham değer YANKILANMAZ), çelişkili yapılandırma RET, okunamayan/yanıtsız CAMARA
 * cevabı RET, "değişmiş" RET.
 *
 * Ne zaman koşar: SADECE "high" katmanda ve SADECE bir kanal yapılandırılmışsa. Gerçek
 * kanal ayrıca OPT-IN'dir (ADSPILOT_DEVICESWAP_CHECK): token'ın varlığı tek başına
 * sorguyu AÇMAZ — istenmemiş bir CAMARA gidiş-dönüşü her onaya gecikme eklerdi.
 */
async function cihazDegisimKatmani(ayar: AgAyar, risk: AgRisk): Promise<HalkaSonuc | undefined> {
  if (risk !== "high") return undefined;
  const sim = ayar.devSwapSimulate?.trim();
  const gercekAcik = Boolean(ayar.nacToken && ayar.devSwapCheck);
  if (!sim && !ayar.nacToken) return undefined;

  if (sim) {
    // Çelişki ölçütü "token var mı" değil "gerçek kanal AÇIK mı" (halka 3'teki gerekçe).
    if (gercekAcik) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: ADSPILOT_DEVICESWAP_CHECK açık (gerçek cihaz değişimi sorgusu) ve " +
          "ADSPILOT_DEVICESWAP_SIMULATE birlikte tanımlı — çelişkili yapılandırma. Gerçek sorgu " +
          "isteniyorsa simülasyon kaldırılmalı, demo isteniyorsa ADSPILOT_DEVICESWAP_CHECK kapatılmalı. " +
          "Güvenlik gereği belirsiz yapılandırmada harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "yapilandirma-celiskili",
      };
    }
    if (sim !== "temiz" && sim !== "degisti") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: ADSPILOT_DEVICESWAP_SIMULATE değeri tanınmadı (değer, sır ` +
          `ihtimaline karşı burada gösterilmez) — geçerli değerler "temiz" | "degisti". Güvenlik ` +
          `gereği anlaşılamayan yapılandırmada harcama artışı uygulanmaz (kapalı arıza).`,
        kanit: [],
        halka: "calismadi",
        retNedeni: "simulasyon-degeri-tanimsiz",
      };
    }
    if (!ayar.approverPhone) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: cihaz değişimi kontrolü aktif ama ADSPILOT_APPROVER_PHONE boş. " +
          "Sorgulanacak numara olmadan bu halka çalışamaz; güvenlik gereği harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "onaylayici-numarasi-yok",
      };
    }
    const pencereSim = pencereSec(ayar, risk);
    const maskeliSim = maskele(ayar.approverPhone);
    if (sim === "degisti") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: CİHAZ DEĞİŞİMİ SAPTANDI (SİMÜLE) — onaylayıcının (${maskeliSim}) ` +
          `hattı son ${pencereSim} saat içinde YENİ BİR CİHAZA taşınmış SAYILDI ` +
          `(ADSPILOT_DEVICESWAP_SIMULATE=degisti; gerçek ağ sorgusu YAPILMADI). Gerçek akışta bu, SIM ` +
          `kartı hiç değişmeden hattın başka bir telefona alınması anlamına gelir — hesap ele ` +
          `geçirmenin SIM Swap kontrolüne yakalanmayan biçimidir; onay istemi gösterilmez ve harcama ` +
          `artışı uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON olduğunu MUTLAKA bildir.`,
        kanit: [],
        halka: "simulasyon",
        maskeliNumara: maskeliSim,
        retNedeni: "cihaz-degisti",
        pencereSaat: pencereSim,
      };
    }
    return {
      kanit: [
        `Cihaz değişimi [SİMÜLASYON]: yeni cihaza taşınma yok (son ${pencereSim} saat, ` +
          `${maskeliSim}) — simüle kanal (ADSPILOT_DEVICESWAP_SIMULATE=temiz), gerçek ağ sorgusu YAPILMADI`,
      ],
      halka: "simulasyon",
      maskeliNumara: maskeliSim,
      pencereSaat: pencereSim,
    };
  }

  // Token var ama halka açılmamış: BİLEREK sorgu yok, ret yok, kanıt satırı yok —
  // beyan yalnız yapısal ize düşer (halka 3'teki aynı gerekçe).
  if (!gercekAcik) return { kanit: [], halka: "kapali" };

  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi: cihaz değişimi kontrolü açık (ADSPILOT_DEVICESWAP_CHECK) ama " +
        "ADSPILOT_APPROVER_PHONE boş. Onaylayıcının numarası olmadan ağ kontrolü yapılamaz; " +
        "güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      halka: "calismadi",
      retNedeni: "onaylayici-numarasi-yok",
    };
  }
  const pencere = pencereSec(ayar, risk);
  const maskeli = maskele(ayar.approverPhone);
  try {
    const kanal = await cihazDegisimKanaliGetir(ayar);
    const degisti = await kanal.cihazDegistiMi(pencere);
    if (degisti === true) {
      return {
        engel:
          `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (${maskeli}) hattı son ${pencere} ` +
          `saat içinde YENİ BİR CİHAZA taşınmış (GSMA Open Gateway Device Swap). Bu, SIM kartı hiç ` +
          `değişmeden hattın başka bir telefona alınması demektir ve hesap ele geçirmenin SIM Swap ` +
          `kontrolüne yakalanmayan biçimidir; onay istemi hiç gösterilmedi ve harcama artışı ` +
          `uygulanmaz. Hesap sahibi durumu doğrulayana kadar tekrar deneme.`,
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "cihaz-degisti",
        pencereSaat: pencere,
      };
    }
    if (degisti === false) {
      return {
        kanit: [
          `Cihaz değişimi: yeni cihaza taşınma yok (son ${pencere} saat, ${maskeli}) — ` +
            `GSMA Open Gateway Device Swap`,
        ],
        halka: "gercek",
        maskeliNumara: maskeli,
        pencereSaat: pencere,
      };
    }
    /**
     * Yanıt geldi ama okunamadı. "Değişmedi" demek sessiz gevşeme, "değişti" demek
     * yanlış suçlama olurdu; ikisi de değil — kontrol cevaplanamadı.
     */
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — cihaz değişimi kontrolünden okunabilir yanıt " +
        "alınamadı. Güvenlik gereği cevaplanamayan kontrolde harcama artışı uygulanmaz; daha sonra " +
        "tekrar dene.",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
      pencereSaat: pencere,
    };
  } catch (e: any) {
    // Upstream metin ASLA ret mesajına girmez; ayrıntı numara maskelenerek stderr'e.
    const detay = String(e?.message ?? e).split(ayar.approverPhone).join(maskeli);
    console.error(`[adspilot] cihaz değişimi hatası (${maskeli}): ${detay}`);
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — cihaz değişimi kontrolünden yanıt alınamadı. " +
        "Güvenlik gereği yanıtsız kontrolde harcama artışı uygulanmaz; daha sonra tekrar dene. " +
        "Sorun sürerse operatör sunucu günlüklerine bakmalı (ayrıntı oraya yazıldı).",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
      pencereSaat: pencere,
    };
  }
}

/**
 * Zincirin 6. halkası: Call Forwarding — "hatta KOŞULSUZ çağrı yönlendirme açık mı?".
 *
 * Açık yönlendirme, OTP/sesli doğrulamayı ele geçirmenin klasik yoludur ve önceki beş
 * halkanın hiçbiri onu göremez (SIM aynı, cihaz aynı, hat erişilebilir, ülke beklenen).
 *
 * Kapalı arıza iki ek tuzağı da kapsar (bkz. dosya başı, Halka 6): `active` alanı
 * tipte OPSİYONELDİR — okunamaması "yönlendirme yok" değil "bilinmiyor"dur ve RET
 * üretir; uç noktanın 501 dahil her fırlatması da RET'tir.
 */
async function cagriYonlendirmeKatmani(ayar: AgAyar, risk: AgRisk): Promise<HalkaSonuc | undefined> {
  if (risk !== "high") return undefined;
  const sim = ayar.callFwdSimulate?.trim();
  const gercekAcik = Boolean(ayar.nacToken && ayar.callFwdCheck);
  if (!sim && !ayar.nacToken) return undefined;

  if (sim) {
    if (gercekAcik) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: ADSPILOT_CALLFWD_CHECK açık (gerçek çağrı yönlendirme sorgusu) ve " +
          "ADSPILOT_CALLFWD_SIMULATE birlikte tanımlı — çelişkili yapılandırma. Gerçek sorgu " +
          "isteniyorsa simülasyon kaldırılmalı, demo isteniyorsa ADSPILOT_CALLFWD_CHECK kapatılmalı. " +
          "Güvenlik gereği belirsiz yapılandırmada harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "yapilandirma-celiskili",
      };
    }
    if (sim !== "kapali" && sim !== "acik") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: ADSPILOT_CALLFWD_SIMULATE değeri tanınmadı (değer, sır ihtimaline ` +
          `karşı burada gösterilmez) — geçerli değerler "kapali" | "acik". Güvenlik gereği ` +
          `anlaşılamayan yapılandırmada harcama artışı uygulanmaz (kapalı arıza).`,
        kanit: [],
        halka: "calismadi",
        retNedeni: "simulasyon-degeri-tanimsiz",
      };
    }
    if (!ayar.approverPhone) {
      return {
        engel:
          "Reddedildi [SİMÜLASYON]: çağrı yönlendirme kontrolü aktif ama ADSPILOT_APPROVER_PHONE boş. " +
          "Sorgulanacak numara olmadan bu halka çalışamaz; güvenlik gereği harcama artışı uygulanmaz.",
        kanit: [],
        halka: "calismadi",
        retNedeni: "onaylayici-numarasi-yok",
      };
    }
    const maskeliSim = maskele(ayar.approverPhone);
    if (sim === "acik") {
      return {
        engel:
          `Reddedildi [SİMÜLASYON]: ÇAĞRI YÖNLENDİRME AÇIK (SİMÜLE) — onaylayıcının (${maskeliSim}) ` +
          `hattında koşulsuz çağrı yönlendirme etkin SAYILDI (ADSPILOT_CALLFWD_SIMULATE=acik; gerçek ` +
          `ağ sorgusu YAPILMADI). Gerçek akışta bu, hattın doğrulama çağrılarının başka bir numaraya ` +
          `aktarıldığı anlamına gelir — OTP/sesli doğrulama ele geçirmenin klasik yolu; onay istemi ` +
          `gösterilmez ve harcama artışı uygulanmaz. Kullanıcıya bunun bir SİMÜLASYON olduğunu ` +
          `MUTLAKA bildir.`,
        kanit: [],
        halka: "simulasyon",
        maskeliNumara: maskeliSim,
        retNedeni: "cagri-yonlendirme-acik",
      };
    }
    return {
      kanit: [
        `Çağrı yönlendirme [SİMÜLASYON]: onaylayıcının hattında koşulsuz yönlendirme YOK SAYILDI ` +
          `(${maskeliSim}) — simüle kanal (ADSPILOT_CALLFWD_SIMULATE=kapali), gerçek ağ sorgusu YAPILMADI`,
      ],
      halka: "simulasyon",
      maskeliNumara: maskeliSim,
    };
  }

  if (!gercekAcik) return { kanit: [], halka: "kapali" };

  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi: çağrı yönlendirme kontrolü açık (ADSPILOT_CALLFWD_CHECK) ama " +
        "ADSPILOT_APPROVER_PHONE boş. Onaylayıcının numarası olmadan ağ kontrolü yapılamaz; " +
        "güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      halka: "calismadi",
      retNedeni: "onaylayici-numarasi-yok",
    };
  }
  const maskeli = maskele(ayar.approverPhone);
  try {
    const kanal = await cagriYonlendirmeKanaliGetir(ayar);
    const acik = await kanal.kosulsuzYonlendirmeAcikMi();
    if (acik === true) {
      return {
        engel:
          `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (${maskeli}) hattında KOŞULSUZ ÇAĞRI ` +
          `YÖNLENDİRME açık (GSMA Open Gateway Call Forwarding Signal). Hattın doğrulama çağrıları ` +
          `başka bir numaraya aktarılıyor olabilir; bu, OTP/sesli doğrulama ele geçirmenin klasik ` +
          `yoludur. Onay istemi hiç gösterilmedi ve harcama artışı uygulanmaz. Hesap sahibi ` +
          `yönlendirmeyi kaldırıp durumu doğrulayana kadar tekrar deneme.`,
        kanit: [],
        halka: "gercek",
        maskeliNumara: maskeli,
        retNedeni: "cagri-yonlendirme-acik",
      };
    }
    if (acik === false) {
      return {
        kanit: [
          `Çağrı yönlendirme: onaylayıcının hattında koşulsuz yönlendirme yok (${maskeli}) — ` +
            `GSMA Open Gateway Call Forwarding Signal`,
        ],
        halka: "gercek",
        maskeliNumara: maskeli,
      };
    }
    /**
     * `active` CAMARA yanıtında OPSİYONEL: yokluğu "yönlendirme kapalı" DEĞİL "bilinmiyor"dur.
     * Bilinmeyeni temiz saymak, halkanın var olma sebebini yutardı.
     */
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — çağrı yönlendirme kontrolünden okunabilir yanıt " +
        "alınamadı. Güvenlik gereği cevaplanamayan kontrolde harcama artışı uygulanmaz; daha sonra " +
        "tekrar dene.",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
    };
  } catch (e: any) {
    /**
     * 501 (NotImplementedError) dahil HER fırlatma buraya düşer ve RET üretir: operatörün
     * şebekesi bu sinyali sunmuyorsa halka KAPATILMALIDIR (ADSPILOT_CALLFWD_CHECK), sessizce
     * geçilmemelidir — "cevap alamadım" ile "yönlendirme yok" aynı şey değildir.
     */
    const detay = String(e?.message ?? e).split(ayar.approverPhone).join(maskeli);
    console.error(`[adspilot] çağrı yönlendirme hatası (${maskeli}): ${detay}`);
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — çağrı yönlendirme kontrolünden yanıt alınamadı " +
        "(şebeke bu sinyali sunmuyor olabilir). Güvenlik gereği yanıtsız kontrolde harcama artışı " +
        "uygulanmaz; daha sonra tekrar dene. Sorun sürerse operatör sunucu günlüklerine bakmalı " +
        "(ayrıntı oraya yazıldı).",
      kanit: [],
      halka: "gercek",
      maskeliNumara: maskeli,
      retNedeni: "ag-yanitsiz",
    };
  }
}

/**
 * Consults the network before a spend-increasing approval. Called by the approval gate
 * for every risk-tagged action; the caller treats `engel` as a hard refusal.
 *
 * Zincir SABİT ve TEK YÖNLÜ sırayla koşar:
 *   SIM Swap → Number Verification → Device Reachability → Location
 *   → Device Swap → Call Forwarding
 * Son beşi YALNIZ "high" katmanda çalışır. Bir halkanın reti KESİNDİR: o noktada hemen
 * dönülür, sonraki halkalar ne koşar ne de kararı yumuşatabilir — sonraki bir halka
 * yalnızca reddetmek için yeni bir sebep ekleyebilir.
 */
export async function agDogrula(ayar: AgAyar, risk: AgRisk): Promise<AgKarar> {
  const simSwap = await simSwapKatmani(ayar, risk);
  if (simSwap.engel) return simSwap;

  /**
   * ZİNCİR BİRLEŞİMİ. Koşan her halka KENDİ iz alanına yazar; tek bir alana ASLA
   * ezilmez. "Gerçek CAMARA SIM-Swap sorgusu + NV simülasyonu + kapalı konum halkası"
   * ile "hepsi simülasyon" farklı güven seviyeleridir ve denetim izinin tek işi bu
   * ayrımı kanıtlamaktır. Halka eklendikçe bu kural yeniden kazanılır: yeni halka
   * hem KENDİ AgIz alanını hem de kararGunlugu.ts'teki kendi kayıt alanını ister.
   *
   * `retNedeni` yalnız reddeden halkadan gelebilir: önceki halkaların engeli zaten
   * erken dönmüştür, dolayısıyla bu noktada tanımsızdır.
   */
  let kanit = [...simSwap.kanit];
  let iz: AgIz = simSwap.iz;

  const nv = nvKatmani(ayar, risk);
  if (nv) {
    iz = {
      ...iz,
      nv: nv.nv,
      maskeliNumara: iz.maskeliNumara ?? nv.maskeliNumara,
      retNedeni: nv.retNedeni,
    };
    if (nv.engel) return { engel: nv.engel, kanit: [], iz };
    kanit = [...kanit, ...nv.kanit];
  }

  const reach = await erisilebilirlikKatmani(ayar, risk);
  if (reach) {
    iz = {
      ...iz,
      reach: reach.halka,
      maskeliNumara: iz.maskeliNumara ?? reach.maskeliNumara,
      retNedeni: reach.retNedeni,
    };
    if (reach.engel) return { engel: reach.engel, kanit: [], iz };
    kanit = [...kanit, ...reach.kanit];
  }

  const loc = await konumKatmani(ayar, risk);
  if (loc) {
    iz = {
      ...iz,
      loc: loc.halka,
      maskeliNumara: iz.maskeliNumara ?? loc.maskeliNumara,
      retNedeni: loc.retNedeni,
    };
    if (loc.engel) return { engel: loc.engel, kanit: [], iz };
    kanit = [...kanit, ...loc.kanit];
  }

  const devSwap = await cihazDegisimKatmani(ayar, risk);
  if (devSwap) {
    iz = {
      ...iz,
      devSwap: devSwap.halka,
      maskeliNumara: iz.maskeliNumara ?? devSwap.maskeliNumara,
      retNedeni: devSwap.retNedeni,
      /**
       * KENDİ alanına yazar, `pencereSaat`e DEĞİL: o alan SIM-Swap halkasınındır ve iki
       * halkanın penceresi tek alana ezilirse denetçi hangi sorunun hangi pencereyle
       * sorulduğunu ayırt edemez (bkz. AgIz.devSwapPencereSaat).
       */
      devSwapPencereSaat: devSwap.pencereSaat,
    };
    if (devSwap.engel) return { engel: devSwap.engel, kanit: [], iz };
    kanit = [...kanit, ...devSwap.kanit];
  }

  const callFwd = await cagriYonlendirmeKatmani(ayar, risk);
  if (callFwd) {
    iz = {
      ...iz,
      callFwd: callFwd.halka,
      maskeliNumara: iz.maskeliNumara ?? callFwd.maskeliNumara,
      retNedeni: callFwd.retNedeni,
    };
    if (callFwd.engel) return { engel: callFwd.engel, kanit: [], iz };
    kanit = [...kanit, ...callFwd.kanit];
  }

  return { kanit, iz };
}

/**
 * Zincirin 1. halkası: SIM Swap (gerçek CAMARA sorgusu ya da SİMÜLASYON kanalı).
 * Karar mantığı halka ayrımından önceki hâliyle aynıdır.
 */
async function simSwapKatmani(ayar: AgAyar, risk: AgRisk): Promise<AgKarar> {
  // Simülasyon tanımlıysa gerçek kanaldan ÖNCE devreye girer (token'a bakılmaksızın):
  // jüri demosu SDK'sız/token'sız çalışır, karar mantığı ve fail-closed yolları aynıdır.
  const sim = ayar.nacSimulate?.trim();
  if (sim) return simDogrula(ayar, risk, sim);

  if (!ayar.nacToken) {
    // Katman BİLEREK kapalı: yapılandırma hatası değil, sorgu da yok.
    return { kanit: ["Ağ doğrulaması: kapalı (ADSPILOT_NAC_TOKEN tanımlı değil)"], iz: { simSwap: "kapali" } };
  }
  if (!ayar.approverPhone) {
    return {
      engel:
        "Reddedildi: ağ doğrulaması yapılandırması eksik — ADSPILOT_NAC_TOKEN tanımlı ama " +
        "ADSPILOT_APPROVER_PHONE boş. Onaylayıcının numarası olmadan ağ kontrolü yapılamaz; " +
        "güvenlik gereği harcama artışı uygulanmaz.",
      kanit: [],
      iz: { simSwap: "calismadi", retNedeni: "onaylayici-numarasi-yok" },
    };
  }

  const pencere = pencereSec(ayar, risk);
  const maskeli = maskele(ayar.approverPhone);

  try {
    const kanal = await kanalGetir(ayar);
    const degisti = await kanal.verifySimSwap(pencere);
    if (degisti) {
      return {
        engel:
          `Reddedildi: AĞ DOĞRULAMASI BAŞARISIZ — onaylayıcının (${maskeli}) SIM kartı ` +
          `son ${pencere} saat içinde değişmiş (GSMA Open Gateway SIM Swap). Bu, hesap ele geçirme ` +
          `saldırılarının tipik işaretidir; onay istemi hiç gösterilmedi. Hesap sahibi durumu doğrulayana ` +
          `kadar harcama artışı uygulanmaz. Kullanıcıya bu durumu MUTLAKA bildir.`,
        kanit: [],
        iz: { simSwap: "gercek", pencereSaat: pencere, maskeliNumara: maskeli, retNedeni: "sim-degisti" },
      };
    }
    return {
      kanit: [`Ağ doğrulaması: SIM değişimi yok (son ${pencere} saat, ${maskeli}) — GSMA Open Gateway`],
      iz: { simSwap: "gercek", pencereSaat: pencere, maskeliNumara: maskeli },
    };
  } catch (e: any) {
    /**
     * The trust anchor is unreachable: refusing is the entire point of having one.
     *
     * The upstream error is NEVER inlined into the refusal. The NaC SDK builds
     * error.message from the full server response body, and CAMARA 4xx bodies echo
     * the offending phoneNumber verbatim — inlining it would hand the agent (and an
     * attacker holding a stolen session) the exact secret maskele() protects, plus an
     * unsanitized channel for upstream text. Details go to stderr for the operator,
     * with the approver number redacted even there.
     */
    const detay = String(e?.message ?? e).split(ayar.approverPhone).join(maskeli);
    console.error(`[adspilot] ağ doğrulaması hatası (${maskeli}): ${detay}`);
    return {
      engel:
        "Reddedildi: ağ doğrulaması tamamlanamadı — SIM Swap kontrolünden yanıt alınamadı. " +
        "Güvenlik gereği yanıtsız kontrolde harcama artışı uygulanmaz; daha sonra tekrar dene. " +
        "Sorun sürerse operatör sunucu günlüklerine bakmalı (ayrıntı oraya yazıldı).",
      kanit: [],
      /**
       * Kanal "gercek": yapılandırma sağlamdı ve gerçek sorgu bu pencereyle DENENDİ —
       * yanıt gelmedi. "calismadi" demek, yapılandırma hatasıyla hiç sorulmamış bir
       * kararla aynı kefeye koymak olurdu; denetimde bu ikisi ayrı durumlardır.
       */
      iz: { simSwap: "gercek", pencereSaat: pencere, maskeliNumara: maskeli, retNedeni: "ag-yanitsiz" },
    };
  }
}
