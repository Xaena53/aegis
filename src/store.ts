// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Credential and settings storage for hosted mode.
 *
 * Refresh tokens are encrypted with AES-256-GCM; API keys are stored only as hashes, so
 * the plaintext key exists exactly once — on the page shown at registration. Tenants are
 * keyed by Google's stable subject identifier rather than email, which can change or be
 * reassigned.
 */
import { existsSync } from "node:fs";
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
 * THE KDF SALT AND THE MINIMUM LENGTH ARE PINNED.
 *
 * The constants sit here so that tests compare them against a known answer they compute
 * themselves rather than reading them from the code: if the salt or the length changes,
 * EVERY refresh_token_enc in production becomes undecryptable — and a change like that
 * breaks neither the build nor the tests on its own. What breaks is the fixed fixture that
 * depends on these values.
 */
/**
 * ⚠ THIS STRING MUST NEVER CHANGE — not even when the product is renamed.
 *
 * A passphrase-type master key is put through scrypt with this salt. Change the salt and
 * the derived key changes with it, and EVERY ENCRYPTED ROW IN THE STORE BECOMES
 * UNDECRYPTABLE: the process starts, no type error appears, every tenant meets an error
 * with no reason in it, and the warm backup is broken in exactly the same way.
 *
 * The "adspilot" prefix is the product's former name and it stays DELIBERATELY. The bulk
 * rename to Aegis changed this line too; the embedded ciphertext in test/anahtarBelgesi.ts
 * caught it immediately. If you want to rotate the key, the path is reconnecting users, not
 * changing the salt.
 */
const ANAHTAR_TUZU = "adspilot-token-encryption-v1";
const ANAHTAR_ASGARI_UZUNLUK = 32;
const ANAHTAR_BAYT = 32;

/**
 * The master key as TEXT — TRIMMED.
 *
 * WHY TRIMMING IS REQUIRED: in most deployments the key arrives from a secret file or a
 * `docker secret`, and a single trailing newline breaks the 64-hex shape and drops the same
 * key into the passphrase (scrypt) branch. The result is a silent catastrophe: the process
 * starts, raises nothing, and yet no row in the store can be decrypted — and the warm backup
 * is broken too.
 *
 * WHY THE HTTP SIDE CALLS THIS: the same text is used for HMAC signatures (the session and
 * state cookies in http.ts), and that code used to say
 * `process.env.AEGIS_MASTER_KEY ?? ""`. Since signing and verification used the same
 * expression, it was internally CONSISTENT — a trimming difference would never have broken
 * those signatures, so that was the wrong reason. The real gain is smaller and elsewhere: the
 * `?? ""` fallback signed cookies with the EMPTY STRING when no key was set, that is, with a
 * key anyone could guess. Going through here, that situation throws instead of signing
 * quietly. The path is already closed at startup today (http.ts:validateHostedEnv runs while
 * the module loads and kills the process on a missing key), so the shared entry point is not
 * a gate but defence in depth — and it is held in place by a source-level guard
 * (test/kaynakHijyeni.test.ts: the signing paths never read the raw environment).
 */
