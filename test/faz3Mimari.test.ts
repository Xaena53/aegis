// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MİMARİ BELGESİ GÖZCÜSÜ — "nerede ne var" yazan belge, gerçekten orada olanı yazsın.
 *
 * Bu gözcü ölçülmüş bir sürüklenmeden doğdu: ARCHITECTURE.md'nin "Non-goals" listesi
 * Meta'yı hâlâ HEDEF-DIŞI sayarken aynı belgenin katman diyagramı, yerleşim bloğu ve risk
 * tablosu Meta'yı sevk edilmiş ikinci harcama alanı olarak anlatıyordu. Bir belge kendi
 * hakkında iki farklı şey söylediğinde okuyan hangisine güveneceğini bilemez — ve depoyu
 * ilk kez açan biri (ya da jüri) ağ kapısını mimaride yeri olmayan bir eklenti sanır.
 *
 * TASARIM: her iddia ÇİFT YÖNLÜ bağlanır.
 *   - Belgedeki cümle bayatlarsa (geri alınır, silinir) → KIRMIZI.
 *   - Kod değişirse (dosya eklenir, silinir, sıra bozulur) → KIRMIZI.
 * Tek yönlü bir gözcü, kodun altından kayıp gittiği belgeyi yeşil gösterirdi; bu depoda
 * daha önce hiçbir koşulda kırmızı olamayan bir gözcünün sahte güvence ürettiği görüldü.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const KOK = path.join(import.meta.dirname, "..");
const MIMARI = readFileSync(path.join(KOK, "ARCHITECTURE.md"), "utf8");

