// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Credential and settings storage for hosted mode.
 *
 * Refresh tokens are encrypted with AES-256-GCM; API keys are stored only as hashes, so
 * the plaintext key exists exactly once — on the page shown at registration. Tenants are
 * keyed by Google's stable subject identifier rather than email, which can change or be
 * reassigned.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv, createDecipheriv, createHash, scryptSync } from "node:crypto";

export interface StoredUser {
  id: number;
  /** Google's immutable user identifier (the id_token `sub`). This is the tenant key. */
  googleSub?: string;
  email: string;
  refreshToken: string;
  loginCustomerId?: string;
  writeEnabled: boolean;
  maxDailyBudget: number;
  createdAt: string;
}

let cachedMasterKey: Buffer | undefined;

/**
 * KDF TUZU VE ASGARİ UZUNLUK ÇİVİLENMİŞTİR.
 *
 * Sabitler burada duruyor ki testler onları koddan değil, kendi hesapladıkları
 * bilinen-cevapla karşılaştırsın: tuz ya da uzunluk değişirse üretimdeki HER
 * refresh_token_enc çözülemez hâle gelir, ama bu tür bir değişiklik derlemeyi de
 * testleri de kendiliğinden kırmaz. Kıran şey, bu değerlere bağlı sabit fikstürdür.
 */
const ANAHTAR_TUZU = "adspilot-token-encryption-v1";
const ANAHTAR_ASGARI_UZUNLUK = 32;
const ANAHTAR_BAYT = 32;

/**
 * Ana anahtarın METİN hâli — KIRPILMIŞ.
 *
 * NEDEN KIRPMA ŞART: anahtar çoğu kurulumda bir secret dosyasından ya da `docker
 * secret`ten gelir ve sondaki tek bir yeni satır, 64-hex düzenini bozup aynı anahtarı
 * parola (scrypt) dalına düşürür. Sonuç sessiz felakettir: süreç açılır, hiçbir hata
 * vermez, ama depodaki hiçbir satır çözülemez ve sıcak yedek de bozulur.
 *
 * HTTP TARAFI NEDEN BURAYI ÇAĞIRIYOR: aynı metin HMAC imzalarında da kullanılıyor
 * (http.ts oturum/state çerezleri) ve orası eskiden `process.env.ADSPILOT_MASTER_KEY ?? ""`
 * diyordu. İmzalama ve doğrulama aynı ifadeyi kullandığı için bu kendi içinde TUTARLIYDI —
 * kırpma farkı oradaki imzaları hiç bozmazdı, o gerekçe yanlıştı. Gerçek kazanç daha küçük
 * ve başka yerde: `?? ""` yedeği, anahtar hiç yokken çerezleri BOŞ DİZEYLE imzalardı, yani
 * herkesin bilebileceği bir anahtarla. Buradan geçince böyle bir durum sessizce imzalamak
 * yerine fırlatır. Bu yol bugün açılışta zaten kapalı (http.ts:validateHostedEnv modül
 * yüklenirken koşuyor ve eksik anahtarda süreci öldürüyor), dolayısıyla ortak giriş noktası
 * bir bekçi değil, savunma derinliğidir — ve kaynak-düzeyi bir bekçiyle korunur
 * (test/kaynakHijyeni.test.ts: imza yollarında ham env okunmaz).
 */
