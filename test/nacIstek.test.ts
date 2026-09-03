// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CAMARA HALKALARININ İSTEK TARAFI — tele NE GİDİYOR?
 *
 * Depodaki bütün zincir testleri sahte KANAL enjekte ediyordu (`__setSimSwapKanalForTests`
 * ve kardeşleri), yani gerçek uyarlayıcı kapanışları hiç koşmuyordu. bozukYanit.test.ts
 * sahte SDK istemcisiyle YANIT tarafını kapattı; İSTEK tarafı hâlâ ölçülmemişti: sahte
 * istemcinin `don()` yardımcısı argümanları yutuyor.
 *
 * Ölçülmeyen üç şey vardı ve üçü de sessizce bozulabilirdi:
 *
 *   1) HANGİ NUMARA sorgulanıyor — yanlış numara, yanlış kişinin SIM'ini doğrular.
 *      Kapı çalışıyormuş gibi görünür ve hiçbir test bunu göremez.
 *   2) HANGİ PENCERE gidiyor — `simSwapWindowHours` ayarı tele ulaşmazsa, operatörün
 *      72 saat sandığı kontrol SDK varsayılanıyla koşar; ayar sayfası süs olur.
 *   3) ZAMAN AŞIMI SINIRLARI — `{timeoutInSeconds: 10, maxRetries: 1}` düşerse SDK
 *      varsayılanına (60 sn × 3 deneme) döner: erişilemeyen bir uçta onay akışı ~3
 *      DAKİKA asılı kalır. Kapalı arıza HIZLI olmak zorundadır; yavaş kapalı arıza,
 *      kullanıcı açısından donmuş bir üründür.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  agDogrula,
  __setNacIstemciFabrikasiForTests,
  type AgAyar,
} from "../src/networkTrust.js";

const TELEFON = "+905551112277";

/** Tele giden her çağrının argümanları. */
interface Cagri {
  halka: string;
  arg: any;
  secenek: any;
}

let cagrilar: Cagri[] = [];

afterEach(() => {
  __setNacIstemciFabrikasiForTests(undefined);
  cagrilar = [];
});

/** Argümanları KAYDEDEN sahte SDK istemcisi — hepsi temiz yanıt döner. */
function kaydedenIstemci(): any {
  const kaydet = (halka: string, sonuc: unknown) => async (arg: any, secenek: any) => {
    cagrilar.push({ halka, arg, secenek });
    return sonuc;
  };
  return {
    simSwap: { check: kaydet("simSwap", { swapped: false }) },
    deviceStatus: {
      retrieveReachabilityStatus: kaydet("reach", { reachable: true }),
      checkRoaming: kaydet("loc", { roaming: false, countryName: [] }),
    },
    deviceSwap: { check: kaydet("devSwap", { swapped: false }) },
    callForwardingSignal: {
      retrieveUnconditionalCallForwarding: kaydet("callFwd", { active: false }),
    },
  };
}

const TUM_HALKALAR: AgAyar = {
  nacToken: "gercek-token",
  approverPhone: TELEFON,
  simSwapWindowHours: 137, // varsayılan OLMAYAN bir değer: taşındığı görülebilsin
  reachCheck: true,
  devSwapCheck: true,
  callFwdCheck: true,
  expectedCountry: "TR",
};

async function halkalariKostur(ayar: AgAyar = TUM_HALKALAR): Promise<void> {
  __setNacIstemciFabrikasiForTests(async () => kaydedenIstemci());
  await agDogrula(ayar, "high");
}

const halka = (ad: string): Cagri | undefined => cagrilar.find((c) => c.halka === ad);

