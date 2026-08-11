import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

/**
 * Hosted mod kullanıcı deposu. Refresh token'lar AES-256-GCM ile şifreli saklanır;
 * API anahtarları yalnız hash olarak tutulur (düz metin tek kez, kayıt anında gösterilir).
 */

export interface StoredUser {
  id: number;
  email: string;
  refreshToken: string;
  loginCustomerId?: string;
  writeEnabled: boolean;
  maxDailyBudget: number;
  createdAt: string;
}

function masterKey(): Buffer {
  const raw = process.env.ADSPILOT_MASTER_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      "ADSPILOT_MASTER_KEY eksik ya da 32 karakterden kısa — hosted mod token şifrelemesi için zorunlu. " +
        "Üretmek için: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  // Hex ya da düz parola kabul; her ikisi de 32 baytlık anahtara indirgenir
  return createHash("sha256").update(raw).digest();
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

/** Zamanlama saldırısına kapalı hash karşılaştırma. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class UserStore {
  private db: DatabaseSync;

  constructor(path = process.env.ADSPILOT_DB ?? "adspilot.db") {
    try {
      this.db = new DatabaseSync(path);
    } catch (e: any) {
      throw new Error(
        `Veritabanı açılamadı: '${path}' (${e?.message ?? e}). ` +
          `Klasör var mı ve yazılabilir mi? ADSPILOT_DB ile başka bir yol verebilirsin.`
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        refresh_token_enc TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        login_customer_id TEXT,
        write_enabled INTEGER NOT NULL DEFAULT 1,
        max_daily_budget REAL NOT NULL DEFAULT 500,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key_hash);
    `);
  }

  /** Kullanıcı oluşturur (ya da aynı e-posta varsa token'ı yeniler) ve yeni API anahtarı döner. */
  upsertUser(input: {
    email: string;
    refreshToken: string;
    loginCustomerId?: string;
    maxDailyBudget?: number;
  }): { apiKey: string; userId: number } {
    const { plain, hash } = generateApiKey();
    const enc = encryptSecret(input.refreshToken);
    const existing = this.db.prepare("SELECT id FROM users WHERE email = ?").get(input.email) as
      | { id: number }
      | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE users SET refresh_token_enc = ?, api_key_hash = ?, login_customer_id = ?,
                            max_daily_budget = COALESCE(?, max_daily_budget)
           WHERE id = ?`
        )
        .run(enc, hash, input.loginCustomerId ?? null, input.maxDailyBudget ?? null, existing.id);
      return { apiKey: plain, userId: existing.id };
    }

    const res = this.db
      .prepare(
        `INSERT INTO users (email, refresh_token_enc, api_key_hash, login_customer_id, max_daily_budget)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.email, enc, hash, input.loginCustomerId ?? null, input.maxDailyBudget ?? 500);
    return { apiKey: plain, userId: Number(res.lastInsertRowid) };
  }

  /** API anahtarından kullanıcıyı çözer; bulunamazsa undefined. */
  findByApiKey(apiKeyPlain: string): StoredUser | undefined {
    const row = this.db
      .prepare(
        `SELECT id, email, refresh_token_enc, login_customer_id, write_enabled, max_daily_budget, created_at
         FROM users WHERE api_key_hash = ?`
      )
      .get(hashApiKey(apiKeyPlain)) as any;
    if (!row) return undefined;
    return {
      id: Number(row.id),
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