export function masterKeyText(): string {
  const kirpik = process.env.ADSPILOT_MASTER_KEY?.trim() ?? "";
  if (kirpik.length < ANAHTAR_ASGARI_UZUNLUK) {
    throw new Error(
      `ADSPILOT_MASTER_KEY eksik ya da ${ANAHTAR_ASGARI_UZUNLUK} karakterden kısa — hosted mod token şifrelemesi için zorunlu. ` +
        "Üretmek için: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return kirpik;
}

/**
 * Encryption key derivation:
 * - 64 hex characters (recommended, machine-generated) → used directly as the 32-byte key
 * - anything else (a human-chosen passphrase) → derived with scrypt; plain SHA-256 is too
 *   weak for passphrase input, whereas scrypt puts a CPU and memory cost on brute force.
 * The fixed salt is deliberate: there is a single application secret, so there is no
 * cross-user rainbow-table exposure, and keeping a salt in the database would complicate
 * key rotation for no gain.
 *
 * SHA-256'ya (ya da başka ucuz bir özete) düşmek burada bir hız iyileştirmesi DEĞİL,
 * güvenlik kaybıdır: parola tipi bir anahtarda tahmin başına maliyet ~23.000 kat düşer
 * ve DB dosyası sızdığında parola çevrimdışı denenip tüm kiracıların refresh token'ları
 * çözülür. Bu yüzden algoritma+tuz+uzunluk üçlüsü testte bilinen-cevapla çivilenmiştir.
 *
 * SALT HEX AMA 64 DEĞİLSE RET: "64 hex" ile "parola" arasındaki seçim sessizce
 * yapılamaz. Kırpılmış/eklenmiş bir makine anahtarı (63 ya da 65 hex) parola dalına
 * düşerdi ve operatör doğru anahtarı verdiğini sanarak hiçbir satırı açamazdı —
 * "bilinmiyor" ile "temiz" aynı şey değildir, o yüzden açıkça reddedilir.
 */
export function deriveMasterKey(ham: string): Buffer {
  const kirpik = ham.trim();
  if (kirpik.length < ANAHTAR_ASGARI_UZUNLUK) {
    throw new Error(
      `ADSPILOT_MASTER_KEY ${ANAHTAR_ASGARI_UZUNLUK} karakterden kısa olamaz (kırpılmış uzunluk: ${kirpik.length}).`
    );
  }
  if (/^[0-9a-f]{64}$/i.test(kirpik)) return Buffer.from(kirpik, "hex");
  if (/^[0-9a-f]+$/i.test(kirpik)) {
    throw new Error(
      `ADSPILOT_MASTER_KEY yalnız onaltılık karakterlerden oluşuyor ama uzunluğu 64 değil (${kirpik.length}). ` +
        "Eksik/fazla kopyalanmış bir makine anahtarı, parola olarak türetilirse depodaki hiçbir sır açılamaz. " +
        "Ya tam 64 hex karakter ver ya da hex olmayan bir parola kullan."
    );
  }
  return scryptSync(kirpik, ANAHTAR_TUZU, ANAHTAR_BAYT);
}

function masterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  const kirpik = masterKeyText();
  cachedMasterKey = deriveMasterKey(kirpik);
  // Hangi dalın koştuğu ÜRETİMDE görünmeli: "anahtarı verdim ama hiçbir şey açılmıyor"
  // arızasının tek ucuz teşhisi budur (env'de görünmeyen bir boşluk, yanlış uzunluk).
  console.error(
    `[adspilot] ana anahtar türetmesi: ${
      /^[0-9a-f]{64}$/i.test(kirpik) ? "64-hex (doğrudan)" : `parola (scrypt, tuz: ${ANAHTAR_TUZU})`
    }`
  );
  return cachedMasterKey;
}

export function encryptSecret(plain: string): string {
  /**
   * BOŞ SIR KAYNAĞINDA REDDEDİLİR.
   *
   * Boş düz metin "iv.tag." üretiyordu: kendi decryptSecret'imizin biçim denetiminden
   * geçemeyen bir paket. Yani depoya yazılabilen ama okunamayan bir satır — ve okuyan
   * taraf "Şifreli veri bozuk" görüp disk bozulması arardı. Boş bir refresh token zaten
   * hiçbir işe yaramaz; doğru yer, üretildiği an.
   */
  if (plain === "") throw new Error("Boş sır şifrelenemez (kaynakta reddedildi).");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret(packed: string): string {
  /**
   * BİÇİM DENETİMİ YAPISALDIR, DOĞRULUK TEMELLİ DEĞİL.
   *
   * Eskiden yalnız "üç parça da boş değil mi" bakılıyordu; base64 çözümü toleranslı
   * olduğu için 3 baytlık bir IV ya da 2 baytlık bir etiket denetimden geçip
   * createDecipheriv'in anlaşılmaz "Unsupported state" hatasına dönüşüyordu. GCM'de
   * IV 12, etiket 16 bayttır — ölçüsü tutmayan paket bozuktur, tahmin edilmez.
   */
  const parcalar = packed.split(".");
  if (parcalar.length !== 3) throw new Error("Şifreli veri bozuk (format).");
  const iv = Buffer.from(parcalar[0], "base64");
  const tag = Buffer.from(parcalar[1], "base64");
  const veri = Buffer.from(parcalar[2], "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Şifreli veri bozuk (format).");
  // Boş gövde ayrı bir cümleyle bildirilir: operatör disk bozulması değil, sırrı boş
  // yazan bir içe aktarma/geçiş adımı aramalı.
  if (veri.length === 0) throw new Error("Şifreli veri boş — bu satıra hiç sır yazılmamış.");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(veri), decipher.final()]).toString("utf8");
}

