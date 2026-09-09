// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KARAR GÜNLÜĞÜ DEPOYA SIZMAZ — .gitignore belgelerin gösterdiği yolu kapsar.
 *
 * NEDEN VAR: depo PUBLIC. `AEGIS_DECISION_LOG` açıkken yazılan her JSONL satırı
 * MASKELENMEMİŞ reklam hesabı kimliği (hesapId), riske giren tutarı (tutar) ve maskeli
 * onaylayıcı numarasını taşıyor. Belgeler operatöre örnek yolu tam da depo kökünde
 * veriyor (docs/DEMO.md, docs/CAMARA.md → `./kararlar.jsonl`, `$PWD/kararlar.jsonl`).
 * .gitignore'da uzun süre yalnız `*.log` vardı; demodan sonraki rutin bir
 * `git add -A && git commit && git push` bu dosyayı GitHub'a sokardı. CI'daki gitleaks
 * yakalayamaz: hesap kimliği de tutar da bir sır kalıbına uymaz. rapor-brain-*.md için
 * aynı risk görülüp kapatılmıştı; karar günlüğü aynı sınıftaydı ama kapsanmamıştı.
 *
 * BEKÇİ ÇİFT YÖNLÜDÜR — sahte güvence üretmesin diye:
 *   • .gitignore kuralı silinir ya da daraltılırsa → KIRMIZI (kural tarafı),
 *   • belgeler yolu/uzantıyı değiştirirse, yeni ad kapsanmaz → KIRMIZI (belge tarafı),
 *   • belgeler depo-içi örneği tümden bırakırsa → KIRMIZI (gerekçe bayatladı, gözden geçir),
 *   • src/kararGunlugu.ts devretme son ekini değiştirirse → KIRMIZI (devir kuşağı açıkta),
 *   • günlük satırı artık hesabı/tutarı taşımıyorsa → KIRMIZI (.gitignore yorumu bayat).
 *
 * Kardeş bekçiler: test/derlemeGirdileri.test.ts (derleme girdileri),
 * test/kaynakHijyeni.test.ts (kaynak dosyalara ham denetim baytı sızmasın).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KOK = fileURLToPath(new URL("..", import.meta.url));
const oku = (ad: string): string => readFileSync(join(KOK, ad), "utf8");

const GITIGNORE = oku(".gitignore");
const GUNLUK_KAYNAGI = oku("src/kararGunlugu.ts");

/* ------------------------------------------------------------------ *
 * Minimal .gitignore evaluator.
 *
 * Deliberately NOT a shell-out to `git check-ignore`: the guard has to stay red for the
 * right reason inside a tarball, a container build or a vendored checkout where no .git
 * directory exists. Only the pattern syntax this file actually uses is supported —
 * `*`, `?`, `[...]`, negation and the trailing-slash directory form.
 * ------------------------------------------------------------------ */
interface Kural {
  olumsuz: boolean;
  dizinSadece: boolean;
  ankrajli: boolean;
  re: RegExp;
}

