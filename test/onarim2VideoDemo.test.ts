// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ROUND-2 cover for the JURY VIDEO's refusal screen (scripts/video-demo.mts).
 *
 * WHAT THE REVIEWER FOUND, AND WHAT THIS FILE CAN AND CANNOT ANSWER.
 *
 * Both defects the reviewer reported live OUTSIDE this repository — the prototype deck and
 * the rendered video/frames under the MENA folder still carry the old
 * "elicitation prompts shown: 0" wording and still advertise `npm run video` as the command
 * that counts. Neither is reachable from here, and both are recorded as handed over.
 *
 * What IS in reach is the residue the round-1 repair left inside this script. The repair
 * replaced one sentence the script could not observe
 *
 *     elicitation prompts shown: 0
 *
 * with another sentence the script also does not observe:
 *
 *     approval prompt: never reached   the refusal returns before any prompt
 *
 * The second sentence is TRUE today — src/approval.ts short-circuits on `ag.engel` long
 * before it ever calls `elicitInput` — but truth is not the point. Under the vouching rule a
 * line may only be printed by something able to CONTRADICT it, and nothing did:
 * video-demo.mts calls `agDogrula` directly, so it never touches the approval layer whose
 * ordering it narrates, and no test bound the sentence to that ordering. Re-order
 * approval.ts tomorrow and the jury screen would go on saying "never reached" while a prompt
 * was shown.
 *
 * So this file supplies the missing contradiction: while the screen makes the claim, the
 * approval layer must really return on a gate refusal BEFORE any prompt is requested. The
 * guard is conditional in the same way as the round-1 one — drop the claim from the screen
 * and it lifts itself; it forbids an unbacked claim, not a sentence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const oku = (gorece: string): string => readFileSync(new URL(gorece, import.meta.url), "utf8");

/**
 * Comments are stripped from BOTH sides before anything is measured.
 *
 * On the video side, for the round-1 reason: the fix's own comment quotes the sentences it
 * is explaining, and a scan unable to tell prose from output would fail every honest
 * explanation. On the approval side it is load-bearing for a different reason — approval.ts
 * already names `elicitInput` inside a comment above the code that calls it, and a prose
 * mention drifting above the `ag.engel` return would otherwise fake a violation (or, the
 * other way round, hide one).
 */
const kodu = (kaynak: string): string =>
  kaynak.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** The screen's claim about a module it never calls. */
const EKRAN_IDDIASI = [/never reached/iu, /before any prompt/iu];

/**
 * The gate-refusal short-circuit the claim depends on.
 *
 * The optional brace is not cosmetic. This watchdog exists to catch a REORDERING, and a
 * watchdog that also fires when someone merely wraps the same return in a block would be
 * teaching the team to ignore it — the surest way to lose a guard is to make it cry wolf.
 */
