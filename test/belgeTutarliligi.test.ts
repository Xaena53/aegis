// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BELGE TUTARLILIĞI — aynı gerçeği iki kez yazmanın bedeli.
 *
 * Bu test var olan bir sürüklenmeden doğdu: rozet "554 test" derken hemen altındaki
 * özet tablosu "487 otomatik test" diyordu ve İngilizce/Türkçe README'ler birbirinden
 * ayrı ayrı kaymıştı. İkisi de doğru olamaz, ve okuyan hangisine güveneceğini bilemez.
 *
 * Bu, ayar adları için yazılan bekçinin (ayarAdlari.test.ts) kardeşi: orada belgenin
 * KODLA, burada belgenin KENDİSİYLE tutarlı kalması sınanır. İkisi de "belge, kanıtı
 * olmayan bir şey iddia etmesin" kuralının parçası.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const KOK = path.join(import.meta.dirname, "..");
const BELGELER = ["README.md", "README.tr.md"];

function oku(ad: string): string {
  return readFileSync(path.join(KOK, ad), "utf8");
}

/** `src/` altındaki tüm TypeScript kaynağı — kayıt sayıları oradan SAYILIR, elle tutulmaz. */
function kaynaklariTopla(dizin: string): string {
  let metin = "";
  for (const giris of readdirSync(dizin, { withFileTypes: true })) {
    const tam = path.join(dizin, giris.name);
    if (giris.isDirectory()) metin += kaynaklariTopla(tam);
    else if (giris.name.endsWith(".ts")) metin += readFileSync(tam, "utf8") + "\n";
  }
  return metin;
}

const KAYNAK_SRC = kaynaklariTopla(path.join(KOK, "src"));

/** Belgedeki bir bölümü (`### Başlık` → bir sonraki `### `) döndürür. */
function bolum(ad: string, baslik: string): string {
  const satirlar = oku(ad).split(/\r?\n/);
  const bas = satirlar.findIndex((s) => s.startsWith("### ") && s.includes(baslik));
  assert.notEqual(bas, -1, `${ad} içinde "${baslik}" bölümü yok — test yolu bayatlamış`);
  const kalan = satirlar.slice(bas + 1);
  const son = kalan.findIndex((s) => s.startsWith("### "));
  return (son === -1 ? kalan : kalan.slice(0, son)).join("\n");
}

test("test sayısı her iki README'de ve her geçtiği yerde AYNI", () => {
  /**
   * Sayı üç ayrı yerde geçiyor: rozet, özet tablosundaki durum satırı ve geliştirme
   * bölümündeki komut yorumu. Üçü elle güncellendiği için biri unutulduğunda depo,
   * kendi hakkında iki farklı şey söyleyen bir belgeyle kalıyor.
   */
  const desenler = [
    /badge\/tests?-(\d{3,4})-/i,
    /badge\/test-(\d{3,4})-/i,
    /(\d{3,4}) automated tests/,
    /(\d{3,4}) otomatik test/,
    /(\d{3,4}) offline tests/,
    /(\d{3,4}) çevrimdışı test/,
  ];

  const bulunan = new Map<string, number[]>();
  for (const ad of BELGELER) {
    const metin = oku(ad);
    for (const d of desenler) {
      for (const m of metin.matchAll(new RegExp(d, "g"))) {
        const liste = bulunan.get(ad) ?? [];
        liste.push(Number(m[1]));
        bulunan.set(ad, liste);
      }
    }
  }

  const hepsi = [...bulunan.values()].flat();
  assert.ok(hepsi.length >= 4, `test sayısı yeterince yerde bulunamadı (${hepsi.length}) — desenler bayatlamış olabilir`);

  const benzersiz = [...new Set(hepsi)];
  assert.equal(
    benzersiz.length,
    1,
    `README'ler farklı test sayıları duyuruyor: ${benzersiz.join(", ")} — ` +
      `hepsi tek bir gerçeği göstermeli (${JSON.stringify([...bulunan])})`
  );
});

