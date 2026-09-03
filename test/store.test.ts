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

/* ── ANAHTAR TÜRETMESİ: algoritma + tuz + uzunluk ÇİVİLENMİŞTİR ───────────────── */

/**
 * NEDEN BU TESTLER VAR: türetmeyi scrypt yerine tuzsuz SHA-256 yapan tek satırlık bir
 * mutasyon tüm paketi YEŞİL bırakıyordu. Gidiş-dönüş testleri yalnız "şifrelediğimizi
 * çözebiliyoruz" der; hangi anahtarla, hangi maliyetle şifrelediğimizi ölçmez. Oysa
 * fark ölçülmüştür: parola başına ~46 ms yerine ~0,002 ms ve tuz yok — DB dosyası
 * sızdığında parola çevrimdışı denenip TÜM kiracıların refresh token'ları çözülür.
 * Aşağıdaki iki bekçi türetmeyi iki ayrı yönden çiviler: bağımsız hesap (bilinen cevap)
 * ve depoya gömülü sabit şifreli metin.
 */
const TEST_PAROLASI = "birim-test-anahtari-32-bayttan-uzun-olmali";

test("anahtar türetmesi bilinen cevaba EŞİT: scrypt + sabit tuz + 32 bayt", async () => {
  const { scryptSync } = await import("node:crypto");
  const { deriveMasterKey } = await import("../src/store.js");

  // Testin KENDİ hesabı — üretim koduyla aynı sabitleri tekrarlar, ondan okumaz.
  const beklenen = scryptSync(TEST_PAROLASI, "adspilot-token-encryption-v1", 32);
  const uretilen = deriveMasterKey(TEST_PAROLASI);

  assert.equal(uretilen.length, 32, "AES-256 için 32 bayt");
  assert.equal(uretilen.toString("hex"), beklenen.toString("hex"), "algoritma ya da tuz değişmiş");
  // Ucuz özete düşüşün doğrudan reddi: SHA-256 aynı girdi için başka bir çıktı verir.
  const { createHash } = await import("node:crypto");
  assert.notEqual(
    uretilen.toString("hex"),
    createHash("sha256").update(TEST_PAROLASI).digest("hex"),
    "türetme düz SHA-256'ya düşmüş"
  );
});

test("DEPOYA GÖMÜLÜ ŞİFRELİ METİN hâlâ çözülüyor (KDF sessizce değiştirilemez)", () => {
  /**
   * Bu paket, yukarıdaki parolayla ÜRETİM sırasında bir kez şifrelendi ve buraya
   * çivilendi. Anahtar türetmesi, tuz, uzunluk ya da şifre düzeni değişirse üretimdeki
   * her `refresh_token_enc` okunamaz hâle gelir — bu satır o günü CI'da yaşatır.
   */
  const SABIT_PAKET = "Nk6to6Wemdfxz7D+.ZYvWhvWKtkILlvnE2wZgqQ==.IUUfdkQtETHJEGCzRUdzKQvYvtW2VonRpgkxZA0=";
  assert.equal(decryptSecret(SABIT_PAKET), "TEST-ONLY-sabit-fikstur-sirri");
});

test("64-hex anahtar DOĞRUDAN kullanılır (scrypt'e düşmez)", async () => {
  const { deriveMasterKey } = await import("../src/store.js");
  const hex = "a".repeat(64);
  assert.equal(deriveMasterKey(hex).toString("hex"), hex);
});

test("KIRPMA: sondaki yeni satır anahtarı DEĞİŞTİRMEZ", async () => {
  const { deriveMasterKey } = await import("../src/store.js");
  /**
   * Secret dosyasından gelen tek bir "\n" eskiden 64-hex düzenini bozup aynı anahtarı
   * parola (scrypt) dalına düşürüyordu: süreç sorunsuz açılıyor, ama depodaki hiçbir
   * satır açılamıyor ve sıcak yedek de bozuluyordu.
   */
  const hex = "b".repeat(64);
  assert.equal(deriveMasterKey(`${hex}\n`).toString("hex"), hex);
  assert.equal(deriveMasterKey(`  ${hex}  `).toString("hex"), hex);
  assert.equal(
    deriveMasterKey(` ${TEST_PAROLASI} `).toString("hex"),
    deriveMasterKey(TEST_PAROLASI).toString("hex"),
    "parola dalı da kırpılmış değeri kullanmalı"
  );
});

