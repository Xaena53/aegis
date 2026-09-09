// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAYNAK HİJYENİ — kaynak dosyalara ham denetim baytı sızmasın.
 *
 * NEDEN VAR: bu tuzağa bu depoda İKİ KEZ düşüldü. Önbellek anahtarlarında ayraç olarak
 * ham bir 0x00 baytı kullanıldı (`${token}<NUL>${phone}`), çünkü NUL bir kimlik bilgisinde
 * asla geçmez ve mükemmel bir ayraç gibi görünür. Sonuç: git dosyayı İKİLİ sayar. O andan
 * itibaren `git diff` çalışmaz, kod incelemesi imkânsızlaşır, `grep` dosyayı atlar ve
 * gizlice bozulan bir satır kimsenin gözüne çarpmaz. İlk seferinde networkTrust.ts,
 * ikincisinde meta/client.ts — yani "bir kez düzelttik" yetmiyor.
 *
 * Ayraç fikri doğru; yazımı yanlıştı. Ters-bölü + u0000 kaçış dizisi aynı çalışma-anı dizesini üretir
 * ve dosya metin olarak kalır. Bu test o tercihi kalıcı kılar.
 *
 * Kapsam bilerek geniş (tüm src + test + scripts): bir sonraki kopyala-yapıştır nereye
 * düşerse düşsün yakalansın.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const KOK = fileURLToPath(new URL("..", import.meta.url));
// ".mts" belongs here: scripts/agDogrula.mts and scripts/metaDogrula.mts are real, running
// surfaces, and without this extension the walker skipped them silently — a hole in a test
// whose whole point is that the next copy-paste gets caught wherever it lands.
const UZANTILAR = new Set([".ts", ".mts", ".mjs", ".js", ".json", ".md"]);
// Data files and prose cannot leak a secret at run time; the leak walker below reads code only.
const KOD_UZANTILARI = new Set([".ts", ".mts", ".mjs", ".js"]);
const ATLA = new Set(["node_modules", "dist", ".git", "coverage"]);

function dosyalar(
  dizin: string,
  uzantilar: Set<string> = UZANTILAR,
  toplanan: string[] = []
): string[] {
  for (const ad of readdirSync(dizin)) {
    if (ATLA.has(ad)) continue;
    const tam = join(dizin, ad);
    if (statSync(tam).isDirectory()) dosyalar(tam, uzantilar, toplanan);
    else if (uzantilar.has(extname(ad))) toplanan.push(tam);
  }
  return toplanan;
}

test("kaynak dosyalarda HAM NUL baytı yok (git dosyayı ikili sayar)", () => {
  const suclular: string[] = [];
  for (const yol of dosyalar(join(KOK, "src")).concat(
    dosyalar(join(KOK, "test")),
    dosyalar(join(KOK, "scripts"))
  )) {
    const ham = readFileSync(yol);
    if (ham.includes(0x00)) suclular.push(yol.slice(KOK.length));
  }
  assert.deepEqual(
    suclular,
    [],
    `Ham NUL baytı içeren dosya(lar): ${suclular.join(", ")}.\n` +
      `git bu dosyaları İKİLİ sayar: diff çalışmaz, inceleme imkânsızlaşır, grep atlar.\n` +
      `Ayraç olarak NUL kullanmak istiyorsan '\\u0000' escape'ini yaz — aynı çalışma-anı ` +
      `dizesini üretir, dosya metin kalır.`
  );
});

/**
 * İMZA ANAHTARININ TEK KAYNAĞI.
 *
 * NEDEN VAR: çerez imzaları eskiden `process.env.AEGIS_MASTER_KEY ?? ""` ile
 * üretiliyordu. Bunun sinsi yanı, imzalama ile doğrulamanın AYNI ifadeyi kullanması:
 * anahtar hiç yokken bile her şey kendi içinde tutarlı çalışırdı — çerezler herkesin
 * bilebileceği BOŞ DİZEYLE imzalanır, tek bir test bile kızarmazdı. Bugün açılışta
 * eksik anahtar süreci öldürdüğü için bu yola ulaşılamıyor; ama "bugün ulaşılamıyor"
 * bir bekçi değildir, o yüzden kaynak düzeyinde çivileniyor: HMAC anahtarı yalnız
 * store.ts'in kırpan/fırlatan masterKeyText()'inden gelebilir.
 */
