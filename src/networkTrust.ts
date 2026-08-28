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
 * Ret nedenleri SABİT sözlük. Upstream metin (SDK hata gövdesi, env değeri, CAMARA
 * yanıtı) bu kümeye ASLA giremez: denetim izi serbest metin taşımaz, kod taşır.
 */
export type RetNedeni =
  | "sim-degisti"
  | "nv-uyusmadi"
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
  /** YALNIZ gerçekten sorgulanan katmanın geriye bakış penceresi (saat). */
  pencereSaat?: number;
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
}

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
 * Consults the network before a spend-increasing approval. Called by the approval gate
 * for every risk-tagged action; the caller treats `engel` as a hard refusal.
 *
 * The chain runs in a fixed order — SIM Swap first, then (on the "high" tier only)
 * Number Verification. A refusal from the first link returns immediately: the second
 * link must never be able to overturn it, only to add a further reason to refuse.
 */
export async function agDogrula(ayar: AgAyar, risk: AgRisk): Promise<AgKarar> {
  const simSwap = await simSwapKatmani(ayar, risk);
  if (simSwap.engel) return simSwap;

  const nv = nvKatmani(ayar, risk);
  if (!nv) return simSwap;

  /**
   * ZİNCİR BİRLEŞİMİ. İki halka da koştuysa iz İKİSİNİ de yansıtır: `simSwap` alanı
   * 1. halkanın gerçekliğini korur (gerçek CAMARA sorgusu, NV simüle olsa bile),
   * `nv` alanı 2. halkanınkini söyler. Tek alana ezmek, denetim izinin varlık
   * sebebini yok ederdi.
   *
   * Ret nedeni burada yalnız NV'den gelebilir: 1. halkanın engeli yukarıda erken
   * dönmüştür, dolayısıyla simSwap.iz.retNedeni bu noktada tanımsızdır.
   */
  const iz: AgIz = {
    ...simSwap.iz,
    nv: nv.nv,
    maskeliNumara: simSwap.iz.maskeliNumara ?? nv.maskeliNumara,
    retNedeni: nv.retNedeni,
  };
  if (nv.engel) return { engel: nv.engel, kanit: [], iz };
  return { kanit: [...simSwap.kanit, ...nv.kanit], iz };
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
