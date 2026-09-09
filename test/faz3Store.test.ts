// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FAZ 3 — src/store.ts gözcüsü: kiracı veritabanı DÜNYA-OKUNUR doğmasın.
 *
 * ÖLÇÜLEN AÇIK: SQLite yeni veritabanını SQLITE_DEFAULT_FILE_PERMISSIONS ile, yani 0644 ile
 * yaratıyor. Linux konteynerde ölçüldü — hem umask 022 (systemd varsayılanı) hem umask 000
 * altında dosya 0644 doğdu, `-wal`/`-shm` yan dosyaları da öyle. Süreç bunu hiçbir yerde
 * daraltmıyordu: depoda tek bir chmod/umask satırı yoktu ve deploy/aegis.service'te UMask=
 * satırı da yok. Yanı başındaki `.env` özenle chmod 600'e çekilirken, tüm kiracıların
 * e-postası, google_sub değeri, bütçe tavanı ve şifreli refresh token'ı sunucudaki HERHANGİ
 * bir yerel hesaba açıktı.
 *
 * Bu dosya üç ayrı yüzeyi kilitliyor:
 *   1) KAPININ KENDİSİ — enjekte edilmiş bir dosya sistemiyle: 0600 yazılıyor mu, yan
 *      dosyalar kapsanıyor mu, DARALTILAMAYAN dosya REDDEDİLİYOR mu, ölçülemeyen izin
 *      "temiz" sayılıyor mu, Windows'ta sessizce atlanıyor mu.
 *   2) GERÇEK DOSYA SİSTEMİ — POSIX'te `new UserStore(...)` sonrası ölçülen mod (win32'de
 *      atlanır: orada POSIX kip bitleri yok, Node'un chmod'u yalnız salt-okunur bayrağını
 *      çevirir).
 *   3) BAĞLANTI + BELGE — kapı kurucudan gerçekten çağrılıyor mu, ve dosya başındaki cümle
 *      kodun bugün yazdığı modu söylüyor mu. Çift yönlü: cümle bayatlarsa da, çağrı ya da
 *      mod değişirse de kırmızı.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Tip-düzeyi içe aktarım derlemede silinir: ana anahtar ortamı aşağıda kurulduktan sonra
// yapılan dinamik içe aktarımın sırası bozulmaz.
import type { DosyaIzinKapisi } from "../src/store.js";

process.env.AEGIS_MASTER_KEY = "faz3-store-testi-32-bayttan-uzun-anahtar";

const {
  UserStore,
  depoIzinleriniKisitla,
  depoDosyaYollari,
  DEPO_DOSYA_MODU,
} = await import("../src/store.js");
const KOK = fileURLToPath(new URL("..", import.meta.url));
const KLASOR = mkdtempSync(join(tmpdir(), `aegis-faz3-store-${process.pid}-`));
const WIN = process.platform === "win32";

/**
 * Sahte bir POSIX dosya sistemi. `modlar` haritasında olmayan yol "dosya yok" demektir.
 * `chmodEtkisiz` seçeneği, chmod'u kabul edip UYGULAMAYAN bir dosya sistemini taklit eder —
 * kapının "denemek başarmak değildir" iddiasının ölçüldüğü yer burası.
 */
function sahteKapi(
  modlar: Record<string, number>,
  secenek: { platform?: string; chmodEtkisiz?: boolean; chmodHatasi?: any; okumaHatasi?: any } = {}
) {
  const yazmalar: Array<{ yol: string; mod: number }> = [];
  const kapi: DosyaIzinKapisi = {
    platform: secenek.platform ?? "linux",
    varMi: (yol: string) => yol in modlar,
    moduOku: (yol: string) => {
      if (secenek.okumaHatasi) throw secenek.okumaHatasi;
      return modlar[yol];
    },
    moduYaz: (yol: string, mod: number) => {
      yazmalar.push({ yol, mod });
      if (secenek.chmodHatasi) throw secenek.chmodHatasi;
      if (!secenek.chmodEtkisiz) modlar[yol] = mod;
    },
  };
  return { kapi, yazmalar, modlar };
}

function enoent(): any {
  const e: any = new Error("ENOENT: no such file or directory");
  e.code = "ENOENT";
  return e;
}