test("HMAC imzaları anahtarı ham env'den değil masterKeyText()'ten alır", () => {
  const suclular: string[] = [];
  let sayac = 0;
  for (const yol of dosyalar(join(KOK, "src")).concat(dosyalar(join(KOK, "scripts")))) {
    const metin = readFileSync(yol, "utf8");
    const desen = /createHmac\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*,\s*([A-Za-z0-9_.$]+\(\)|[^),]+)/g;
    for (const m of metin.matchAll(desen)) {
      sayac++;
      const anahtar = m[1].trim();
      if (anahtar !== "masterKeyText()") suclular.push(`${yol.slice(KOK.length)}: ${anahtar}`);
    }
  }
  assert.ok(sayac >= 2, `createHmac çağrısı bulunamadı (${sayac}) — desen bayatlamış olabilir`);
  assert.deepEqual(
    suclular,
    [],
    `HMAC anahtarını masterKeyText() dışından alan çağrı(lar): ${suclular.join(", ")}.
` +
      `Ham env okumak, anahtar yokken çerezleri boş dizeyle imzalar ve bu kendi içinde ` +
      `tutarlı olduğu için hiçbir testi kızartmaz.`
  );
});

/**
 * NOTHING RAW FROM UPSTREAM, AND NO CREDENTIAL, REACHES THE TERMINAL.
 *
 * NEDEN VAR: the contract says raw upstream text, tokens and PII never reach the agent, the
 * log or the terminal. Until now the only mechanised proof of that sentence was
 * config.test.ts's SIZINTI_SENTINELI, and it watches exactly three functions of
 * src/config.ts (parseBool / parseNumEnv / parseBudgetCap). Every script under scripts/ —
 * the surface that actually runs in front of an audience — was unguarded. It was not a
 * theoretical hole: get-refresh-token.mjs used to print the WHOLE Google token response
 * (`JSON.stringify(tokens)`, live adwords-scoped access_token included) into the operator's
 * terminal, and the suite stayed green. That line was fixed by hand; nothing stopped the
 * next paste of it. This file already walked scripts/ — a walker with no secret rule.
 *
 * WHAT IS CHECKED: every DIRECT terminal writer (console.log/error/warn/info/debug/dir/
 * table/trace, process.stdout|stderr.write) plus every `throw new Error`, because a script's
 * top-level catch prints exactly that message and a tool's throw is handed to the agent
 * verbatim — AND every call to a LOCAL ONE-HOP WRAPPER around one of those. The wrapper hop
 * is not decoration: scripts/agDogrula.mts and scripts/metaDogrula.mts each define
 * `const kayit = (…) => { console.log(…) }`, and 32 of those two files' 55 output points go
 * through it. A scanner that knew only the direct shapes read the two live-verification
 * scripts — the ones that talk to Nokia and Meta holding real tokens — as almost empty. A
 * function counts as a wrapper when it is declared in the SAME file (`const f = (…) => …` or
 * `function f(…)`) and its own body calls a direct writer.
 *
 * The call's arguments are read as EXPRESSION text: literals, comments and regexes are
 * masked out first, so naming a credential in a sentence ("GOOGLE_ADS_DEVELOPER_TOKEN
 * zorunlu") is not a finding while interpolating one is.
 *
 * Three markers say "unknown upstream content or a secret is being printed":
 *   JSON.stringify(...)  — dumps every field of a body we did not build, tokens included
 *   .text()              — the raw response body
 *   a credential-named identifier — the value itself
 * The credential list is THIS repo's vocabulary, not a generic OAuth one: `token`/`tokens`
 * (the Meta access-token parameter threaded through src/meta/client.ts, and the name Google's
 * token response is held under in scripts/), `jeton` (src/prompts.ts), plus any
 * SCREAMING_CASE name ending in _TOKEN/_SECRET/_KEY/_PASSWORD/_PHONE — `CLIENT_SECRET` is
 * get-refresh-token.mjs's own constant and `process.env.AEGIS_NAC_TOKEN` is how the network
 * token is read. Searching only for English camelCase in a Turkish-named codebase looks like
 * a measurement and is not one.
 *
 * A credential may still appear as an ARGUMENT of a redactor (hataTemizle(metin, token)) —
 * that is the prescribed way to remove it — so redactor call regions are masked before the
 * credential check. A redactor is recognised by a WHOLE name root (temizle / maskele / gizle
 * / redact / sanitize); a substring rule used to accept a bare `izle(` too, and `izle` is
 * src/networkTrust.ts's trace-tagging helper, which redacts nothing. JSON.stringify/.text()
 * are NOT excused by a redactor: the redactor removes the token, not the rest of a body that
 * was never ours to print.
 *
 * Exemptions are pinned to an exact code fragment, not to a file, and they clear THAT
 * FRAGMENT ONLY: whatever is left of the expression is scanned again, so appending a second
 * secret to an exempt line (`…=${tokens.refresh_token} access=${tokens.access_token}`) is
 * still a finding. A permit that forgave whatever gets pasted next to it is the opposite of
 * a pinned exemption. An exemption that matches nothing fails too, so a line that gets fixed
 * cannot leave a standing permit behind for the next one.
 *
 * LIMITS, stated so nobody reads more into a green run: (1) the walker sees the printing call
 * itself — `const s = JSON.stringify(govde);` on one line and `console.log(s)` on the next
 * passes; it nails the shape that was actually written here twice, not data flow. (2) The
 * wrapper hop is exactly ONE level deep and same-file: a wrapper around a wrapper, or one
 * imported from another module, is not followed. (3) Scope is src/ + scripts/, the code that
 * runs in front of an operator; test/ prints only fixtures we wrote ourselves.
 */

