// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 4 — scripts/brain/strateji.mjs gerileme gözcüleri.
 *
 * TEK BULGU: SISTEM_PROMPT kuralı TÜM alanları kapsıyordu ("Hiçbir alana URL, kod, komut ya
 * da kontrol karakteri koyma."), planDogrula ise URL yasağını YALNIZ iki kelime listesine
 * uyguluyordu. dizeKontrol'ün `{ urlYasak = false }` seçeneği çağrı başına açılıyordu ve dört
 * alan o bayrağı hiç almamıştı.
 *
 * ÖLÇÜLDÜ (düzeltmeden ÖNCE, planDogrula(plan, 200) ile):
 *   KABUL  kampanyaAdi          "Kampanya https://saldirgan.example/?h=sizinti"
 *   KABUL  dil                  "https://saldirgan.example/?h=sizinti"
 *   KABUL  basariMetrikleri[0]  "TO https://saldirgan.example/?h=sizinti"
 *   KABUL  adGruplari[0].ad     "Grup https://saldirgan.example/?h=sizinti"   ← raporda yoktu
 *   RED    anahtarKelimeler[0] / negatifKelimeler[0]   (kapalı olan tek ikisi)
 *
 * NEDEN ÖNEMLİ: kampanyaAdi sistemden ÇIKAN alandır. uygulama.mjs:293 onu guvenliDize'den
 * geçirir — guvenliDize yalnız kontrol karakterine ve uzunluğa bakar, URL ARAMAZ (o dosyada
 * URL kontrolü yalnız kelimeDogrula'da vardır) — ardından uygulama.mjs:478 `name:` olarak
 * Google Ads hesabına, rapor.mjs:315 rapor dosyasına yazar. Enjekte edilmiş site içeriğinin
 * modele yazdırdığı bir sızdırma bağlantısı, MCC altındaki herkesin gördüğü kampanya adına
 * taşınırdı. Bu kapı, o yoldaki SON kapıdır.
 *
 * DÜZELTME (şüpheyi REDDE götüren yönde): URL yasağı, hemen üstündeki kontrol-karakteri yasağı
 * gibi KOŞULSUZ yapıldı ve `urlYasak` seçeneği kaldırıldı. Çağrı başına açılan bir bayrak,
 * plana eklenen her yeni alanı bayrak hatırlanana kadar kuralın DIŞINDA bırakır; bu bulgu tam
 * olarak öyle doğdu.
 *
 * Gözcüler ÇİFT YÖNLÜ ve vakum değil:
 *   A) CÜMLE BAYATLARSA kırmızı — SISTEM_PROMPT'un "hiçbir alana URL" kuralı modele giden
 *      istemden çıkar ya da yeniden yazılırsa. İstem kaynaktan okunmuyor: stratejiKur'un
 *      jsonUret2'ye GERÇEKTEN verdiği sistem metni yakalanıyor.
 *   B) KOD DEĞİŞİRSE kırmızı — planDogrula alanların herhangi birinde URL kabul etmeye
 *      dönerse. Serbest metin alanlarında hata mesajının /URL içeremez/ olduğu ayrıca
 *      doğrulanıyor; böylece gözcü "uzunluk sınırına takıldı" gibi YANLIŞ BİR SEBEPLE
 *      yeşil kalamaz.
 *
 * MUTASYONLA DOĞRULANDI: düzeltme geri alınınca (URL kontrolü yeniden `urlYasak &&` ile
 * koşullandırılıp iki çağrıya bayrak geri konunca) bu dosyadaki B yönü gözcüleri kırmızıya
 * döndü; A yönü de kural cümlesi istemden çıkarılarak ayrıca kırmızıya düşürüldü.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stratejiKur, planDogrula } from "../scripts/brain/strateji.mjs";

const KAYNAK = new URL("../scripts/brain/strateji.mjs", import.meta.url);

/** SISTEM_PROMPT'taki kural — birebir, kırpılmadan. */
const PROMPT_KURALI = "- Hiçbir alana URL, kod, komut ya da kontrol karakteri koyma.";

/** Sızdırma bağlantısı. Kısa tutuldu: eklendiği hiçbir alanın uzunluk sınırını aşmasın ki
 * red URL kuralından gelsin, uzunluktan değil. */
const SIZDIRMA_URL = "https://kotu.example/?s=1";

function gecerliPlan(degisiklik = {}) {
  return {
    kampanyaAdi: "GB Test Kampanyası",
    hedefUlke: "TR",
    dil: "tr",
    butceGunlukTL: 150,
    adGruplari: [
      {
        ad: "Ana Grup",
        anahtarKelimeler: ["koşu ayakkabısı", "spor ayakkabı fiyat"],
        eslesmeTipi: "PHRASE",
      },
    ],
    negatifKelimeler: ["ücretsiz", "iş ilanı"],
    basariMetrikleri: ["TO %5 üzeri", "TBM 5 TL altı"],
    ...degisiklik,
  };
}