const RET_KISA_DEVRESI = /if\s*\(\s*ag\.engel\s*\)\s*\{?\s*return\b/u;

/** Asking a human. If this call cannot be located, the ordering cannot be judged at all. */
const ISTEM_CAGRISI = /\belicitInput\s*\(/u;

type Sonuc = { readonly tamam: boolean; readonly neden: string };

/**
 * Decides whether a gate refusal provably returns before any prompt is requested.
 *
 * FAIL-CLOSED IN BOTH UNKNOWN DIRECTIONS. A missing short-circuit is a refusal, and so is a
 * prompt call that can no longer be found: "the sentence cannot be checked any more" is not
 * permission to keep printing it. Returning `true` on an unrecognised approval layer would
 * let a rename retire the guard in silence — the exact move this whole round is about.
 */
function retIstemdenOnceMi(approvalKaynagi: string): Sonuc {
  const kod = kodu(approvalKaynagi);
  const ret = kod.search(RET_KISA_DEVRESI);
  const istem = kod.search(ISTEM_CAGRISI);
  if (ret === -1) {
    return {
      tamam: false,
      neden:
        "src/approval.ts'te ağ kapısı reddinde erken dönen `if (ag.engel) return` bulunamadı — " +
        "ret artık istemden önce dönüyor olmayabilir.",
    };
  }
  if (istem === -1) {
    return {
      tamam: false,
      neden:
        "src/approval.ts'te istem çağrısı (elicitInput) bulunamadı — sıralama DOĞRULANAMIYOR. " +
        "Bilinmiyor, 'sorun yok' değildir: ekrandaki iddia dayanaksız kalır.",
    };
  }
  return ret < istem
    ? { tamam: true, neden: "ret kısa devresi istem çağrısından önce" }
    : {
        tamam: false,
        neden:
          "src/approval.ts'te istem çağrısı, ağ kapısı reddinin ERKEN DÖNÜŞÜNDEN ÖNCE geliyor — " +
          "reddedilen bir koşuda insana istem gösterilebilir.",
      };
}

/** Does the jury screen still make the claim this guard exists to back? */
const ekranIddiaEdiyorMu = (videoKaynagi: string): boolean =>
  EKRAN_IDDIASI.some((k) => k.test(kodu(videoKaynagi)));

test("KRİTİK: ekrandaki 'istem hiç gösterilmedi' iddiası approval.ts'in sırasına ÇİVİLİ", () => {
  const iddiaVar = ekranIddiaEdiyorMu(oku("../scripts/video-demo.mts"));
  /**
   * Self-lifting premise: if the jury screen stops claiming the prompt was never reached,
   * there is nothing left to back and the guard steps aside.
   */
  if (!iddiaVar) return;

  const sonuc = retIstemdenOnceMi(oku("../src/approval.ts"));
  assert.equal(
    sonuc.tamam,
    true,
    `video-demo.mts jüri ekranında "approval prompt: never reached — the refusal returns ` +
      `before any prompt" yazıyor, ama bu cümlenin dayandığı sıra artık doğrulanamıyor: ` +
      `${sonuc.neden} Ya sırayı geri getir ya da ekrandaki iddiayı kaldır; gözlemlenmeyen ` +
      `bir olguyu jüriye ölçüm gibi sunma.`
  );
});

test("gözcü gerçekten kırmızıya düşebiliyor: üç bozulma da yakalanıyor", () => {
  /**
   * The three ways the sentence can go stale, checked against synthetic sources so the
   * mutation costs no edit to a file another change may be in flight on. Without this, a
   * watchdog that always returns `tamam: true` would look exactly like a passing one.
   */
  const saglam = [
    "const ag = await agDogrula(ozet.agAyar, ozet.risk);",
    'if (ag.engel) return { onaylandi: false, kanal: "ag", mesaj: ag.engel };',
    "const cevap = await server.server.elicitInput({ message: soru });",
  ].join("\n");
  assert.equal(retIstemdenOnceMi(saglam).tamam, true, "sağlam sıra yeşil olmalı");

  const kisaDevreYok = saglam.replace(
    'if (ag.engel) return { onaylandi: false, kanal: "ag", mesaj: ag.engel };',
    "const engelli = Boolean(ag.engel);"
  );
  assert.equal(retIstemdenOnceMi(kisaDevreYok).tamam, false, "erken dönüş silinmiş: KIRMIZI olmalı");

  const sonraDonuyor = [
    "const ag = await agDogrula(ozet.agAyar, ozet.risk);",
    "const cevap = await server.server.elicitInput({ message: soru });",
    'if (ag.engel) return { onaylandi: false, kanal: "ag", mesaj: ag.engel };',
  ].join("\n");
  assert.equal(retIstemdenOnceMi(sonraDonuyor).tamam, false, "istem önce geliyor: KIRMIZI olmalı");

  const istemTaninmiyor = saglam.replace("elicitInput(", "insanaSor(");
  assert.equal(
    retIstemdenOnceMi(istemTaninmiyor).tamam,
    false,
    "istem çağrısı tanınmıyor: sıra doğrulanamaz, fail-closed KIRMIZI olmalı"
  );
});

test("gözcü YORUMA değil KODA bakıyor: prose'daki elicitInput sıralamayı bozmuyor", () => {
  /**
   * approval.ts documents the prompt call in a comment above the branch that makes it. If
   * that prose counted as the call site, a comment moved one paragraph up would fail a
   * correct file — and a team that learns to ignore this watchdog gets nothing from it.
   */
  const yorumlu = [
    "/** the SDK's `elicitInput(` form call is what asks the human */",
    "const ag = await agDogrula(ozet.agAyar, ozet.risk);",
    'if (ag.engel) return { onaylandi: false, kanal: "ag", mesaj: ag.engel };',
    "const cevap = await server.server.elicitInput({ message: soru });",
  ].join("\n");
  assert.equal(retIstemdenOnceMi(yorumlu).tamam, true, "yorumdaki geçiş çağrı sayılmamalı");
});

test("gözcü ŞU AN SİLAHLI: ekran yeniden yazılıp gözcü sessizce düşmüş değil", () => {
  /**
   * The guard above lifts itself when the claim disappears — which is right when the claim
   * really is gone, and a silent hole when the claim was merely REWORDED ("no prompt was
   * displayed" matches none of the patterns). A relaxation nobody tests slides one way only,
   * so the armed state is pinned here: reword the screen and this goes red, forcing the
   * patterns to be updated in the same change instead of the guard evaporating unnoticed.
   *
   * If the script is ever rebuilt to COUNT for real and the claim is dropped on purpose,
   * this assertion is the deliberate place to say so.
   */
  assert.equal(
    ekranIddiaEdiyorMu(oku("../scripts/video-demo.mts")),
    true,
    "video-demo.mts'in ret ekranı artık EKRAN_IDDIASI kalıplarının hiçbirine uymuyor — " +
      "cümle yeniden yazıldıysa kalıbı da güncelle; yoksa yukarıdaki gözcü kendini sessizce " +
      "kaldırır ve jüri ekranı dayanaksız bir iddiayla kalır."
  );
});