/** One terminal-facing call whose arguments carry unknown upstream content or a secret. */
type Sizinti = { satir: number; isaret: string; ifade: string };

/** Calls that put their arguments in front of an operator or an agent, with no hop. */
const DOGRUDAN_YAZICI =
  "(?:console\\.(?:log|error|warn|info|debug|dir|table|trace)" +
  "|process\\.(?:stdout|stderr)\\.write|throw new Error)";

/** Identifiers that hold a secret in THIS repo. Case-sensitive on purpose: the
 * SCREAMING_CASE branch would swallow every ordinary word under `i`. */
const KIMLIK =
  /\b(?:access_token|refresh_token|id_token|client_secret|clientSecret|refreshToken|accessToken|apiKey|api_key|developerToken|nacToken|metaToken|masterKey|masterKeyText|approverPhone|password|sifre|jeton|tokens?)\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:TOKEN|SECRET|KEY|PASSWORD|PHONE)\b/;

/** Whole name roots, not substrings — see the redactor paragraph above. */
const TEMIZLEYICI_KAYNAK =
  "\\b[A-Za-z0-9_$]*(?:[Tt]emizle|[Mm]askele|[Gg]izle|[Rr]edact|[Ss]anitize)[A-Za-z0-9_$]*\\s*\\(";

/**
 * Masks string/template literal text, comments and regex literals with spaces, keeping the
 * length and the newlines intact so offsets keep pointing at the original source. What
 * survives is executable expression text — including `${...}` interpolations, which is
 * precisely where a leak has to happen.
 */