test("KRİTİK: her halka ONAYLAYICININ numarasını sorguluyor", async () => {
  /**
   * Yanlış numara, yanlış kişinin SIM'ini doğrular: kapı yeşil yanar, koruduğu şeyi
   * hiç ölçmemiştir. Her halka ayrı ayrı iddia ediliyor — biri kayarsa hangisi olduğu
   * doğrudan görünsün.
   */
  await halkalariKostur();

  assert.equal(halka("simSwap")?.arg?.phoneNumber, TELEFON, "SIM değişimi onaylayıcıyı sormalı");
  assert.equal(halka("reach")?.arg?.device?.phoneNumber, TELEFON, "erişilebilirlik onaylayıcıyı sormalı");
  assert.equal(halka("loc")?.arg?.device?.phoneNumber, TELEFON, "konum onaylayıcıyı sormalı");
  assert.equal(halka("devSwap")?.arg?.phoneNumber, TELEFON, "cihaz değişimi onaylayıcıyı sormalı");
  assert.equal(
    halka("callFwd")?.arg?.phoneNumber ?? halka("callFwd")?.arg?.device?.phoneNumber,
    TELEFON,
    "çağrı yönlendirme onaylayıcıyı sormalı"
  );
});

test("KRİTİK: yapılandırılan PENCERE tele gidiyor (ayar süs değil)", async () => {
  /**
   * `simSwapWindowHours` tele ulaşmazsa, operatörün 72 saat sandığı kontrol SDK
   * varsayılanıyla koşar. 137 bilerek seçildi: hiçbir varsayılana benzemiyor.
   */
  await halkalariKostur();

  assert.equal(halka("simSwap")?.arg?.maxAge, 137, "SIM penceresi tele taşınmalı");
  assert.equal(halka("devSwap")?.arg?.maxAge, 137, "cihaz değişimi penceresi tele taşınmalı");
});

test("KRİTİK: pencere değişince tele giden değer de değişir", async () => {
  /**
   * Üstteki iddia sabit bir sayıyı kodda görebilirdi; bu iddia bağlantının GERÇEKTEN
   * ayardan geldiğini gösterir.
   */
  await halkalariKostur({ ...TUM_HALKALAR, simSwapWindowHours: 24 });
  assert.equal(halka("simSwap")?.arg?.maxAge, 24, "değişen ayar tele yansımalı");
});

test("KRİTİK: her çağrı SIKI zaman aşımı sınırlarıyla gidiyor (yavaş kapalı arıza donmuş üründür)", async () => {
  /**
   * Sınırlar düşerse SDK varsayılanı devreye girer: 60 sn × 3 deneme = erişilemeyen bir
   * uçta ~3 dakika asılı onay akışı. Kullanıcı açısından bu, reddeden bir kapı değil,
   * donmuş bir üründür.
   */
  await halkalariKostur();

  assert.ok(cagrilar.length >= 5, `beş halka da koşmalı (koşan: ${cagrilar.map((c) => c.halka).join(",")})`);
  for (const c of cagrilar) {
    assert.equal(c.secenek?.timeoutInSeconds, 10, `${c.halka}: zaman aşımı 10 sn olmalı`);
    assert.equal(c.secenek?.maxRetries, 1, `${c.halka}: en fazla 1 yeniden deneme olmalı`);
  }
});

test("onaylayıcı numarası DEĞİŞİRSE yeni numara sorulur (önbellek eski numarayı taşımaz)", async () => {
  /**
   * Gerçek kanallar token+numara anahtarıyla önbelleklenir. Anahtar numarayı taşımasaydı,
   * onaylayıcıyı değiştiren operatör ESKİ numaranın SIM'ini doğrulamaya devam ederdi —
   * sessizce ve süresiz.
   */
  const ikinci = "+905559998877";
  await halkalariKostur();
  assert.equal(halka("simSwap")?.arg?.phoneNumber, TELEFON);

  cagrilar = [];
  await agDogrula({ ...TUM_HALKALAR, approverPhone: ikinci }, "high");
  assert.equal(halka("simSwap")?.arg?.phoneNumber, ikinci, "numara değişince yeni numara sorulmalı");
});
