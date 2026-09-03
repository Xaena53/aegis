// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BELGE ↔ KAPI: KADEME VE CANLILIK — iki iddianın koddan türetilmesi.
 *
 * NEDEN VAR: bu depoda belge gözcüleri şimdiye kadar VARLIK sorusunu soruyordu ("bu env
 * adı belgede geçiyor mu"). İki iddia bu ağdan kaçtı, çünkü ikisi de varlık değil ANLAM
 * iddiasıydı:
 *
 *   1) KADEMELİ DOĞRULAMA. `ADSPILOT_STEPUP` docs/ altında HİÇ geçmiyordu ve hiçbir
 *      gözcü onu aramıyordu (zincir kaydında yoktu). Sonuç: runbook'un kapalı-arıza
 *      matrisi ile README, kapının TERSİNE çalışan bir davranışını KURAL diye ilan
 *      ediyordu — "SIM değişimi anında reddeder, sonraki hiçbir halka yumuşatamaz".
 *      Ölçüldü: aynı kısmi arızada STEPUP=0 → RET, STEPUP=1 → kademe=yukseltildi.
 *      Matrise güvenen operatör ya yanlış alarm verir, ya da "ulaşılamaz = ret"
 *      garantisinin hâlâ durduğunu sanarak step-up açık bir `.env` ile canlıya çıkar.
 *
 *   2) CANLILIK. "Hangi halka gerçekten canlı koştu" iddiası yalnız serbest metinde
 *      yaşıyordu ve belge kendi kendisiyle çelişiyordu: docs/CAMARA.md §1 halka 3-4 için
 *      "Live since 31 Aug" derken §2 "links 2, 3 and 4 have not run live" diyordu, README
 *      diyagramı ise CAMARA'yı "never yet called live" diye etiketliyordu. Üçü aynı anda
 *      doğru olamaz; okuyucu hangisinin bayat olduğunu bilemez.
 *
 * Her iki iddia da artık KODDAN türetilir: kademe listesi `KADEME_UYGUN`'dan, canlılık
 * `ZINCIR_HALKALARI[].canliDogrulandi`'dan. Belge kaydırılırsa test kırmızı olur.
 *
 * SÖZLEŞME: buradaki hiçbir test kapı mantığına dokunmaz, gevşetmez, ağa çıkmaz.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KADEME_UYGUN, ZINCIR_HALKALARI } from "../src/networkTrust.js";

const yol = (goreli: string) => fileURLToPath(new URL(goreli, import.meta.url));
/**
 * Belgeler LF'e NORMALLEŞTİRİLEREK okunur.
 *
 * Aşağıdaki bölüm sınırları BOŞ SATIR arıyor. Windows'ta bir düzenleyici — ya da bu
 * depoyu düzenleyen bir betik — dosyayı CRLF'e çevirdiğinde o sınır CR+LF çiftine
 * dönüşür, arama tutmaz ve gözcü BÖLÜM YERİNE DOSYANIN YARISINI tarar: iddia, belgenin
 * geri kalanından toplanmış anlamsız bir listeyle karşılaştırılıp kızarır. Ölçüldü —
 * tam olarak böyle oldu. Gözcünün kızarma sebebi belgenin İÇERİĞİ olmalı, hangi işletim
 * sisteminde kaydedildiği değil.
 */
const oku = (goreli: string) => readFileSync(yol(goreli), "utf8").replace(/\r\n/g, "\n");

const BELGE_DEMO = oku("../docs/DEMO.md");
const BELGE_CAMARA = oku("../docs/CAMARA.md");
const BELGE_README = oku("../README.md");
const BELGE_README_TR = oku("../README.tr.md");

/* ── 1) Kademe: runbook, koddaki listenin AYNISINI sayıyor mu? ───────────────── */