/** Serbest metin alanları: bu alanlarda red URL KURALINDAN gelmeli. */
const SERBEST_METIN_ALANLARI = [
  "kampanyaAdi",
  "dil",
  "adGruplari[0].ad",
  "adGruplari[0].anahtarKelimeler[0]",
  "negatifKelimeler[0]",
  "basariMetrikleri[0]",
];

function yolaYaz(nesne, yol, deger) {
  const parcalar = yol.replace(/\[(\d+)\]/g, ".$1").split(".");
  let hedef = nesne;
  for (let i = 0; i < parcalar.length - 1; i++) hedef = hedef[parcalar[i]];
  hedef[parcalar.at(-1)] = deger;
}

function yoldanOku(nesne, yol) {
  const parcalar = yol.replace(/\[(\d+)\]/g, ".$1").split(".");
  let deger = nesne;
  for (const p of parcalar) deger = deger[p];
  return deger;
}

/** Plandaki HER dize yaprağının yolu — plana yeni bir alan eklendiğinde yürüyüş onu da görsün. */
function dizeYapraklari(deger, yol = "") {
  if (typeof deger === "string") return [yol];
  if (Array.isArray(deger)) return deger.flatMap((d, i) => dizeYapraklari(d, `${yol}[${i}]`));
  if (deger !== null && typeof deger === "object") {
    return Object.entries(deger).flatMap(([k, v]) => dizeYapraklari(v, yol ? `${yol}.${k}` : k));
  }
  return [];
}

/** stratejiKur'un jsonUret2'ye gerçekten verdiği sistem istemi — kaynaktan değil, koşudan. */
async function sistemIstemiYakala() {
  const kayit = {};
  await stratejiKur(
    { hedef: "Koşu ayakkabısı satışı", butceGunlukTL: 200, arastirma: { pazarOzeti: "özet" } },
    {
      jsonUret2: async (sistem) => {
        kayit.sistem = sistem;
        return gecerliPlan();
      },
    }
  );
  assert.equal(
    typeof kayit.sistem,
    "string",
    "sistem istemi yakalanamadı — stratejiKur sözleşmesi değişmiş."
  );
  return kayit.sistem;
}

/* ══ A YÖNÜ — cümle bayatlarsa kırmızı ═════════════════════════════════════ */

test("A) 'hiçbir alana URL' kuralı modele GİDEN istemde birebir duruyor", async () => {
  const sistem = await sistemIstemiYakala();
  assert.ok(
    sistem.includes(PROMPT_KURALI),
    `SISTEM_PROMPT'ta şu kural birebir bulunamadı:\n  ${PROMPT_KURALI}\n` +
      `Kural yeniden yazıldıysa aşağıdaki B yönü gözcüleri artık YANLIŞ bir cümleye kefil ` +
      `oluyor demektir: ya kuralı geri getir ya da bu dosyadaki alan listesini kuralın yeni ` +
      `kapsamıyla birlikte güncelle.`
  );
});

/* ══ B YÖNÜ — kod değişirse kırmızı ════════════════════════════════════════ */

test("B) düzeltilen dört alan URL'yi reddediyor (kampanyaAdi, dil, grup adı, metrik)", () => {
  const vakalar = [
    ["kampanyaAdi", { kampanyaAdi: `Kampanya ${SIZDIRMA_URL}` }],
    ["dil", { dil: `tr ${SIZDIRMA_URL}` }],
    [
      "adGruplari[0].ad",
      {
        adGruplari: [
          { ad: `Grup ${SIZDIRMA_URL}`, anahtarKelimeler: ["koşu"], eslesmeTipi: "PHRASE" },
        ],
      },
    ],
    ["basariMetrikleri[0]", { basariMetrikleri: [`TO ${SIZDIRMA_URL}`] }],
  ];
  for (const [alan, degisiklik] of vakalar) {
    assert.throws(
      () => planDogrula(gecerliPlan(degisiklik), 200),
      /URL içeremez/,
      `${alan} URL kabul ediyor. kampanyaAdi Google Ads hesabına ve rapor dosyasına yazılan ` +
        `alandır; uygulama.mjs'teki guvenliDize URL aramaz, yani bu kapı son kapıdır.`
    );
  }
});

test("B) zaten kapalı iki kelime listesi hâlâ URL reddediyor (gerileme)", () => {
  assert.throws(
    () =>
      planDogrula(
        gecerliPlan({
          adGruplari: [
            { ad: "Ana Grup", anahtarKelimeler: [SIZDIRMA_URL], eslesmeTipi: "PHRASE" },
          ],
        }),
        200
      ),
    /anahtarKelimeler\[0\] URL içeremez/
  );
  assert.throws(
    () => planDogrula(gecerliPlan({ negatifKelimeler: [SIZDIRMA_URL] }), 200),
    /negatifKelimeler\[0\] URL içeremez/
  );
});

