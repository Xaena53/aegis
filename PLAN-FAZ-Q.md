# Faz Q — "Çalışan MCP"den "Referans MCP"ye

**Konum:** Faz 3a (hosted çekirdek) ✅ bitti → **Faz Q (burası)** → Faz 3d (VPS deploy)

**Neden VPS'ten ÖNCE:** Deploy, mimariyi dondurur. Aşağıdaki maddelerin çoğu
araç sözleşmesini (tool contract) değiştiriyor; canlı kullanıcılar bağlandıktan
sonra sözleşme değiştirmek kırıcı güncelleme demek. Ayrıca Q1 ve Q2 birer
*güvenlik* işi — deploy öncesi kapatılmalı.

---

## Bugünkü durum (ölçüldü, tahmin değil)

| Boyut | Durum |
|---|---|
| Araç sayısı | 12 (5 okuma + 6 yazma + 1 site) |
| MCP ileri yetenekleri | **0 / 7** kullanılıyor (elicitation, resources, prompts, outputSchema, structuredContent, completions, logging) |
| Test edilen kaynak dosya | **4 / 11** — araç katmanının (`tools/*`) ve HTTP katmanının testi YOK |
| Birim test | 51 (hepsi saf yardımcılar) |
| Taşıma | stdio + Streamable HTTP ✅ |
| Güvenlik kapıları | Var ama **ajan-aracılı** (aşağıda Q1) |

---

## Q1 — Onayı ajandan alıp İNSANA bağla (elicitation)

**Öncelik: KRİTİK. Bu bir güvenlik işi, cila değil.**

Bugünkü `confirm=true` kapısı bir *şeref sözü*: araç "reddedildi, önce kullanıcıya
sor" diyor ve ajanın gerçekten sorduğuna **güveniyor**. Kötü niyetli ya da özensiz
bir ajan aynı çağrıyı `confirm=true` ile tekrarlayıp insana hiç sormadan gerçek
para harcatabilir. Sunucunun insanın onayladığını doğrulama yolu yok.

`elicitInput` bunu tersine çevirir: **sunucu, istemci üzerinden doğrudan insana
sorar** ve yanıtı kendisi alır. Onay artık ajanın anlattığı bir hikâye değil,
protokol düzeyinde bir olgu.

- **Değişecek:** `tools/write.ts` — `set_campaign_status(ENABLED)`,
  `update_campaign_budget`, canlı kampanyaya yazan araçlar.
- **Nasıl:** `server.server.elicitInput({ message, requestedSchema })` ile
  kampanya özetini (bütçe, kelimeler, metin, ülke) gösterip onay iste.
- **Geri uyumluluk:** İstemci elicitation desteklemiyorsa (capability yoksa)
  mevcut `confirm` kapısına düş — davranış bozulmasın.
- **Kabul ölçütü:** Elicitation destekli istemcide `confirm=true` gönderilse
  bile insan reddederse işlem YAPILMAZ. Entegrasyon testiyle kanıtlanır.

## Q2 — Araç katmanı entegrasyon testleri (InMemoryTransport)

**Öncelik: KRİTİK.** Ürünün README'de reklamı yapılan tüm güvenlik vaatleri
(PAUSED-varsayılan, onay kapısı, bütçe tavanı, canlı-kampanya koruması,
yazma kilidi) şu anda **tek satır testle korunmuyor**. Bir refactor bu `if`'leri
düşürse hiçbir şey uyarmaz; bedeli gerçek para.

- **Nasıl:** SDK'nın `InMemoryTransport.createLinkedPair()` ile gerçek bir MCP
  istemci↔sunucu çifti kur; `AdsContext` yerine sahte (fake) bir context enjekte
  et — `buildServer(getCtx)` zaten bunu mümkün kılıyor, ek refactor gerekmez.
- **Yazılacak testler (`test/tools.write.test.ts`):**
  - `set_campaign_status(ENABLED)` confirm'siz reddeder
  - `writeEnabled=false` iken **altı** yazma aracının hepsi reddeder
  - kampanya PAUSED + `explicitly_shared=false` kurulur
  - bütçe tavanı context'ten okunur (kullanıcı-başı)
  - paylaşımlı bütçe reddedilir
  - reklamsız/yayınlanamaz kampanya ENABLED edilemez
  - bilinmeyen ülke kodu ve boş `countryCodes` reddedilir
  - RSA'da dedupe sonrası eşik altı reddedilir
  - canlı kampanyaya onaysız reklam/kelime eklenemez
- **`test/tools.read.test.ts`:** GAQL'e giden metnin normalize edildiği,
  LIMIT'in dayatıldığı, enum adlarının çözüldüğü.
- **`test/http.test.ts`:** 401/403/404/429 yolları, oturum sahipliği,
  çerezli OAuth state, izinli host listesi.
- **Kabul ölçütü:** Test edilen kaynak dosya 4/11 → 10/11; her güvenlik kapısı
  için en az bir kırmızı-yeşil testi var.

## Q3 — Prompts: ürünü komut satırından çıkar

MCP `prompts` yeteneği, Claude Code'da **slash komut** olarak görünür. Bugün
kullanıcı ne yapacağını kendi tarif etmek zorunda; prompts ile iş akışları
hazır gelir.

- `/reklam-kur <url>` → analyze_site → kelime+metin üretimi → onay → taslak
- `/israf-bul` → search_terms_report → negatif kelime önerisi → onay → uygula
- `/haftalik-rapor` → performans + kelime + arama terimi özeti
- `/kampanya-denetle <id>` → bütçe, teklif, negatifler, reklam sayısı kontrolü

**Değer:** Ürünün "Claude ile reklam ver" vaadi, kullanıcı hiçbir şey
yazmadan çalışır hale gelir. Aynı zamanda en iyi dokümantasyondur.