test("0644 doğan depo dosyası ve WAL yan dosyaları 0600'e daraltılır", () => {
  const yol = "/opt/aegis/data/aegis.db";
  const { kapi, yazmalar, modlar } = sahteKapi({
    [yol]: 0o644,
    [`${yol}-wal`]: 0o644,
    [`${yol}-shm`]: 0o644,
  });

  const kisitlanan = depoIzinleriniKisitla(yol, kapi);

  assert.deepEqual(kisitlanan, [yol, `${yol}-wal`, `${yol}-shm`]);
  assert.deepEqual(
    yazmalar.map((y) => y.mod),
    [0o600, 0o600, 0o600],
    "üç dosyaya da 0600 yazılmalı"
  );
  for (const hedef of depoDosyaYollari(yol)) {
    assert.equal(modlar[hedef] & 0o077, 0, `${hedef} grup/diğer bitleri sıfırlanmalı`);
  }
});

test("var olmayan yan dosyaya dokunulmaz (temiz açılışta -wal/-shm henüz yok)", () => {
  const yol = join(KLASOR, "yok.db");
  const { kapi, yazmalar } = sahteKapi({ [yol]: 0o644 });
  assert.deepEqual(depoIzinleriniKisitla(yol, kapi), [yol]);
  assert.deepEqual(yazmalar, [{ yol, mod: 0o600 }]);
});

test("KRİTİK: daraltılamayan dosya REDDEDİLİR — denemek başarmak değildir", () => {
  const yol = "/mnt/paylasim/aegis.db";
  const { kapi } = sahteKapi({ [yol]: 0o644 }, { chmodEtkisiz: true });
  assert.throws(
    () => depoIzinleriniKisitla(yol, kapi),
    (e: any) => {
      const m = String(e?.message ?? e);
      assert.match(m, /0644/, "ölçülen mod mesajda adıyla geçmeli");
      assert.match(m, /grup\/diğer/i);
      assert.ok(m.includes(yol), "hangi dosya olduğu yazmalı");
      assert.match(m, /chmod 600/, "elle düzeltme komutu verilmeli");
      return true;
    }
  );
});

test("chmod hata fırlatıp mod açık kalırsa: ret, ve chmod hatası da mesajda", () => {
  const yol = "/mnt/ro/aegis.db";
  const eperm: any = new Error("EPERM: operation not permitted, chmod");
  eperm.code = "EPERM";
  const { kapi } = sahteKapi({ [yol]: 0o644 }, { chmodHatasi: eperm });
  assert.throws(() => depoIzinleriniKisitla(yol, kapi), /EPERM[\s\S]*chmod 600|chmod başarısız/);
});

test("chmod fırlatsa bile dosya ZATEN 0600 ise geçilir (karar ölçümle verilir)", () => {
  const yol = "/opt/aegis/data/aegis.db";
  const eperm: any = new Error("EPERM: operation not permitted, chmod");
  eperm.code = "EPERM";
  const { kapi } = sahteKapi({ [yol]: 0o600 }, { chmodHatasi: eperm });
  assert.deepEqual(depoIzinleriniKisitla(yol, kapi), [yol]);
});

test("KRİTİK: izni OKUNAMAYAN dosya 'temiz' sayılmaz — ret", () => {
  const yol = "/opt/aegis/data/aegis.db";
  const eacces: any = new Error("EACCES: permission denied, stat");
  eacces.code = "EACCES";
  const { kapi } = sahteKapi({ [yol]: 0o600 }, { okumaHatasi: eacces });
  assert.throws(() => depoIzinleriniKisitla(yol, kapi), /OKUNAMADI[\s\S]*açılmadı/);
});

test("eşzamanlı checkpoint -wal'i silerse ENOENT ret sebebi DEĞİLDİR", () => {
  const yol = "/opt/aegis/data/aegis.db";
  const { kapi } = sahteKapi(
    { [yol]: 0o600, [`${yol}-wal`]: 0o600 },
    { okumaHatasi: undefined }
  );
  // -wal, varMi ile stat arasında yok oluyor: chmod ENOENT ile düşüyor.
  const asil = kapi.moduYaz;
  kapi.moduYaz = (hedef: string, mod: number) => {
    if (hedef.endsWith("-wal")) throw enoent();
    asil(hedef, mod);
  };
  assert.deepEqual(depoIzinleriniKisitla(yol, kapi), [yol], "silinmiş yan dosya sırf atlanır");
});

