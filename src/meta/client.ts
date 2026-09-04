// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Meta (Facebook/Instagram) Marketing API — the second spend domain.
 *
 * WHY THIS EXISTS: the trust gate's central claim is that it is *domain-general* — that
 * "ask the network before a human is prompted" is not a Google Ads feature but a property
 * of any path that moves money. A claim like that is cheap until a second domain sits
 * behind the same gate. This module is that second domain.
 *
 * Deliberately thin. It is a transport, not a strategy layer: create a campaign (always
 * paused), read a budget, change a budget, change a status. Every safety decision — the
 * ceiling, the approval, the network chain — lives in the tool layer and the approval gate,
 * exactly where it lives for Google Ads. Duplicating a guard here would mean two places to
 * get it right and one place to forget.
 *
 * HONESTY: this file reached Meta's servers for the first time on 2 September 2026, and the
 * distinction it used to disclaim is now settled by evidence rather than by promise.
 *
 * The offline tests still only prove our side: the tool tests inject a fake channel and the
 * budget tests stub `fetch`, so both feed this code responses we wrote ourselves. They cover
 * our parsing and our refusals and say nothing about whether Meta answers in these shapes.
 * What closes that gap is `npm run metatest`, which drives the real client against the live
 * Marketing API — including a real campaign creation that confirms the campaign is born
 * PAUSED, is read back from Meta as PAUSED, and survives the minor-unit round trip intact.
 *
 * Keep both. Green unit tests are evidence about decision logic; only the live run is
 * evidence about the wire, and conflating the two is how a suite starts lying.
 */

/** The Graph API version this module is written against. Pinned deliberately: Meta ships
 * breaking changes per version and an unpinned call silently follows the newest one. */
export const GRAPH_SURUM = "v21.0";

/** Meta's campaign objectives, as the Marketing API spells them (OUTCOME_* since v13). */
export type MetaHedef =
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_SALES"
  | "OUTCOME_LEADS"
  | "OUTCOME_AWARENESS"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_APP_PROMOTION";

export type MetaDurum = "ACTIVE" | "PAUSED";

/**
 * The statuses that can be seen ON A READ. Writes send only ACTIVE or PAUSED, per
 * MetaDurum, but on a read Meta also returns ARCHIVED and DELETED. Folding those into PAUSED
 * meant treating "archived" and "paused" as the same thing; they are not.
 */
export type MetaOkunanDurum = MetaDurum | "ARCHIVED" | "DELETED";

export interface MetaKampanya {
  id: string;
  ad: string;
  /**
   * The status Meta reports — ONLY when it was read for certain.
   *
   * This field used to be produced with `status === "ACTIVE" ? ACTIVE : PAUSED`: when the
   * field never arrived, when its type was unexpected, or when Meta added a new enum value,
   * the result was "PAUSED" — that is, "unknown" was being reported as "not spending". The
   * FIRST gate to consult this field would have failed open, quietly, on that day.
   * undefined now means "unknown", and a consumer cannot treat it as clean.
   */
  durum?: MetaOkunanDurum;
  /** The REASON the status could not be read, so refusal and report text can carry it
   * verbatim. */
  durumNotu?: string;
  /** The daily budget in the account's currency — NOT in minor units; the conversion
   * happens in the client. */
  gunlukButce?: number;
  /**
   * WHERE the figure came from. Meta holds the budget in one of two places, and they are
   * not the same thing: at campaign level (CBO) it is a single number, while at ad-set level
   * it is a sum. Putting this in the approval summary lets the operator know where to look
   * for the figure they are seeing in Ads Manager.
   */
  butceKaynagi?: "kampanya" | "reklam-setleri";
  /**
   * The REASON the budget could not be read — "could not be read" on its own does not tell
   * the operator what to do about it. The refusal message carries this note verbatim.
   */
  butceNotu?: string;
}

/** The capability surface the tools need; the HTTP client is adapted to it. */
export interface MetaKanali {
  kampanyaOlustur(girdi: { ad: string; hedef: MetaHedef; gunlukButce: number }): Promise<MetaKampanya>;
  kampanyaOku(kampanyaId: string): Promise<MetaKampanya>;
  butceGuncelle(kampanyaId: string, gunlukButce: number): Promise<void>;
  durumDegistir(kampanyaId: string, durum: MetaDurum): Promise<void>;
}

