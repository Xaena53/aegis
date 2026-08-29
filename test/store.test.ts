import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ADSPILOT_MASTER_KEY = "birim-test-anahtari-32-bayttan-uzun-olmali";
const DB = join(tmpdir(), `adspilot-test-${process.pid}.db`);

const { UserStore, encryptSecret, decryptSecret, generateApiKey, hashApiKey } = await import("../src/store.js");

let store: InstanceType<typeof UserStore>;
before(() => {
  store = new UserStore(DB);
});
after(() => {
  store.close();
  try {
    rmSync(DB, { force: true });
  } catch {
    /* the file may still be locked on Windows */
  }
});

test("şifreleme gidiş-dönüş, her seferinde farklı şifre metni", () => {
  // Test data is never derived from a real credential, prefix included: no fragment of a
  // real secret belongs in the repository, not even inside a fake value.
  const secret = "TEST-ONLY-refresh-token-sabiti-0000";
  const a = encryptSecret(secret);
  const b = encryptSecret(secret);
  assert.notEqual(a, b, "aynı girdi farklı IV ile farklı çıktı vermeli");
  assert.equal(decryptSecret(a), secret);
  assert.equal(decryptSecret(b), secret);
});

test("kurcalanmış şifreli veri reddedilir (GCM auth tag)", () => {
  const packed = encryptSecret("gizli");
  const [iv, tag] = packed.split(".");
  const bozuk = [iv, tag, Buffer.from("baskaveri").toString("base64")].join(".");
  assert.throws(() => decryptSecret(bozuk));
  assert.throws(() => decryptSecret("bozuk-format"));
});

test("API anahtarı: ap_ önekli, yalnız hash saklanır", () => {
  const { plain, hash } = generateApiKey();
  assert.match(plain, /^ap_[\w-]{40,}$/);
  assert.equal(hash, hashApiKey(plain));
  assert.notEqual(plain, hash);
  assert.notEqual(hashApiKey(plain), hashApiKey("ap_baska"));
  // Two generations must never collide (32 bytes of entropy)
  assert.notEqual(generateApiKey().plain, generateApiKey().plain);
});

test("kullanıcı kaydı ve API anahtarıyla çözümleme", () => {
  const { apiKey, userId } = store.upsertUser({
    email: "a@ornek.com",
    refreshToken: "token-A",
    loginCustomerId: "1234567890",
    maxDailyBudget: 250,
  });
  const user = store.findByApiKey(apiKey);
  assert.equal(user?.id, userId);
  assert.equal(user?.email, "a@ornek.com");
  assert.equal(user?.refreshToken, "token-A", "token şifreli saklanıp doğru çözülmeli");
  assert.equal(user?.loginCustomerId, "1234567890");
  assert.equal(user?.maxDailyBudget, 250);
  assert.equal(user?.writeEnabled, true);
});

test("bilinmeyen API anahtarı undefined döner", () => {
  assert.equal(store.findByApiKey("ap_hicvarolmayan"), undefined);
});

test("kullanıcılar izole: her birinin kendi token ve tavanı", () => {
  const u1 = store.upsertUser({ email: "b@ornek.com", refreshToken: "token-B", maxDailyBudget: 100 });
  const u2 = store.upsertUser({ email: "c@ornek.com", refreshToken: "token-C", maxDailyBudget: 900 });
  assert.notEqual(u1.apiKey, u2.apiKey);
  assert.equal(store.findByApiKey(u1.apiKey)?.refreshToken, "token-B");
  assert.equal(store.findByApiKey(u2.apiKey)?.refreshToken, "token-C");
  assert.equal(store.findByApiKey(u1.apiKey)?.maxDailyBudget, 100);
  assert.equal(store.findByApiKey(u2.apiKey)?.maxDailyBudget, 900);
});

test("updateSettings: ayarlar anında yazılır, geçersiz tavan reddedilir", () => {
  const { apiKey, userId } = store.upsertUser({ email: "e@ornek.com", refreshToken: "token-E", maxDailyBudget: 400 });
  store.updateSettings(userId, { maxDailyBudget: 25, writeEnabled: false });
  const u = store.findByApiKey(apiKey)!;
  assert.equal(u.maxDailyBudget, 25);
  assert.equal(u.writeEnabled, false);
  // findById has to agree — this is the session-refresh path
  assert.equal(store.findById(userId)?.maxDailyBudget, 25);
  assert.equal(store.findById(userId)?.refreshToken, "token-E");
  assert.throws(() => store.updateSettings(userId, { maxDailyBudget: 0 }));
  assert.throws(() => store.updateSettings(userId, { maxDailyBudget: NaN }));
});