/** `## Baslik` (ya da `### Baslik`) govdesi: bir sonraki ayni/ust duzey basliga kadar. */
function bolum(baslik: string): string {
  const satirlar = MIMARI.split("\n");
  const bas = satirlar.findIndex((s) => /^#{2,3} /.test(s) && s.includes(baslik));
  assert.notEqual(bas, -1, `ARCHITECTURE.md icinde "${baslik}" basligi yok — gozcu bayatlamis`);
  const derinlik = satirlar[bas].match(/^#+/)![0].length;
  const kalan = satirlar.slice(bas + 1);
  const son = kalan.findIndex((s) => {
    const m = s.match(/^#+/);
    return m !== null && m[0].length <= derinlik;
  });
  return (son === -1 ? kalan : kalan.slice(0, son)).join("\n");
}

/** Bir bolumun ILK cit blogu (```mermaid / ``` ) — cevresindeki proza haric. */
function diyagram(baslik: string): string {
  const govde = bolum(baslik);
  const m = govde.match(/```[a-z]*\n([\s\S]*?)\n```/);
  assert.ok(m, `"${baslik}" bolumunde cit icine alinmis bir diyagram yok — gozcu bayatlamis`);
  return m[1];
}

/**
 * `diyagram`in TERSI: bir bolumun cit bloklarindan arindirilmis govdesi — yani ANLATIM.
 * Diyagram dugumleri ve dizin listeleri ETIKET tasir, aciklama tasimaz. Bir cumlenin
 * belgede yazili oldugunu iddia eden gozcu, o cumlenin yerine bir etiketi kabul ederse
 * anlatimin tamami ucup gittiginde bile yesil kalir — olculdu, bkz. Test 4.
 */
function proza(baslik: string): string {
  return bolum(baslik).replace(/```[a-z]*\n[\s\S]*?\n```/g, "");
}

/** `src/` kokundeki modul adlari — elle tutulmaz, DIZINDEN sayilir. */
function srcKokModulleri(): string[] {
  return readdirSync(path.join(KOK, "src"), { withFileTypes: true })
    .filter((g) => g.isFile() && g.name.endsWith(".ts"))
    .map((g) => g.name)
    .sort();
}

/** `src/tools/` altindaki arac yuzeyleri: "meta.ts" → "meta". */
function aracYuzeyleri(): string[] {
  return readdirSync(path.join(KOK, "src", "tools"), { withFileTypes: true })
    .filter((g) => g.isFile() && g.name.endsWith(".ts"))
    .map((g) => g.name.replace(/\.ts$/, ""))
    .sort();
}

/** Bir reklam platformu GERCEKTEN sevk edilmis mi: araci var ve MCP'ye kayitli mi. */
function sevkEdildi(yuzey: string): boolean {
  const dosya = path.join(KOK, "src", "tools", `${yuzey}.ts`);
  return existsSync(dosya) && readFileSync(dosya, "utf8").includes("registerTool(");
}

test("Non-goals listesi, sevk edilmiş bir reklam platformunu hedef-dışı ilan etmiyor", () => {
  /**
   * CIFT YONLU BAG: sevk edilmis bir platform, hedef-disi listesinde ARAC DOSYASIYLA
   * anilmak zorunda; sevk edilmemis olan anilamaz.
   *   - Belge eski "Multi-platform (Meta, TikTok) …" cumlesine donerse `tools/meta.ts`
   *     kaybolur → KIRMIZI.
   *   - src/tools/meta.ts silinirse iddia yalana doner → KIRMIZI.
   *   - src/tools/tiktok.ts eklenirse TikTok artik hedef-disi degildir → KIRMIZI.
   */
  const hedefDisi = bolum("Non-goals");

  for (const platform of ["meta", "tiktok"]) {
    const atif = `tools/${platform}.ts`;
    if (sevkEdildi(platform)) {
      assert.ok(
        hedefDisi.includes(atif),
        `src/tools/${platform}.ts sevk edilmis ama ARCHITECTURE.md "Non-goals" bolumu ` +
          `bunu ${atif} atfiyla kabul etmiyor — belge, kodun sevk ettigi yuzeyi hala ` +
          `hedef-disi gosteriyor.`
      );
    } else {
      assert.ok(
        !hedefDisi.includes(atif),
        `ARCHITECTURE.md "Non-goals" bolumu ${atif} diyor ama boyle bir arac yuzeyi yok — ` +
          `belge var olmayan bir seye atif yapiyor.`
      );
    }
  }

  // TikTok henuz yok; hedef-disi listesi bunu adiyla soylemeli, sessizce dusurmemeli.
  if (!sevkEdildi("tiktok")) {
    assert.match(
      hedefDisi,
      /TikTok/,
      "TikTok hala sevk edilmemis; \"Non-goals\" bolumu bunu adiyla soylemeli."
    );
  }
});

test("Repository layout bloğu src/ ağacıyla İKİ YÖNLÜ eşleşiyor", () => {
  // Cevresindeki proza degil, yerlesimin KENDISI okunur.
  const yerlesim = diyagram("Repository layout");

  // YON 1 — kod → belge: diskteki her kok modul belgede gecmeli.
  for (const dosya of srcKokModulleri()) {
    assert.ok(
      yerlesim.includes(dosya),
      `src/${dosya} var ama ARCHITECTURE.md "Repository layout" blogunda gecmiyor — ` +
        `depoyu ilk acan onu goremez.`
    );
  }

  // YON 2 — belge → kod: belgenin andigi her .ts adi diskte bulunmali (hayalet satir yok).
  for (const m of yerlesim.matchAll(/([A-Za-z0-9/]+\.ts)\b/g)) {
    assert.ok(
      existsSync(path.join(KOK, "src", m[1])),
      `ARCHITECTURE.md "Repository layout" blogu src/${m[1]} diyor ama boyle bir dosya yok.`
    );
  }

  // `tools/` satiri, arac yuzeylerinin TAMAMINI saymali — ve fazlasini degil.
  const araclar = aracYuzeyleri();
  const toolsSatiri = yerlesim.split("\n").find((s) => /^\s*tools\//.test(s));
  assert.ok(toolsSatiri, "\"Repository layout\" blogunda tools/ satiri yok.");
  for (const arac of araclar) {
    assert.ok(
      toolsSatiri.includes(arac),
      `src/tools/${arac}.ts var ama yerlesimin tools/ satiri onu saymiyor: "${toolsSatiri.trim()}"`
    );
  }
  for (const m of toolsSatiri.matchAll(/[a-z][a-zA-Z0-9]*/g)) {
    if (m[0] === "tools") continue;
    assert.ok(
      araclar.includes(m[0]),
      `Yerlesimin tools/ satiri "${m[0]}" diyor ama src/tools/${m[0]}.ts yok.`
    );
  }

  // Meta tasimasi alt dizinde: yolu tam haliyle anilmali (ya ikisi de var, ya ikisi de yok).
  assert.equal(
    yerlesim.includes("meta/client.ts"),
    existsSync(path.join(KOK, "src", "meta", "client.ts")),
    "src/meta/client.ts ile yerlesimdeki meta/client.ts satiri birbirini tutmuyor."
  );
});

test("Layers diyagramı harcama yolundaki modülleri adıyla anıyor", () => {
  /**
   * Urunun manset ozelligi ag guven kapisi; mimari diyagramda yeri olmayan bir kapi,
   * okuyan icin var olmayan bir kapidir. Liste diskten DOGRULANIR: hem diyagram hem de
   * dosya kayboldugunda gozcu kirmizi olur.
   *
   * YALNIZ mermaid bloguna bakilir, bolumun tamamina degil: bolumdeki DUZ METIN de ayni
   * dosya adlarini aniyor, ve ilk surum bolumun tamamini okudugu icin diyagramdan silinen
   * networkTrust dugumunu prozanin arkasinda kaybediyordu — mutasyonla olculdu.
   */
  const katmanlar = diyagram("Layers");
  const harcamaYolu = [
    "approval.ts",
    "networkTrust.ts",
    "kararGunlugu.ts",
    "adsClient.ts",
    "meta/client.ts",
    "store.ts",
  ];

  for (const modul of harcamaYolu) {
    assert.ok(
      existsSync(path.join(KOK, "src", modul)),
      `src/${modul} yok — gozcunun harcama-yolu listesi bayatlamis, duzelt.`
    );
    assert.ok(
      katmanlar.includes(modul),
      `src/${modul} harcama yolunda ama "Layers" diyagraminda adi gecmiyor.`
    );
  }

  for (const arac of aracYuzeyleri()) {
    assert.ok(
      katmanlar.includes(`tools/${arac}`),
      `src/tools/${arac}.ts var ama "Layers" diyagraminin MCP yuzeyi onu gostermiyor.`
    );
  }
});

test("\"önce ağ, sonra insan\" sıralaması hem belgede yazılı hem kodda geçerli", () => {
  /**
   * BELGE YONU — iki olculmus delige karsi kuruldu.
   *
   * (1) CIT HARIC TUTULUR. Ilk surum belgenin TAMAMINDA paragraf ariyordu, ve "Repository
   *     layout" citindeki tek satirlik dizin anotasyonu ("networkTrust.ts  … consulted
   *     before the prompt") predikati TEK BASINA tatmin ediyordu: invaryanti ANLATAN iki
   *     proza paragrafi da silindiginde gozcu yesil kaliyordu (mutasyonla olculdu). Bir
   *     dizin listesi anotasyonu anlatimin yerini tutmaz. Test 3'te ayni sinif delige
   *     TERS tedavi uygulaniyor (orada yalniz cit okunur); burada cit ayiklanir.
   *
   * (2) HER BOLUM KENDI CUMLESINDEN SORUMLU. Invaryant iki ayri okur icin iki ayri yerde
   *     duruyor: "Layers" katman siralamasini kuran cumleyi tasir, "The network trust
   *     gate" ise ayni siralamanin GEREKCESINI. Belgenin tamaminda tek bir eslesme
   *     aramak, birini silip otekine yaslanmayi serbest birakirdi; ikisi ayri ayri
   *     civilenir. Bolum basligi kaybolursa `bolum()` zaten "gozcu bayatlamis" diye duser.
   */
  const SIRA_ANLATIYOR = (p: string): boolean =>
    p.includes("networkTrust.ts") && /\bbefore\b/.test(p) && /\bhuman\b|\bprompt\b/.test(p);

  for (const baslik of ["Layers", "The network trust gate"]) {
    const paragraflar = proza(baslik).split(/\n\s*\n/);
    assert.ok(
      paragraflar.some(SIRA_ANLATIYOR),
      `ARCHITECTURE.md "${baslik}" bolumunun ANLATIMI, ag kapisinin insan isteminden ONCE ` +
        `soruldugunu soylemiyor — kapinin merkezi invaryanti o bolumden ucmus. ` +
        `(Cit icindeki diyagram dugumleri ve dizin satirlari sayilmaz: etiket, anlatim degildir.)`
    );
  }

  // KOD YONU: approval.ts'te ag cagrisi, istem cagrisindan once gelmeli.
  const onay = readFileSync(path.join(KOK, "src", "approval.ts"), "utf8");
  const agIndeks = onay.indexOf("await agDogrula(");
  const istemIndeks = onay.indexOf("elicitInput(");
  assert.notEqual(agIndeks, -1, "src/approval.ts icinde `await agDogrula(` yok — gozcu bayatlamis.");
  assert.notEqual(istemIndeks, -1, "src/approval.ts icinde `elicitInput(` yok — gozcu bayatlamis.");
  assert.ok(
    agIndeks < istemIndeks,
    "src/approval.ts insan istemini ag dogrulamasindan ONCE kuruyor — belge tersini vaat ediyor."
  );
});
