// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ÖLÇEK UYUŞMAZLIĞI: kıyaslanan büyüklük ile YAZILAN büyüklük aynı nesne mi?
 *
 * update_meta_campaign_budget "artış mı azaltma mı" kararını `kampanyaOku`nun döndürdüğü
 * `gunlukButce` rakamına bakarak verir. Meta'da o rakam iki AYRI yerden gelebilir ve
 * `butceKaynagi` hangisi olduğunu söyler:
 *   - "kampanya"       → CBO: kampanyanın kendi günlük bütçesi (tek sayı),
 *   - "reklam-setleri" → ABO: kampanya düzeyinde bütçe YOKTUR; rakam AKTİF reklam
 *                        setlerinin TOPLAMIDIR (src/meta/client.ts, reklamSetiButcesi).
 *
 * Yazma ise her koşulda KAMPANYA düğümüne gider (butceGuncelle → graf(kampanyaId,
 * {daily_budget})). ABO'da "600 → 400" bu yüzden bir azaltma değildir: kampanya düzeyinde
 * daha önce hiç var olmayan 400'lük bir bütçe yazılırken reklam setlerinin 3×200'ü olduğu
 * yerde durur. Kıyas iki farklı nesne arasında yapılmış olur.
 *
 * Bu dosyanın kilitlediği DAVRANIŞ: kampanya düzeyinde kıyaslanacak bir sayı yokken
 * "azaltma" kısayolu KULLANILMAZ — istek insan onayından ve CAMARA ağ kapısından geçer,
 * karar günlüğüne satır düşer, başarı metni de olmayan bir düşüşü ilan etmez. Kısayolun
 * MEŞRU hâli (CBO) ise açıkça korunur: karşı kontrol testi, düzeltmenin her azaltmayı
 * pahalı hâle getirmediğini ölçer.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/server.js";
import { __setMetaKanalForTests, type MetaKampanya } from "../src/meta/client.js";
import { __setSimSwapKanalForTests } from "../src/networkTrust.js";

const HESAP = "act_555000111";
const KIMLIK = "120200000000001";

/** Çağrılan Meta işlemleri — "yazma HİÇ yapılmadı" ölçülebilsin diye. */
let cagrilar: string[] = [];
/** Gösterilen onay istemi sayısı — "insana hiç sorulmadı" ölçülebilsin diye. */
let istemSayisi = 0;
/** Günlüğün yazıldığı geçici dizin; afterEach siler. */
let gunlukKok: string | undefined;

afterEach(() => {
  __setMetaKanalForTests(undefined);
  __setSimSwapKanalForTests(undefined);
  cagrilar = [];
  istemSayisi = 0;
  delete process.env.AEGIS_DECISION_LOG;
  if (gunlukKok) {
    rmSync(gunlukKok, { recursive: true, force: true });
    gunlukKok = undefined;
  }
});

/** Günlüğü AÇAR: geçici dizin + env. Dönüş, okunacak JSONL dosyasının yoludur. */
function gunlukAc(): string {
  gunlukKok = mkdtempSync(path.join(tmpdir(), "aegis-meta-kiyas-"));
  const dosya = path.join(gunlukKok, "kararlar.jsonl");
  process.env.AEGIS_DECISION_LOG = dosya;
  return dosya;
}

function satirlar(dosya: string): any[] {
  return readFileSync(dosya, "utf8")
    .split("\n")
    .filter((x) => x.trim() !== "")
    .map((x) => JSON.parse(x));
}

interface Secenek {
  /** Okunan rakam NEREDEN geliyor — testin bütün konusu bu alandır. */
  butceKaynagi?: "kampanya" | "reklam-setleri";
  /** kampanyaOku'nun döndüreceği günlük bütçe. */
  mevcutButce?: number;
  /** Ağ kapısı: SIM değişmiş sayılsın mı? */
  simDegisti?: boolean;
  /** İnsan onay istemine verilecek cevap. */
  onay?: boolean;
}

async function kur(opts: Secenek): Promise<Client> {
  const kampanya: MetaKampanya = {
    id: KIMLIK,
    ad: "ABO Kampanyası",
    // Düğüm kefaleti ayrı bir kapıdır ve burada konu değildir: kanal, okuduğu düğümün
    // GERÇEKTEN kampanya olduğuna kefil oluyor. Ölçülen tek şey ÖLÇEK uyuşmazlığı.
    dugumTuru: "kampanya",
    durum: "PAUSED",
    gunlukButce: opts.mevcutButce,
    butceKaynagi: opts.butceKaynagi,
  };

  __setMetaKanalForTests({
    async kampanyaOlustur({ ad, gunlukButce }) {
      cagrilar.push("kampanyaOlustur");
      return { id: "120200000000002", ad, durum: "PAUSED", gunlukButce };
    },
    async kampanyaOku() {
      cagrilar.push("kampanyaOku");
      return kampanya;
    },
    async butceGuncelle(_id, yeni) {
      cagrilar.push(`butceGuncelle:${yeni}`);
      kampanya.gunlukButce = yeni;
    },
    async durumDegistir(_id, durum) {
      cagrilar.push(`durumDegistir:${durum}`);
      kampanya.durum = durum;
    },
  });

  __setSimSwapKanalForTests({ verifySimSwap: async () => opts.simDegisti === true });

  const config: any = {
    developerToken: "x",
    clientId: "x",
    clientSecret: "x",
    refreshToken: "x",
    writeEnabled: true,
    maxDailyBudget: 5000,
    metaToken: "meta-gizli-jeton-1234567890",
    metaAdAccountId: HESAP,
    simSwapWindowHours: 72,
    reachCheck: false,
    stepUp: false,
    devSwapCheck: false,
    callFwdCheck: false,
    nacToken: "nac-token",
    approverPhone: "+905551112233",
  };

  const server = buildServer(() => ({ config }) as any);
  const istemci = new Client(
    { name: "meta-kiyas-test", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } }
  );
  istemci.setRequestHandler(ElicitRequestSchema, async () => {
    istemSayisi++;
    return opts.onay === false
      ? { action: "decline" as const }
      : { action: "accept" as const, content: { onay: true } };
  });

  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), istemci.connect(b)]);
  return istemci;
}