export function masterKeyText(): string {
  const kirpik = process.env.AEGIS_MASTER_KEY?.trim() ?? "";
  if (kirpik.length < ANAHTAR_ASGARI_UZUNLUK) {
    throw new Error(
      `AEGIS_MASTER_KEY eksik ya da ${ANAHTAR_ASGARI_UZUNLUK} karakterden kısa — hosted mod token şifrelemesi için zorunlu. ` +
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
 * Falling back to SHA-256 (or any other cheap digest) here is NOT a speed improvement but a
 * loss of security: for a passphrase-type key the cost per guess drops roughly 23,000-fold,
 * and if the database file leaks the passphrase can be attacked offline until every tenant's
 * refresh token falls out. That is why the triple of algorithm, salt and length is pinned in
 * the tests against a known answer.
 *
 * HEX BUT NOT 64 CHARACTERS IS REFUSED: the choice between "64 hex" and "passphrase" cannot
 * be made silently. A machine key that lost or gained a character (63 or 65 hex) would drop
 * into the passphrase branch, and the operator — believing they had supplied the right key —
 * could open no row at all. "Unknown" and "clean" are not the same thing, so it is refused
 * explicitly.
 */
export function deriveMasterKey(ham: string): Buffer {
  const kirpik = ham.trim();
  if (kirpik.length < ANAHTAR_ASGARI_UZUNLUK) {
    throw new Error(
      `AEGIS_MASTER_KEY ${ANAHTAR_ASGARI_UZUNLUK} karakterden kısa olamaz (kırpılmış uzunluk: ${kirpik.length}).`
    );
  }
  if (/^[0-9a-f]{64}$/i.test(kirpik)) return Buffer.from(kirpik, "hex");
  if (/^[0-9a-f]+$/i.test(kirpik)) {
    throw new Error(
      `AEGIS_MASTER_KEY yalnız onaltılık karakterlerden oluşuyor ama uzunluğu 64 değil (${kirpik.length}). ` +
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
  // Which branch ran has to be visible IN PRODUCTION: it is the only cheap diagnosis for
  // "I supplied the key and nothing decrypts" (an invisible space in the environment, a
  // wrong length).
  console.error(
    `[aegis] ana anahtar türetmesi: ${
      /^[0-9a-f]{64}$/i.test(kirpik) ? "64-hex (doğrudan)" : `parola (scrypt, tuz: ${ANAHTAR_TUZU})`
    }`
  );
  return cachedMasterKey;
}

export function encryptSecret(plain: string): string {
  /**
   * AN EMPTY SECRET IS REFUSED AT SOURCE.
   *
   * Empty plaintext produced "iv.tag.": a package that cannot pass our own decryptSecret's
   * shape check. That is a row which can be written to the store but never read back — and
   * the reader, seeing "the encrypted data is corrupt", would go looking for disk
   * corruption. An empty refresh token is useless anyway; the right place to catch it is
   * where it is produced.
   */
  if (plain === "") throw new Error("Boş sır şifrelenemez (kaynakta reddedildi).");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret(packed: string): string {
  /**
   * THE SHAPE CHECK IS STRUCTURAL, NOT BASED ON CORRECTNESS.
   *
   * It used to ask only "are all three parts non-empty"; because base64 decoding is
   * forgiving, a 3-byte IV or a 2-byte tag passed the check and turned into
   * createDecipheriv's unintelligible "Unsupported state" error. Under GCM the IV is 12
   * bytes and the tag is 16 — a package whose measurements do not match is corrupt, and it
   * is not guessed at.
   */
  const parcalar = packed.split(".");
  if (parcalar.length !== 3) throw new Error("Şifreli veri bozuk (format).");
  const iv = Buffer.from(parcalar[0], "base64");
  const tag = Buffer.from(parcalar[1], "base64");
  const veri = Buffer.from(parcalar[2], "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Şifreli veri bozuk (format).");
  // An empty body is reported in its own sentence: the operator should be looking for an
  // import or migration step that wrote the secret empty, not for disk corruption.
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

  /**
   * The file to use when AEGIS_DB is not set — WITHOUT ABANDONING THE OLD NAME.
   *
   * When the product was renamed from AdsPilot to Aegis, the default filename moved from
   * `adspilot.db` to `aegis.db`. On its own that is SILENT DATA LOSS for every installation
   * that upgrades: the process starts, creates an empty database, emits not one line of
   * error — and every connected account appears to be gone. The user sees "everything has
   * been deleted", while the old file is sitting right there on disk.
   *
   * So the new name is used ONLY when the old file is NOT THERE. When it is, that file is
   * opened and the choice is WRITTEN to stderr: adapting quietly is as bad as losing
   * quietly, and the operator should know which file is in use and be able to move it by
   * hand.
   */
  static varsayilanYol(): string {
    const acik = process.env.AEGIS_DB?.trim();
    if (acik) return acik;
    if (!existsSync("aegis.db") && existsSync("adspilot.db")) {
      console.error(
        "[aegis] Bilgi: 'aegis.db' yok ama eski 'adspilot.db' bulundu — ESKİ DOSYA kullanılıyor. " +
          "Yeni ada geçmek için süreci durdurup dosyayı 'aegis.db' olarak yeniden adlandır " +
          "(yanındaki -wal ve -shm dosyalarıyla birlikte)."
      );
      return "adspilot.db";
    }
    return "aegis.db";
  }

  // `||` rather than `??`: `??` lets an empty string through, and DatabaseSync("") silently
  // opens a TEMPORARY database — every restart would then wipe all user tokens without
  // raising a single error. `.trim()` is the second half of the same gate: an AEGIS_DB made
  // only of whitespace looks "valid" whether you use `??` or `||`, but opens a file on disk
  // whose name is a space — which is another store that disappears on every restart.
  constructor(path = UserStore.varsayilanYol()) {
    /**
     * AN EXPLICITLY SUPPLIED EMPTY PATH IS REFUSED TOO. The default argument above is
     * protected, but a caller doing `new UserStore(userPath)` with an empty string would
     * fall into the same silent temporary-database trap: tenant tokens are deleted on every
     * restart without producing a single line of error. An unknown path means REFUSE.
     */
    if (!path.trim()) {
      throw new Error(
        "Veritabanı yolu boş — DatabaseSync boş yolda GEÇİCİ bir veritabanı açar ve tüm " +
          "kullanıcı token'ları her yeniden başlatmada sessizce silinirdi. AEGIS_DB'ye gerçek bir yol ver."
      );
    }
    try {
      this.db = new DatabaseSync(path);
    } catch (e: any) {
      throw new Error(
        `Veritabanı açılamadı: '${path}' (${e?.message ?? e}). ` +
          `Klasör var mı ve yazılabilir mi? AEGIS_DB ile başka bir yol verebilirsin.`
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
       * FALLING BACK TO EMAIL IS ALLOWED ONLY FOR A ROW THAT HAS NEVER BEEN LINKED.
       *
       * The earlier form was `bySub ?? (look up by email)`, which fell back to email even
       * when `subject` WAS supplied but did not match. That was the exact opposite of this
       * file's own schema comment — "Email CANNOT serve as the tenant key: it can change,
       * Workspace can reassign it" — and it was open to takeover: a login arriving with a
       * NEW Google `sub` on the same email found the
       * existing tenant's row, replaced google_sub with its own value through an UPDATE,
       * and received a new API key. Because the taken-over row carries the victim's Google
       * Ads refresh token and budget ceiling, the result is authority to spend inside
       * somebody else's ad account. Nor is the scenario theoretical: in Workspace, deleting
       * a user and recreating them at the same address changes the sub and keeps the email.
       *
       * The email path cannot be closed entirely, though: linking a row created WITHOUT a
       * `subject` through the stdio/test flow to a Google login later is a legitimate
       * upgrade. The distinction is whether the row has EVER been linked — an unowned row
       * can be claimed, an owned row is never handed over.
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
   * PROVES THAT THE KEY ACTUALLY OPENS THE STORE — once, at startup.
   *
   * Returns 'bos' (no record to try), 'calisiyor', or the error from the record that could
   * not be decrypted.
   *
   * WHY: the startup check measured only whether we could ENCRYPT, and encryption always
   * works — even with the WRONG key. When the key had been rotated, or the database restored
   * from another installation, the process came up healthy, /health went green, and every
   * tenant met a 500 with no clue in it on their first request. The fault surfaced long after
   * the only moment it could be fixed (startup), and in the wrong layer.
   *
   * One record is enough: the key either opens all of them or none.
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
