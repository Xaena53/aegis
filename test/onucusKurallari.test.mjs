// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ÖN-UÇUŞ KURALLARI — prova ve duman testinin kendi bekçisi.
 *
 * NEDEN VAR: bu iki kural prova betiğinin içine gömülüydü ve hiçbir test onlara
 * ulaşamıyordu — yani kural yanlış olduğunda süit yeşil kalıyordu. İki somut arıza
 * buradan çıktı:
 *   1) Bayat `dist/` yalnız UYARI sayılıyordu; uyarı çıkış kodunu bozmadığı için prova
 *      bayat ikiliyi koşturup "SAHNEYE HAZIR" diyordu. Sahnede oynayan kod, raporun
 *      ölçtüğü kod değildi.
 *   2) Onaylayıcı numarası yalnız gerçek NaC token dalında sorgulanıyordu; oysa sunucu
 *      SİMÜLASYONDA da numarasız her harcama artışını reddeder. compose'daki iki yorumlu
 *      satırdan yalnız simülasyonu açan operatör yeşil rapor alıp sahnede istem
 *      gösterilmeden reddedilen bir demoya çıkıyordu.
 *
 * Test dosyası .mjs: sınanan modül de .mjs ve tsconfig allowJs açmıyor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agKapisiKarari, derlemeTazeligi } from "../scripts/onucusKurallari.mjs";

const KOK = join(import.meta.dirname, "..");

/** Zaman damgası ELLE kurulur: testin "kim daha yeni" kararı saniyeye bağlı kalmasın. */
function dosyaYaz(yol, icerik, saniyeOnce) {
  writeFileSync(yol, icerik);
  const t = Date.now() / 1000 - saniyeOnce;
  utimesSync(yol, t, t);
}

function sahteProje({ distVar = true, kaynakYeni = false, kaynakVar = true } = {}) {
  const kok = mkdtempSync(join(tmpdir(), "aegis-onucus-"));
  mkdirSync(join(kok, "src"));
  mkdirSync(join(kok, "dist"));
  if (kaynakVar) dosyaYaz(join(kok, "src", "a.ts"), "export const a = 1;\n", kaynakYeni ? 10 : 1000);
  if (distVar) dosyaYaz(join(kok, "dist", "index.js"), "export const a = 1;\n", 100);
  return kok;
}

/* ── 1) Derleme tazeliği — kapalı arıza ──────────────────────────────────────── */

test("bayat dist ENGELDİR (uyarı değil)", () => {
  const kok = sahteProje({ kaynakYeni: true });
  try {
    const k = derlemeTazeligi(kok);
    assert.equal(k.taze, false);
    assert.equal(k.kod, "bayat");
  } finally {
    rmSync(kok, { recursive: true, force: true });
  }
});

test("dist yoksa engeldir", () => {
  const kok = sahteProje({ distVar: false });
  try {
    assert.equal(derlemeTazeligi(kok).kod, "dist-yok");
  } finally {
    rmSync(kok, { recursive: true, force: true });
  }
});

test("mtime okunamıyorsa 'temiz' değil ENGEL sayılır", () => {
  // Kaynak ağacında hiç .ts yoksa tazelik ÖLÇÜLEMEZ. Ölçülemeyen tazelik, taze değildir.
  const kok = sahteProje({ kaynakVar: false });
  try {
    const k = derlemeTazeligi(kok);
    assert.equal(k.taze, false);
    assert.equal(k.kod, "mtime-okunamadi");
  } finally {
    rmSync(kok, { recursive: true, force: true });
  }
});

test("derleme kaynaktan yeniyse geçer", () => {
  const kok = sahteProje({ kaynakYeni: false });
  try {
    const k = derlemeTazeligi(kok);
    assert.equal(k.taze, true, k.not);
  } finally {
    rmSync(kok, { recursive: true, force: true });
  }
});

/* ── 2) Ağ kapısı — kanal değil SONUÇ ölçülür ────────────────────────────────── */

test("simülasyon açık + onaylayıcı numarası yok = ENGEL", () => {
  const k = agKapisiKarari({ simVar: true, tokenVar: false, telefonVar: false, simDeger: "temiz" });
  assert.deepEqual(k, { durum: "kaldi", kod: "onaylayici-numarasi-yok" });
});

test("gerçek token + onaylayıcı numarası yok = ENGEL", () => {
  const k = agKapisiKarari({ simVar: false, tokenVar: true, telefonVar: false, simDeger: "" });
  assert.deepEqual(k, { durum: "kaldi", kod: "onaylayici-numarasi-yok" });
});

test("token ve simülasyon birlikte = çelişki (sunucu her artışı reddeder)", () => {
  const k = agKapisiKarari({ simVar: true, tokenVar: true, telefonVar: true, simDeger: "temiz" });
  assert.equal(k.kod, "yapilandirma-celiskili");
});

test("tanınmayan simülasyon değeri uyarıdır, numara varsa engel değildir", () => {
  const k = agKapisiKarari({ simVar: true, tokenVar: false, telefonVar: true, simDeger: "belki" });
  assert.deepEqual(k, { durum: "uyari", kod: "simulasyon-degeri-tanimsiz" });
});

test("numarası olan simülasyon geçer", () => {
  const k = agKapisiKarari({ simVar: true, tokenVar: false, telefonVar: true, simDeger: "degisti" });
  assert.equal(k.durum, "gecti");
});

/* ── 3) prova.mjs davranışı: bayat ikili KOŞTURULMAZ ─────────────────────────── */