const metin = (r: any) => String(r.content?.[0]?.text ?? "");

/** Reklam seti bütçeli (ABO) kampanyada bütçe isteği; okunan rakam üç ACTIVE setin toplamı. */
async function aboButceIstegi(opts: Secenek): Promise<any> {
  const c = await kur({ butceKaynagi: "reklam-setleri", mevcutButce: 600, ...opts });
  return c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 400 },
  });
}

test("KRİTİK: reklam seti toplamının ALTINDAKİ istek 'azaltma' sayılmaz — ağ kapısı KOŞAR", async () => {
  /**
   * Ölçülen arıza: 3×200 = 600 toplamı karşısında 400 isteği "azaltma" sayılıyordu;
   * onay istemi hiç gösterilmiyor, agDogrula hiç çalışmıyor, kampanya düzeyine 400
   * yazılıyordu. SIM'i değişmiş bir onaylayıcıyla koşuluyor ki kapının GERÇEKTEN
   * çağrıldığı tek başına görünsün: kapı çağrılmasa bu metin hiç doğmaz.
   */
  const r = await aboButceIstegi({ simDegisti: true });

  assert.match(metin(r), /AĞ DOĞRULAMASI BAŞARISIZ/, "ağ kapısı bu yolda da konuşmalı");
  assert.equal(istemSayisi, 0, "ağ reddettiğinde insana HİÇ sorulmaz");
  assert.ok(
    !cagrilar.some((x) => x.startsWith("butceGuncelle")),
    "KRİTİK: reddedilen istek Meta'ya HİÇ yazmamalı"
  );
});

test("KRİTİK: reklam seti toplamının altındaki istek İNSAN onayı ister; ret yazmayı durdurur", async () => {
  const r = await aboButceIstegi({ onay: false });

  assert.equal(istemSayisi, 1, "kampanya düzeyinde kıyaslanacak sayı yokken insana SORULUR");
  assert.ok(
    !cagrilar.some((x) => x.startsWith("butceGuncelle")),
    "insan reddettiyse yazma yapılmaz"
  );
  assert.doesNotMatch(metin(r), /güncellendi/u, "yapılmamış bir güncelleme bildirilmemeli");
});

test("ABO isteği karar günlüğüne DÜŞER — sessiz para hareketi kalmaz", async () => {
  const gunluk = gunlukAc();
  await aboButceIstegi({ onay: true });

  const k = satirlar(gunluk);
  assert.equal(k.length, 1, "kapıdan geçen tek karar, tek satır");
  assert.equal(k[0].karar, "gecti");
  assert.equal(k[0].risk, "medium", "bütçe değişikliği orta risk");
  assert.equal(k[0].tutar, 400, "riskteki tutar YENİ kampanya düzeyi bütçesidir");
  assert.equal(k[0].hesapId, HESAP);
});

test("Başarı metni olmayan bir DÜŞÜŞÜ ilan etmez (\"600 → 400\" yalanı)", async () => {
  /**
   * Yazma kampanya düzeyine gider; reklam setlerinin 600'ü olduğu yerde durur. "600 → 400"
   * cümlesi kullanıcıya harcamanın düştüğünü söyler — ölçülmemiş, üstelik yanlış bir iddia.
   */
  const r = await aboButceIstegi({ onay: true });
  const out = metin(r);

  assert.ok(cagrilar.includes("butceGuncelle:400"), "onaydan sonra yazma gerçekten yapılmalı");
  assert.doesNotMatch(out, /600 → 400/, "iki farklı nesne bir düşüş gibi sunulamaz");
  assert.match(out, /reklam set/iu, "eski rakamın reklam setlerinden geldiği söylenmeli");
  assert.match(out, /400/, "yeni kampanya düzeyi bütçesi metinde olmalı");
});

test("KARŞI KONTROL: CBO azaltması hâlâ onaysız geçer — güvenli yön pahalı olmamalı", async () => {
  /**
   * Düzeltme "her azaltmayı onaya sok" olsaydı bu test kırmızı olurdu. Kampanya düzeyinde
   * bütçe VARSA kıyas aynı nesne üzerindedir: 600 → 400 gerçekten bir düşüştür, kapı
   * istemez. Kısayolu tümden kaldırmak insanları kapının etrafından dolaşmaya iter.
   */
  const c = await kur({ butceKaynagi: "kampanya", mevcutButce: 600 });
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 400 },
  });

  assert.equal(istemSayisi, 0, "gerçek azaltma için onay istenmez");
  assert.ok(cagrilar.includes("butceGuncelle:400"), "azaltma uygulanmalı");
  assert.match(metin(r), /600 → 400/, "aynı nesne üzerinde düşüş dürüstçe bildirilir");
});

test("KARŞI KONTROL: ABO'da ARTIŞ zaten kapıdan geçiyordu — o yol bozulmadı", async () => {
  const c = await kur({ butceKaynagi: "reklam-setleri", mevcutButce: 600, simDegisti: true });
  const r: any = await c.callTool({
    name: "update_meta_campaign_budget",
    arguments: { campaignId: KIMLIK, dailyBudget: 900 },
  });

  assert.match(metin(r), /AĞ DOĞRULAMASI BAŞARISIZ/);
  assert.ok(!cagrilar.some((x) => x.startsWith("butceGuncelle")));
});