test("runbook: step-up bölümü KADEME_UYGUN'un TAM listesini sayıyor (eksik de fazla da hata)", () => {
  /**
   * Liste ne eksik ne fazla olmalı. Eksik: operatör, açık step-up'ın hangi retleri
   * yumuşattığını bilmez — matrisi okuyup yanlış sonuç bekler. Fazla: belge, kapının
   * yumuşatMADIĞI bir durumu yumuşuyor gösterir; `cagri-yonlendirme-acik` tam olarak
   * bu tarafta durur ve oraya yanlışlıkla eklenmesi, güvenlik gerekçesini tersine
   * çeviren bir hata olurdu.
   */
  const bas = BELGE_DEMO.indexOf("| `retNedeniKisa` |");
  assert.notEqual(
    bas,
    -1,
    "docs/DEMO.md'de step-up neden tablosu (| `retNedeniKisa` |) bulunamadı — " +
      "bölüm yeniden adlandırıldıysa bu gözcü sessizce boşa düşmesin diye burada durur"
  );
  const son = BELGE_DEMO.indexOf("\n\n", bas);
  const tablo = BELGE_DEMO.slice(bas, son === -1 ? undefined : son);

  const sayilan = new Set([...tablo.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]));
  sayilan.delete("retNedeniKisa");

  assert.deepEqual(
    [...sayilan].sort(),
    [...KADEME_UYGUN].sort(),
    "docs/DEMO.md'nin step-up tablosu ile src/networkTrust.ts · KADEME_UYGUN ayrışmış. " +
      "Kademe, kapının 'koşulsuz reddeder' davranışını KOŞULLU yapar; tabloyu okuyan " +
      "operatör hangi retlerin insan istemine döneceğini buradan öğrenir."
  );
});

test("runbook: kademeye ASLA uygun olmayan nedenler tabloya SIZMAMIŞ", () => {
  /**
   * Ters yönlü aynı sözleşme, ama kaynağı KADEME_UYGUN'un tümleyeni: çağrı yönlendirme
   * ve yapılandırma hataları yükseltilemez. Bunlar tabloya girerse belge, saldırganın
   * eline geçmiş bir kanala daha güçlü doğrulama göndermeyi "destekleniyor" gibi
   * gösterirdi.
   */
  const YASAK = ["cagri-yonlendirme-acik", "nv-uyusmadi", "yapilandirma-celiskili"];
  for (const neden of YASAK) {
    assert.ok(
      !KADEME_UYGUN.has(neden as never),
      `'${neden}' KADEME_UYGUN'a eklenmiş — bu bir güvenlik gerilemesidir, belge hatası değil`
    );
  }
});

test("belge: ADSPILOT_STEPUP hem runbook'ta hem CAMARA kontrol listesinde anlatılıyor", () => {
  /**
   * Zincir kaydına eklenmesi (ZINCIR_ORTAK_ENVLERI) .env.example ve docs/CAMARA.md
   * gözcülerini zaten devreye sokar; docs/DEMO.md gözcüsü HALKA başına çalıştığı için
   * zincir geneli bir ayarı görmez. Runbook sahnede izlenen belgedir: kapalı-arıza
   * matrisinin hangi varsayım altında geçerli olduğunu orada söylemek zorundayız.
   */
  assert.match(
    BELGE_DEMO,
    /ADSPILOT_STEPUP/,
    "docs/DEMO.md `ADSPILOT_STEPUP`'tan hiç söz etmiyor — matrisin hangi ayar altında " +
      "geçerli olduğunu söylemeyen bir kapalı-arıza matrisi yanlış güven verir"
  );
  assert.match(
    BELGE_CAMARA,
    /ADSPILOT_STEPUP/,
    "docs/CAMARA.md `ADSPILOT_STEPUP`'tan hiç söz etmiyor — token gelen operatör canlı " +
      "koşudan önce onun kapalı olması gerektiğini hiç öğrenmez"
  );
});

/* ── 2) Koşulsuz 'istem hiç gösterilmez' iddiası gözcüsü ─────────────────────── */

/**
 * "İnsan hiç sorulmaz" iddiası, kademeye UYGUN bir nedenin sonucunu anlatıyorsa
 * KOŞULLUDUR. Bu desenler tam da o cümleleri yakalar; her biri ölçülerek seçildi
 * (hepsi bugün gerçekten KADEME_UYGUN kapsamındaki bir sinyali anlatıyor).
 */
