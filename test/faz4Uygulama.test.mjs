// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 4 — scripts/brain/uygulama.mjs · KADEMELİ DOĞRULAMA REDDİNİN SINIFLANDIRILMASI.
 *
 * Tek bulgu, ölçülmüş kırmızı: AEGIS_STEPUP açıkken bozuk bir ağ sinyali (SIM taşınmış) o
 * sinyali ÇÜRÜTEBİLEN temiz bir halkayla karşılaştığında networkTrust.ts artık düz ret
 * vermez; kararı approval.ts'e "yükseltme" olarak devreder. Growth Brain'in istemcisi
 * elicitation desteklemediği için approval.ts bunu kanal "ag" ile REDDEDER. Ama o ret
 * metninin taşıdığı tek ağ izi kendi başlıklarıdır ("⚠ AĞ SİNYALİ BOZUK …",
 * "BU İSTEMCİDE YÜKSELTME YAPILAMAZ …"); ne bir halka başlığı ne de bir AEGIS_* değişken
 * adı geçer. Düzeltmeden önce ÖLÇÜLDÜ: gerçek onay kapısı koşturulup dönen metin
 * yayinSonucuSinifla'ya verildiğinde sonuç 'reddedildi' idi — rapor "GÜVENLİK KAPISI
 * ÇALIŞTI" bloğunu hiç basmıyor, CAMARA zincirinin SIM değişimini yakaladığı an sıradan
 * bir sunucu reddi gibi görünüyordu. Bu, uygulama.mjs'teki DEVICESWAP/CALLFWD notunun
 * anlattığı hatanın bir kat yukarısındaki aynısı.
 *
 * Gözcülerin hiçbiri vakumda değil:
 *
 *  1) DAVRANIŞSAL, GERÇEK KAPIDAN. Ret metni fixture DEĞİL: src/approval.ts +
 *     src/networkTrust.ts gerçekten koşturulup üretiliyor (CAMARA kanalları sahte, ağ
 *     çağrısı yok). Böylece gözcü ÇİFT YÖNLÜ olur: uygulama.mjs'ten desenler kalkarsa da,
 *     approval.ts ret cümlesini değiştirirse de kırmızı.
 *
 *  2) YÜK TAŞIMA KANITI. Desen listesi KAYNAKTAN ayrıştırılıp yeni iki desen çıkarılıyor;
 *     kalan desenlerin gerçek kademe reddinde HİÇBİRİ eşleşmemeli. Eşleşirse gözcü
 *     kendini yeşile boyayan bir desen bulmuş demektir ve durur.
 *
 *  3) GENİŞLEME YOK. Aynı gerçek kapıdan üretilen üç insan-kanalı reddi (ajan aracılı ret,
 *     insan reddi, kademe istemi GÖSTERİLİP insanın reddettiği hâl) hâlâ
 *     'insan-onayi-gerekli'; kampanya ADI kademe ifadelerini taşısa bile sıradan bir bütçe
 *     reddi 'ag-retti' olmuyor.
 *
 *  4) BELGE GÖZCÜSÜ ÇİFT YÖNLÜ ve mutasyonu KENDİ İÇİNDE kanıtlı: doğrulayıcı, bozulmuş
 *     kaynak kopyalarında gerçekten fırlatıyor (assert.throws).
 *
 * AĞSIZ, YAZMASIZ, SIRSIZ: MCP/Google/CAMARA bağlantısı yok, .env okunmuyor, geçici dosya
 * bırakılmıyor.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { onayAl } from "../src/approval.js";
import {
  __setSimSwapKanalForTests,
  __setErisimKanalForTests,
  __setCihazDegisimKanalForTests,
} from "../src/networkTrust.js";
import { yayinaAl, yayinSonucuSinifla } from "../scripts/brain/uygulama.mjs";
import { raporOlustur } from "../scripts/brain/rapor.mjs";

const KOK = join(dirname(fileURLToPath(import.meta.url)), "..");
const oku = (p) => readFileSync(join(KOK, p), "utf8");

const KAMPANYA_ADI = "GB-20260909-1200 — El Yapımı Deri Çanta";

/**
 * Kademeli doğrulamanın AÇIK olduğu ağ ayarı. `devSwapCheck` bilinçli açık: SIM değişimine
 * KEFİL olabilen gerçek bir halka olmadan yükseltme hiç doğmaz, ret düz ağ reddi olur ve
 * eski desenler onu zaten yakalar — yani gözcü ölçmek istediği şeyi ölçemezdi.
 */
