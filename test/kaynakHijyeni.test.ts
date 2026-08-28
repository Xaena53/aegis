// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAYNAK HİJYENİ — kaynak dosyalara ham denetim baytı sızmasın.
 *
 * NEDEN VAR: bu tuzağa bu depoda İKİ KEZ düşüldü. Önbellek anahtarlarında ayraç olarak
 * ham bir 0x00 baytı kullanıldı (`${token}<NUL>${phone}`), çünkü NUL bir kimlik bilgisinde
 * asla geçmez ve mükemmel bir ayraç gibi görünür. Sonuç: git dosyayı İKİLİ sayar. O andan
 * itibaren `git diff` çalışmaz, kod incelemesi imkânsızlaşır, `grep` dosyayı atlar ve
 * gizlice bozulan bir satır kimsenin gözüne çarpmaz. İlk seferinde networkTrust.ts,
 * ikincisinde meta/client.ts — yani "bir kez düzelttik" yetmiyor.
 *
 * Ayraç fikri doğru; yazımı yanlıştı. Ters-bölü + u0000 kaçış dizisi aynı çalışma-anı dizesini üretir
 * ve dosya metin olarak kalır. Bu test o tercihi kalıcı kılar.
 *
 * Kapsam bilerek geniş (tüm src + test + scripts): bir sonraki kopyala-yapıştır nereye
 * düşerse düşsün yakalansın.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const KOK = fileURLToPath(new URL("..", import.meta.url));
const UZANTILAR = new Set([".ts", ".mjs", ".js", ".json", ".md"]);
const ATLA = new Set(["node_modules", "dist", ".git", "coverage"]);

function dosyalar(dizin: string, toplanan: string[] = []): string[] {
  for (const ad of readdirSync(dizin)) {
    if (ATLA.has(ad)) continue;
    const tam = join(dizin, ad);
    if (statSync(tam).isDirectory()) dosyalar(tam, toplanan);
    else if (UZANTILAR.has(extname(ad))) toplanan.push(tam);
  }
  return toplanan;
}

test("kaynak dosyalarda HAM NUL baytı yok (git dosyayı ikili sayar)", () => {
  const suclular: string[] = [];
  for (const yol of dosyalar(join(KOK, "src")).concat(
    dosyalar(join(KOK, "test")),
    dosyalar(join(KOK, "scripts"))
  )) {
    const ham = readFileSync(yol);
    if (ham.includes(0x00)) suclular.push(yol.slice(KOK.length));
  }
  assert.deepEqual(
    suclular,
    [],
    `Ham NUL baytı içeren dosya(lar): ${suclular.join(", ")}.\n` +
      `git bu dosyaları İKİLİ sayar: diff çalışmaz, inceleme imkânsızlaşır, grep atlar.\n` +
      `Ayraç olarak NUL kullanmak istiyorsan '\\u0000' escape'ini yaz — aynı çalışma-anı ` +
      `dizesini üretir, dosya metin kalır.`
  );
});