function kodKismi(kaynak: string): string {
  const c = kaynak.split("");
  const gizle = (a: number, b: number) => {
    for (let i = a; i < b && i < c.length; i++) if (c[i] !== "\n") c[i] = " ";
  };
  // Brace depth of every open template literal; 0 means "inside its literal text".
  const sablon: number[] = [];
  // Regex-vs-division heuristic: a "/" is a division only after a value.
  const ANAHTAR = /(?:return|typeof|case|await|yield|new|throw|delete|void|in|of|do|else)$/;
  let sonAnlamli = "";
  let sonKelime = "";
  let i = 0;
  while (i < kaynak.length) {
    const ch = kaynak[i];
    const derinlik = sablon.length ? sablon[sablon.length - 1] : -1;
    if (derinlik === 0) {
      if (ch === "\\") {
        gizle(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "`") {
        gizle(i, i + 1);
        sablon.pop();
        i++;
        sonAnlamli = "x";
        sonKelime = "";
        continue;
      }
      if (ch === "$" && kaynak[i + 1] === "{") {
        gizle(i, i + 2);
        sablon[sablon.length - 1] = 1;
        i += 2;
        sonAnlamli = "{";
        sonKelime = "";
        continue;
      }
      gizle(i, i + 1);
      i++;
      continue;
    }
    if (ch === "/" && kaynak[i + 1] === "/") {
      const s = kaynak.indexOf("\n", i);
      const son = s < 0 ? kaynak.length : s;
      gizle(i, son);
      i = son;
      continue;
    }
    if (ch === "/" && kaynak[i + 1] === "*") {
      const s = kaynak.indexOf("*/", i + 2);
      const son = s < 0 ? kaynak.length : s + 2;
      gizle(i, son);
      i = son;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < kaynak.length) {
        if (kaynak[j] === "\\") {
          j += 2;
          continue;
        }
        if (kaynak[j] === ch || kaynak[j] === "\n") {
          j++;
          break;
        }
        j++;
      }
      gizle(i, j);
      i = j;
      sonAnlamli = "x";
      sonKelime = "";
      continue;
    }
    if (ch === "`") {
      gizle(i, i + 1);
      sablon.push(0);
      i++;
      continue;
    }
    if (ch === "/" && (!/[A-Za-z0-9_$)\]]/.test(sonAnlamli) || ANAHTAR.test(sonKelime))) {
      let j = i + 1;
      let sinif = false;
      while (j < kaynak.length) {
        const k = kaynak[j];
        if (k === "\\") {
          j += 2;
          continue;
        }
        if (k === "\n") break;
        if (k === "[") sinif = true;
        else if (k === "]") sinif = false;
        else if (k === "/" && !sinif) {
          j++;
          while (j < kaynak.length && /[a-z]/.test(kaynak[j])) j++;
          break;
        }
        j++;
      }
      gizle(i, j);
      i = j;
      sonAnlamli = "x";
      sonKelime = "";
      continue;
    }
    if (derinlik > 0) {
      if (ch === "{") sablon[sablon.length - 1] = derinlik + 1;
      else if (ch === "}") {
        sablon[sablon.length - 1] = derinlik - 1;
        if (derinlik - 1 === 0) {
          gizle(i, i + 1);
          i++;
          sonAnlamli = "x";
          sonKelime = "";
          continue;
        }
      }
    }
    if (!/\s/.test(ch)) {
      sonAnlamli = ch;
      sonKelime = /[A-Za-z0-9_$]/.test(ch) ? sonKelime + ch : "";
    }
    i++;
  }
  return c.join("");
}

/**
 * Argument text of the call whose "(" sits at `acik`. The 2000-char ceiling is a fail-closed
 * stop: if the masking ever mis-reads a file, the window stays bounded and the worst case is
 * a loud false finding — never a silent miss.
 */
function cagriBolgesi(kod: string, acik: number): string {
  let derinlik = 0;
  const son = Math.min(kod.length, acik + 2000);
  for (let i = acik; i < son; i++) {
    if (kod[i] === "(") derinlik++;
    else if (kod[i] === ")") {
      derinlik--;
      if (derinlik === 0) return kod.slice(acik + 1, i);
    }
  }
  return kod.slice(acik + 1, son);
}

/** Text between the braces of the block whose "{" sits at `acik`; bounded like cagriBolgesi. */
function blokBolgesi(kod: string, acik: number): string {
  let derinlik = 0;
  const son = Math.min(kod.length, acik + 6000);
  for (let i = acik; i < son; i++) {
    if (kod[i] === "{") derinlik++;
    else if (kod[i] === "}") {
      derinlik--;
      if (derinlik === 0) return kod.slice(acik + 1, i);
    }
  }
  return kod.slice(acik + 1, son);
}

/** A function body starting at `bas`: a braced block, or the single expression of a
 * concise arrow (`const yaz = (s) => console.log(s)`), which is just as much a writer. */
function govdeMetni(kod: string, bas: number): string {
  let i = bas;
  while (i < kod.length && /\s/.test(kod[i])) i++;
  if (kod[i] === "{") return blokBolgesi(kod, i);
  const satirSonu = kod.indexOf("\n", i);
  return kod.slice(i, Math.min(kod.length, satirSonu < 0 ? kod.length : satirSonu, i + 300));
}