/** The config slice this module reads (kept narrow, like AgAyar). */
export interface MetaAyar {
  metaToken?: string;
  /** Either in act_<id> form or bare digits; the client normalises it. */
  metaAdAccountId?: string;
}

/**
 * Test seam. Production builds the channel from fetch; tests inject a fake so every
 * refusal path can be exercised (and mutation-tested) without a network or a token.
 */
let kanalOverride: MetaKanali | "reset" | undefined;
export function __setMetaKanalForTests(k: MetaKanali | undefined): void {
  kanalOverride = k ?? "reset";
  gercekKanal = undefined;
  gercekKanalAnahtari = undefined;
}

let gercekKanal: MetaKanali | undefined;
let gercekKanalAnahtari: string | undefined;

/** "act_123" and "123" point at the same account; the Graph path wants the act_
 * prefix. */
export function hesapYolu(ham: string): string {
  const temiz = ham.trim();
  return temiz.startsWith("act_") ? temiz : `act_${temiz.replace(/\D/g, "")}`;
}

/**
 * Converts a Meta minor-unit field to an INTEGER — or says that it could not be read.
 *
 * `Number.isFinite(Number(x))` is not enough, and that is exactly why it was changed:
 * `Number("")`, `Number(" ")` and `Number([])` are zero, and `Number(true)` is one. With that
 * shortcut, a budget that could not be read counted silently as 0, the total came out smaller
 * than the truth, and the spend ceiling showed green. The same contract as `mikrodanTutar` in
 * write.ts applies here: TYPE FIRST, NUMBER SECOND.
 *
 * Meta's minor units are always non-negative INTEGERS; values such as "1e3", "12.5" and
 * "-100" are shapes Meta does not send, and they are not interpreted as "well, it might mean
 * this" — they fall on the fail-closed side.
 */
export function minorTutar(ham: unknown): number | undefined {
  if (typeof ham === "number") return Number.isSafeInteger(ham) && ham >= 0 ? ham : undefined;
  if (typeof ham !== "string") return undefined;
  const s = ham.trim();
  if (!/^\d+$/.test(s)) return undefined;
  const sayi = Number(s);
  return Number.isSafeInteger(sayi) ? sayi : undefined;
}

/**
 * The account's currency and its minor-unit MULTIPLIER.
 *
 * The multiplier VARIES with the currency: in USD one unit is 100 cents, in JPY one unit is
 * 1 yen. So the multiplier is not guessed, it is read from the account — see paraBirimiCoz.
 */
export interface MetaParaBirimi {
  kod: string;
  carpan: number;
}

/**
 * Resolving the currency from a `/act_<id>?fields=currency,currency_offset` body — FAILS
 * CLOSED.
 *
 * It returns undefined when the field is absent, when its type is unexpected, or when the
 * multiplier is not a positive integer. Defaulting to 100 would make the most dangerous state
 * of this business — "the account is in JPY but we think it is USD" — look normal: on a write
 * it spends 100 times too much, and on a read it shrinks the real budget to a hundredth and
 * blinds the ceiling gate.
 */
export function paraBirimiCoz(govde: any): MetaParaBirimi | undefined {
  const kod = govde?.currency;
  if (typeof kod !== "string" || !/^[A-Za-z]{3}$/.test(kod.trim())) return undefined;
  const carpan = minorTutar(govde?.currency_offset);
  // A multiplier of 0 is a division by zero, and an absurdly large one is not a value that
  // was read, it is a malfunction.
  if (carpan === undefined || carpan < 1 || carpan > 1_000_000) return undefined;
  return { kod: kod.trim().toUpperCase(), carpan };
}