const KADEME_AYARI = Object.freeze({
  nacToken: "TEST-ONLY-token",
  approverPhone: "+905551112277",
  simSwapWindowHours: 137,
  reachCheck: true,
  devSwapCheck: true,
  callFwdCheck: false,
  stepUp: true,
});

function ozetUret() {
  return {
    eylem: `"${KAMPANYA_ADI}" kampanyası YAYINA ALINACAK (ENABLED)`,
    satirlar: [
      `Hesap: 1234567890 · Kampanya: ${KAMPANYA_ADI}`,
      "Günlük bütçe: 40 (hesabın para biriminde)",
    ],
    risk: "high",
    agAyar: KADEME_AYARI,
  };
}

/** Elicitation BİLDİRMEYEN istemci — Growth Brain'in mcpBaglan'ı da böyle. */
function zayifIstemci() {
  return {
    server: {
      getClientCapabilities: () => ({}),
      elicitInput: async () => {
        throw new Error("zayıf kanalda insana istem GÖSTERİLMEMELİ");
      },
    },
  };
}

/** Elicitation bildiren istemci; insanın kararını oynatır ve gösterilen istemi toplar. */
function gucluIstemci(karar, sorulanlar = []) {
  return {
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async (istek) => {
        sorulanlar.push(String(istek.message));
        return { action: karar, content: { onay: false } };
      },
    },
  };
}

/** SIM taşınmış; cihaz değişimi halkası GERÇEK kanaldan temiz → kefil var → yükseltme. */
function kademeKosullari() {
  __setSimSwapKanalForTests({ verifySimSwap: async () => true });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
}

/** Zincirin tamamı temiz. */
function temizKosullar() {
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
}

afterEach(() => {
  __setSimSwapKanalForTests(undefined);
  __setErisimKanalForTests(undefined);
  __setCihazDegisimKanalForTests(undefined);
});

/**
 * GERÇEK kademe reddini üretir. Fixture yazmamanın bedeli bu fonksiyondur, kazancı ise
 * gözcünün approval.ts'in cümlesi değiştiğinde de kırmızı olmasıdır.
 */
async function gercekKademeReti() {
  kademeKosullari();
  const sonuc = await onayAl(zayifIstemci(), ozetUret(), true /* ajan rızayı UYDURUYOR */);
  assert.equal(sonuc.onaylandi, false, "yükseltme zayıf kanalda GEÇMEMELİ");
  assert.equal(sonuc.kanal, "ag", "bu ret ağ kapısının reddidir — kanal 'ag' olmalı");
  assert.ok(typeof sonuc.mesaj === "string" && sonuc.mesaj.length > 0);
  return sonuc.mesaj;
}

/* ── 1) Davranışsal gözcü: gerçek kademe reddi 'ag-retti' sınıflanır ─────────── */

test("KRİTİK: gerçek kademe reddi (kanal 'ag') 'ag-retti' sınıflanır, 'reddedildi' değil", async () => {
  const ret = await gercekKademeReti();

  assert.equal(
    yayinSonucuSinifla(ret, KAMPANYA_ADI),
    "ag-retti",
    "AEGIS_STEPUP açıkken ağ kapısının ürettiği ret 'reddedildi' sınıflanırsa rapor " +
      "'GÜVENLİK KAPISI ÇALIŞTI' bloğunu basmaz: CAMARA zincirinin SIM değişimini " +
      "yakaladığı an sıradan bir sunucu reddi gibi görünür."
  );
});

test("kademe reddi rapora 'GÜVENLİK KAPISI ÇALIŞTI' olarak geçer ve metni AYNEN taşınır", async () => {
  const ret = await gercekKademeReti();
  const cagir = async () => ret;
  const yayinSonucu = await yayinaAl(
    { kampanyaId: "9002", musteriId: "1234567890", kampanyaAdi: KAMPANYA_ADI },
    { cagir }
  );

  assert.equal(yayinSonucu.durum, "ag-retti");
  assert.equal(yayinSonucu.sonucMetni, ret, "ret metni özetlenmeden/yumuşatılmadan taşınmalı");

  const rapor = raporOlustur({ hedef: "test", kuruMod: false, yayinSonucu });
  assert.ok(rapor.includes("AĞ KAPISI REDDETTİ"), "rapor ağ kapısını adıyla anmalı");
  assert.ok(rapor.includes("GÜVENLİK KAPISI ÇALIŞTI"));
  assert.ok(rapor.includes("BU BİR BAŞARISIZLIK DEĞİLDİR"));
  assert.ok(rapor.includes("AĞ SİNYALİ BOZUK"), "bozuk sinyal rapora ADIYLA düşmeli");
  assert.ok(rapor.includes("Kampanya DURAKLATILMIŞ (PAUSED)"));
});