test("kapsam yüzdesi iki README arasında tutarlı", () => {
  /**
   * Aynı sürüklenme kapsam rakamı için de mümkün, üstelik daha sinsi: yüzde, testten
   * farklı olarak koşarken kimsenin gözüne çarpmaz.
   */
  const yakala = (metin: string) => {
    const cikti = new Set<string>();
    for (const m of metin.matchAll(/(\d{2}\.\d{2})%|%(\d{2}\.\d{2})/g)) {
      cikti.add(m[1] ?? m[2]);
    }
    return cikti;
  };

  const [en, tr] = BELGELER.map((a) => yakala(oku(a)));
  assert.ok(en.size > 0 && tr.size > 0, "kapsam yüzdesi hiçbir README'de bulunamadı");
  assert.deepEqual(
    [...en].sort(),
    [...tr].sort(),
    "İngilizce ve Türkçe README farklı kapsam rakamları duyuruyor"
  );
});

test("iki README aynı bölümleri taşır — biri güncellenip diğeri unutulmasın", () => {
  /**
   * Çeviri her zaman birebir olmak zorunda değil, ama BÖLÜM sayısı ayrışmaya başladıysa
   * bu, birine eklenip diğerine eklenmemiş bir içeriğin işaretidir.
   */
  const basliklar = (metin: string) => metin.split("\n").filter((s) => /^##\s/.test(s)).length;
  const en = basliklar(oku("README.md"));
  const tr = basliklar(oku("README.tr.md"));
  assert.ok(
    Math.abs(en - tr) <= 1,
    `README bölüm sayıları ayrışmış (EN ${en}, TR ${tr}) — biri güncellenip diğeri unutulmuş olabilir`
  );
});

test("sunucu yönergesi, sunduğu prompt'ların HEPSİNİ sayar", () => {
  /**
   * Bu test gerçek bir sürüklenmeden doğdu: sunucu beş prompt kaydediyordu ama
   * `instructions` metni yalnız dördünü sayıyordu — `guvenlik-durumu` eklenmiş,
   * yönergeye yazılmamıştı.
   *
   * Sonucu sessizdir ve tam olarak ters yöndedir: ajan yönergeyi okur, o prompt'un
   * var olduğunu hiç öğrenmez ve kullanıcı "güvenlik durumunu göster" dediğinde onu
   * elle yapmaya çalışır. Yani en çok işe yarayacak hazır akış, tam da ihtiyaç
   * anında görünmez kalır.
   */
  /**
   * Adlar KAYITLARIN KENDİSİNDEN okunuyor, ayrı bir listeden değil. Ayrı bir liste
   * tutmak, sürüklenmeyi çözmek yerine ikinci bir sürüklenme yeri açardı: prompt
   * kaydedilir, listeye eklenmez, test yine hiçbir şey görmez.
   */
  const kaynak = readFileSync(path.join(KOK, "src", "prompts.ts"), "utf8");
  const adlar = [...kaynak.matchAll(/registerPrompt\(\s*\n\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(adlar.length >= 5, `prompt kaydı bulunamadı (${adlar.length}) — desen bayatlamış olabilir`);

  const yonerge = readFileSync(path.join(KOK, "src", "server.ts"), "utf8");
  const eksik = adlar.filter((ad) => !yonerge.includes(`/${ad}`));
  assert.deepEqual(
    eksik,
    [],
    `sunucu yönergesinde anılmayan prompt'lar: ${eksik.join(", ")} — ajan bunların ` +
      `varlığını hiç öğrenemez`
  );
});

/* ── Kayıt sayıları: sunucunun GERÇEKTEN kaydettiği yüzey ────────────────────── */

/** Kaynakta `server.registerX(` kaç kez geçiyor. Elle tutulan hiçbir liste yok. */
function kayitSayisi(tur: "Tool" | "Resource" | "Prompt"): number {
  return [...KAYNAK_SRC.matchAll(new RegExp(`server\\.register${tur}\\(`, "g"))].length;
}

test("README'ler sunucunun GERÇEKTEN kaydettiği araç/kaynak/prompt sayısını söylüyor", () => {
  /**
   * Bu gerçek bir sürüklenmeden doğdu: sunucu on beş araç kaydederken iki README de
   * "12 araç" diyordu ve üç Meta aracı Yetenekler tablosunda HİÇ yoktu. Sonuç sessiz ve
   * tek yönlü: Meta hesabını bağlayan kullanıcı, hangi Meta işleminin onay isteyeceğini
   * tablodan öğrenemiyor ve "12 total" ifadesi listeyi TAM sandığı için eksik olanı
   * aramaya da hiç başlamıyor.
   */
  const araclar = kayitSayisi("Tool");
  const kaynaklar = kayitSayisi("Resource");
  const promptlar = kayitSayisi("Prompt");
  assert.ok(araclar >= 10, `registerTool sayımı şüpheli (${araclar}) — desen bayatlamış olabilir`);

  const en = oku("README.md");
  const tr = oku("README.tr.md");

  const enToplam = /\*\*Tools\*\* — (\d+) total/.exec(en);
  assert.ok(enToplam, "README.md 'Tools — N total' satırı bulunamadı — test yolu bayatlamış");
  assert.equal(
    Number(enToplam![1]),
    araclar,
    `README.md ${enToplam![1]} araç duyuruyor, sunucu ${araclar} araç kaydediyor`
  );

  const trToplam = /\*\*Araçlar\*\* — (\d+) adet/.exec(tr);
  assert.ok(trToplam, "README.tr.md 'Araçlar — N adet' satırı bulunamadı — test yolu bayatlamış");
  assert.equal(
    Number(trToplam![1]),
    araclar,
    `README.tr.md ${trToplam![1]} araç duyuruyor, sunucu ${araclar} araç kaydediyor`
  );

  // Mimari diyagramındaki "MCP yüzeyi" düğümü aynı üç sayıyı taşır — özet bölümlerine
  // bakan okuyucu sayıyı çoğu zaman ORADAN alır.
  const enYuzey = /(\d+) tools · (\d+) resources · (\d+) prompts/.exec(en);
  assert.ok(enYuzey, "README.md mimari diyagramında MCP yüzeyi düğümü bulunamadı");
  assert.deepEqual(
    enYuzey!.slice(1, 4).map(Number),
    [araclar, kaynaklar, promptlar],
    "README.md mimari diyagramı, sunucunun kaydettiği sayılarla uyuşmuyor"
  );

  const trYuzey = /(\d+) araç · (\d+) kaynak · (\d+) prompt/.exec(tr);
  assert.ok(trYuzey, "README.tr.md mimari diyagramında MCP yüzeyi düğümü bulunamadı");
  assert.deepEqual(
    trYuzey!.slice(1, 4).map(Number),
    [araclar, kaynaklar, promptlar],
    "README.tr.md mimari diyagramı, sunucunun kaydettiği sayılarla uyuşmuyor"
  );
});

test("Yetenekler tablosu KAYDEDİLEN her aracı anıyor — iki dilde birden", () => {
  /**
   * Sayının doğru olması yetmez: eksik olan ARAÇ bulunabilmeli. Meta araçları tam da
   * böyle kaçmıştı — sayı 12'de kaldığı için hiçbir gözcü üç aracın yokluğunu görmedi.
   * Adlar kaydın kendisinden okunur, ayrı bir listeden değil; ayrı liste ikinci bir
   * sürüklenme yeri açardı.
   */
  const adlar = [...KAYNAK_SRC.matchAll(/server\.registerTool\(\s*\n\s*"([a-z0-9_]+)"/g)].map(
    (m) => m[1]
  );
  assert.ok(adlar.length >= 10, `araç adı ayrıştırılamadı (${adlar.length}) — desen bayatlamış`);

  /**
   * Arama BELGENİN TAMAMINDA değil, YETENEKLER TABLOSUNDA yapılır. Fark mutasyonla
   * ölçüldü: Meta araçlarının adları README'nin "ikinci harcama alanı" paragrafında da
   * geçiyor, dolayısıyla tam metin araması tablodan silinen satırı GÖRMÜYOR ve gözcü
   * sessizce yeşil kalıyordu. Kullanıcı hangi işlemin onay istediğini tablodan okur.
   */
  for (const ad of BELGELER) {
    const tablo = oku(ad)
      .split(/\r?\n/)
      .filter((s) => /^\|\s*`[a-z0-9_]+`\s*\|/.test(s))
      .join("\n");
    assert.ok(tablo.length > 0, `${ad} içinde araç tablosu bulunamadı — test yolu bayatlamış`);
    const eksik = adlar.filter((a) => !tablo.includes(`\`${a}\``));
    assert.deepEqual(
      eksik,
      [],
      `${ad} · Yetenekler tablosu bu araçları HİÇ saymıyor: ${eksik.join(", ")}. Kullanıcı, ` +
        `hangi işlemin onay kapısından geçtiğini o tablodan öğrenir; tabloda olmayan araç ` +
        `onun için yoktur.`
    );
  }
});

/* ── Belgelerin önerdiği komutlar gerçekten var mı? ──────────────────────────── */

test("belgelerdeki her 'npm run X' package.json'da GERÇEKTEN tanımlı", () => {
  /**
   * Bu gözcü daha önce YALNIZ docs/CAMARA.md'nin tek bir bölümünü tarıyordu, ve kaçan
   * satır tam da onun dışındaydı: .env.example var olmayan `npm run beyin` komutunu
   * belgeliyordu (script'in adı `brain`). Operatör `Missing script` hatası alıp doğru
   * adı bulmak için package.json'a bakmak zorunda kalıyordu.
   */
  const pkg = JSON.parse(readFileSync(path.join(KOK, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  const dosyalar = [
    ".env.example",
    "README.md",
    "README.tr.md",
    "CONTRIBUTING.md",
    "ARCHITECTURE.md",
    "docs/DEMO.md",
    "docs/CAMARA.md",
    "deploy/README.md",
  ];

  const bulunanlar: Array<{ dosya: string; komut: string }> = [];
  for (const dosya of dosyalar) {
    const metin = readFileSync(path.join(KOK, dosya), "utf8");
    for (const m of metin.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
      bulunanlar.push({ dosya, komut: m[1] });
    }
  }
  assert.ok(
    bulunanlar.length >= 20,
    `belgelerde yeterince 'npm run' bulunamadı (${bulunanlar.length}) — dosya listesi bayatlamış olabilir`
  );

  const hatalar = bulunanlar
    .filter(({ komut }) => !pkg.scripts?.[komut])
    .map(({ dosya, komut }) => `${dosya}: npm run ${komut}`);
  assert.deepEqual(
    [...new Set(hatalar)],
    [],
    `Belgeler var olmayan script öneriyor:\n${[...new Set(hatalar)].join("\n")}`
  );
});

/* ── Mermaid diyagramları: iki README aynı yapıyı mı çiziyor? ────────────────── */

/** Bir mermaid bloğundaki düğüm/katılımcı kimlikleri — etiket metni DEĞİL. */
function mermaidDugumleri(blok: string): string[] {
  const kumeler = new Set<string>();
  if (blok.includes("sequenceDiagram")) {
    for (const m of blok.matchAll(/participant\s+([A-Za-z][A-Za-z0-9_]*)/g)) kumeler.add(m[1]);
  } else {
    for (const m of blok.matchAll(/(?:^|[\s>])([A-Za-z][A-Za-z0-9_]*)\s*[[{(]/gm)) kumeler.add(m[1]);
  }
  return [...kumeler].sort();
}

test("iki README aynı mermaid diyagramlarını, aynı düğümlerle çiziyor", () => {
  /**
   * Ölçülmüş sürüklenme: README.tr.md'nin güvenlik-modeli akışı, harcama artıran bir
   * eylemde doğrudan elicitation'a gidiyordu — İngilizcesindeki AĞ GÜVEN KAPISI düğümü
   * (N) Türkçesinde HİÇ yoktu; mimari diyagramında da NT/NAC/LOG düğümleri eksikti.
   * Yani Türkçe okuyan bir değerlendirici için projenin ana iddiası — "insana sorulmadan
   * ÖNCE ağa sorulur" — diyagramlarda görünmüyordu, oysa kod (approval.ts) ağ kontrolünü
   * gerçekten önce koşuyor.
   *
   * Karşılaştırma ETİKET metnine değil DÜĞÜM KİMLİĞİNE bakar: çeviri serbesttir, yapı
   * değildir.
   */
  const bloklar = (ad: string) =>
    [...oku(ad).matchAll(/```mermaid\r?\n([\s\S]*?)```/g)].map((m) => m[1]);

  const en = bloklar("README.md");
  const tr = bloklar("README.tr.md");
  assert.ok(en.length >= 3, `README.md'de mermaid bloğu bulunamadı (${en.length})`);
  assert.equal(
    tr.length,
    en.length,
    `README.md ${en.length}, README.tr.md ${tr.length} mermaid diyagramı taşıyor — ` +
      `biri eklenip diğeri unutulmuş`
  );

  for (let i = 0; i < en.length; i++) {
    assert.deepEqual(
      mermaidDugumleri(tr[i]),
      mermaidDugumleri(en[i]),
      `${i + 1}. mermaid diyagramı iki README'de FARKLI düğüm kümesi çiziyor. Eksik ya da ` +
        `fazla bir düğüm, iki dilde iki farklı mimari anlatmak demektir.`
    );
  }
});

/* ── Kapsam bölümü: iki README aynı rakamları mı duyuruyor? ──────────────────── */

test("kapsam bölümünün TÜM rakamları iki README'de aynı (yüzde biçimi ne olursa olsun)", () => {
  /**
   * Var olan gözcü yalnız `dd.dd%` biçimini görüyordu; tablo `100%` / `94–100%` gibi
   * biçimler kullandığı için satır ve aralık rakamları hiç sınanmıyordu. Tam da o
   * hücreler bayatlamıştı.
   *
   * Bölüm SINIRLI okunur (yalnız kapsam bölümü): belgenin tamamındaki her sayıyı
   * karşılaştırmak, çeviri farklarından doğan yanlış alarmlar üretirdi.
   */
  /**
   * Yalnız ÖLÇÜM satırları okunur: özet satırı ve tablo satırları. Bölümün geri kalanı
   * serbest metindir ve çevirisi birebir değildir ("okunamayan bütçe `0` sayılıyor"
   * cümlesi Türkçede sıfırı iki kez anıyor) — onu da karşılaştırmak, kapsam rakamıyla
   * hiç ilgisi olmayan yanlış alarmlar üretirdi.
   */
  const olcumSatirlari = (metin: string) =>
    metin
      .split(/\r?\n/)
      .filter((s) => s.trim().startsWith("|") || /^\d+ tests? · /.test(s.trim()))
      .join("\n");
  const sayilar = (metin: string) =>
    (olcumSatirlari(metin).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const enBolum = bolum("README.md", "Test metrics");
  const trBolum = bolum("README.tr.md", "Test metrikleri");

  assert.ok(sayilar(enBolum).length >= 10, "kapsam bölümünde rakam bulunamadı — başlık bayatlamış olabilir");
  assert.deepEqual(
    sayilar(trBolum),
    sayilar(enBolum),
    "İngilizce ve Türkçe kapsam bölümleri farklı rakamlar duyuruyor — biri ölçümle " +
      "güncellenip diğeri unutulmuş"
  );
});