/** Mints an API key: the plaintext (shown once) plus the hash that gets stored. */
export function generateApiKey(): { plain: string; hash: string } {
  const plain = "ap_" + randomBytes(32).toString("base64url");
  return { plain, hash: hashApiKey(plain) };
}

export function hashApiKey(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

export class UserStore {
  private db: DatabaseSync;

  // `||` rather than `??`: `??` lets an empty string through, and DatabaseSync("") silently
  // opens a TEMPORARY database — every restart would then wipe all user tokens without
  // raising a single error. `.trim()` aynı kapının ikinci yarısıdır: yalnız boşluktan
  // oluşan bir ADSPILOT_DB `??`/`||` fark etmeksizin "doğru" görünür ama diske adı
  // boşluk olan bir dosya açar; o da her yeniden başlatmada kaybolan bir depodur.
  constructor(path = process.env.ADSPILOT_DB?.trim() || "adspilot.db") {
    /**
     * AÇIKÇA VERİLEN BOŞ YOL DA RET. Varsayılan argüman yukarıda korunuyor ama
     * `new UserStore(kullaniciYolu)` çağıran bir yol boş dize geçirirse aynı sessiz
     * geçici-veritabanı tuzağına düşerdi: kiracı token'ları her yeniden başlatmada
     * tek bir hata satırı bile üretmeden silinir. Bilinmeyen yol = RET.
     */
    if (!path.trim()) {
      throw new Error(
        "Veritabanı yolu boş — DatabaseSync boş yolda GEÇİCİ bir veritabanı açar ve tüm " +
          "kullanıcı token'ları her yeniden başlatmada sessizce silinirdi. ADSPILOT_DB'ye gerçek bir yol ver."
      );
    }
    try {
      this.db = new DatabaseSync(path);
    } catch (e: any) {
      throw new Error(
        `Veritabanı açılamadı: '${path}' (${e?.message ?? e}). ` +
          `Klasör var mı ve yazılabilir mi? ADSPILOT_DB ile başka bir yol verebilirsin.`
      );
    }
    // Concurrency: the default busy_timeout=0 makes two simultaneous requests fail hard
    // with SQLITE_BUSY. WAL plus a wait timeout is what keeps them from colliding.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        refresh_token_enc TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        login_customer_id TEXT,
        write_enabled INTEGER NOT NULL DEFAULT 1,
        max_daily_budget REAL NOT NULL DEFAULT 500,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key_hash);
    `);
    // Durable identity is Google's `sub` claim. Email CANNOT serve as the tenant key: it
    // can change, Workspace can reassign it, and when it fails to resolve it collapses
    // everyone into a single row. Added as an additive migration for existing installs.
    const cols = this.db.prepare("PRAGMA table_info(users)").all() as any[];
    if (!cols.some((c) => String(c.name) === "google_sub")) {
      this.db.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sub ON users(google_sub)");
  }

  /**
   * Inserts or refreshes the user and returns a NEW API key.
   * When `subject` (Google's `sub`) is present it is the tenant key; otherwise the email
   * is the fallback, a path that exists only for stdio and tests since the hosted flow
   * requires a subject.
   * Everything runs in one transaction so two concurrent callbacks cannot race into a
   * UNIQUE violation and lose the user's fresh refresh token.
   */
  upsertUser(input: {
    subject?: string;
    email: string;
    refreshToken: string;
    loginCustomerId?: string;
    maxDailyBudget?: number;
  }): { apiKey: string; userId: number } {
    const { plain, hash } = generateApiKey();
    const enc = encryptSecret(input.refreshToken);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const bySub = input.subject
        ? (this.db.prepare("SELECT id FROM users WHERE google_sub = ?").get(input.subject) as { id: number } | undefined)
        : undefined;
      /**
       * E-POSTAYA DÜŞÜŞ, YALNIZ HENÜZ HİÇ BAĞLANMAMIŞ SATIRA İZİNLİ.
       *
       * Önceki hâl `bySub ?? (email ile ara)` idi ve `subject` VERİLMİŞ ama eşleşmemiş
       * olsa bile e-postaya düşüyordu. Bu, bu dosyanın kendi şema yorumunun ("Email
       * CANNOT serve as the tenant key: it can change, Workspace can reassign it")
       * tam tersiydi ve devralmaya açıktı: aynı e-postayla YENİ bir Google `sub`'ı
       * gelen giriş, mevcut kiracının satırını buluyor, UPDATE ile google_sub'ı kendi
       * değeriyle değiştiriyor ve yeni bir API anahtarı alıyordu. Devralınan satır
       * kurbanın Google Ads refresh token'ını ve bütçe tavanını taşıdığı için sonuç,
       * başkasının reklam hesabında harcama yetkisidir. Bu senaryo teorik de değil:
       * Workspace'te bir kullanıcı silinip aynı adresle yeniden açıldığında sub değişir,
       * e-posta aynı kalır.
       *
       * Ama e-posta yolu tamamen kapatılamaz: stdio/test akışıyla `subject` OLMADAN
       * açılmış satırların sonradan Google girişine bağlanması meşru bir yükseltmedir.
       * Ayrım, satırın DAHA ÖNCE bağlanmış olup olmadığıdır — sahipsiz satır sahiplenilir,
       * sahipli satır asla devredilmez.
       */
      const byEmail = this.db
        .prepare("SELECT id, google_sub FROM users WHERE email = ?")
        .get(input.email) as { id: number; google_sub: string | null } | undefined;

      if (!bySub && byEmail && byEmail.google_sub && byEmail.google_sub !== input.subject) {
        throw new Error(
          "Bu e-posta başka bir Google hesabına bağlı. Güvenlik gereği devralınmaz — " +
            "hesap sahibiyle iletişime geçin."
        );
      }

      const existing = bySub ?? byEmail;

      let userId: number;
      if (existing) {
        this.db
          .prepare(
            `UPDATE users SET google_sub = COALESCE(?, google_sub),
                              email = ?,
                              refresh_token_enc = ?,
                              api_key_hash = ?,
                              login_customer_id = COALESCE(?, login_customer_id),
                              max_daily_budget = COALESCE(?, max_daily_budget)
             WHERE id = ?`
          )
          .run(
            input.subject ?? null,
            input.email,
            enc,
            hash,
            input.loginCustomerId ?? null,
            input.maxDailyBudget ?? null,
            existing.id
          );
        userId = existing.id;
      } else {
        const res = this.db
          .prepare(
            `INSERT INTO users (google_sub, email, refresh_token_enc, api_key_hash, login_customer_id, max_daily_budget)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(input.subject ?? null, input.email, enc, hash, input.loginCustomerId ?? null, input.maxDailyBudget ?? 500);
        userId = Number(res.lastInsertRowid);
      }
      this.db.exec("COMMIT");
      return { apiKey: plain, userId };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Updates the user's guardrails. Open MCP sessions re-read the user on their next
   * request, so a change takes effect immediately and no session keeps a stale value.
   */
  updateSettings(userId: number, s: { writeEnabled?: boolean; maxDailyBudget?: number }): void {
    // Validate BEFORE writing anything, so a rejected value cannot leave a half-applied setting.
    if (s.maxDailyBudget !== undefined && (!Number.isFinite(s.maxDailyBudget) || s.maxDailyBudget <= 0)) {
      throw new Error("maxDailyBudget 0'dan büyük bir sayı olmalı.");
    }
    /**
     * Both fields change in one transaction, protective value first. Applying them
     * separately means a mid-way failure can leave writes enabled with the old, higher
     * ceiling still in place — the failure landing on the unsafe side.
     */
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (s.maxDailyBudget !== undefined) {
        this.db.prepare("UPDATE users SET max_daily_budget = ? WHERE id = ?").run(s.maxDailyBudget, userId);
      }
      if (s.writeEnabled !== undefined) {
        this.db.prepare("UPDATE users SET write_enabled = ? WHERE id = ?").run(s.writeEnabled ? 1 : 0, userId);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Re-reads the user by id — this is how open sessions avoid running on stale settings. */
  findById(id: number): StoredUser | undefined {
    const row = this.db
      .prepare(
        `SELECT id, google_sub, email, refresh_token_enc, login_customer_id, write_enabled, max_daily_budget, created_at
         FROM users WHERE id = ?`
      )
      .get(id) as any;
    return row ? this.rowToUser(row) : undefined;
  }

  /** Resolves a user from an API key; undefined when nothing matches. */
  findByApiKey(apiKeyPlain: string): StoredUser | undefined {
    const row = this.db
      .prepare(
        `SELECT id, google_sub, email, refresh_token_enc, login_customer_id, write_enabled, max_daily_budget, created_at
         FROM users WHERE api_key_hash = ?`
      )
      .get(hashApiKey(apiKeyPlain)) as any;
    return row ? this.rowToUser(row) : undefined;
  }

  /**
   * DEPODAKİ ANAHTARIN GERÇEKTEN ÇALIŞTIĞINI KANITLAR — açılışta bir kez.
   *
   * Dönüş: 'bos' (denenecek kayıt yok), 'calisiyor', ya da çözülemeyen kaydın hatası.
   *
   * NEDEN: açılış denetimi yalnız ŞİFRELEYEBİLMEYİ ölçüyordu ve şifrelemek her zaman
   * çalışır — anahtar YANLIŞ olsa bile. Anahtar döndürüldüğünde ya da veritabanı başka
   * bir kurulumdan geri yüklendiğinde süreç sağlıkla ayağa kalkıyor, /health yeşil
   * yanıyor, ve her kiracı ilk isteğinde ipucusuz bir 500 alıyordu. Arıza, onu
   * düzeltebilecek tek anın (açılış) çok sonrasında ve yanlış katmanda görünüyordu.
   *
   * Tek kayıt yeter: anahtar ya hepsini çözer ya hiçbirini.
   */
  anahtarCalisiyorMu(): "bos" | "calisiyor" | { hata: string } {
    const row = this.db
      .prepare(`SELECT refresh_token_enc FROM users ORDER BY id LIMIT 1`)
      .get() as any;
    if (!row) return "bos";
    try {
      decryptSecret(String(row.refresh_token_enc));
      return "calisiyor";
    } catch (e: any) {
      return { hata: String(e?.message ?? e) };
    }
  }

  private rowToUser(row: any): StoredUser {
    return {
      id: Number(row.id),
      googleSub: row.google_sub ? String(row.google_sub) : undefined,
      email: String(row.email),
      refreshToken: decryptSecret(String(row.refresh_token_enc)),
      loginCustomerId: row.login_customer_id ? String(row.login_customer_id) : undefined,
      writeEnabled: Number(row.write_enabled) === 1,
      maxDailyBudget: Number(row.max_daily_budget),
      createdAt: String(row.created_at),
    };
  }

  close(): void {
    this.db.close();
  }
}