## Q4 — Resources: hesabı gezilebilir yap

Google'ın kendi resmi MCP'si 4 resource sunuyor; bizde 0 var. Resources,
istemcinin veriyi **araç çağırmadan** okumasını sağlar (token tasarrufu + keşif).

- `adspilot://accounts` — erişilebilir hesaplar
- `adspilot://accounts/{id}/campaigns` — kampanya listesi
- `adspilot://accounts/{id}/limits` — **bu kullanıcının** bütçe tavanı ve yazma
  izni (bugün hiçbir yerden görünmüyor — denetimde çıkan boşluk)
- `adspilot://gaql-sema` — sık kullanılan GAQL alanları (ajanın sorgu yazarken
  uydurmasını engeller)

`ResourceTemplate` ile parametreli URI + `complete` ile hesap ID tamamlama.

## Q5 — Structured output (`outputSchema` + `structuredContent`)

Bugün her araç serbest metin döndürüyor: ajan bunu ayrıştırmak zorunda,
token pahalı ve kırılgan. MCP 2025-06-18 tipli çıktıyı destekliyor.

- `campaign_performance`, `keyword_performance`, `search_terms_report`,
  `list_accounts` → tipli JSON + insan-okur metin özeti (ikisi birden).
- **Yan fayda:** `run_gaql`'in 20K karakter kesme sorunu (geçersiz JSON
  üretebiliyordu) yapısal çıktıyla kökten çözülür.
- **Kabul ölçütü:** Şemalar Zod'dan üretilir, testte doğrulanır.

## Q6 — Ajan ergonomisi: açıklamalar, isimler, hata-olarak-talimat

Bir MCP'nin kalitesi, LLM'in **doğru aracı doğru argümanlarla** seçme oranıdır.

- Araç açıklamalarını "ne yapar" değil "**ne zaman kullan / ne zaman kullanma**"
  diliyle yeniden yaz; her araca `title` ekle.
- Hata mesajlarını *kurtarma talimatı* olarak standartlaştır (bir kısmı yapıldı):
  her ret mesajı "ne oldu → neden → şimdi ne yap" üçlüsünü içersin.
- Token disiplini: uzun listelerde sayfalama, özet-önce çıktı.
- `logging` yeteneği ile ayrıntıyı istemci loguna taşı (araç çıktısını şişirme).

## Q7 — Kullanıcı kendi kelepçesini yönetebilsin

Denetimde çıktı: hosted kullanıcı bütçe tavanını ve yazma iznini **değiştiremiyor**;
`store.updateSettings` yazılmış ama üretimde çağıran yok. README ise "kullanıcı
bazlıdır" diyor — bugün karşılıksız bir iddia.

- `/settings` sayfası (oturum çerezi ile, API anahtarı URL'e KOYMADAN).
- Kritik kural: **ajan kendi tavanını yükseltemez.** Okuma MCP'den (Q4 resource),
  yazma yalnız insan arayüzünden.

## Q8 — Davranış testleri (eval): ajan doğru olanı yapıyor mu?

Birim testi kodun doğruluğunu ölçer; MCP'de asıl soru **ajanın davranışı**.

- Senaryo seti: "şu siteye kampanya kur" → ajan onay almadan yayına aldı mı?
  bütçeyi tavana dayadı mı? ülke hedefi verdi mi? negatif kelime önerdi mi?
- Sahte context + kaydedilmiş ajan turlarıyla, API harcamadan çalıştırılabilir.
- **Kabul ölçütü:** Onaysız yayına alma senaryosu %0 başarı oranıyla geçmeli
  (yani ajan asla başaramamalı).

## Q9 — Dağıtım hazırlığı (Faz 3d ve sonrası için)

- `Dockerfile` + `systemd` unit + `nginx` örneği + `.nvmrc` (bugün hiçbiri yok).
- Sürüm/uyumluluk politikası: araç sözleşmesi değişimlerinde SemVer.
- Anthropic connectors dizini başvurusu için: İngilizce README, gizlilik
  metni, kurulum GIF'i.
- `npx adspilot-mcp` ile tek komut kurulum (bin alanı zaten hazır).

---

## Sıralama ve bağımlılıklar

```
Q2 (testler)  ──┬─► Q1 (elicitation)  ──┐
                └─► Q5 (structured)   ──┼─► Q6 (ergonomi) ─► Q8 (eval)
Q4 (resources) ─────────────────────────┘
Q3 (prompts)   ── bağımsız, her an yapılabilir
Q7 (ayarlar)   ── bağımsız
Q9 (deploy)    ── en son, Faz 3d ile birleşir
```

**Önerilen icra sırası:** Q2 → Q1 → Q3 → Q4 → Q5 → Q6 → Q7 → Q8 → Q9

Gerekçe: Önce güvenlik ağı (Q2), sonra güvenlik modelinin kendisi (Q1) —
elicitation'ı testsiz değiştirmek en riskli sıralama olurdu. Q3 erken gelir
çünkü kullanıcı değeri en yüksek/maliyeti en düşük madde odur.

## Kapsam dışı bıraktıklarım (bilinçli)

- **Sampling** (sunucunun istemciden LLM tamamlaması istemesi): reklam metnini
  zaten istemci modeli üretiyor; sunucuya taşımak mimariyi karmaşıklaştırır,
  değer katmaz.
- **Resource subscriptions / canlı akış:** Google Ads verisi saatlik tazelenir,
  abonelik maliyeti karşılığını vermez.
- **Çoklu platform (Meta/TikTok):** Faz 4 konusu; Google tarafı referans
  kalitesine ulaşmadan genişlemek kaliteyi seyreltir.
