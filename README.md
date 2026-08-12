# AdsPilot — Google Ads MCP Sunucusu

> **Lisans: [AGPL-3.0](LICENSE)** · Copyright (C) 2026 AdsPilot katkıcıları
>
> Bu yazılımı kullanabilir, değiştirebilir ve dağıtabilirsin. **Ancak** değiştirilmiş
> bir sürümünü ağ üzerinden servis olarak sunuyorsan (AGPL §13), o servisin
> kullanıcılarına kaynak kodu sunmakla yükümlüsün. Bu yükümlülük bu projenin
> kendi hosted sürümü için de geçerlidir: `/source` adresi ve her sayfanın
> altbilgisi kaynağa bağlantı verir.


Claude'u (veya herhangi bir MCP istemcisini) Google Ads hesabına bağlar: raporlama **ve** güvenlik kapılı kampanya yönetimi. Google'ın resmi MCP'sinden farkı: **yazma erişimi** var (kampanya oluşturma, bütçe, anahtar kelime, RSA reklam), ama her tehlikeli adım korumalı:

- Kampanyalar **her zaman PAUSED** oluşturulur — asla doğrudan yayına çıkmaz.
- Ülke hedefleme **zorunlu** (`countryCodes`) — dünya-geneli kazara yayın engellenir.
- Paylaşımlı bütçeye dokunulmaz (çok kampanyayı birden etkileme koruması).
- Yayına alma (`ENABLED`) açık kullanıcı onayı ister (`confirm=true` kapısı).
- Günlük bütçe tavanı: `ADSPILOT_MAX_DAILY_BUDGET` üzerindeki istekler reddedilir.
- Tüm yazma araçları `ADSPILOT_WRITE_ENABLED=0` ile toptan kapatılabilir.

## Araçlar

| Araç | Tür | Ne yapar |
|---|---|---|
| `analyze_site` | okuma | **"Siteni bağla":** URL → başlık/meta/H1-H3/JSON-LD/menü/metin çıkarımı → kelime+RSA üretimi için hammadde (kimlik bilgisi gerektirmez, SSRF korumalı) |
| `list_accounts` | okuma | Erişilebilir müşteri hesaplarını listeler |
| `campaign_performance` | okuma | Son N gün kampanya özeti (maliyet, tıklama, dönüşüm, CTR) |
| `keyword_performance` | okuma | Anahtar kelime bazlı performans |
| `search_terms_report` | okuma | Gerçek arama terimleri + boşa-harcama işaretleme (negatif önerisi akışı) |
| `run_gaql` | okuma | Ham GAQL sorgusu |
| `create_search_campaign` | yazma | Bütçe + kampanya (PAUSED) + ülke hedefleme (zorunlu) + reklam grubu + kelimeler |
| `create_responsive_search_ad` | yazma | Reklam grubuna RSA ekler |
| `add_keywords` | yazma | Anahtar kelime / negatif kelime ekler (reklam grubu) |
| `add_campaign_negative_keywords` | yazma | Kampanya seviyesi negatif kelime (tüm reklam gruplarını kapsar) |
| `update_campaign_budget` | yazma | Günlük bütçe günceller (tavan kelepçeli) |
| `set_campaign_status` | yazma | Yayına al / duraklat (ENABLED onay kapılı) |

## Kurulum

```bash
npm install
npm run build
npm test        # birim testleri (saf yardımcılar: guard'lar, retry, tarih aralığı)
```

**Node 22.13+ gerekir** (hosted mod `node:sqlite` kullanır; Node 18/20'de `npm run serve` ilk import'ta çöker).

Geçici API hataları (UNAVAILABLE, kota) okuma yollarında üstel geri çekilmeyle
otomatik tekrar denenir. **Mutasyonlar ağ hatalarında retry EDİLMEZ** (çift kayıt
riski); tek istisna `CONCURRENT_MODIFICATION` — Google bu hatada isteği açıkça
reddeder, yazma uygulanmamıştır, bu yüzden güvenle tekrar denenir.

### 1. Faz 0 — Google tarafı (bir kere yapılır)

1. **MCC (yönetici) hesabı aç:** https://ads.google.com/home/tools/manager-accounts/ — developer token yalnızca MCC'den alınır.
2. **Developer token al:** MCC > Tools & Settings > API Center. Başlangıçta **Test Access** verilir (sadece test hesaplarında çalışır). Gerçek hesaplar için **Basic Access** başvurusu yap (aynı ekrandan; kullanım amacını dürüst yaz: "kendi hesaplarımın raporlama ve yönetimi"). Onay genelde birkaç gün sürer.
3. **Google Cloud projesi:** https://console.cloud.google.com → yeni proje → "Google Ads API"yi etkinleştir.
4. **OAuth istemcisi:** APIs & Services > Credentials > Create Credentials > OAuth client ID > **Desktop app**. Client ID + Secret'ı al. (Consent screen'de test kullanıcısı olarak kendi Gmail'ini ekle.)
5. `.env.example` → `.env` kopyala, değerleri doldur.
6. **Refresh token üret:** `npm run auth` → tarayıcıda izin ver → çıkan satırı `.env`'e yapıştır.

