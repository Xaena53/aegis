// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dependency audit gate — `npm run audit`.
 *
 * WHY THIS EXISTS INSTEAD OF PLAIN `npm audit`
 *
 * A plain `npm audit --audit-level=moderate` is a gate with only two settings: it either
 * fails the build on an advisory nobody can act on, or it is turned down to `high` and
 * stops seeing the class of problem it was installed to catch. Neither is a decision;
 * both are ways of not making one.
 *
 * This gate keeps the moderate threshold and allows named exceptions. An exception is not
 * a silence: it carries the reason, the measurement behind it, and a review date, and it
 * is printed on every run so it stays visible in the CI log rather than decaying into a
 * flag nobody remembers setting.
 *
 * Anything not on the list, at moderate or above, still fails the build.
 */
import { execFileSync } from "node:child_process";

/**
 * Advisories we have examined and consciously accept, for now.
 *
 * Adding an entry requires three things: why the vulnerable path is not reachable from
 * how we use the package, what was measured, and when the decision should be revisited.
 * "We could not fix it" alone is not a reason to add one.
 */
const KABUL_EDILENLER = [
  {
    advisory: "GHSA-528h-pc64-c93x",
    paket: "stream-json",
    siddet: "moderate",
    neden:
      "Reached only through google-ads-api, which uses stream-json to parse Google's own " +
      "API responses — not attacker-supplied JSON. The advisory is a quadratic slowdown in " +
      "the pick/ignore/filter/replace filters on deeply nested input; nothing in this " +
      "repository passes untrusted JSON through those filters.",
    olcum:
      "Forcing the patched stream-json@3.6.0 through npm overrides was tried and measured: " +
      "42 unit tests failed and the live Google smoke test dropped from 9/9 to 0/1. " +
      "google-ads-api@24.1.0 is already the latest release and pins the 1.x line, so there " +
      "is no upgrade path that keeps the client working. npm's own suggested fix " +
      "(google-ads-api@20.0.0) is a downgrade.",
    gozdenGecir: "2026-12-01",
  },
];

/**
 * Runs npm audit and returns the parsed report.
 *
 * Windows needs both halves of this. npm there is `npm.cmd`, a shell shim, so the bare
 * name fails with ENOENT; and since Node's 2024 hardening of child_process, running a
 * `.cmd` at all requires `shell: true`, otherwise it fails again with EINVAL. Both were
 * measured — the gate reported a crash instead of a verdict on the platform this
 * repository is developed on.
 *
 * `shell: true` is safe here and only here: every argument is a literal in this file.
 * Nothing from the environment, the network or a package name reaches this command line.
 *
 * A non-zero exit is the normal case when findings exist, so the report is read from the
 * thrown error's stdout rather than treated as a failure.
 */
function denetimCiktisi() {
  const win = process.platform === "win32";
  const secenek = { encoding: "utf8", shell: win };
  try {
    return JSON.parse(execFileSync(win ? "npm.cmd" : "npm", ["audit", "--omit=dev", "--json"], secenek));
  } catch (e) {
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  }
}

const SIDDET_SIRASI = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const ESIK = SIDDET_SIRASI.moderate;

const rapor = denetimCiktisi();
const kabulEdilenIdler = new Set(KABUL_EDILENLER.map((k) => k.advisory));

const engelleyen = [];
const gorulen = [];

for (const [paket, v] of Object.entries(rapor.vulnerabilities ?? {})) {
  if ((SIDDET_SIRASI[v.severity] ?? 0) < ESIK) continue;
  /**
   * `via` either names other packages (a transitive path) or carries the advisory itself.
   * Only entries with their own advisory are judged: a package listed purely because a
   * dependency of it is vulnerable would otherwise be counted twice, once under a name
   * that has no advisory to allow.
   */
  const advisoryler = (v.via ?? []).filter((x) => typeof x === "object" && x.url);
  if (advisoryler.length === 0) continue;
  for (const a of advisoryler) {
    const id = String(a.url).split("/").pop();
    gorulen.push({ paket, id, siddet: v.severity, baslik: a.title });
    if (!kabulEdilenIdler.has(id)) engelleyen.push({ paket, id, siddet: v.severity, baslik: a.title });
  }
}

const yaz = (s = "") => process.stdout.write(s + "\n");

yaz("");
yaz("  Dependency audit — production dependencies, moderate and above");
yaz("");

if (KABUL_EDILENLER.length) {
  yaz("  Accepted, with reasons:");
  for (const k of KABUL_EDILENLER) {
    const hala = gorulen.some((g) => g.id === k.advisory);
    yaz(`    ${k.advisory}  ${k.paket}  (${k.siddet})${hala ? "" : "  — NO LONGER REPORTED"}`);
    yaz(`      why      : ${k.neden}`);
    yaz(`      measured : ${k.olcum}`);
    yaz(`      review by: ${k.gozdenGecir}`);
    /**
     * An exception that has outlived its advisory is not harmless: it is a standing
     * permission for a problem that no longer exists, and the next person to read the
     * list cannot tell which entries are still load-bearing.
     */
    if (!hala) {
      yaz("      NOTE: this advisory is no longer reported — remove the exception.");
    }
  }
  yaz("");
}

if (engelleyen.length === 0) {
  yaz(`  PASS — ${gorulen.length} finding(s), all accounted for.`);
  yaz("");
  process.exit(0);
}

yaz("  FAIL — advisories with no recorded decision:");
for (const b of engelleyen) {
  yaz(`    ${b.id}  ${b.paket}  (${b.siddet})`);
  yaz(`      ${b.baslik ?? ""}`);
}
yaz("");
yaz("  Fix it, or add it to KABUL_EDILENLER in scripts/bagimlilikDenetimi.mjs with a");
yaz("  reason, a measurement and a review date. An entry without those is not a decision.");
yaz("");
process.exit(1);
