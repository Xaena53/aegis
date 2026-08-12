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
    /* Windows'ta kilit kalabilir */
  }
});

test("şifreleme gidiş-dönüş, her seferinde farklı şifre metni", () => {
  // Test verisi GERÇEK bir kimlik bilgisinden TÜRETİLMEZ (önek dahil) —
  // sahte olsa bile gerçek sırrın parçası repoya girmemeli.
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
  // İki üretim asla çakışmamalı (32 bayt entropi)
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
  // findById aynı sonucu vermeli (oturum tazeleme yolu)
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