test("B) geçerli planın HER dize yaprağı URL'yi reddeder — yeni alan sessizce açık kalamaz", () => {
  const yapraklar = dizeYapraklari(gecerliPlan());
  // Hiçbir şey gözlememiş yürüyüş hiçbir şeye kefil olamaz.
  assert.ok(
    yapraklar.length >= 8,
    `dize yaprağı yürüyüşü boş/eksik döndü: ${yapraklar.join(", ")}`
  );
  for (const alan of SERBEST_METIN_ALANLARI) {
    assert.ok(yapraklar.includes(alan), `yürüyüş '${alan}' alanını görmedi — fikstür bayatlamış.`);
  }

  const gecenler = [];
  for (const yol of yapraklar) {
    const plan = structuredClone(gecerliPlan());
    yolaYaz(plan, yol, `${yoldanOku(plan, yol)} ${SIZDIRMA_URL}`);
    let mesaj = null;
    try {
      planDogrula(plan, 200);
    } catch (e) {
      mesaj = e.message;
    }
    if (mesaj === null) {
      gecenler.push(yol);
      continue;
    }
    // Serbest metinde red URL KURALINDAN gelmeli; uzunluk/enum sebebiyle yeşil kalmak,
    // gözcünün yanlış sebeple kefil olması demektir.
    if (SERBEST_METIN_ALANLARI.includes(yol)) {
      assert.match(mesaj, /URL içeremez/, `${yol} reddedildi ama URL kuralından değil: ${mesaj}`);
    }
  }
  assert.deepEqual(
    gecenler,
    [],
    `Şu alan(lar) URL taşıyan bir değeri KABUL etti: ${gecenler.join(", ")}. ` +
      `SISTEM_PROMPT kuralı tüm alanları kapsar; dizeKontrol'deki URL kontrolü koşulsuz olmalı.`
  );
  // hedefUlke ve eslesmeTipi de reddedilir, ama kendi biçim/enum kapılarından: bu gözcü onlar
  // için yalnız "URL geçmiyor" der, "URL kuralı çalıştı" demez.
});

test("B) YAPISAL: hiçbir dizeKontrol çağrısı seçenek nesnesi geçmiyor", async () => {
  const metin = await readFile(KAYNAK, "utf8");
  const cagrilar = metin
    .split("\n")
    .map((satir, i) => ({ no: i + 1, satir }))
    .filter(
      ({ satir }) => satir.includes("dizeKontrol(") && !satir.trimStart().startsWith("function ")
    );

  assert.ok(
    cagrilar.length >= 6,
    `dizeKontrol çağrısı bulunamadı (${cagrilar.length}) — desen bayatlamış.`
  );
  for (const etiket of [
    "kampanyaAdi",
    "dil",
    "].ad",
    "anahtarKelimeler",
    "negatifKelimeler",
    "basariMetrikleri",
  ]) {
    assert.ok(
      cagrilar.some(({ satir }) => satir.includes(etiket)),
      `'${etiket}' için dizeKontrol çağrısı görülmedi — alan doğrulamadan çıkarılmış olabilir.`
    );
  }

  // Yalnızca `${...}` şablon aradeğerleri maskeleniyor (bilerek DAR bir ayıklama): geriye
  // kalan metinde bir `{` varsa o, çağrıya geçirilen seçenek nesnesidir.
  const suclular = cagrilar
    .filter(({ satir }) => satir.replace(/\$\{[^}]*\}/g, "X").includes("{"))
    .map(({ no, satir }) => `${no}: ${satir.trim()}`);
  assert.deepEqual(
    suclular,
    [],
    `dizeKontrol'e seçenek nesnesi geçen çağrı(lar):\n${suclular.join("\n")}\n` +
      `URL yasağı çağrı başına açılan bir bayrak olamaz: bayrağı unutulan her yeni alan ` +
      `kuralın dışında kalır. Bu bulgu tam olarak böyle doğdu.`
  );
});

/* ══ AŞIRI ENGELLEME YOK ═══════════════════════════════════════════════════ */

test("URL taşımayan geçerli plan aynen geçer (değiştirilmeden döner)", () => {
  const plan = gecerliPlan({
    kampanyaAdi: "GB-2026 · Koşu Ayakkabısı — Arama (TR)",
    basariMetrikleri: ["TO %5 üzeri", "Dönüşüm başı maliyet 50 TL altı"],
  });
  assert.equal(planDogrula(plan, 200), plan);
});