/* ── 2) Vakum karşıtı: sınıflandırmayı gerçekten YENİ desenler taşıyor ───────── */

/**
 * AG_KAPISI_IZLERI'ni KAYNAKTAN okur (import etmez): dizi dışa aktarılmıyor ve sınanmak
 * istenen şey tam olarak sevk edilen dosyanın içeriği.
 */
function agKapisiDesenleri() {
  const kaynak = oku("scripts/brain/uygulama.mjs");
  const bas = kaynak.indexOf("const AG_KAPISI_IZLERI = [");
  assert.notEqual(bas, -1, "AG_KAPISI_IZLERI bulunamadı — yeniden adlandırıldıysa bu gözcü de güncellenmeli");
  const son = kaynak.indexOf("];", bas);
  assert.notEqual(son, -1, "AG_KAPISI_IZLERI dizisi kapanmıyor — kaynak ayrıştırılamadı");
  const desenler = [];
  for (const satir of kaynak.slice(bas, son).split(/\r?\n/)) {
    const m = /^\s*\/(.+)\/([a-z]*),?\s*$/.exec(satir);
    if (m) desenler.push(new RegExp(m[1], m[2]));
  }
  assert.ok(desenler.length >= 10, `yalnız ${desenler.length} desen ayrıştırılabildi — ayrıştırma bozulmuş olabilir`);
  return desenler;
}

/** Sınıflandırıcının ağ desenlerine verdiği gövde: madde satırları ÇIKARILMIŞ metin. */
function maddesiz(metin) {
  return String(metin)
    .split("\n")
    .filter((s) => !s.trim().startsWith("•"))
    .join("\n");
}

const KADEME_DESEN_KAYNAKLARI = ["AĞ SİNYALİ BOZUK", "BU İSTEMCİDE YÜKSELTME YAPILAMAZ"];

test("gözcü boş değil: kademe reddini YALNIZ yeni iki desen yakalıyor", async () => {
  const govde = maddesiz(await gercekKademeReti());
  const desenler = agKapisiDesenleri();

  const yeniler = desenler.filter((d) => KADEME_DESEN_KAYNAKLARI.includes(d.source));
  assert.equal(
    yeniler.length,
    2,
    "AG_KAPISI_IZLERI kademe reddinin iki başlığını da taşımalı: " + KADEME_DESEN_KAYNAKLARI.join(" · ")
  );
  for (const d of yeniler) assert.ok(d.test(govde), `${d} gerçek kademe reddiyle eşleşmiyor`);

  /**
   * MUTASYON, KAYNAK ÜZERİNDEN: iki desen çıkarıldığında geriye kalanların hiçbiri bu reddi
   * tanımamalı. Tanısaydı gözcü hiçbir şeyi tutmuyor olurdu — düzeltme geri alınsa bile
   * yeşil kalırdı. Ölçülen kırmızı tam olarak budur: fix'ten önceki desen kümesi bu gövdede
   * HİÇ eşleşme üretmiyor ve sınıf 'reddedildi' oluyordu.
   */
  const eskiler = desenler.filter((d) => !KADEME_DESEN_KAYNAKLARI.includes(d.source));
  const kacak = eskiler.filter((d) => d.test(govde));
  assert.deepEqual(
    kacak.map(String),
    [],
    "kademe reddini eski desenlerden biri de yakalıyor: gözcü artık düzeltmeye BAĞLI değil, " +
      "yeniden kurulmalı (ya da o desenin gereğinden geniş olup olmadığı incelenmeli)"
  );
});

/* ── 3) Düzeltme kapıyı GENİŞLETMEDİ ─────────────────────────────────────────── */

