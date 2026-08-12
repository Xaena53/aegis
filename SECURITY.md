# Güvenlik Politikası

AdsPilot, kullanıcıların Google Ads hesaplarına yazma erişimi olan ve **gerçek
para harcatabilen** bir MCP sunucusudur. Güvenlik bildirimlerini ciddiye alıyoruz.

## Açık bildirimi

Güvenlik açığını **herkese açık issue olarak açmayın.**

- GitHub **Security → Report a vulnerability** (private advisory) yolunu kullanın.
- Alternatif: depo sahibiyle GitHub üzerinden özel iletişime geçin.

Bildiriminizde şunlar yardımcı olur: etkilenen dosya/satır, somut bir yeniden
üretme adımı ve etkiyi anladığınız kadarıyla açıklama. İlk yanıtı makul sürede
vermeye çalışırız; düzeltme yayımlanana kadar ayrıntıyı gizli tutmanızı rica ederiz.

## Kapsam

Aşağıdakiler **açık** sayılır:

- Kiracı izolasyonunun kırılması (bir kullanıcının başkasının verisine/hesabına erişmesi)
- Kimlik doğrulama/yetkilendirme atlatma (bearer, oturum çerezi, OAuth akışı)
- **Onay kapılarının atlatılması** — insan onayı olmadan harcamayı artıran herhangi bir yol
- Güvenlik kelepçelerinin (bütçe tavanı, yazma izni) ajan tarafından gevşetilmesi
- Şifreli refresh token'ların ifşası
- Uzaktan kod çalıştırma, SSRF, servis dışı bırakma

Kapsam **dışı**: yalnız `.env`/master key'e zaten erişimi olan bir saldırganı
varsayan senaryolar; Google Ads API'nin kendi davranışları.

## Tasarım gereği güvenlik değişmezleri

Bir açık bildirirken bu değişmezlerden birini kırdığınızı gösterirseniz doğrudan
kabul edilir:

1. Kampanyalar **her zaman duraklatılmış** oluşturulur; hiçbir araç kendiliğinden
   harcama başlatmaz.
2. Yayına alma, bütçe **artışı** ve **yayındaki** kampanyaya reklam/pozitif kelime
   ekleme kullanıcının açık onayını gerektirir. Elicitation destekleyen istemcilerde
   onay doğrudan insandan alınır; ajanın `confirm` değeri dikkate alınmaz.
3. Belirsizlikte **kapalı arıza**: durum doğrulanamıyorsa onay istenir.
4. Bütçe tavanı ve yazma izni MCP üzerinden **yalnız okunur**; değişiklik yalnız
   insanın tarayıcı oturumundan yapılır (API anahtarı bu kapıyı açmaz).
5. `analyze_site` çıktısı güvenilmez dış içeriktir ve sınırlandırılmış bir blokta sunulur.

## Yamalar

Güvenlik düzeltmeleri `main` dalına uygulanır. Bu proje AGPL-3.0 lisanslıdır;
kendi kopyanızı çalıştırıyorsanız güncellemeleri takip etmek sizin sorumluluğunuzdadır.