/**
 * Names of local one-hop terminal wrappers declared in this file. Without these the scan is
 * nearly blind on scripts/agDogrula.mts and scripts/metaDogrula.mts, whose `kayit()` carries
 * 32 of their 55 output points.
 */
function yaziciSarmalayicilar(kod: string): string[] {
  const adlar = new Set<string>();
  const dogrudan = new RegExp(DOGRUDAN_YAZICI + "\\s*\\(");
  const tanim =
    /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=;\n]*)?=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z0-9_$]+)\s*(?::[^=;\n]*)?=>|\b(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*\([^()]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = tanim.exec(kod))) {
    if (dogrudan.test(govdeMetni(kod, m.index + m[0].length))) adlar.add(m[1] ?? m[2]);
  }
  return [...adlar];
}

/**
 * The marker this argument text carries, or "" when it carries none. Split out of the scan
 * because the exemption check re-runs it on what is LEFT after the exempt fragment is
 * removed — an exemption clears its own fragment and nothing else.
 */
function isaretle(bolge: string): string {
  if (/JSON\.stringify\s*\(/.test(bolge)) return "JSON.stringify (upstream gövdenin tamamı)";
  if (/\.\s*text\s*\(\s*\)/.test(bolge)) return ".text() (ham upstream gövdesi)";
  // A secret handed TO a redactor is the prescribed shape; blank those regions out so
  // only a secret that survives into the output is left standing.
  const temizleyici = new RegExp(TEMIZLEYICI_KAYNAK, "g");
  let kalan = bolge;
  let t: RegExpExecArray | null;
  while ((t = temizleyici.exec(kalan))) {
    const ic = cagriBolgesi(kalan, t.index + t[0].length - 1);
    const bit = t.index + t[0].length + ic.length + 1;
    kalan = kalan.slice(0, t.index) + " ".repeat(bit - t.index) + kalan.slice(bit);
  }
  return KIMLIK.test(kalan) ? "kimlik bilgisi adı taşıyan ifade" : "";
}

/** Number of terminal-facing call regions seen — a staleness alarm for the scan below. */
let sizintiYaziciSayaci = 0;
/** …and how many of those were reached only through a local wrapper. Zero here would mean
 * the wrapper hop stopped working, which is invisible in the findings list. */
let sizintiSarmalayiciSayaci = 0;

function sizintiTara(kaynak: string): Sizinti[] {
  const kod = kodKismi(kaynak);
  const sarmalayici = yaziciSarmalayicilar(kod);
  // "$" is legal in an identifier and means end-of-input in a pattern, so it must be escaped.
  const ekstra = sarmalayici.length
    ? "|(?:" + sarmalayici.map((a) => a.split("$").join("\\$")).join("|") + ")"
    : "";
  // The lookbehind keeps `obj.kayit(` and `xkayit(` from passing as the local `kayit`.
  const yazici = new RegExp("(?<![.\\w$])(?:" + DOGRUDAN_YAZICI + ekstra + ")\\s*\\(", "g");
  const dogrudanMi = new RegExp("^" + DOGRUDAN_YAZICI);
  const bulgular: Sizinti[] = [];
  let m: RegExpExecArray | null;
  while ((m = yazici.exec(kod))) {
    sizintiYaziciSayaci++;
    if (!dogrudanMi.test(m[0])) sizintiSarmalayiciSayaci++;
    const bolge = cagriBolgesi(kod, m.index + m[0].length - 1);
    const satir = kod.slice(0, m.index).split("\n").length;
    const isaret = isaretle(bolge);
    if (isaret) bulgular.push({ satir, isaret, ifade: bolge.replace(/\s+/g, " ").trim() });
  }
  return bulgular;
}

/**
 * Pinned exemptions. `parca` must occur in the flagged expression, so an exempt file gets no
 * blanket permit; a different leak in the same file still fails — and, since the expression
 * is re-scanned with `parca` removed, so does a second secret appended to the exempt line.
 */
const SIZINTI_MUAFLARI: Array<{ dosya: string; parca: string; gerekce: string }> = [
  {
    dosya: "scripts/demo-agent.mjs",
    parca: "JSON.stringify(block.input)",
    gerekce:
      "Basılan nesne upstream gövdesi değil, ajanın BİZİM aracımıza gönderdiği ve şemayla " +
      "doğrulanan argümanlardır; demonun amacı hangi aracın hangi girdiyle çağrıldığını " +
      "seyirciye göstermektir ve çıktı 120 karaktere kırpılır.",
  },
  {
    dosya: "scripts/get-refresh-token.mjs",
    parca: "tokens.refresh_token",
    gerekce:
      ".env yazılamadığında operatörün KENDİ jetonunu kendi terminaline basar — bu betiğin " +
      "tek ürünü o satırdır, başka teslim yolu yoktur. Upstream gövdesi değil, tek alan.",
  },
  {
    dosya: "scripts/metaDogrula.mts",
    parca: "!m.includes(ayar.metaToken)",
    gerekce:
      "Jeton BASILMIYOR, aranıyor: bu ifade Meta'nın hata metninin jetonu içermediğini " +
      "doğrulayan sızıntı testinin ta kendisidir ve kayit()'e giden değer bir boolean'dır. " +
      "Bu satır, sarmalayıcı taraması açıldığında görünür oldu.",
  },
];

/**
 * The exemption covering `ifade` in `goreli`, or -1. The named fragment is cleared and the
 * REMAINDER is scanned again: a permit is for one fragment, never for the line it sits on.
 */
function muafIndeksi(goreli: string, ifade: string): number {
  return SIZINTI_MUAFLARI.findIndex(
    (mu) =>
      mu.dosya === goreli &&
      ifade.includes(mu.parca) &&
      isaretle(ifade.split(mu.parca).join(" ")) === ""
  );
}

test("terminale/ajana yazan hiçbir çağrı ham upstream gövdesi ya da kimlik bilgisi basmaz", () => {
  const kullanilan = new Set<number>();
  const suclular: string[] = [];
  for (const yol of dosyalar(join(KOK, "src"), KOD_UZANTILARI).concat(
    dosyalar(join(KOK, "scripts"), KOD_UZANTILARI)
  )) {
    const goreli = yol.slice(KOK.length).split("\\").join("/");
    for (const b of sizintiTara(readFileSync(yol, "utf8"))) {
      const muafIndeks = muafIndeksi(goreli, b.ifade);
      if (muafIndeks >= 0) {
        kullanilan.add(muafIndeks);
        continue;
      }
      suclular.push(`${goreli}:${b.satir} [${b.isaret}] ${b.ifade.slice(0, 160)}`);
    }
  }

  assert.ok(
    sizintiYaziciSayaci >= 100,
    `Terminale yazan çağrı bulunamadı (${sizintiYaziciSayaci}) — tarayıcı bayatlamış ya da ` +
      `maskeleme bozulmuş olabilir; sıfıra yakın bir sayı "temiz" değil, "kör" demektir.`
  );
  assert.ok(
    sizintiSarmalayiciSayaci >= 50,
    `Yerel yazıcı sarmalayıcısı üzerinden görülen çağrı yok denecek kadar az ` +
      `(${sizintiSarmalayiciSayaci}) — sarmalayıcı adımı çalışmıyor demektir. Bu adım ` +
      `olmadan agDogrula.mts/metaDogrula.mts'in çıktı noktalarının çoğu taranmaz ve bu ` +
      `kayıp bulgular listesinde HİÇ görünmez, çünkü taranmayan satır bulgu üretmez.`
  );
  assert.deepEqual(
    suclular,
    [],
    `Ham upstream gövdesi ya da kimlik bilgisi basan çağrı(lar):\n  ${suclular.join("\n  ")}\n` +
      `Sözleşme: ham upstream metin, jeton, tam telefon numarası, PII asla ajana/loga/terminale ` +
      `sızmaz. Yalnız KENDİ ürettiğin alanları bas; upstream metnini önce bir temizleyiciden ` +
      `geçir (hataTemizle gibi) ve gövdenin tamamını asla stringify etme. Bilinçli bir ` +
      `istisnaysa SIZINTI_MUAFLARI'na gerekçesiyle ekle.`
  );

  const bayat = SIZINTI_MUAFLARI.filter((_, i) => !kullanilan.has(i)).map(
    (mu) => `${mu.dosya}: ${mu.parca}`
  );
  assert.deepEqual(
    bayat,
    [],
    `Hiçbir şeyle eşleşmeyen muafiyet(ler): ${bayat.join(", ")}. Satır düzeltildiyse muafiyet ` +
      `de silinmeli — duran bir izin, bir sonraki sızıntıyı sessizce affeder.`
  );
});

/**
 * The scanner is itself a piece of behaviour, so it gets locked like one: known-bad shapes
 * must be caught and known-good ones must stay quiet. Without this, a masking bug would turn
 * the scan above into a green light that measures nothing — the exact failure mode the
 * "bilinmiyor 0 değildir" rule exists to prevent. The samples are plain quoted strings, never
 * template literals, so they are source TEXT and not code.
 */
const SIZINTI_KOTU_ORNEKLER: Array<[string, string]> = [
  [
    "gövdenin tamamı stringify",
    'console.error("refresh_token dönmedi: " + JSON.stringify(tokens));',
  ],
  ["ham gövde metni", "console.log(`Google yanıtı: ${await res.text()}`);"],
  ["jeton değeri yazdırılıyor", "console.error(`NaC çağrısı: ${ayar.nacToken}`);"],
  [
    "throw da terminale/ajana çıkar",
    "throw new Error(`kimlik alınamadı: ${JSON.stringify(tokens)}`);",
  ],
  [
    "çok satırlı yazıcı",
    'console.error(\n  [\n    "  Meta hatası:",\n    `  ${JSON.stringify(govde)}`,\n  ].join("\\n")\n);',
  ],
  // Wrapper hop. Both shapes exist in scripts/: a braced arrow (kayit) and a concise one.
  [
    "yerel yazıcı sarmalayıcısı ham gövdeyi basar",
    'const kayit = (ad, gecti, not) => {\n  console.log(`  ${ad}\\n     ${not}`);\n};\n' +
      'kayit("ham gövde", false, JSON.stringify(await res.text()));',
  ],
  [
    "tek satırlık sarmalayıcı jetonu basar",
    "const yaz = (s) => console.log(s);\nyaz(`jeton: ${ayar.metaToken}`);",
  ],
  ["console.dir da terminale yazar", "console.dir(tokens);"],
  // This repo's own secret-carrying names, which a generic OAuth word list does not know.
  ["deponun kendi jeton adı", "console.error(`NaC çağrısı: ${jeton}`);"],
  ["Meta istemcisinin token parametresi", "console.error(`Meta hatası: ${token}`);"],
  ["ortam değişkeni adıyla okunan sır", "console.log(`değer: ${process.env.AEGIS_NAC_TOKEN}`);"],
  ["betiğin kendi CLIENT_SECRET sabiti", "console.error(`gizli: ${CLIENT_SECRET}`);"],
  ["izle() bir temizleyici değildir", "console.error(`iz: ${izle(ayar.nacToken)}`);"],
];

const SIZINTI_TEMIZ_ORNEKLER: Array<[string, string]> = [
  [
    "kimlik adı yalnız düz metinde",
    'console.error("GOOGLE_ADS_DEVELOPER_TOKEN zorunlu — .env dosyasına ekle.");',
  ],
  ["maskelenmiş değer", "console.error(`[aegis] cihaz hatası (${maskeli}): ${detay}`);"],
  [
    "sır yalnız temizleyicinin argümanı",
    "console.error(`hata: ${hamMetinTemizle(ayar.approverPhone, detay)}`);",
  ],
  ["yorum kod değildir", "// console.log(JSON.stringify(tokens));"],
  [
    "tırnak içeren regex ayrıştırmayı bozmaz",
    'const kacir = (s) => s.replace(/[&<>"\']/g, "*");\nconsole.log(`durum: ${maskeli}`);',
  ],
  ["terminale gitmeyen stringify (bilinen sınır)", "const kopya = JSON.stringify(govde);"],
  [
    "terminale yazmayan yerel yardımcı yazıcı değildir",
    "const izle = (ham) => ({ ...ham, etiket: 1 });\nizle(ayar.nacToken);",
  ],
  [
    "gerçek temizleyiciler hâlâ muaf",
    "console.error(`x: ${musteriIdMaskele(id)} ${hataTemizle(m, token)}`);",
  ],
];

test("sızıntı tarayıcısı: bilinen kötü kalıpları yakalar, temizlere dokunmaz", () => {
  for (const [ad, ornek] of SIZINTI_KOTU_ORNEKLER) {
    assert.ok(sizintiTara(ornek).length > 0, `yakalanmalıydı ama sessiz kaldı: ${ad}`);
  }
  for (const [ad, ornek] of SIZINTI_TEMIZ_ORNEKLER) {
    const bulunan = sizintiTara(ornek);
    assert.deepEqual(
      bulunan.map((b) => b.isaret),
      [],
      `yanlış alarm: ${ad} — ${JSON.stringify(bulunan)}`
    );
  }
});

/**
 * The wrapper hop, nailed to the two files it exists for. A synthetic sample proves the
 * MECHANISM; this proves it lands on the real surface, and it pins the docblock's counts so
 * the sentence cannot quietly go stale. Red in BOTH directions on purpose: if the hop breaks,
 * `kayit` drops out of the wrapper list; if those scripts move, rename or inline their
 * writer, the numbers move and whoever changed them is told to fix the sentence — rather than
 * finding out through a silent drop in coverage, which produces no finding at all.
 */
const SARMALAYICI_BETIKLERI = ["scripts/agDogrula.mts", "scripts/metaDogrula.mts"];
/** Docblock: "32 of those two files' 55 output points go through it." */
const SARMALAYICI_CIKTI = { sarmalayici: 32, toplam: 55 };

test("yazıcı sarmalayıcı adımı canlı doğrulama betiklerine gerçekten değiyor", () => {
  let sarmalayici = 0;
  let dogrudan = 0;
  for (const yol of SARMALAYICI_BETIKLERI) {
    const kod = kodKismi(readFileSync(join(KOK, yol), "utf8"));
    assert.ok(
      yaziciSarmalayicilar(kod).includes("kayit"),
      `${yol}: kayit() bir yazıcı sarmalayıcısı olarak görülmüyor — ya sarmalayıcı adımı ` +
        `bozuldu ya da betik çıktısını başka bir yardımcıya taşıdı.`
    );
    sarmalayici += (kod.match(/(?<![.\w$])kayit\s*\(/g) ?? []).length;
    dogrudan += (
      kod.match(
        /(?<![.\w$])(?:console\.(?:log|error|warn|info|debug|dir|table|trace)|process\.(?:stdout|stderr)\.write|throw new Error)\s*\(/g
      ) ?? []
    ).length;
  }
  assert.deepEqual(
    { sarmalayici, toplam: sarmalayici + dogrudan },
    SARMALAYICI_CIKTI,
    `${SARMALAYICI_BETIKLERI.join(" + ")} çıktı noktaları değişmiş. Bu dosyanın docblock'u ` +
      `"32 of those two files' 55 output points go through it" diyor; sayı değiştiyse CÜMLEYİ ` +
      `de düzelt — ölçülmemiş bir gerekçe, gerekçe değildir.`
  );
});

/**
 * A pinned exemption forgives its own fragment, not the line. Without this the most likely
 * shape of a repeat leak — "add one more field to the line that already has a permit" —
 * would be waved through by the very mechanism written to prevent standing permits.
 */
test("muafiyet yalnız adını verdiği parçayı affeder, satırın gerisini değil", () => {
  const dosya = "scripts/get-refresh-token.mjs";
  assert.ok(
    muafIndeksi(dosya, "tokens.refresh_token") >= 0,
    "muaf satırın kendisi affedilmeliydi"
  );
  assert.equal(
    muafIndeksi(dosya, "tokens.refresh_token tokens.access_token"),
    -1,
    "aynı ifadeye eklenen İKİNCİ sır affedildi — muafiyet parçaya değil satıra çakılmış"
  );
  assert.equal(
    muafIndeksi(dosya, "tokens.refresh_token CLIENT_SECRET"),
    -1,
    "muaf parçanın yanına yapıştırılan ALL-CAPS sır affedildi"
  );
  assert.equal(
    muafIndeksi("scripts/prova.mjs", "tokens.refresh_token"),
    -1,
    "muafiyet başka bir dosyada da geçerli sayıldı — dosya çivisi tutmuyor"
  );
});