const MUTLAK_IDDIA = [
  /before any prompt/i,
  /zero prompts/i,
  /zero elicitations/i,
  /refuses immediately/i,
  /istem gösterilmeden/i,
];

/** İddiayı koşula bağlayan ifadeler — aynı SATIRDA bulunmak zorunda. */
const KOSUL = /ADSPILOT_STEPUP|step-up|kademe/i;

test("belge: 'istem hiç gösterilmez' diyen her satır step-up koşulunu SÖYLÜYOR", () => {
  /**
   * Koşul AYNI SATIRDA aranır, paragrafta değil. Fark mutasyonla ölçüldü: paragraf
   * kapsamında, tablonun başka bir satırındaki tek bir "step-up" kelimesi bütün
   * satırları "kanıtlanmış" sayıyor ve gözcü sessizce boşa düşüyordu.
   */
  const suclular: string[] = [];
  for (const [ad, metin] of [
    ["README.md", BELGE_README],
    ["README.tr.md", BELGE_README_TR],
    ["docs/DEMO.md", BELGE_DEMO],
  ] as const) {
    metin.split(/\r?\n/).forEach((satir, i) => {
      if (!MUTLAK_IDDIA.some((d) => d.test(satir))) return;
      if (KOSUL.test(satir)) return;
      suclular.push(`${ad}:${i + 1} → ${satir.trim().slice(0, 120)}`);
    });
  }

  assert.deepEqual(
    suclular,
    [],
    "Bu satırlar onay isteminin HİÇ gösterilmediğini KOŞULSUZ bir kural gibi yazıyor, " +
      "oysa KADEME_UYGUN'daki her neden için bu yalnız `ADSPILOT_STEPUP=0` iken (varsayılan) " +
      "doğrudur. Cümleyi koşula bağla (ör. \"while step-up is off, the default\"):\n" +
      suclular.join("\n")
  );
});

test("gözcü kendisi çalışıyor: desenler bugünkü belgelerde GERÇEKTEN eşleşiyor", () => {
  /**
   * Yukarıdaki test boş liste beklediği için, desenler bayatladığında (cümleler yeniden
   * yazıldı, dosya bölündü) SESSİZCE yeşile döner ve hiçbir şey ölçmez. Bu test o
   * sessiz ölümü engeller: iddia cümleleri belgelerde durduğu sürece gözcü canlıdır.
   */
  const tumu = [BELGE_README, BELGE_README_TR, BELGE_DEMO].join("\n");
  const eslesen = MUTLAK_IDDIA.filter((d) => d.test(tumu));
  assert.ok(
    eslesen.length >= 4,
    `Mutlak iddia desenlerinden yalnız ${eslesen.length} tanesi belgelerde eşleşiyor — ` +
      "cümleler yeniden yazıldıysa desenleri güncelle, yoksa gözcü hiçbir şey ölçmez"
  );
});

/* ── 3) Canlılık: koddaki kayıt ile belgelerin canlı iddiaları ───────────────── */

const CANLI_HALKALAR = ZINCIR_HALKALARI.filter((h) => h.canliDogrulandi);

test("kayıt: canlı doğrulama tarihleri ISO biçiminde ve geçmişte", () => {
  assert.ok(
    CANLI_HALKALAR.length > 0,
    "hiçbir halka canlı doğrulanmış görünmüyor — kayıt bayatlamışsa aşağıdaki belge " +
      "gözcüleri de anlamsızlaşır"
  );
  for (const halka of CANLI_HALKALAR) {
    assert.match(
      halka.canliDogrulandi!,
      /^\d{4}-\d{2}-\d{2}$/,
      `halka '${halka.id}': canliDogrulandi ISO tarih (YYYY-MM-DD) olmalı — belge gözcüleri ` +
        `bu dizeyi belgede ARAR, biçim serbestse arama sessizce boşa düşer`
    );
  }
});