test("ASGARİ GÜÇ EŞİĞİ: 32 karakterin altı REDDEDİLİR", async () => {
  const { deriveMasterKey } = await import("../src/store.js");
  assert.throws(() => deriveMasterKey(""), /32 karakterden kısa/);
  assert.throws(() => deriveMasterKey("k".repeat(31)), /32 karakterden kısa/);
  // Kırpma eşiği ATLATMAK için kullanılamaz: 30 karakter + iki boşluk hâlâ kısadır.
  assert.throws(() => deriveMasterKey(`  ${"k".repeat(30)}  `), /32 karakterden kısa/);
  // Tam eşik geçerli olmalı; eşik bir duvar değil, taban.
  assert.equal(deriveMasterKey("k".repeat(32)).length, 32);
});

test("HEX AMA 64 DEĞİL: sessizce parolaya düşmek yerine REDDEDİLİR", async () => {
  const { deriveMasterKey } = await import("../src/store.js");
  // Eksik/fazla kopyalanmış makine anahtarı: parola olarak türetilse hiçbir sır açılmazdı.
  assert.throws(() => deriveMasterKey("a".repeat(63)), /uzunluğu 64 değil/);
  assert.throws(() => deriveMasterKey("a".repeat(65)), /uzunluğu 64 değil/);
  // Hex olmayan bir parola bu retten etkilenmez.
  assert.equal(deriveMasterKey(TEST_PAROLASI).length, 32);
});

test("masterKeyText: env'i KIRPARAK verir, kısa/eksik değerde fırlatır", async () => {
  const { masterKeyText } = await import("../src/store.js");
  const eski = process.env.ADSPILOT_MASTER_KEY;
  try {
    process.env.ADSPILOT_MASTER_KEY = `  ${TEST_PAROLASI}\n`;
    assert.equal(masterKeyText(), TEST_PAROLASI, "HMAC ve KDF aynı dizeyi görmeli");
    process.env.ADSPILOT_MASTER_KEY = "kisa";
    assert.throws(() => masterKeyText(), /32 karakterden kısa/);
    delete process.env.ADSPILOT_MASTER_KEY;
    assert.throws(() => masterKeyText(), /eksik/);
  } finally {
    process.env.ADSPILOT_MASTER_KEY = eski;
  }
});

/* ── BOŞ SIR: kaynakta reddedilir, biçim denetimi yapısaldır ──────────────────── */

test("encryptSecret boş girdiyi KAYNAKTA reddeder (okunamayan satır üretmez)", () => {
  /**
   * Eskiden boş düz metin "iv.tag." üretiyordu: kendi decryptSecret'imizin çözemediği
   * bir paket. İleride bir içe aktarma/geçiş adımı boş refreshToken yazsaydı,
   * kullanıcının HER isteği "veri bozuk" ile patlar ve operatör disk bozulması arardı.
   */
  assert.throws(() => encryptSecret(""), /Boş sır/);
});

test("çözme biçim denetimi YAPISAL: parça sayısı, IV 12 ve etiket 16 bayt", () => {
  const [iv, tag, veri] = encryptSecret("gizli").split(".");
  // Parça sayısı
  assert.throws(() => decryptSecret(`${iv}.${tag}`), /format/);
  assert.throws(() => decryptSecret(`${iv}.${tag}.${veri}.fazla`), /format/);
  // Kısa IV / kısa etiket eskiden bu denetimden geçip anlaşılmaz bir kripto hatasına
  // dönüşüyordu ("Unsupported state..."); artık bozuk paket olarak adlandırılır.
  assert.throws(() => decryptSecret(`${Buffer.from("kisa-iv").toString("base64")}.${tag}.${veri}`), /format/);
  assert.throws(() => decryptSecret(`${iv}.${Buffer.from("kisa").toString("base64")}.${veri}`), /format/);
  // Boş gövde AYRI cümleyle bildirilir: aranacak yer disk değil, sırrı boş yazan adım.
  assert.throws(() => decryptSecret(`${iv}.${tag}.`), /boş/);
});

