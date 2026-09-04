// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUDGET ALLOCATION ACROSS CHANNELS — the Growth Brain step that splits the goal between
 * channels.
 *
 * Why this is a step of its own: "50 lira a day" is not the answer to a goal, it is an input
 * to one. A goal with strong search intent — selling something people are already looking for
 * — and a discovery-led goal — introducing something nobody is searching for — do not put the
 * same budget in the same place. This step makes the model take that decision and records its
 * REASONING.
 *
 * TWO HARD RULES, both applications of the principle of not making things up:
 *
 * 1) ONLY A CONFIGURED CHANNEL GETS A SHARE. Without a Meta token, Meta is not an option;
 *    telling the model "allocate to Meta as well if you like" would produce a plan that
 *    cannot run and then present it to the user as a recommendation. The set of usable
 *    channels comes from the environment
 *    OKUNUR, modele sorulmaz.
 *
 * 2) THE TOTAL CANNOT EXCEED THE NUMBER THE OPERATOR GAVE. This matters more than it looks:
 *    the server's budget ceiling is PER CAMPAIGN. On an account with a 50-lira ceiling, an
 *    allocation of 40 to Google plus 40 to Meta has both parts under the ceiling, and comes
 *    to 80 in total — so on a multi-channel plan the clamp does not protect the total by
 *    itself. We have to protect it here.
 */

/** The spend channels this repository supports. A new platform is added here. */
export const KANALLAR = /** @type {const} */ (["google", "meta"]);

/**
 * Returns the channels that are ACTUALLY configured in the environment.
 *
 * Google is always present: without credentials the CLI does not start at all. Meta counts
 * only when its token AND its ad account are both defined — with either missing the tool
 * already fails closed, so allocating a share to it would be an empty promise.
 */
export function kullanilabilirKanallar(env = process.env) {
  const kanallar = ["google"];
  if (env.AEGIS_META_TOKEN?.trim() && env.AEGIS_META_AD_ACCOUNT_ID?.trim()) {
    kanallar.push("meta");
  }
  return kanallar;
}

const DAGITIM_SEMA = {
  tur: "nesne",
  zorunlu: ["dagitim"],
  alanlar: {
    dagitim: "dizi",
  },
};

/**
 * Validates the allocation. It throws on a violation — there is NO silent repair.
 *
 * Silently repairing — normalising the shares and carrying on — is tempting and wrong: the
 * model failing to make the total add up is a sign that the rest of the plan cannot be
 * trusted either. If we fix the number, the user looks at a plan the model produced and sees
 * a budget we produced.
 */
export function dagitimDogrula(dagitim, toplamButce, kanallar) {
  if (!Array.isArray(dagitim) || dagitim.length === 0) {
    throw new Error("Bütçe dağıtımı boş — en az bir kanala pay verilmeli.");
  }

  const gorulen = new Set();
  let toplam = 0;

  for (const pay of dagitim) {
    const kanal = String(pay?.kanal ?? "").trim().toLowerCase();
    if (!kanallar.includes(kanal)) {
      throw new Error(
        `Bütçe dağıtımında yapılandırılmamış kanal: "${kanal}". ` +
          `Kullanılabilir kanallar: ${kanallar.join(", ")}. ` +
          `Yapılandırılmamış bir kanala pay ayırmak, çalışmayacak bir planı öneri diye sunmaktır.`
      );
    }
    if (gorulen.has(kanal)) {
      throw new Error(`Bütçe dağıtımında "${kanal}" kanalı birden çok kez geçiyor.`);
    }
    gorulen.add(kanal);

    const tutar = Number(pay?.gunlukButce);
    if (!Number.isFinite(tutar) || tutar <= 0) {
      throw new Error(`"${kanal}" kanalının günlük bütçesi geçersiz: ${pay?.gunlukButce}`);
    }
    if (!String(pay?.gerekce ?? "").trim()) {
      throw new Error(
        `"${kanal}" kanalına pay verilmiş ama GEREKÇE yok. ` +
          `Gerekçesiz dağıtım denetlenemez: kullanıcı neden o kanala o parayı koyduğumuzu göremez.`
      );
    }
    toplam += tutar;
  }

  /**
   * A tolerance of one cent: if the model splits into 33.33 + 33.33 + 33.34, the total may
   * not come out exact in floating point. The tolerance is kept NARROW — one cent is the
   * rounding allowance, and anything wider starts to hide a real mistake.
   */
  const sapma = Math.abs(toplam - toplamButce);
  if (sapma > 0.01) {
    throw new Error(
      `Bütçe dağıtımının toplamı verilen bütçeyle uyuşmuyor: ${toplam.toFixed(2)} ≠ ${toplamButce}. ` +
        `Sunucudaki bütçe tavanı KAMPANYA BAŞINADIR, yani çok kanallı bir planda toplamı ` +
        `kendiliğinden korumaz — toplamı burada tutmak zorundayız.`
    );
  }

  return dagitim.map((p) => ({
    kanal: String(p.kanal).trim().toLowerCase(),
    gunlukButce: Number(p.gunlukButce),
    gerekce: String(p.gerekce).trim(),
  }));
}