test("docs/CAMARA.md sinyal envanteri: canlı halkanın satırı TARİHİ taşıyor", () => {
  /**
   * §1 tablosunun satırları halkanın KENDİ env adlarıyla bulunur (her satır kendi
   * anahtarlarını sayar; bunu ayrı bir gözcü zaten şart koşuyor). Aranan şey kayıttaki
   * tarihin KENDİSİ: "Live since 31 Aug 2026" gibi serbest biçimler tam olarak bu
   * belgenin kendi kendisiyle çelişmesine yol açmıştı.
   */
  const satirlar = BELGE_CAMARA.split(/\r?\n/).filter((s) => s.startsWith("| **"));
  assert.ok(satirlar.length >= 6, `§1 envanter satırları bulunamadı (${satirlar.length})`);

  for (const halka of CANLI_HALKALAR) {
    const satir = satirlar.find((s) => halka.envler.some((e) => s.includes(e)));
    assert.ok(satir, `halka '${halka.id}' için §1 envanter satırı bulunamadı`);
    assert.ok(
      satir!.includes(halka.canliDogrulandi!),
      `docs/CAMARA.md §1'de halka '${halka.id}' satırı canlı doğrulama tarihini ` +
        `(${halka.canliDogrulandi}) taşımıyor. Bu satır jüriye/mentöre verilen en pahalı ` +
        `iddiadır; tarihi koddan gelir, serbest metinden değil.`
    );
  }
});

test("docs/CAMARA.md: canlı doğrulanMAMIŞ halka canlı gibi gösterilmiyor", () => {
  /**
   * Ters yön. Number Verification'ın canlı koşmaması bayat bir beyan değil, mimari bir
   * hüküm (cihaz-taraflı OIDC); envanterde "verified live" damgası görürsek belge,
   * çözülemeyecek bir sorunu çözülmüş gösteriyor demektir.
   */
  const satirlar = BELGE_CAMARA.split(/\r?\n/).filter((s) => s.startsWith("| **"));
  for (const halka of ZINCIR_HALKALARI.filter((h) => !h.canliDogrulandi)) {
    const satir = satirlar.find((s) => halka.envler.some((e) => s.includes(e)));
    assert.ok(satir, `halka '${halka.id}' için §1 envanter satırı bulunamadı`);
    assert.doesNotMatch(
      satir!,
      /verified against the live endpoint|live-verified/i,
      `docs/CAMARA.md §1'de halka '${halka.id}' canlı doğrulanmış gibi yazıyor ama kayıtta ` +
        `canliDogrulandi YOK. Gerçekten canlıya çıktıysa kaydı güncelle; çıkmadıysa cümleyi.`
    );
  }
});

test("README'ler: canlı doğrulanmış bir zincirde 'hiç canlı koşmadı' demiyorlar", () => {
  /**
   * Bu tam olarak kaçan hataydı: README'nin mimari diyagramı CAMARA düğümünü
   * "(never yet called live)" diye etiketliyor, karşılaştırma tablosu "links 2-6 not yet
   * exercised" diyordu — aynı dosyanın 250 satır yukarısı tersini söylerken. Özet
   * bölümlerine bakan bir değerlendirici, projenin en pahalı kanıtlanmış iddiasının geri
   * alındığını okuyup linkten aynı bayat beyana gidiyordu.
   */
  const YASAK = [
    /never yet called live/i,
    /not yet exercised/i,
    /has not run live/i,
    /hiç canlı çağrılmadı/i,
    /henüz koşmadı/i,
  ];
  for (const [ad, metin] of [
    ["README.md", BELGE_README],
    ["README.tr.md", BELGE_README_TR],
  ] as const) {
    for (const desen of YASAK) {
      assert.doesNotMatch(
        metin,
        desen,
        `${ad} ${desen} diyor, ama kayıtta ${CANLI_HALKALAR.length} halka canlı doğrulanmış ` +
          `(${CANLI_HALKALAR.map((h) => h.id).join(", ")}). Halka BAZINDA bir sınır varsa onu ` +
          `adıyla yaz; mutlak "hiç" ifadesi bugün yanlış.`
      );
    }
  }
});