/* ── VERİTABANI YOLU: toptan kimlik-bilgisi kaybına karşı bekçi ───────────────── */

/**
 * NEDEN BU TESTLER VAR: `process.env.ADSPILOT_DB || "adspilot.db"` içindeki `||` işaretini
 * `??` yapan TEK KARAKTERLİK bir değişiklik tüm paketi yeşil bırakıyordu. Oysa
 * ADSPILOT_DB tanımlı ama BOŞSA `??` boş dizeyi geçirir ve `DatabaseSync("")` sessizce
 * GEÇİCİ bir veritabanı açar: tüm kiracı token'ları her yeniden başlatmada tek bir hata
 * satırı bile üretmeden silinir. Varsayılan argüman yolunu koşan hiçbir test yoktu.
 */
test("VARSAYILAN YOL: ADSPILOT_DB kullanılır ve depo diskte KALICIDIR", async () => {
  const { existsSync, mkdtempSync } = await import("node:fs");
  const klasor = mkdtempSync(join(tmpdir(), "adspilot-varsayilan-"));
  const yol = join(klasor, "kalici.db");
  const eski = process.env.ADSPILOT_DB;
  process.env.ADSPILOT_DB = yol;
  try {
    // Argümansız çağrı: varsayılan argüman ifadesinin GERÇEKTEN koştuğu tek yol.
    const ilk = new UserStore();
    const { apiKey } = ilk.upsertUser({ email: "kalici@ornek.com", refreshToken: "kalici-token" });
    ilk.close();

    assert.equal(existsSync(yol), true, "dosya diske yazılmalı — geçici veritabanı değil");

    // İKİNCİ ÖRNEK: "yeniden başlatma" provası. Geçici bir DB açılmış olsaydı burası boş çıkardı.
    const ikinci = new UserStore();
    assert.equal(ikinci.findByApiKey(apiKey)?.refreshToken, "kalici-token", "token yeniden başlatmayı geçmeli");
    ikinci.close();
  } finally {
    if (eski === undefined) delete process.env.ADSPILOT_DB;
    else process.env.ADSPILOT_DB = eski;
    try {
      rmSync(klasor, { recursive: true, force: true });
    } catch {
      /* Windows'ta dosya hâlâ kilitli olabilir */
    }
  }
});

test("BOŞ ADSPILOT_DB geçici veritabanına DÜŞMEZ (varsayılan dosya adına düşer)", async () => {
  const { existsSync, mkdtempSync } = await import("node:fs");
  const klasor = mkdtempSync(join(tmpdir(), "adspilot-bosdb-"));
  const eskiCwd = process.cwd();
  const eski = process.env.ADSPILOT_DB;
  process.env.ADSPILOT_DB = "";
  process.chdir(klasor); // varsayılan "adspilot.db" göreli yolu bu klasöre düşsün
  try {
    const ilk = new UserStore();
    const { apiKey } = ilk.upsertUser({ email: "bosdb@ornek.com", refreshToken: "bosdb-token" });
    ilk.close();
    assert.equal(existsSync(join(klasor, "adspilot.db")), true, "boş env varsayılan DOSYAYA düşmeli");

    const ikinci = new UserStore();
    assert.equal(ikinci.findByApiKey(apiKey)?.refreshToken, "bosdb-token");
    ikinci.close();
  } finally {
    process.chdir(eskiCwd);
    if (eski === undefined) delete process.env.ADSPILOT_DB;
    else process.env.ADSPILOT_DB = eski;
    try {
      rmSync(klasor, { recursive: true, force: true });
    } catch {
      /* Windows'ta dosya hâlâ kilitli olabilir */
    }
  }
});

test("AÇIKÇA verilen boş/boşluk yol REDDEDİLİR (sessiz geçici veritabanı yok)", () => {
  assert.throws(() => new UserStore(""), /Veritabanı yolu boş/);
  assert.throws(() => new UserStore("   "), /Veritabanı yolu boş/);
});