/**
 * Meta budgets are expected in MINOR UNITS — kurus, cents, yen — and as INTEGERS.
 *
 * This is a second trap that resembles Google Ads's micros but is on a different scale:
 * sending the same number to both APIs means being off by a factor of 100 on one of them. The
 * rounding is deliberately Math.round: truncating would err AGAINST the customer rather than
 * for them every single time, producing a silent shortfall of the "I asked for 1.005 and got
 * 1.00" kind.
 *
 * THE MULTIPLIER IS A REQUIRED PARAMETER, with NO default: had it defaulted to 100, one call
 * site forgetting to pass it would mean a silent hundredfold error on a JPY account. Forget
 * it and compilation stops; the wrong amount of money does not go out quietly.
 */
export function minorUnit(tutar: number, carpan: number): number {
  carpanDogrula(carpan);
  /**
   * The toFixed in the middle IS THERE ON PURPOSE and is necessary: `1.005 * 100` comes
   * out as 100.49999999999999 in binary, so a plain `Math.round(tutar * 100)` would take it
   * down to 100 — precisely the silent, customer-unfavourable shortfall we are trying to
   * avoid. Rounding to a fixed number of places first and only then to an integer closes
   * that gap.
   */
  return Math.round(Number((tutar * carpan).toFixed(4)));
}

/** The inverse of minorUnit — used on the read path. */
export function minorUnitTers(minor: number, carpan: number): number {
  carpanDogrula(carpan);
  return minor / carpan;
}

/**
 * Multiplier validation. Throwing is deliberate: a number produced with a multiplier that
 * was never read would push a wrong figure into the ceiling gate — better to produce nothing
 * at all than to produce NaN or Infinity quietly.
 */
function carpanDogrula(carpan: number): void {
  if (!Number.isInteger(carpan) || carpan < 1) {
    throw new Error("Meta para birimi çarpanı okunmadan bütçe çevrilemez (kapalı arıza)");
  }
}

/**
 * Defuses an unexpected field value BEFORE it goes into a note.
 *
 * The operator can only know what to fix if we tell them the value we saw; but carrying raw
 * upstream content through as-is is forbidden everywhere in this repository, for token and
 * PII reasons. The middle ground: the type's name, or a short sample reduced to letters and
 * digits.
 */
export function gorunurDeger(x: unknown): string {
  if (x === undefined) return "alan yok";
  if (x === null) return "null";
  if (typeof x === "string") return `"${x.replace(/[^A-Za-z0-9_\- ]/g, "?").slice(0, 32)}"`;
  if (Array.isArray(x)) return "dizi";
  return typeof x;
}

/**
 * An ad set's status — an ALLOWLIST. Anything unrecognised is undefined.
 *
 * There used to be a `String(r?.status) === "ACTIVE"` filter here, and an unrecognised status
 * fell quietly onto the "not spending" side: `"active"`, a missing field, `["ACTIVE"]`,
 * `"ACTIVE_LEARNING"` — every one of those values DROPPED that set from the total. And an
 * incomplete total is an overrun that looks like it is under the ceiling — the most dangerous
 * way for the gate to be wrong.
 */
export function setDurumu(ham: unknown): "ACTIVE" | "PASIF" | undefined {
  if (ham === "ACTIVE") return "ACTIVE";
  if (ham === "PAUSED" || ham === "ARCHIVED" || ham === "DELETED") return "PASIF";
  return undefined;
}

/** Reading a campaign's status FOR CERTAIN — an allowlist; an unrecognised value is
 * "unknown". */
export function kampanyaDurumu(ham: unknown): { durum?: MetaOkunanDurum; not?: string } {
  if (ham === "ACTIVE" || ham === "PAUSED" || ham === "ARCHIVED" || ham === "DELETED") {
    return { durum: ham };
  }
  return {
    not:
      `Meta kampanya durumu okunamadı (status: ${gorunurDeger(ham)}); ` +
      `"duraklatılmış" varsayılmadı — bilinmeyen durum harcamıyor demek değildir`,
  };
}

/**
 * Cleans upstream error text before it is shown to the agent.
 *
 * Meta's error bodies can echo the request URL, and access_token is a QUERY PARAMETER — so
 * showing the raw body as-is would be handing the token to the agent, and to a stolen session
 * with it. The same lesson was learned on the CAMARA side; here it is applied from the
 * start.
 */