test("Windows'ta kapı hiç çalışmaz (POSIX kip bitleri orada yok)", () => {
  const yol = "C:/aegis/aegis.db";
  const { kapi, yazmalar } = sahteKapi({ [yol]: 0o666 }, { platform: "win32" });
  assert.deepEqual(depoIzinleriniKisitla(yol, kapi), []);
  assert.deepEqual(yazmalar, [], "win32'de tek bir chmod bile denenmemeli");
});

test(
  "GERÇEK DOSYA SİSTEMİ: UserStore açılan depoyu 0600 bırakır (WAL yan dosyaları dahil)",
  { skip: WIN ? "POSIX kip bitleri yalnız POSIX'te ölçülebilir" : false },
  () => {
    const yol = join(KLASOR, "gercek.db");
    const store = new UserStore(yol);
    try {
      store.upsertUser({ email: "kiraci@ornek.com", refreshToken: "TEST-ONLY-token-faz3" });
      for (const hedef of depoDosyaYollari(yol)) {
        let mod: number;
        try {
          mod = statSync(hedef).mode & 0o777;
        } catch {
          continue; // yan dosya yoksa korunacak bir şey de yok
        }
        assert.equal(
          mod & 0o077,
          0,
          `${hedef} modu 0${mod.toString(8)} — grup/diğer kullanıcılara açık kalmış`
        );
      }
    } finally {
      store.close();
    }
  }
);

/**
 * BAĞLANTI + BELGE — çift yönlü.
 *
 * Enjekte edilebilir bir kapıyı sınamak, o kapının KURUCUDAN çağrıldığını kanıtlamaz;
 * Windows'ta gerçek dosya sistemiyle de ölçülemez. Bu yüzden bağ kaynak düzeyinde
 * kilitleniyor. Aynı test dosya başındaki vaadi de kodun bugün YAZDIĞI moda bağlıyor:
 * modu değiştiren cümleyi de değiştirmek zorunda kalır, cümleyi silen bağı da kaybeder.
 */
test("KRİTİK: kapı kurucuya bağlı ve dosya başındaki 0600 vaadi koda uyuyor", () => {
  const kaynak = readFileSync(join(KOK, "src", "store.ts"), "utf8");

  const kurucu = kaynak.slice(kaynak.indexOf("constructor(path = UserStore.varsayilanYol())"));
  assert.ok(
    kurucu.length > 0 && /depoIzinleriniKisitla\(this\.yol\)/.test(kurucu.slice(0, 3000)),
    "UserStore kurucusu depoIzinleriniKisitla(this.yol) çağırmalı — yoksa kapı ölü kod olur"
  );
  // Daraltma WAL dosyaları yaratılmadan ÖNCE olmalı; yan dosyalar modu ana dosyadan miras alır.
  assert.ok(
    kurucu.indexOf("depoIzinleriniKisitla(this.yol)") < kurucu.indexOf("journal_mode = WAL"),
    "chmod, WAL yan dosyaları yaratılmadan önce koşmalı"
  );

  // Kodun gerçekten yazdığı mod (sabitten değil, kapıyı koşturarak ölçülür):
  const yol = "/olcum/aegis.db";
  const { yazmalar } = (() => {
    const s = sahteKapi({ [yol]: 0o644 });
    depoIzinleriniKisitla(yol, s.kapi);
    return s;
  })();
  const yazilanMod = yazmalar[0].mod;
  assert.equal(yazilanMod, DEPO_DOSYA_MODU);
  const sekizli = `0${yazilanMod.toString(8)}`;

  const bas = kaynak.slice(0, kaynak.indexOf("import "));
  assert.ok(
    bas.includes(sekizli),
    `Dosya başı, kapının yazdığı modu (${sekizli}) adıyla söylemeli — bayat vaat yasak`
  );
  assert.match(bas, /depoIzinleriniKisitla/, "vaat, onu uygulayan kapıya işaret etmeli");
});

process.on("exit", () => {
  try {
    rmSync(KLASOR, { recursive: true, force: true });
  } catch {
    /* Windows'ta dosya hâlâ kilitli olabilir */
  }
});