/**
 * Kuralın doğru olması yetmez, betiğin ona UYMASI gerekir. Sahte projeye, çalıştırıldığını
 * dosyaya yazan bir `dist/index.js` konur: koruma kaldırılırsa prova o ikiliyi açar ve
 * damga dosyası ortaya çıkar. Yani bu test yalnız çıkış kodunu değil, "bayat ikili
 * gerçekten koşturulmadı mı" sorusunu ölçer.
 *
 * Geçici proje depo KÖKÜNE kurulur: prova `dotenv`i node_modules'tan çözer.
 */
test("prova bayat dist'te 1 ile çıkar ve ikiliyi HİÇ açmaz", async () => {
  const kok = join(KOK, `.tmp-prova-${process.pid}`);
  rmSync(kok, { recursive: true, force: true });
  mkdirSync(join(kok, "scripts"), { recursive: true });
  mkdirSync(join(kok, "src"), { recursive: true });
  mkdirSync(join(kok, "dist"), { recursive: true });
  const damga = join(kok, "KOSTU.txt");
  try {
    for (const ad of ["prova.mjs", "onucusKurallari.mjs", "demo-senaryo.mjs"]) {
      cpSync(join(KOK, "scripts", ad), join(kok, "scripts", ad));
    }
    writeFileSync(join(kok, "package.json"), JSON.stringify({ engines: { node: ">=22.13.0" } }));
    dosyaYaz(
      join(kok, "dist", "index.js"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(damga)}, "acildi");\n`,
      100
    );
    dosyaYaz(join(kok, "src", "a.ts"), "export const a = 1;\n", 10); // kaynak DAHA YENİ

    const r = await new Promise((coz) => {
      const p = spawn(process.execPath, [join(kok, "scripts", "prova.mjs"), "--musteri", "1234567890"], {
        cwd: kok,
        stdio: ["ignore", "pipe", "pipe"],
        // PATH boşaltılır: `docker` kontrolü ENOENT ile anında uyarıya düşsün, test
        // Docker Desktop'ın açık olup olmamasına bağlı kalmasın.
        env: {
          ...process.env,
          PATH: "",
          Path: "",
          AEGIS_NAC_SIMULATE: "temiz",
          AEGIS_NAC_TOKEN: "",
          AEGIS_APPROVER_PHONE: "",
        },
      });
      let cikti = "";
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (c) => (cikti += c));
      p.stderr.setEncoding("utf8");
      p.stderr.on("data", (c) => (cikti += c));
      p.on("exit", (kod) => coz({ kod, cikti }));
    });

    assert.equal(r.kod, 1, `bayat dist sahneye engeldir — çıktı:\n${r.cikti}`);
    assert.match(r.cikti, /SAHNEYE HAZIR DEĞİL/);
    // Kontrolün kendi damgası da ENGEL olmalı: UYARI'ya düşerse çıkış kodunu bozmaz ve
    // başka bir kontrol tesadüfen kırmızıyken arıza görünmez kalır.
    assert.match(r.cikti, /KALDI\s+dist\/ kaynakla güncel/, "bayat dist UYARI değil ENGEL olmalı");
    assert.match(r.cikti, /KOŞTURULMADI/, "bayat ikili koşturulmadığı raporda söylenmeli");
    assert.equal(existsSync(damga), false, "bayat dist/index.js AÇILDI — koruma çalışmıyor");
    // Aynı koşu, simülasyon açıkken eksik onaylayıcı numarasını da yakalamalı.
    assert.match(r.cikti, /onaylayıcı numarası yok/);
  } finally {
    rmSync(kok, { recursive: true, force: true });
  }
});

/* ── 4) smoke.mjs davranışı: fiş yalnız sınanan derleme için kesilir ─────────── */

/**
 * Duman testinin çıktısı bir FİŞTİR ("canlı doğrulandı" diye PR'a yapıştırılır). Betik
 * `dist/index.js`i derleme tazeliğine hiç bakmadan açıyordu: kapıyı gevşeten katkıcı
 * build'i unutunca eski derlemenin hâlâ sağlam kapısı "geçti" diyordu. Damga dosyası
 * yine ölçüt: önkoşul kaldırılırsa bayat ikili açılır ve dosya ortaya çıkar.
 */
test("smoke bayat dist'te başlamaz ve ikiliyi HİÇ açmaz", async () => {
  const kok = join(KOK, `.tmp-smoke-${process.pid}`);
  rmSync(kok, { recursive: true, force: true });
  mkdirSync(join(kok, "scripts"), { recursive: true });
  mkdirSync(join(kok, "src"), { recursive: true });
  mkdirSync(join(kok, "dist"), { recursive: true });
  const damga = join(kok, "KOSTU.txt");
  try {
    for (const ad of ["smoke.mjs", "onucusKurallari.mjs"]) {
      cpSync(join(KOK, "scripts", ad), join(kok, "scripts", ad));
    }
    dosyaYaz(
      join(kok, "dist", "index.js"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(damga)}, "acildi");\n`,
      100
    );
    dosyaYaz(join(kok, "src", "a.ts"), "export const a = 1;\n", 10); // kaynak DAHA YENİ

    const r = await new Promise((coz) => {
      const p = spawn(process.execPath, [join(kok, "scripts", "smoke.mjs")], {
        cwd: kok,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let cikti = "";
      p.stdout.setEncoding("utf8");
      p.stdout.on("data", (c) => (cikti += c));
      p.stderr.setEncoding("utf8");
      p.stderr.on("data", (c) => (cikti += c));
      p.on("exit", (kod) => coz({ kod, cikti }));
    });

    assert.equal(r.kod, 1, `bayat derlemenin fişi kesilmez — çıktı:\n${r.cikti}`);
    assert.match(r.cikti, /BAŞLATILMADI/);
    assert.equal(existsSync(damga), false, "bayat dist/index.js AÇILDI — önkoşul çalışmıyor");
  } finally {
    rmSync(kok, { recursive: true, force: true });
  }
});