function globRegex(kalip: string): RegExp {
  let re = "";
  for (let i = 0; i < kalip.length; i++) {
    const c = kalip[i];
    if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const kapanis = kalip.indexOf("]", i + 1);
      if (kapanis === -1) {
        re += "\\[";
      } else {
        re += kalip.slice(i, kapanis + 1);
        i = kapanis;
      }
    } else {
      re += c.replace(/[.+^${}()|\\/\]]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function kurallariAyristir(metin: string): Kural[] {
  const kurallar: Kural[] = [];
  for (const ham of metin.split("\n")) {
    const satir = ham.trim();
    if (satir === "" || satir.startsWith("#")) continue;
    const olumsuz = satir.startsWith("!");
    let desen = olumsuz ? satir.slice(1) : satir;
    const dizinSadece = desen.endsWith("/");
    if (dizinSadece) desen = desen.slice(0, -1);
    const govde = desen.startsWith("/") ? desen.slice(1) : desen;
    kurallar.push({
      olumsuz,
      dizinSadece,
      ankrajli: govde.includes("/"),
      re: globRegex(govde),
    });
  }
  return kurallar;
}

const KURALLAR = kurallariAyristir(GITIGNORE);

/** Would git ignore this repo-relative FILE path? Last matching rule wins, as in git. */
function yoksayiliyorMu(yol: string): boolean {
  const taban = yol.slice(yol.lastIndexOf("/") + 1);
  let sonuc = false;
  for (const k of KURALLAR) {
    if (k.dizinSadece) continue;
    if (k.re.test(k.ankrajli ? yol : taban)) sonuc = !k.olumsuz;
  }
  return sonuc;
}

/* ------------------------------------------------------------------ *
 * What the documentation tells the operator to do.
 * ------------------------------------------------------------------ */
const ATLA = new Set(["node_modules", "dist", ".git", "coverage"]);

function belgeDosyalari(dizin: string, toplanan: string[] = []): string[] {
  for (const ad of readdirSync(dizin)) {
    if (ATLA.has(ad)) continue;
    const tam = join(dizin, ad);
    if (statSync(tam).isDirectory()) belgeDosyalari(tam, toplanan);
    else if (ad.endsWith(".md") || ad === ".env.example") toplanan.push(tam);
  }
  return toplanan;
}

interface Ornek {
  dosya: string;
  ham: string;
  taban: string;
}

/** Every `AEGIS_DECISION_LOG=<path>` example in prose that lands inside the working tree. */
function depoIciOrnekler(): Ornek[] {
  const bulunan: Ornek[] = [];
  for (const tam of belgeDosyalari(KOK)) {
    const metin = readFileSync(tam, "utf8");
    for (const eslesme of metin.matchAll(/AEGIS_DECISION_LOG=([^\s\\`"']+)/g)) {
      const ham = eslesme[1];
      // A path is OUTSIDE the tree when it is absolute (/var/log/..., /data/... or a
      // Windows drive) — that is the operator's own disk, not this repository.
      if (ham.startsWith("/") || ham.startsWith("~") || /^[A-Za-z]:/.test(ham)) continue;
      const temiz = ham.replace(/^\$PWD\//, "").replace(/^\.\//, "");
      if (temiz.includes("..")) continue;
      bulunan.push({
        dosya: tam.slice(KOK.length).replace(/\\/g, "/"),
        ham,
        taban: temiz.slice(temiz.lastIndexOf("/") + 1),
      });
    }
  }
  return bulunan;
}

const ORNEKLER = depoIciOrnekler();

/** The rollover suffix as src/kararGunlugu.ts actually writes it (`${hedef}.1` → ".1"). */
function devretmeSonEki(): string {
  const eslesme = /renameSync\(hedef,\s*`\$\{hedef\}([^`]+)`\)/.exec(GUNLUK_KAYNAGI);
  assert.ok(
    eslesme,
    "src/kararGunlugu.ts içinde renameSync(hedef, ...) devretme çağrısı bulunamadı — " +
      "devretme yeniden yazıldıysa bu bekçinin kapsadığı kuşak adı da değişmiştir, kontrol et"
  );
  return eslesme[1];
}

test("belgeler karar günlüğünü DEPO KÖKÜNE yazdırmayı hâlâ öneriyor (gerekçe taze)", () => {
  assert.ok(
    ORNEKLER.length > 0,
    "Hiçbir belgede depo-içi bir AEGIS_DECISION_LOG örneği kalmamış. Bu bekçinin ve " +
      ".gitignore'daki gerekçe yorumunun dayanağı buydu; ikisini de gözden geçir — " +
      "sessizce yeşil kalan bir bekçi sahte güvencedir"
  );
});

test("belgelerdeki her depo-içi karar günlüğü yolu .gitignore'da kapsanır", () => {
  for (const o of ORNEKLER) {
    assert.ok(
      yoksayiliyorMu(o.taban),
      `${o.dosya} operatöre AEGIS_DECISION_LOG=${o.ham} diyor ama "${o.taban}" ` +
        ".gitignore'da kapsanmıyor. Depo PUBLIC ve satır maskelenmemiş hesap kimliği + " +
        "tutar taşıyor: ya deseni ekle ya da belgeyi depo dışı bir yola çevir"
    );
  }
});

test("devretme kuşağı da kapsanır — *.jsonl tek başına .1'i tutmaz", () => {
  const sonEk = devretmeSonEki();
  assert.notEqual(sonEk, "", "devretme son eki boş — dosya kendi üstüne devrediyor olamaz");
  for (const o of ORNEKLER) {
    const kusak = o.taban + sonEk;
    assert.ok(
      yoksayiliyorMu(kusak),
      `Devretme "${kusak}" üretiyor (src/kararGunlugu.ts) ama bu ad .gitignore'da ` +
        "kapsanmıyor: tavana varan günlüğün eski kuşağı izlenmeyen olarak açıkta kalır"
    );
  }
});

test(".gitignore gerekçesi bayat değil — satır hâlâ hesabı ve tutarı taşıyor", () => {
  for (const alan of ["hesapId", "tutar"]) {
    assert.ok(
      new RegExp(`\\b${alan}: kayit\\.${alan}\\b`).test(GUNLUK_KAYNAGI),
      `src/kararGunlugu.ts artık "${alan}" alanını yazmıyor — .gitignore'daki gerekçe ` +
        "yorumu bayatladı, ya yorumu güncelle ya da kuralı yeniden değerlendir"
    );
    assert.ok(
      GITIGNORE.includes(alan),
      `.gitignore'daki karar günlüğü gerekçesi "${alan}" alanını anmıyor — kural neden ` +
        "var olduğunu söylemezse bir sonraki temizlikte silinir"
    );
  }
});

test("kural fazla geniş değil — izlenen kaynak dosyalarını süpürmez", () => {
  for (const izlenen of [
    "README.md",
    "package.json",
    "src/kararGunlugu.ts",
    "test/faz3GitIgnore.test.ts",
    ".gitignore",
  ]) {
    assert.equal(
      yoksayiliyorMu(izlenen),
      false,
      `${izlenen} .gitignore tarafından yok sayılıyor — bir desen fazla genişletilmiş, ` +
        "izlenen kaynak sessizce commit dışı kalır"
    );
  }
});
