// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RİSK → HALKA EŞLEMESİ.
 *
 * Mentör önerisi (Aleksi Puranen, Nokia, 31.08.2026): "İlk yayına alma üç turu da alsın,
 * kapının zaten temizlediği bir örüntüdeki bütçe artışı bir tur alsın. Eşlemeyi basit ve
 * açık tut."
 *
 * Eşleme zaten böyleydi ama görünmüyordu: beş ayrı katmanın içine dağılmış
 * `if (risk !== "high")` satırlarıydı. Artık tek tabloda duruyor — ve bir tablo,
 * gerçekten uygulandığı sınanmadıkça yalnızca bir niyet beyanıdır. Aşağıdaki testler
 * tablonun DAVRANIŞLA aynı şeyi söylediğini sabitler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agDogrula,
  halkaKosarMi,
  RISK_HALKA_ESLEMESI,
  __setSimSwapKanalForTests,
  __setErisimKanalForTests,
  __setKonumKanalForTests,
  __setCihazDegisimKanalForTests,
  __setCagriYonlendirmeKanalForTests,
  type AgAyar,
} from "../src/networkTrust.js";

/** Bütün halkalar AÇIK ve hepsi temiz: fark yalnız risk katmanından gelsin. */
const HEPSI_ACIK: AgAyar = {
  nacToken: "TEST-ONLY-token",
  approverPhone: "+905550000000",
  simSwapWindowHours: 72,
  reachCheck: true,
  devSwapCheck: true,
  callFwdCheck: true,
  expectedCountry: "TR",
  nvSimulate: "dogrulandi",
  stepUp: false,
};

function temizKanallar() {
  __setSimSwapKanalForTests({ verifySimSwap: async () => false });
  __setErisimKanalForTests({ cihazErisilebilirMi: async () => true });
  __setKonumKanalForTests({ ulkeDurumu: async () => ({ yurtDisinda: false, ulkeler: [] }) });
  __setCihazDegisimKanalForTests({ cihazDegistiMi: async () => false });
  __setCagriYonlendirmeKanalForTests({ kosulsuzYonlendirmeAcikMi: async () => false });
}

/** İzde gerçekten KOŞMUŞ halkalar (kapalı/çalışmadı sayılmaz). */
function kosanlar(iz: Record<string, unknown>): string[] {
  const kosdu = (v: unknown) => v !== undefined && v !== "kapali" && v !== "calismadi";
  return (["simSwap", "nv", "reach", "loc", "devSwap", "callFwd"] as const).filter((k) =>
    kosdu(iz[k])
  );
}

test("KRİTİK: bütçe artışı (medium) YALNIZ tek güçlü sinyal koşturur", async () => {
  /**
   * Her açık halka onaya bir CAMARA gidiş-dönüşü ve meşru bir harcamayı reddetmenin bir
   * yolunu daha ekler. Bütçe artışında bunun bedeli, kazandırdığından büyüktür: SIM
   * değişimi zaten "onay istemini cevaplayan kişi saldırgan olabilir mi" sorusudur.
   */
  temizKanallar();
  const k = await agDogrula(HEPSI_ACIK, "medium");

  assert.equal(k.engel, undefined);
  assert.deepEqual(kosanlar(k.iz as any), ["simSwap"], "medium katmanında yalnız SIM Swap koşmalı");
});

test("KRİTİK: yayına alma (high) zincirin TAMAMINI koşturur", async () => {
  /**
   * Gerçek harcamanın başladığı andır; burada bir tur fazladan CAMARA çağrısı ucuzdur.
   */
  temizKanallar();
  const k = await agDogrula(HEPSI_ACIK, "high");

  assert.equal(k.engel, undefined);
  assert.deepEqual(
    kosanlar(k.iz as any).sort(),
    ["callFwd", "devSwap", "loc", "nv", "reach", "simSwap"],
    "high katmanında bütün açık halkalar koşmalı"
  );
});

test("KRİTİK: tablo ile DAVRANIŞ aynı şeyi söyler", async () => {
  /**
   * Bu testin varlık sebebi: tablo tek başına bir niyet beyanıdır. Bir katmanın kendi
   * koşulunu tabloya bakmadan değiştirmesi (ya da tabloya bir halka eklenip katmanın
   * bağlanmaması) sessizce ayrışma üretir — kapı bir şey yapar, belge başka bir şey söyler.
   */
  temizKanallar();
  for (const risk of ["medium", "high"] as const) {
    const k = await agDogrula(HEPSI_ACIK, risk);
    const beklenen = [...RISK_HALKA_ESLEMESI[risk]].sort();
    assert.deepEqual(
      kosanlar(k.iz as any).sort(),
      beklenen,
      `'${risk}' katmanında tablo ${beklenen.join(",")} diyor ama koşanlar farklı`
    );
  }
});

test("halkaKosarMi tablonun tek okuma yoludur", () => {
  assert.equal(halkaKosarMi("medium", "simSwap"), true);
  assert.equal(halkaKosarMi("medium", "callFwd"), false);
  assert.equal(halkaKosarMi("high", "callFwd"), true);
  assert.equal(halkaKosarMi("high", "bilinmeyen-halka"), false, "tabloda olmayan halka koşmaz");
});

test("eşleme dondurulmuştur — çalışma anında politika değiştirilemez", () => {
  /**
   * Tablo canlıyken değiştirilebilseydi, bir istek sırasında politikayı gevşetmek
   * mümkün olurdu ve denetim izi hangi politikanın geçerli olduğunu söyleyemezdi.
   */
  assert.throws(() => {
    (RISK_HALKA_ESLEMESI as any).medium = ["hicbiri"];
  }, "tablo yeniden atanamamalı");
  assert.throws(() => {
    (RISK_HALKA_ESLEMESI.medium as any).push("callFwd");
  }, "tablo içeriği değiştirilememeli");
});