/**
 * Splits the budget between the channels.
 *
 * With only one channel the model is not asked at all: there is nothing to ask, and spending
 * an LLM call on a question whose answer is already known adds both cost and failure
 * surface.
 */
export async function butceDagit({ hedef, toplamButce, kanallar, arastirma }, { jsonUret2 }) {
  if (kanallar.length === 1) {
    return [
      {
        kanal: kanallar[0],
        gunlukButce: toplamButce,
        gerekce: `Tek yapılandırılmış kanal (${kanallar[0]}) — bölünecek başka kanal yok.`,
      },
    ];
  }

  const sistem =
    "Sen bir dijital pazarlama bütçe stratejistisin. Verilen günlük bütçeyi, YALNIZ " +
    "kullanılabilir kanallar arasında böleceksin. Kurallar: (1) payların TOPLAMI verilen " +
    "bütçeye EŞİT olmalı; (2) yalnız listelenen kanalları kullan; (3) her pay için kısa ve " +
    "somut bir gerekçe yaz — 'daha iyi performans' gibi boş ifadeler değil, hedefe özgü bir " +
    "sebep. Arama niyeti yüksek hedeflerde arama ağırlığı, keşif/farkındalık hedeflerinde " +
    "sosyal ağırlık mantıklıdır. Yalnız JSON döndür.";

  const kullanici =
    `Hedef: ${hedef}\n` +
    `Günlük toplam bütçe: ${toplamButce}\n` +
    `Kullanılabilir kanallar: ${kanallar.join(", ")}\n` +
    `Pazar özeti: ${arastirma?.pazarOzeti ?? "(yok)"}\n` +
    `Hedef kitle: ${arastirma?.hedefKitle ?? "(yok)"}\n\n` +
    `Şu biçimde JSON döndür:\n` +
    `{"dagitim":[{"kanal":"google","gunlukButce":30,"gerekce":"..."}]}`;

  const cevap = await jsonUret2(sistem, kullanici, DAGITIM_SEMA);
  return dagitimDogrula(cevap?.dagitim, toplamButce, kanallar);
}

/** A one-line summary for the report and the terminal. */
export function dagitimOzeti(dagitim) {
  return dagitim.map((p) => `${p.kanal}: ${p.gunlukButce}`).join(" · ");
}

/**
 * Selects the share of the channel the campaign will ACTUALLY be created on — by NAME, not
 * by position.
 *
 * WHY BY NAME: the creation path in uygulama.mjs calls only create_search_campaign, so it
 * writes to Google under every condition. When the share was taken with `dagitim[0]`, the
 * MODEL was deciding the ordering: if it returned the allocation as
 * `[{kanal:"meta"},{kanal:"google"}]`, the approval screen and the report both said "the
 * SHARE of the 'meta' channel", while what got created was a GOOGLE campaign built with
 * Meta's share. The operator was getting something other than what they approved, and at the
 * wrong figure too.
 *
 * When there is no share, or it is zero, `undefined` is returned and the caller stops with a
 * closed failure. Quietly falling back to another channel's share would let the bug back in
 * through a different door.
 */
export function uygulanacakPay(dagitim, kanal) {
  if (!Array.isArray(dagitim)) return undefined;
  const pay = dagitim.find((p) => p?.kanal === kanal);
  return pay && typeof pay.gunlukButce === "number" && pay.gunlukButce > 0 ? pay : undefined;
}
