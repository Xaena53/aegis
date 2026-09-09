// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Regression: an unreadable account must be MARKED unreadable no matter which path put
 * it into the list first.
 *
 * `hesaplariTopla` walks the top-level accounts and, for every manager, folds that
 * manager's descendants into the same list. So one account can be reached TWICE: once as
 * a manager's `customer_client` row, and once on its own turn from
 * `listAccessibleCustomers`. When its OWN query throws (USER_PERMISSION_DENIED is the
 * everyday case), the catch used to flag the account ONLY if it was not already in the
 * list - so whether the row carried `erisilemedi` depended on nothing but the order the
 * API happened to return the accounts in.
 *
 * That is a fail-OPEN, not a cosmetic gap. `erisilemedi` is the single field that
 * `resources.ts` (reklamHesaplari) and `prompts.ts` (the customerId completion) filter
 * on. An unflagged row is handed to the agent as a usable ad account, the
 * `aegis://accounts` resource claims the unreadable accounts are "erisilemedi=true
 * olarak listede" when no such flag exists, and `list_accounts` (read.ts, which does
 * mark the row in place) reports the very same account as unreachable. Two surfaces of
 * one server, contradicting each other about money-spending accounts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AdsContext, type HesapKaydi } from "../src/adsClient.js";

const AYAR = {
  developerToken: "t",
  clientId: "c",
  clientSecret: "s",
  refreshToken: "r",
  writeEnabled: true,
  maxDailyBudget: 500,
  simSwapWindowHours: 72,
  reachCheck: false,
  devSwapCheck: false,
  callFwdCheck: false,
} as any;

interface SahteHesap {
  id: string;
  ad: string;
  yonetici: boolean;
  cocuklar?: SahteHesap[];
  /** Every query against this account throws, as a permission-denied account does. */
  patlasin?: boolean;
}

function torunlar(h: SahteHesap): SahteHesap[] {
  return (h.cocuklar ?? []).flatMap((c) => [c, ...torunlar(c)]);
}

/**
 * A fake Google Ads API. The manager's own row comes back at level 0 like the real
 * `customer_client` query returns it, and a manager's listing does NOT throw just
 * because one of its children is unreadable - only that child's OWN query does. That is
 * exactly what makes the two arrival paths differ.
 */
function baglam(ustDuzey: SahteHesap[]) {
  const ctx = new AdsContext(AYAR);
  const hepsi = ustDuzey.flatMap((h) => [h, ...torunlar(h)]);
  (ctx as any).api = {
    async listAccessibleCustomers() {
      return { resource_names: ustDuzey.map((h) => `customers/${h.id}`) };
    },
    Customer({ customer_id }: { customer_id: string }) {
      return {
        async query(q: string) {
          const h = hepsi.find((x) => x.id === customer_id);
          if (!h) return [];
          if (h.patlasin) throw new Error("USER_PERMISSION_DENIED");
          if (q.includes("FROM customer_client")) {
            const satirlar = [h, ...torunlar(h)].map((c) => ({
              customer_client: { id: c.id, descriptive_name: c.ad, manager: c.yonetici },
            }));
            const limit = Number(/LIMIT (\d+)/.exec(q)?.[1] ?? satirlar.length);
            return satirlar.slice(0, limit);
          }
          return [{ customer: { descriptive_name: h.ad, manager: h.yonetici } }];
        },
      };
    },
  };
  return ctx;
}

/**
 * One account object shared by BOTH paths: it is a child of the MCC and is also listed
 * as accessible in its own right, and its own query throws.
 */
function paylasilanKurulum(): { mcc: SahteHesap; ortak: SahteHesap } {
  const ortak: SahteHesap = { id: "2222222222", ad: "Müşteri A", yonetici: false, patlasin: true };
  const mcc: SahteHesap = { id: "1111111111", ad: "Ajans MCC", yonetici: true, cocuklar: [ortak] };
  return { mcc, ortak };
}

/** The filter resources.ts (reklamHesaplari) and prompts.ts apply, character for character. */
function onerilenler(liste: HesapKaydi[]): string[] {
  return liste.filter((h) => !h.yonetici && !h.erisilemedi).map((h) => h.id);
}