test("insan kapısı retleri hâlâ 'insan-onayi-gerekli' — üçü de gerçek kapıdan", async () => {
  temizKosullar();
  const ajanKanali = await onayAl(zayifIstemci(), ozetUret(), undefined);
  assert.equal(ajanKanali.kanal, "ajan");
  assert.equal(yayinSonucuSinifla(ajanKanali.mesaj, KAMPANYA_ADI), "insan-onayi-gerekli");

  const insanRetti = await onayAl(gucluIstemci("decline"), ozetUret(), true);
  assert.equal(insanRetti.kanal, "insan");
  assert.equal(yayinSonucuSinifla(insanRetti.mesaj, KAMPANYA_ADI), "insan-onayi-gerekli");

  /**
   * EN İNCE HÂL: kademe VAR, istem GÖSTERİLDİ (başlığında "AĞ SİNYALİ BOZUK" geçiyor) ve
   * İNSAN reddetti. Karar insanındır; ret metni de insan kanalınındır ve ağ ifadesi
   * taşımaz. Yeni desenler insan kanalına taşsaydı bu satır kırmızı olurdu.
   */
  kademeKosullari();
  const sorulanlar = [];
  const kademeliInsanRetti = await onayAl(gucluIstemci("decline", sorulanlar), ozetUret(), true);
  assert.equal(sorulanlar.length, 1, "kademe istemi insana gösterilmeliydi");
  assert.match(sorulanlar[0], /AĞ SİNYALİ BOZUK/, "istem bozuk sinyali adıyla söylemeli");
  assert.equal(kademeliInsanRetti.kanal, "insan");
  assert.equal(
    yayinSonucuSinifla(kademeliInsanRetti.mesaj, KAMPANYA_ADI),
    "insan-onayi-gerekli",
    "insanın reddi ağ reddi diye SUNULAMAZ"
  );
});

test("uydurulamaz: kademe ifadelerini AD olarak taşıyan sıradan ret 'ag-retti' olmaz", () => {
  for (const ad of [
    "AĞ SİNYALİ BOZUK",
    " AĞ SİNYALİ BOZUK ",
    "BU İSTEMCİDE YÜKSELTME YAPILAMAZ",
    " BU İSTEMCİDE YÜKSELTME YAPILAMAZ ",
  ]) {
    const ret = `Reddedildi: "${ad}" kampanyasının günlük bütçesi 900 — hesabın günlük bütçe tavanı 500.`;
    assert.equal(
      yayinSonucuSinifla(ret, ad),
      "reddedildi",
      `modelin seçtiği ad ("${ad}") sıradan bir bütçe reddini ağ reddine çeviremez`
    );
  }
});

/* ── 4) Belge gözcüsü: iki dize approval.ts'te GERÇEKTEN üretiliyor mu? ──────── */

/**
 * ÇİFT YÖNLÜ. Desenler uygulama.mjs'te durur ama karşılıkları src/approval.ts'te üretilir;
 * o cümleler değişirse desenler sessizce ölü kalır ve kademe reddi yine 'reddedildi'
 * sınıflanır. Bu yüzden dizeler approval.ts'in KOD satırlarında aranır — yorum satırları
 * elenir, yoksa bir yorumdaki alıntı gözcüyü ayakta tutar (sahte güvence).
 */
function approvalKodSatirlari(kaynak) {
  return String(kaynak)
    .split(/\r?\n/)
    .filter((s) => {
      const t = s.trim();
      return t !== "" && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
}

function kademeDizeleriniDogrula(kaynak) {
  const kod = approvalKodSatirlari(kaynak);
  for (const dize of KADEME_DESEN_KAYNAKLARI) {
    if (!kod.includes(dize)) {
      throw new Error(
        `src/approval.ts artık "${dize}" dizesini ÜRETMİYOR. scripts/brain/uygulama.mjs · ` +
          `AG_KAPISI_IZLERI o dizeye dayanıyor: karşılığı değişince desen ölür ve kademeli ` +
          `doğrulama reddi 'ag-retti' yerine 'reddedildi' sınıflanır.`
      );
    }
  }
}

test("belge/kod bağı: kademe ret cümleleri approval.ts'in KODUNDA duruyor", () => {
  const kaynak = oku("src/approval.ts");
  assert.doesNotThrow(() => kademeDizeleriniDogrula(kaynak));

  /**
   * MUTASYON, GÖZCÜNÜN İÇİNDE: bozulmuş kopyalarda doğrulayıcı gerçekten fırlıyor. Vakum
   * gözcü olmadığının kanıtı testin kendi içinde durur.
   */
  for (const dize of KADEME_DESEN_KAYNAKLARI) {
    assert.throws(
      () => kademeDizeleriniDogrula(kaynak.split(dize).join("AĞ DURUMU DEĞİŞTİ")),
      /dizesini ÜRETMİYOR/,
      `"${dize}" kaynaktan silindiğinde gözcü kırmızı olmalı`
    );
  }
  assert.throws(
    () => kademeDizeleriniDogrula("// AĞ SİNYALİ BOZUK\n * BU İSTEMCİDE YÜKSELTME YAPILAMAZ\n"),
    /dizesini ÜRETMİYOR/,
    "yalnız YORUMDA geçen dizeler gözcüyü yeşil tutmamalı"
  );
});