test("belge: canlı doğrulanan halka SAYISI koddan türer ve üç belgede AYNI", () => {
  /**
   * Sayı üç ayrı belgede, üç ayrı cümlede geçiyor (durum tablosu, canlılık bloğu,
   * karşılaştırma satırı) ve elle tutuluyor. Kaydı değiştirip belgeleri unutmak bu
   * testte kırmızı olur — sayının kendisi ZINCIR_HALKALARI'ndan sayılır.
   */
  const EN = ["zero", "one", "two", "three", "four", "five", "six"];
  const TR_PAY = ["hiçbiri", "biri", "ikisi", "üçü", "dördü", "beşi", "altısı"];
  const TR_TOPLAM = ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı"];

  const canli = CANLI_HALKALAR.length;
  const toplam = ZINCIR_HALKALARI.length;
  assert.ok(canli < EN.length && toplam < EN.length, "sayı sözlüğü zincire yetmiyor");

  const enDesen = new RegExp(`${EN[canli]}\\s+of\\s+(the\\s+)?${EN[toplam]}`, "i");
  for (const [ad, metin] of [
    ["README.md", BELGE_README],
    ["docs/CAMARA.md", BELGE_CAMARA],
  ] as const) {
    assert.match(
      metin,
      enDesen,
      `${ad}, canlı doğrulanmış halka sayısını "${EN[canli]} of ${EN[toplam]}" biçiminde ` +
        `söylemiyor. Kayıtta ${canli}/${toplam} halka canlı; belge sayıyı elle taşıyor ve ` +
        `kayıt değişince birlikte güncellenmeli.`
    );
  }

  const trDesen = new RegExp(`${TR_TOPLAM[toplam]}[^.\\n]{0,40}${TR_PAY[canli]}`, "i");
  assert.match(
    BELGE_README_TR,
    trDesen,
    `README.tr.md, canlı doğrulanmış halka sayısını "${TR_TOPLAM[toplam]} … ` +
      `${TR_PAY[canli]}" biçiminde söylemiyor. İngilizce README güncellenirken Türkçesinin ` +
      `geride kalması bu depoda ölçülmüş bir örüntü.`
  );
});

test("README'lerin CANLILIK BLOĞU, halka sayısını kendi içinde söylüyor", () => {
  /**
   * Sayının belgede bir yerde geçmesi yetmiyor: Türkçe README'de sayı özet tablosunda
   * doğruyken, hemen altındaki canlılık bloğu hâlâ "3. ve 4. halkayı hesap engelliyor,
   * her Device Status yolu 404" diyordu. Yani okuyucu doğru sayıyı bir satır, yanlış
   * teşhisi bir sonraki paragraf olarak okuyordu — ve depo hafızasına "haftalarca
   * kovalanan yanlış teşhis" diye geçen hata Türkçe tarafta canlı kalıyordu.
   *
   * Bu yüzden sayı, iddiayı KURAN bloğun İÇİNDE aranır. Blok, iki dilde de aynı
   * çapayla bulunur: denetim izi alanı `simSwapKanali` yalnız orada geçer.
   */
  const EN = ["zero", "one", "two", "three", "four", "five", "six"];
  const TR_PAY = ["hiçbiri", "biri", "ikisi", "üçü", "dördü", "beşi", "altısı"];
  const TR_TOPLAM = ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı"];

  const canli = CANLI_HALKALAR.length;
  const toplam = ZINCIR_HALKALARI.length;

  /** `simSwapKanali` çapasını içeren, `>` ile başlayan bitişik alıntı bloğu. */
  const canlilikBlogu = (ad: string, metin: string): string => {
    const satirlar = metin.split(/\r?\n/);
    const capa = satirlar.findIndex((s) => s.startsWith(">") && s.includes("simSwapKanali"));
    assert.notEqual(
      capa,
      -1,
      `${ad} içinde canlılık bloğu (simSwapKanali geçen alıntı) bulunamadı — test yolu bayatlamış`
    );
    let bas = capa;
    while (bas > 0 && satirlar[bas - 1].startsWith(">")) bas--;
    let son = capa;
    while (son + 1 < satirlar.length && satirlar[son + 1].startsWith(">")) son++;
    return satirlar.slice(bas, son + 1).join("\n");
  };

  assert.match(
    canlilikBlogu("README.md", BELGE_README),
    new RegExp(`${EN[canli]}\\s+of\\s+(the\\s+)?${EN[toplam]}`, "i"),
    `README.md'nin canlılık bloğu, kaç halkanın canlı doğrulandığını söylemiyor ` +
      `(kayıtta ${canli}/${toplam}). İddiayı kuran paragraf, sayıyı da taşımalı.`
  );
  assert.match(
    canlilikBlogu("README.tr.md", BELGE_README_TR),
    new RegExp(`${TR_TOPLAM[toplam]}[^.\\n]{0,40}${TR_PAY[canli]}`, "i"),
    `README.tr.md'nin canlılık bloğu, kaç halkanın canlı doğrulandığını söylemiyor ` +
      `(kayıtta ${canli}/${toplam}). Türkçe blok İngilizcesinden geride kalmış olabilir.`
  );
});

