import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv, createDecipheriv, createHash, scryptSync } from "node:crypto";

/**
 * Hosted mod kullanıcı deposu. Refresh token'lar AES-256-GCM ile şifreli saklanır;
 * API anahtarları yalnız hash olarak tutulur (düz metin tek kez, kayıt anında gösterilir).
 */

export interface StoredUser {
  id: number;
  /** Google'ın değişmez kullanıcı kimliği (id_token `sub`). Kiracı anahtarı budur. */
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
 * Şifreleme anahtarı türetimi:
 * - 64 hex karakter (önerilen, makine üretimi) → doğrudan 32 baytlık anahtar
 * - başka her şey (insan parolası) → scrypt ile türetilir; düz SHA-256 parola
 *   girdisi için zayıftır, scrypt kaba kuvvete CPU/bellek maliyeti ekler.
 * Sabit salt bilinçli: tek uygulama sırrı var, kullanıcılar arası rainbow-table
 * riski yok; salt'ı DB'de saklamak anahtar rotasyonunu gereksiz yere karmaşıklaştırırdı.
 */
function masterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  const raw = process.env.ADSPILOT_MASTER_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      "ADSPILOT_MASTER_KEY eksik ya da 32 karakterden kısa — hosted mod token şifrelemesi için zorunlu. " +
        "Üretmek için: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  cachedMasterKey = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : scryptSync(raw, "adspilot-token-encryption-v1", 32);
  return cachedMasterKey;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret(packed: string): string {
  const [ivB64, tagB64, dataB64] = packed.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Şifreli veri bozuk (format).");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** API anahtarı üret: düz metin (bir kez gösterilir) + saklanacak hash. */
export function generateApiKey(): { plain: string; hash: string } {
  const plain = "ap_" + randomBytes(32).toString("base64url");
  return { plain, hash: hashApiKey(plain) };
}

export function hashApiKey(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

export class UserStore {
  private db: DatabaseSync;

  // DİKKAT: `??` boş string'i geçirir ve DatabaseSync("") sessizce GEÇİCİ bir
  // veritabanı açar — her yeniden başlatmada tüm kullanıcı token'ları yok olur,
  // tek hata bile vermeden. Bu yüzden `||` (boş string'i de yakalar) şart.
  constructor(path = process.env.ADSPILOT_DB || "adspilot.db") {
    try {
      this.db = new DatabaseSync(path);
    } catch (e: any) {
      throw new Error(
        `Veritabanı açılamadı: '${path}' (${e?.message ?? e}). ` +
          `Klasör var mı ve yazılabilir mi? ADSPILOT_DB ile başka bir yol verebilirsin.`
      );
    }
    // Eşzamanlılık: varsayılan busy_timeout=0 → aynı anda gelen iki istek
    // SQLITE_BUSY ile SERT hata verir. WAL + bekleme süresi bunu giderir.
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
    // Kalıcı kimlik: Google'ın `sub` claim'i. E-posta kiracı anahtarı OLAMAZ —
    // değişebilir, Workspace'te yeniden atanabilir ve çözülemediğinde herkesi
    // tek bir satırda birleştirir. Mevcut kurulumlar için eklemeli geçiş.
    const cols = this.db.prepare("PRAGMA table_info(users)").all() as any[];
    if (!cols.some((c) => String(c.name) === "google_sub")) {
      this.db.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sub ON users(google_sub)");
  }

  /**
   * Kullanıcıyı kaydeder/yeniler ve YENİ bir API anahtarı döner.
   * `subject` (Google `sub`) verildiyse kiracı anahtarı odur; yoksa e-postaya
   * düşülür (yalnız stdio/test yolu — hosted akış subject'i ZORUNLU kılar).
   * Tamamı tek işlemde: eşzamanlı iki callback yarışıp UNIQUE ihlaliyle
   * kullanıcının taze refresh token'ını kaybettiremesin.
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
      const existing =
        bySub ?? (this.db.prepare("SELECT id FROM users WHERE email = ?").get(input.email) as { id: number } | undefined);

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
   * Kullanıcının güvenlik ayarlarını günceller. Açık MCP oturumları bir sonraki
   * istekte tazelendiği için değişiklik anında etkili olur (bayat ayar kalmaz).
   */
  updateSettings(userId: number, s: { writeEnabled?: boolean; maxDailyBudget?: number }): void {
    // Doğrulama YAZMADAN ÖNCE: yarım uygulanmış ayar kalmasın.
    if (s.maxDailyBudget !== undefined && (!Number.isFinite(s.maxDailyBudget) || s.maxDailyBudget <= 0)) {
      throw new Error("maxDailyBudget 0'dan büyük bir sayı olmalı.");
    }
    /**
     * TEK İŞLEM. Eskiden iki ayrı UPDATE vardı ve sıra terstiŕ: önce
     * write_enabled (tehlikeli yarı), sonra tavan (koruyucu yarı). İkincisi
     * SQLITE_BUSY ya da disk hatasıyla patlarsa sonuç "yazma AÇIK + tavan
     * ESKİ/yüksek" oluyordu — yani hata güvenli olmayan tarafa düşüyordu.
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

  /** Kullanıcıyı id ile tazeler — açık oturumların ayarları bayatlamasın diye. */
  findById(id: number): StoredUser | undefined {
    const row = this.db
      .prepare(
        `SELECT id, google_sub, email, refresh_token_enc, login_customer_id, write_enabled, max_daily_budget, created_at
         FROM users WHERE id = ?`
      )
      .get(id) as any;
    return row ? this.rowToUser(row) : undefined;
  }

  /** API anahtarından kullanıcıyı çözer; bulunamazsa undefined. */
  findByApiKey(apiKeyPlain: string): StoredUser | undefined {
    const row = this.db
      .prepare(
        `SELECT id, google_sub, email, refresh_token_enc, login_customer_id, write_enabled, max_daily_budget, created_at
         FROM users WHERE api_key_hash = ?`
      )
      .get(hashApiKey(apiKeyPlain)) as any;
    return row ? this.rowToUser(row) : undefined;
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