/** Extracts text from an exception — the same as `String(e)`, but in one place. */
function hataMetni(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function hataTemizle(ham: string, token?: string): string {
  let s = ham.replace(/access_token=[^&\s"']+/gi, "access_token=***");
  if (token && token.length >= 8) s = s.split(token).join("***");
  return s.replace(/\s+/g, " ").slice(0, 300);
}

/** A Graph API call — bounded by a timeout, with the token only in the POST body. */
async function graf(
  ayar: MetaAyar,
  yol: string,
  govde: Record<string, string>,
  yontem: "POST" | "GET" = "POST"
): Promise<any> {
  const token = ayar.metaToken!;
  const url = `https://graph.facebook.com/${GRAPH_SURUM}/${yol}`;
  const kontrol = new AbortController();
  /**
   * Fifteen seconds: a call standing in front of an approval flow cannot hang for minutes.
   * The same reasoning as the CAMARA calls on the Google side — failing closed must be
   * FAST.
   */
  const zamanlayici = setTimeout(() => kontrol.abort(), 15_000);
  try {
    const istek: RequestInit = { method: yontem, signal: kontrol.signal };
    if (yontem === "POST") {
      istek.headers = { "Content-Type": "application/x-www-form-urlencoded" };
      istek.body = new URLSearchParams({ ...govde, access_token: token }).toString();
    }
    const hedefUrl = yontem === "GET" ? `${url}?${new URLSearchParams({ ...govde, access_token: token })}` : url;
    let cevap: Response;
    try {
      cevap = await fetch(hedefUrl, istek);
    } catch (e: any) {
      /**
       * A WRITE THAT TIMED OUT IS NOT "FAILED" — ITS OUTCOME IS UNKNOWN.
       *
       * The abort happens on our side; Meta may already have received the request and
       * APPLIED it. Saying "the Meta operation failed" convinces the agent and the user
       * that nothing happened, and the typical next move is to retry — which can mean
       * changing the budget a second time, or giving birth to a second campaign.
       *
       * A READ is different: aborting a GET changes nothing, so it really did fail. That is
       * why the distinction is drawn by method.
       */
      if (e?.name === "AbortError" && yontem === "POST") {
        throw new Error(
          "Meta işleminin SONUCU BİLİNMİYOR: istek 15 saniyede yanıt vermediği için " +
            "iptal edildi, ama iptal bizim tarafımızdadır — Meta isteği almış ve UYGULAMIŞ " +
            "olabilir. TEKRAR DENEME; önce Meta Ads Manager'dan kampanyanın güncel durumunu " +
            "ve bütçesini doğrula."
        );
      }
      throw e;
    }
    const metin = await cevap.text();
    if (!cevap.ok) {
      throw new Error(`Meta API ${cevap.status}: ${hataTemizle(metin, token)}`);
    }
    return metin ? JSON.parse(metin) : {};
  } finally {
    clearTimeout(zamanlayici);
  }
}

/**
 * The most ad sets to read in one call. Beyond it the total would be INCOMPLETE, and an
 * incomplete total lets a campaign through the ceiling by mistake — so a page overflow is not
 * silently truncated, it is REFUSED.
 */
const REKLAM_SETI_TAVANI = 200;

/**
 * WHEN THERE IS NO BUDGET AT CAMPAIGN LEVEL, SUM THE AD SETS.
 *
 * On Meta the budget lives either on the campaign (CBO) or on the ad sets. Looking only at
 * the `daily_budget` field dropped every non-CBO campaign into "its budget cannot be read",
 * and those campaigns could not be taken live with this tool. The right fix was not to loosen
 * the refusal but to complete the OBSERVATION: this is that observation.
 *
 * Every uncertainty falls on the REFUSE side, because the number coming out of here is
 * measured directly against the spend ceiling: an incomplete total is an overrun that looks
 * like it is under the ceiling.
 */
async function reklamSetiButcesi(
  ayar: MetaAyar,
  kampanyaId: string,
  carpan: number
): Promise<{ gunlukButce?: number; not?: string }> {
  let yanit: any;
  try {
    yanit = await graf(
      ayar,
      `${kampanyaId}/adsets`,
      { fields: "id,name,status,daily_budget,lifetime_budget", limit: String(REKLAM_SETI_TAVANI) },
      "GET"
    );
  } catch (e) {
    /**
     * THE REASON GOES TO THE AGENT, BUT NOT RAW.
     *
     * This note enters set_meta_campaign_status's refusal text as `butceNotu`, which is a
     * surface the agent sees directly. `graf` only cleaned HTTP errors; on a 200 with a
     * non-JSON body, the message of the SyntaxError thrown carries A PREFIX OF THE UPSTREAM
     * BODY, and it used to pass through here unmasked and uncapped. hataTemizle removes both
     * access_token and the token itself, and cuts at 300 characters.
     */
    return { not: `reklam setleri okunamadı (${hataTemizle(hataMetni(e), ayar.metaToken)})` };
  }

  const setler = Array.isArray(yanit?.data) ? yanit.data : undefined;
  if (!setler) return { not: "Meta reklam seti listesi beklenen biçimde gelmedi" };

  /**
   * A PAGE OVERFLOW IS A REFUSAL. If `paging.next` is present, the list we hold is
   * incomplete, and the total that comes out of an incomplete list is SMALLER THAN THE TRUTH
   * — so a campaign that exceeds the ceiling appears to be under it. Quietly settling for
   * the first page is the most dangerous way for the gate to be wrong.
   */
  if (yanit?.paging?.next) {
    return {
      not:
        `kampanyada ${REKLAM_SETI_TAVANI}'den fazla reklam seti var; toplam bütçe eksik ` +
        `hesaplanacağı için doğrulanamıyor`,
    };
  }

  /**
   * Only ACTIVE sets spend. Counting a paused set's budget into the total would make the
   * campaign look more expensive than it is and block a legitimate go-live. The set's OWN
   * `status` field is the right one: these are the sets that will start delivering once the
   * campaign is ACTIVE, whereas `effective_status` also folds in the parent's current state.
   *
   * A SET WHOSE STATUS CANNOT BE READ INVALIDATES THE TOTAL — it is not skipped. The old
   * filter looked like an allowlist but was a silent EXCLUSION: an unrecognised status
   * counted as "not spending", and that set's budget dropped out of the total. On a mixed
   * list, where one set is recognised and another is not, that produces an overrun that
   * looks like it is under the ceiling. An unknown status is held to the same discipline as
   * an unknown budget: REFUSE, with a note saying why.
   */
  const aktif: any[] = [];
  for (const r of setler) {
    const durum = setDurumu(r?.status);
    if (durum === undefined) {
      return {
        not:
          `"${setAdi(r)}" reklam setinin durumu okunamadı (status: ${gorunurDeger(r?.status)}); ` +
          `harcayıp harcamadığı bilinmeden toplam bütçe güvenilir değil`,
      };
    }
    if (durum === "ACTIVE") aktif.push(r);
  }
  if (!aktif.length) {
    return {
      not:
        "kampanyada ACTIVE reklam seti yok — yayına alınsa da gösterim yapamaz " +
        "(Google tarafındaki 'yayınlanabilir reklam yok' kuralının Meta karşılığı)",
    };
  }

  let toplamMinor = 0;
  for (const r of aktif) {
    const ad = setAdi(r);
    const gunluk = minorTutar(r?.daily_budget);
    if (gunluk !== undefined) {
      toplamMinor += gunluk;
      continue;
    }
    /**
     * THE FIELD EXISTS BUT CANNOT BE READ and THE FIELD IS ABSENT are different things;
     * both are refusals, but their reasons are written separately. In the old code values
     * such as `""`, `" "`, `[]` and `true` were turned into zero or one by `Number()` and
     * entered the total — the silent shortfall that showed the ceiling green.
     */
    if (r?.daily_budget !== undefined && r?.daily_budget !== null) {
      return {
        not:
          `"${ad}" reklam setinin günlük bütçesi okunamadı ` +
          `(beklenmedik değer: ${gorunurDeger(r.daily_budget)})`,
      };
    }
    /**
     * A LIFETIME BUDGET CANNOT BE CONVERTED INTO A DAILY CEILING. Dividing the total by
     * the duration is an estimate, and Meta can front-load delivery within a day; measuring
     * an estimate as though it were a real ceiling produces a number the gate believes it
     * verified but did not.
     */
    if (r?.lifetime_budget !== undefined && r?.lifetime_budget !== null) {
      return { not: `"${ad}" reklam seti ömürlük bütçe kullanıyor; günlük tavana çevrilemez` };
    }
    return { not: `"${ad}" reklam setinin günlük bütçesi okunamadı` };
  }

  // The minor units are summed as integers FIRST: dividing separately for each set would
  // accumulate floating-point residue.
  return { gunlukButce: minorUnitTers(toplamMinor, carpan) };
}

/**
 * The name the set WILL BE CALLED BY in a refusal message. Only fields that really are a
 * string or a number are used: `String(object)` would produce "[object Object]" and tell the
 * operator nothing.
 */
function setAdi(r: any): string {
  const ham = typeof r?.name === "string" && r.name.trim() !== "" ? r.name : r?.id;
  if (typeof ham === "string" || typeof ham === "number") return String(ham).slice(0, 80);
  return "adsız";
}

/**
 * The real channel. The cache is keyed by token plus account id — an unkeyed singleton
 * would pin the first caller's account forever, which is the same bug that happened on the
 * CAMARA side.
 */
export function metaKanali(ayar: MetaAyar): MetaKanali {
  if (kanalOverride && kanalOverride !== "reset") return kanalOverride;
  const anahtar = `${ayar.metaToken}\u0000${ayar.metaAdAccountId}`;
  if (gercekKanal && gercekKanalAnahtari === anahtar) return gercekKanal;

  const hesap = hesapYolu(ayar.metaAdAccountId!);

  /**
   * THE CURRENCY IS READ FROM THE ACCOUNT, NOT ASSUMED.
   *
   * The minor-unit multiplier depends on the account's currency: 100 for USD, 1 for JPY. A
   * hard-coded ×100 spends 100 TIMES too much when writing to a JPY account, and when
   * reading it shrinks the real budget to a hundredth and blinds the ceiling gate — and the
   * figure we put to a human for approval would be wrong as well. If the multiplier cannot
   * be read, no budget is written and no budget counts as "verified".
   *
   * The value is fixed per account, and since the channel is already cached under a
   * token-plus-account key, holding it here is safe. ERRORS ARE NOT CACHED: a transient
   * network fault must not lock the account out for the rest of the session.
   */
  let paraBirimi: MetaParaBirimi | undefined;
  const paraBirimiAl = async (): Promise<MetaParaBirimi> => {
    if (paraBirimi) return paraBirimi;
    let govde: any;
    try {
      govde = await graf(ayar, hesap, { fields: "currency,currency_offset" }, "GET");
    } catch (e) {
      /**
       * A network fault and "the field did not arrive" produce THE SAME OUTCOME — the
       * multiplier is unknown — so they are reported in the same sentence: the operator
       * reading the refusal is looking for one reason, not two.
       */
      // This message also reaches the agent through `butceNotu`: carrying raw upstream text
      // without hataTemizle would hand the agent the token and a prefix of the body.
      throw new Error(
        `Meta hesabının para birimi okunamadı (${hataTemizle(hataMetni(e), ayar.metaToken)})`
      );
    }
    const cozum = paraBirimiCoz(govde);
    if (!cozum) {
      throw new Error(
        "Meta hesabının para birimi okunamadı (currency/currency_offset alanları " +
          "beklenen biçimde gelmedi); minor-unit çarpanı bilinmeden bütçe ne yazılabilir " +
          "ne doğrulanabilir"
      );
    }
    paraBirimi = cozum;
    return cozum;
  };

  gercekKanal = {
    async kampanyaOlustur({ ad, hedef, gunlukButce }) {
      /**
       * status: "PAUSED" IS FIXED HERE, and is NOT a parameter.
       *
       * The promise made on the Google side — campaigns are always born paused — has to
       * hold on this surface too; letting the caller pass it would leave the promise up to
       * the call site. Going live is a separate tool, and it wants human approval plus the
       * network chain.
       */
      // The currency is read FIRST: if it cannot be read, no campaign is created at all —
      // better none than one born with a budget at the wrong scale.
      const { carpan } = await paraBirimiAl();
      const cevap = await graf(ayar, `${hesap}/campaigns`, {
        name: ad,
        objective: hedef,
        status: "PAUSED",
        special_ad_categories: "[]",
        daily_budget: String(minorUnit(gunlukButce, carpan)),
      });
      /**
       * A RESPONSE WITHOUT AN ID IS NOT A SUCCESS. `String(cevap.id)` turned undefined
       * into the string "undefined", and the tool reported "campaign created (id
       * undefined)": the user believed the campaign existed, while every subsequent call
       * made with that id went to a meaningless identifier. The campaign may or may not
       * really have been created — neither of those is "created".
       */
      const yeniId = cevap?.id;
      if (yeniId === undefined || yeniId === null || String(yeniId).trim() === "") {
        throw new Error(
          "Meta kampanya oluşturma yanıtında kimlik (id) yok — kampanyanın kurulup " +
            "kurulmadığı doğrulanamıyor. TEKRAR DENEME; önce Meta Ads Manager'dan kontrol et."
        );
      }
      return { id: String(yeniId), ad, durum: "PAUSED", gunlukButce };
    },
    async kampanyaOku(kampanyaId) {
      const c = await graf(ayar, kampanyaId, { fields: "id,name,status,daily_budget" }, "GET");
      const durum = kampanyaDurumu(c?.status);
      const temel: MetaKampanya = {
        id: String(c.id),
        ad: String(c.name ?? ""),
        durum: durum.durum,
        durumNotu: durum.not,
      };

      /**
       * If the currency could not be read, NO BUDGET FIGURE IS PRODUCED. Returning a note
       * rather than throwing is deliberate: the consuming gate, set_meta_campaign_status,
       * already prints its "budget could not be verified" refusal along with the reason, so
       * the operator learns what to fix.
       */
      let carpan: number;
      try {
        carpan = (await paraBirimiAl()).carpan;
      } catch (e) {
        // Defence in depth: the text at the source is already cleaned, but this boundary
        // faces the agent, so the cleaning is applied here too.
        return { ...temel, butceNotu: hataTemizle(hataMetni(e), ayar.metaToken) };
      }

      const kampanyaDuzeyi = minorTutar(c?.daily_budget);
      if (kampanyaDuzeyi !== undefined) {
        return { ...temel, gunlukButce: minorUnitTers(kampanyaDuzeyi, carpan), butceKaynagi: "kampanya" };
      }
      /**
       * IF THE FIELD EXISTS BUT CANNOT BE READ, we do NOT descend to the ad sets: the
       * field's presence says the campaign is CBO, and its unreadability is an uncertainty.
       * Falling back to the ad-set total would produce a figure without ever counting the
       * real budget at campaign level.
       */
      if (c?.daily_budget !== undefined && c?.daily_budget !== null) {
        return {
          ...temel,
          butceKaynagi: "kampanya",
          butceNotu:
            `kampanya düzeyi günlük bütçe okunamadı ` +
            `(beklenmedik değer: ${gorunurDeger(c.daily_budget)})`,
        };
      }

      // Not CBO: the budget is on the ad sets. Rather than looking at one field and
      // declaring it unreadable, we descend to the second layer.
      const setler = await reklamSetiButcesi(ayar, kampanyaId, carpan);
      return {
        ...temel,
        gunlukButce: setler.gunlukButce,
        butceKaynagi: "reklam-setleri",
        butceNotu: setler.not,
      };
    },
    async butceGuncelle(kampanyaId, gunlukButce) {
      // On the write path too, the multiplier is read first; if it cannot be read, the
      // request is NEVER sent.
      const { carpan } = await paraBirimiAl();
      await graf(ayar, kampanyaId, { daily_budget: String(minorUnit(gunlukButce, carpan)) });
    },
    async durumDegistir(kampanyaId, durum) {
      await graf(ayar, kampanyaId, { status: durum });
    },
  };
  gercekKanalAnahtari = anahtar;
  return gercekKanal;
}