test("docs/CAMARA.md §2: 'henüz koşmadı' YALNIZ canlı doğrulanmamış halkalar için söylenebilir", () => {
  /**
   * Belgenin kendi kendisiyle çelişmesi tam olarak burada oldu: §1 halka 3-4 için
   * "Live since 31 Aug" derken §2 hâlâ "links 2, 3 and 4 have not run live — blocked by
   * the account" diyordu. İkisi aynı anda doğru olamaz ve okuyucu hangisinin bayat
   * olduğunu bilemez; daha kötüsü, belge ÇÖZÜLMÜŞ bir sorunu mentör oturumunun
   * gündemine yazıyordu (tek 30 dakikalık hak).
   *
   * Gözcü halka NUMARALARINI cümleden söküp kayda sorar: numarası canlı doğrulanmış bir
   * halkayı "koşmadı" diye anan her cümle kırmızı olur.
   */
  const satirlar = BELGE_CAMARA.split(/\r?\n/);
  const bas = satirlar.findIndex((s) => s.startsWith("## ") && s.includes("What has run live"));
  assert.notEqual(bas, -1, "docs/CAMARA.md §2 bulunamadı — test yolu bayatlamış");
  const kalan = satirlar.slice(bas + 1);
  const sonIdx = kalan.findIndex((s) => s.startsWith("## "));
  const bolum2 = sonIdx === -1 ? kalan : kalan.slice(0, sonIdx);

  const KOSMADI = /has not run live|have not been exercised|not been exercised|not yet run/i;
  const suclular: string[] = [];
  let iddiaSayisi = 0;

  for (const satir of bolum2) {
    if (!KOSMADI.test(satir)) continue;
    iddiaSayisi++;
    for (const m of satir.matchAll(/links?\s+((?:\d(?:\s*,\s*|\s+and\s+)?)+)/gi)) {
      for (const n of m[1].match(/\d/g) ?? []) {
        const halka = ZINCIR_HALKALARI[Number(n) - 1];
        if (halka?.canliDogrulandi) {
          suclular.push(`halka ${n} (${halka.id}, ${halka.canliDogrulandi}): ${satir.trim().slice(0, 100)}`);
        }
      }
    }
  }

  assert.ok(
    iddiaSayisi > 0,
    "docs/CAMARA.md §2 artık 'henüz koşmadı' cümlesi taşımıyor — gözcü sessizce boşa " +
      "düşmesin diye burada durur; NV halkası hâlâ canlı koşmuyor ve bu SÖYLENMELİ"
  );
  assert.deepEqual(
    suclular,
    [],
    "docs/CAMARA.md §2, kayıtta CANLI DOĞRULANMIŞ bir halka için 'henüz koşmadı' diyor:\n" +
      suclular.join("\n") +
      "\nBelge çözülmüş bir sorunu açık gösteriyor; §1 ile §2 birlikte güncellenir."
  );
});