### 2. Claude Code'a bağla

```bash
claude mcp add adspilot -- node C:/AdsPilot/dist/index.js
```

veya proje kökündeki `.mcp.json` zaten kayıtlı — `C:\AdsPilot` içinde çalışırken otomatik yüklenir.

## İki çalışma modu

**1. Yerel (stdio)** — tek kullanıcı, kimlik `.env`'den:
```bash
claude mcp add adspilot -- node C:/AdsPilot/dist/index.js
```

**2. Hosted (HTTP)** — çok kullanıcılı, her kullanıcı kendi Google hesabını bağlar:
```bash
# .env'e ADSPILOT_MASTER_KEY ve ADSPILOT_PUBLIC_URL ekle, sonra:
npm run serve
```
Kullanıcı `<PUBLIC_URL>/connect` sayfasından Google ile bağlanır → kendisine bir API
anahtarı verilir → onunla bağlanır:
```bash
claude mcp add --transport http adspilot <PUBLIC_URL>/mcp \
  --header "Authorization: Bearer ap_..."
```

Adım adım VPS kurulumu için: **[deploy/README.md](deploy/README.md)**
(systemd unit, nginx örneği ve Dockerfile `deploy/` altında hazır).

### VPS dağıtımında ZORUNLU adımlar

1. **Node 22.13+** kur (apt'ın 18/20 sürümü `node:sqlite` yokluğundan çöker).
2. **TEK instance** çalıştır. Oturumlar ve hız sınırı sayaçları süreç belleğindedir;
   pm2 cluster / birden çok worker → istek başka worker'a düşer, `404 session_not_found`
   döngüsü başlar ve hız sınırı worker sayısınca çarpılır.
3. **`ADSPILOT_ALLOWED_HOSTS`** ayarla ve nginx'te `proxy_set_header Host $host;`
   satırını UNUTMA — aksi halde upstream'e `Host: 127.0.0.1` gider, DNS rebinding
   koruması eşleşmez ve **tüm MCP trafiği 403 alır** (teşhisi zor bir arıza).
4. **`ADSPILOT_DB`'ye mutlak yol ver.** Boş bırakılırsa geçici bir veritabanı
   açılır ve her yeniden başlatmada tüm kullanıcı token'ları kaybolur.
5. `chmod 600 .env adspilot.db*` — master key ve şifreli token'lar taşırlar.
   WAL modunda `.db-wal`/`.db-shm` yan dosyaları da yedeklenmelidir.
6. TLS zorunlu; `ADSPILOT_PUBLIC_URL` https:// olmalı (bearer anahtarları ve
   OAuth kodları düz HTTP'de taşınamaz).

Hosted modda **her oturum tek kullanıcıya bağlıdır**: refresh token'lar AES-256-GCM
ile şifreli saklanır, API anahtarları yalnız hash olarak tutulur, başka kullanıcının
oturum kimliğiyle gelen istek `403 session_owner_mismatch` ile reddedilir, bütçe
tavanı ve yazma izni kullanıcı bazlıdır.

## Güvenlik modeli

Yazma zinciri her zaman şu sırayla ilerler:

```
taslak oluştur (PAUSED) → reklam metni ekle → kullanıcıya özet göster → açık onay → ENABLED
```

Ajan `set_campaign_status(status=ENABLED)` çağrısını `confirm=true` olmadan yapamaz; araç reddeder ve önce kullanıcıya bütçe/kelime/metin özetini göstermesini söyler.

## "Siteni bağla" akışı (Faz 2)

```
analyze_site(url) → Claude ürün/hizmeti anlar → kelime + RSA metni üretir
  → kullanıcı onayı → create_search_campaign (PAUSED) → create_responsive_search_ad
  → son onay → set_campaign_status(ENABLED)
```

Tasarım ilkesi: MCP sunucusu *gerçek çıkarır*, yaratıcı işi (kelime seçimi, metin yazımı)
istemci taraftaki model yapar — böylece sunucu deterministik ve test edilebilir kalır.

## Yol haritası

- **Faz 3 — Hosted:** remote MCP (OAuth ile tek tık bağlantı), abonelik, Anthropic connectors dizini, Meta/TikTok genişlemesi.
