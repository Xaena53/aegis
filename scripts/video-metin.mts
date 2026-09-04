// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fixed strings the video demo PRINTS TO THE SCREEN — free of side effects.
 *
 * They live in their own file because scripts/video-demo.mts is an ENTRY POINT: importing
 * it runs the demo and makes real CAMARA calls. Pulling the text from there would take the
 * test suite onto the network on every run.
 */

/**
 * The ENGLISH rendering of the SIM-swap refusal — this is what carries comprehension in
 * the video.
 *
 * The product's own messages are in Turkish. That is not an omission: it is the language of
 * the market it was built for, and multilingual refusals are on the roadmap. But the jury is
 * international, and in the video's most important frame a message nobody can read does not
 * count as evidence. The raw Turkish output is NOT removed from the screen — it sits
 * directly below, labelled "raw output".
 *
 * A FAITHFUL TRANSLATION: it says neither more nor less than the raw output does. Written by
 * hand, it can drift, so test/videoCevirisi.test.ts pins both against the same MEASURABLE
 * facts — the window, the signal's name, that no prompt was shown, and that no spend was
 * applied.
 */
export const INGILIZCE_RET = [
  "REFUSED: NETWORK VERIFICATION FAILED — the approver's SIM card changed",
  "within the last 72 hours (GSMA Open Gateway SIM Swap). This is the classic",
  "sign of an account-takeover attack; the approval prompt was never shown.",
  "No spend increase is applied until the account owner confirms. The user",
  "MUST be told about this.",
];
