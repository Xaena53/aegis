# VPS dağıtımı — adım adım

Bu klasördeki dosyalar denetimde bulunan tuzakları önceden kapatır. Sırayı bozma.

## 0. Ön koşullar

| Gereksinim | Neden |
|---|---|
| **Node ≥ 22.13** | Hosted mod `node:sqlite` kullanır (Node 22.5'te geldi, 22.13'te bayraksız). Ubuntu/Debian'ın apt paketi 18/20'dir → `npm run serve` ilk import'ta çöker. |
| **Alan adı + TLS** | Bearer API anahtarları ve OAuth kodları düz HTTP'de taşınamaz. |
| **Google Ads Basic Access** | Test Access seviyesinde GERÇEK kullanıcı hesapları çalışmaz — hosted beta açılamaz. |

```bash
# Node 22.13 (nodesource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs && node -v   # v22.13+ olmalı
```

## 1. Kullanıcı ve dizin

```bash
sudo useradd --system --home /opt/adspilot --shell /usr/sbin/nologin adspilot
sudo mkdir -p /opt/adspilot/data
sudo chown -R adspilot:adspilot /opt/adspilot
```

## 2. Kodu kur

```bash
sudo -u adspilot git clone <repo> /opt/adspilot
cd /opt/adspilot
sudo -u adspilot npm ci
sudo -u adspilot npm run build
```

## 3. Yapılandırma (`.env`)

```bash
sudo -u adspilot cp .env.example .env
sudo -u adspilot node -e "console.log('ADSPILOT_MASTER_KEY='+require('crypto').randomBytes(32).toString('hex'))"
sudo nano /opt/adspilot/.env
sudo chmod 600 /opt/adspilot/.env      # master key burada
```

Zorunlu alanlar:

```ini
GOOGLE_ADS_DEVELOPER_TOKEN=...
GOOGLE_ADS_CLIENT_ID=...
GOOGLE_ADS_CLIENT_SECRET=...
ADSPILOT_MASTER_KEY=<64 hex>           # KAYBOLURSA tüm kullanıcı token'ları çözülemez
ADSPILOT_DB=/opt/adspilot/data/adspilot.db   # MUTLAK yol; BOŞ BIRAKMA
ADSPILOT_PUBLIC_URL=https://adspilot.ornek.com
ADSPILOT_ALLOWED_HOSTS=adspilot.ornek.com    # nginx arkasında ŞART
PORT=8787
```

> **Sessiz veri kaybı tuzağı:** `ADSPILOT_DB=` boş bırakılırsa SQLite *geçici*
> bir veritabanı açar — sunucu sorunsuz çalışır, kullanıcılar API anahtarı alır,
> ve her yeniden başlatmada tüm şifreli token'lar yok olur. Tek hata bile düşmez.
> Mutlak yol ver.

Sunucu eksik/geçersiz yapılandırmada **başlamaz** (fail-fast) — `/health` yeşil
yanıp seni yanıltmaz.

## 4. Google Cloud OAuth

Yetkili yönlendirme URI'sine **birebir** şunu ekle:

```
https://adspilot.ornek.com/oauth/callback
```

## 5. Servis

```bash
sudo cp deploy/adspilot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now adspilot
sudo systemctl status adspilot
journalctl -u adspilot -f
```

> **TEK INSTANCE.** Oturumlar ve hız sınırı sayaçları süreç belleğindedir.
> pm2 cluster / birden çok replika → `404 session_not_found` döngüsü ve
> hız sınırının worker sayısınca çarpılması. Ölçeklemek gerekirse önce
> oturum+sayaç durumu Redis'e taşınmalı.

## 6. nginx + TLS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/adspilot
# alan adını düzenle, sonra:
sudo ln -s /etc/nginx/sites-available/adspilot /etc/nginx/sites-enabled/
sudo certbot --nginx -d adspilot.ornek.com
sudo nginx -t && sudo systemctl reload nginx
```

> **`proxy_set_header Host $host;` satırını silme.** O olmadan upstream'e
> `Host: 127.0.0.1` gider, DNS rebinding koruması eşleşmez ve **tüm MCP
> trafiği 403 alır**. "Hiçbir şey çalışmıyor" şeklinde görünen, teşhisi zor
> bir arızadır.

## 7. Doğrulama

```bash
curl -s https://adspilot.ornek.com/health                     # {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://adspilot.ornek.com/mcp                      # 401 bekleniyor
```

Tarayıcıdan `https://adspilot.ornek.com/connect` → Google ile bağlan →
API anahtarını al → Claude Code'a ekle:

```bash
claude mcp add --transport http adspilot https://adspilot.ornek.com/mcp \
  --header "Authorization: Bearer ap_..."
```

## 8. Yedekleme

WAL modu üç dosya üretir; **üçünü birlikte** al (yalnız `.db` almak bozuk
yedek verir):

```bash
sudo -u adspilot sqlite3 /opt/adspilot/data/adspilot.db ".backup '/yedek/adspilot-$(date +%F).db'"
```

`ADSPILOT_MASTER_KEY`'i veritabanından **ayrı** bir yerde sakla: ikisi bir arada
çalınırsa şifreleme anlamsız kalır, anahtar kaybolursa yedek işe yaramaz.

## 9. Docker alternatifi

```bash
docker build -t adspilot .
docker run -d --name adspilot -p 127.0.0.1:8787:8787 \
  --env-file .env -v adspilot-data:/data --restart unless-stopped adspilot
```