test("findById bilinmeyen id için undefined", () => {
  assert.equal(store.findById(999999), undefined);
});

test("yeniden bağlanma: aynı e-posta token'ı yeniler, ESKİ anahtar geçersizleşir", () => {
  const first = store.upsertUser({ email: "d@ornek.com", refreshToken: "eski-token" });
  const second = store.upsertUser({ email: "d@ornek.com", refreshToken: "yeni-token" });
  assert.notEqual(first.apiKey, second.apiKey);
  assert.equal(second.userId, first.userId, "aynı kullanıcı kaydı güncellenmeli");
  assert.equal(store.findByApiKey(first.apiKey), undefined, "eski anahtar artık çalışmamalı");
  assert.equal(store.findByApiKey(second.apiKey)?.refreshToken, "yeni-token");
});

/**
 * KİRACI DEVRALMA — bu üç test bir denetimde bulunan boşluğun bekçisidir.
 *
 * Kiracı anahtarı Google'ın `sub` iddiasıdır; bu dosyanın şema yorumu e-postanın
 * kiracı anahtarı OLAMAYACAĞINI ("it can change, Workspace can reassign it") zaten
 * söylüyordu. Buna rağmen upsertUser, `subject` verilmiş ama eşleşmemiş olsa bile
 * e-postayla arıyor ve bulduğu satırı devralıyordu. Devralınan satır kurbanın Google
 * Ads refresh token'ını taşıdığı için bedeli, başkasının reklam hesabında harcama
 * yetkisidir.
 */
test("KRİTİK: farklı bir Google sub'ı, aynı e-postayla mevcut kiracıyı DEVRALAMAZ", () => {
  const kurban = store.upsertUser({
    subject: "sub-kurban",
    email: "ortak@ornek.com",
    refreshToken: "kurban-token",
    maxDailyBudget: 50,
  });

  assert.throws(
    () =>
      store.upsertUser({
        subject: "sub-saldirgan",
        email: "ortak@ornek.com",
        refreshToken: "saldirgan-token",
      }),
    /başka bir Google hesabına bağlı/,
    "aynı e-postayla gelen yeni bir sub, sahipli satırı devralamaz"
  );

  // Ret bir mesajdan ibaret olamaz: kurbanın satırı el değmemiş kalmalı.
  const u = store.findByApiKey(kurban.apiKey);
  assert.ok(u, "KRİTİK: kurbanın API anahtarı hâlâ geçerli olmalı");
  assert.equal(u!.refreshToken, "kurban-token", "KRİTİK: kurbanın token'ı değişmemeli");
  assert.equal(u!.maxDailyBudget, 50, "kurbanın tavanı değişmemeli");
});

test("SAHİPSİZ satır sahiplenilebilir: stdio ile açılan hesap Google girişine bağlanır", () => {
  /**
   * E-posta yolu tamamen kapatılamaz. `subject` OLMADAN (stdio/test akışı) açılmış
   * satırların sonradan Google girişine bağlanması meşru bir yükseltmedir; ayrım
   * satırın daha önce bağlanmış olup olmadığıdır.
   */
  const once = store.upsertUser({ email: "yukselt@ornek.com", refreshToken: "ilk-token" });
  const sonra = store.upsertUser({
    subject: "sub-yukselt",
    email: "yukselt@ornek.com",
    refreshToken: "baglanmis-token",
  });
  assert.equal(sonra.userId, once.userId, "yeni satır açılmamalı: aynı kiracı bağlandı");
  assert.equal(store.findByApiKey(sonra.apiKey)?.refreshToken, "baglanmis-token");
});

test("AYNI sub ile tekrar giriş, kendi satırını normal yeniler (kapı bir duvar değil)", () => {
  const ilk = store.upsertUser({
    subject: "sub-sabit",
    email: "sabit@ornek.com",
    refreshToken: "eski-token",
  });
  // E-posta değişse bile sub aynı olduğu için aynı kiracıdır.
  const ikinci = store.upsertUser({
    subject: "sub-sabit",
    email: "sabit-yeni@ornek.com",
    refreshToken: "yeni-token",
  });
  assert.equal(ikinci.userId, ilk.userId);
  assert.equal(store.findByApiKey(ikinci.apiKey)?.refreshToken, "yeni-token");
  assert.equal(store.findByApiKey(ilk.apiKey), undefined, "eski API anahtarı geçersizleşmeli");
});