test("KRİTİK: MCC'nin çocuğu olarak listeye giren okunamayan hesap YERİNDE işaretlenir", async () => {
  /**
   * The MCC is walked first, so 2222222222 is already in the list (name and `yonetici`
   * read from the parent) when its own turn comes and its query throws. Before the fix
   * the catch saw it in `gorulen`, wrote it to `okunamayan` and left the row untouched.
   */
  const { mcc, ortak } = paylasilanKurulum();
  const { liste, eksik } = await baglam([mcc, ortak]).tumHesaplar();

  const kayit = liste.find((h) => h.id === "2222222222");
  assert.ok(kayit, "okunamayan hesap listeden düşmemeli");
  assert.equal(
    kayit!.erisilemedi,
    true,
    "KRİTİK: kendi sorgusu patlayan hesap, listeye MCC üzerinden girmiş olsa da işaretlenmeli"
  );
  assert.deepEqual(eksik.okunamayan, ["2222222222"]);
  assert.equal(eksik.var, true, "bir hesap okunamadıysa sonuç EKSİK'tir");
});

test("KRİTİK: işaret, hesabın önerilen reklam hesapları arasından DÜŞMESİNİ sağlar", async () => {
  /**
   * The flag is not decoration: it is the only thing standing between an account whose
   * every call comes back USER_PERMISSION_DENIED and the completion list the agent picks
   * a campaign target from.
   */
  const { mcc, ortak } = paylasilanKurulum();
  const { liste } = await baglam([mcc, ortak]).tumHesaplar();

  assert.deepEqual(
    onerilenler(liste),
    [],
    "KRİTİK: kendi sorgusu izin hatası veren hesap tamamlamada/kaynakta önerilmemeli"
  );
});

test("KRİTİK: işaretleme, hesapların dönüş SIRASINDAN bağımsızdır", async () => {
  /**
   * The two orders are the same account set and the same failure; only
   * listAccessibleCustomers' ordering differs, and no safety decision may hang on it.
   */
  const a = paylasilanKurulum();
  const mccOnce = await baglam([a.mcc, a.ortak]).tumHesaplar();

  const b = paylasilanKurulum();
  const bozukOnce = await baglam([b.ortak, b.mcc]).tumHesaplar();

  assert.equal(
    mccOnce.liste.find((h) => h.id === "2222222222")?.erisilemedi,
    bozukOnce.liste.find((h) => h.id === "2222222222")?.erisilemedi,
    "KRİTİK: aynı arıza, sıraya göre farklı işaretlenemez"
  );
  assert.deepEqual(onerilenler(mccOnce.liste), onerilenler(bozukOnce.liste));
  assert.deepEqual(onerilenler(bozukOnce.liste), []);
});

test("işaretlenen hesap listede TEKRARLANMAZ", async () => {
  /**
   * Flagging must happen in place. Pushing a second "(detay okunamadi)" row would show
   * the user the same account twice and leave one unflagged copy behind.
   */
  const { mcc, ortak } = paylasilanKurulum();
  const { liste } = await baglam([mcc, ortak]).tumHesaplar();

  assert.equal(liste.filter((h) => h.id === "2222222222").length, 1, "hesap listeye bir kez girmeli");
  assert.deepEqual(liste.map((h) => h.id).sort(), ["1111111111", "2222222222"]);
});

test("sağlam hesap yanlışlıkla erisilemedi işaretlenmez", async () => {
  /**
   * The counter-case: the same two-path shape with nothing failing. A fix that flags too
   * eagerly would hide a perfectly usable ad account from every completion, which is the
   * "you have no accounts" failure the envelope exists to prevent.
   */
  const ortak: SahteHesap = { id: "2222222222", ad: "Müşteri A", yonetici: false };
  const mcc: SahteHesap = { id: "1111111111", ad: "Ajans MCC", yonetici: true, cocuklar: [ortak] };
  const { liste, eksik } = await baglam([mcc, ortak]).tumHesaplar();

  assert.equal(liste.find((h) => h.id === "2222222222")?.erisilemedi, undefined);
  assert.deepEqual(onerilenler(liste), ["2222222222"], "okunabilen reklam hesabı önerilmeye devam etmeli");
  assert.equal(eksik.var, false, "hiçbir şey okunamamış değilse liste TAM'dır");
});
