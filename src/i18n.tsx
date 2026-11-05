import { createContext, Fragment, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Languages } from "lucide-react";

export type Lang = "en" | "tr" | "ru" | "zh";
export const LANGS: { id: Lang; label: string; locale: string }[] = [
  { id: "en", label: "English", locale: "en-US" },
  { id: "tr", label: "Türkçe", locale: "tr-TR" },
  { id: "ru", label: "Русский", locale: "ru-RU" },
  { id: "zh", label: "中文", locale: "zh-CN" },
];
const IDX: Record<Lang, number> = { en: 0, tr: 1, ru: 2, zh: 3 };

// Every entry is [English, Türkçe, Русский, 中文]; a missing language is a type error.
// Placeholders: {name} for UI strings, {0} {1}... for backend messages ("err.*").
const S = {
  // ---------- common ----------
  "common.cancel": ["Cancel", "Vazgeç", "Отмена", "取消"],
  "common.save": ["Save", "Kaydet", "Сохранить", "保存"],
  "common.delete": ["Delete", "Sil", "Удалить", "删除"],
  "common.edit": ["Edit", "Düzenle", "Изменить", "编辑"],
  "common.ok": ["OK", "Tamam", "ОК", "确定"],
  "common.search": ["Search...", "Ara...", "Поиск...", "搜索…"],
  "common.name": ["Name", "Ad", "Имя", "名称"],
  "common.group": ["Group", "Grup", "Группа", "分组"],
  "common.port": ["Port", "Port", "Порт", "端口"],
  "common.user": ["User", "Kullanıcı", "Пользователь", "用户"],
  "common.server": ["Server", "Sunucu", "Сервер", "服务器"],
  "common.key": ["Key", "Anahtar", "Ключ", "密钥"],
  "common.password": ["Password", "Şifre", "Пароль", "密码"],
  "common.notes": ["Notes", "Notlar", "Заметки", "备注"],
  "common.test": ["Test", "Test", "Проверить", "测试"],
  "common.refresh": ["Refresh", "Yenile", "Обновить", "刷新"],
  "common.general": ["General", "Genel", "Общее", "常规"],
  "common.import": ["Import", "İçe aktar", "Импорт", "导入"],
  "common.generate": ["Generate", "Üret", "Создать", "生成"],
  "common.choose": ["— choose —", "— seç —", "— выберите —", "— 请选择 —"],
  "common.cancelled": ["Cancelled", "İptal edildi", "Отменено", "已取消"],
  "common.deleteConfirm": ["Delete “{name}”?", "“{name}” silinsin mi?", "Удалить «{name}»?", "删除“{name}”？"],
  "common.untitled": ["Untitled", "Başlıksız", "Без названия", "无标题"],
  "common.saved": ["Saved", "Kaydedildi", "Сохранено", "已保存"],

  // ---------- shell ----------
  "nav.hosts": ["Servers", "Sunucular", "Серверы", "服务器"],
  "nav.tunnels": ["Tunnels", "Tüneller", "Туннели", "隧道"],
  "nav.keys": ["Keys", "Anahtarlar", "Ключи", "密钥"],
  "nav.secrets": ["Passwords", "Şifreler", "Пароли", "密码"],
  "nav.notes": ["Notes", "Notlar", "Заметки", "笔记"],
  "nav.git": ["Git", "Git", "Git", "Git"],
  "nav.terminals": ["Terminals", "Terminaller", "Терминалы", "终端"],
  "nav.settings": ["Settings", "Ayarlar", "Настройки", "设置"],
  "app.unlocked": ["● unlocked", "● kilit açık", "● разблокировано", "● 已解锁"],
  "app.lock": ["Lock", "Kilitle", "Заблокировать", "锁定"],
  "app.autoLockIn": ["Locks after {n} min of inactivity", "{n} dk hareketsizlikte kilitlenir", "Блокировка через {n} мин бездействия", "闲置 {n} 分钟后锁定"],
  "app.noTerminals": ["No open terminals", "Açık terminal yok", "Нет открытых терминалов", "没有打开的终端"],
  "app.noTerminalsHint": ["Press “Connect” on the Servers page.", "Sunucular sayfasından “Bağlan”a bas.", "Нажмите «Подключиться» на странице «Серверы».", "在“服务器”页面点击“连接”。"],
  "tray.show": ["Show", "Göster", "Показать", "显示"],
  "tray.lock": ["Lock", "Kilitle", "Заблокировать", "锁定"],
  "tray.quit": ["Quit", "Çıkış", "Выход", "退出"],

  "trust.mismatchTitle": ["⚠ Server key has CHANGED", "⚠ Sunucu anahtarı DEĞİŞMİŞ", "⚠ Ключ сервера ИЗМЕНИЛСЯ", "⚠ 服务器密钥已更改"],
  "trust.firstTitle": ["First connection to this server", "Sunucuya ilk bağlantı", "Первое подключение к серверу", "首次连接此服务器"],
  "trust.mismatchOk": ["Trust anyway", "Yine de güven", "Всё равно доверять", "仍然信任"],
  "trust.firstOk": ["Trust and connect", "Güven ve bağlan", "Доверять и подключиться", "信任并连接"],
  "trust.mismatchBody": [
    "The server's host key differs from the saved one. If you did not reinstall the server, this could be a man-in-the-middle (MITM) attack!",
    "Sunucunun host key'i kayıtlı olandan farklı. Sunucuyu yeniden kurmadıysan bu bir ortadaki adam (MITM) saldırısı olabilir!",
    "Ключ сервера отличается от сохранённого. Если вы не переустанавливали сервер, это может быть атака «человек посередине» (MITM)!",
    "服务器的主机密钥与已保存的不同。如果你没有重装服务器，这可能是中间人（MITM）攻击！",
  ],
  "trust.firstBody": [
    "This server's identity has not been verified yet. Compare the fingerprint with the one on the server:",
    "Bu sunucunun kimliği henüz doğrulanmadı. Parmak izini sunucudaki ile karşılaştır:",
    "Подлинность сервера ещё не подтверждена. Сравните отпечаток с отпечатком на сервере:",
    "尚未验证此服务器的身份。请将指纹与服务器上的指纹进行比对：",
  ],
  "trust.onServer": ["On the server:", "Sunucuda:", "На сервере:", "在服务器上："],

  "agent.title": ["SSH key use request", "SSH anahtarı kullanım isteği", "Запрос на использование SSH-ключа", "SSH 密钥使用请求"],
  "agent.body": [
    "A program wants to sign in with the {key} key (git, ssh, VS Code...).",
    "Bir program {key} anahtarıyla oturum açmak istiyor (git, ssh, VS Code...).",
    "Программа хочет войти с ключом {key} (git, ssh, VS Code...).",
    "有程序想使用密钥 {key} 登录（git、ssh、VS Code…）。",
  ],
  "agent.bodyUser": [
    "A program wants to sign in as {user} with the {key} key (git, ssh, VS Code...).",
    "Bir program {key} anahtarıyla {user} kullanıcısı olarak oturum açmak istiyor (git, ssh, VS Code...).",
    "Программа хочет войти как {user} с ключом {key} (git, ssh, VS Code...).",
    "有程序想使用密钥 {key} 以 {user} 身份登录（git、ssh、VS Code…）。",
  ],
  "agent.hint": [
    "If you didn't start this, deny it. If you allow it, this key won't ask again for 5 minutes.",
    "Bunu sen başlatmadıysan reddet. İzin verirsen bu anahtar 5 dakika boyunca tekrar sormaz.",
    "Если это не вы, отклоните. После разрешения ключ не будет спрашивать 5 минут.",
    "如果不是你发起的，请拒绝。允许后，此密钥 5 分钟内不再询问。",
  ],
  "agent.deny": ["Deny", "Reddet", "Отклонить", "拒绝"],
  "agent.allow": ["Allow", "İzin ver", "Разрешить", "允许"],

  // ---------- lock screen ----------
  "lock.unlockSub": ["Enter your master password to open the vault", "Kasayı açmak için master şifreni gir", "Введите мастер-пароль, чтобы открыть хранилище", "输入主密码以打开保险库"],
  "lock.createSub": ["Create a new vault — this password cannot be recovered", "Yeni kasa oluştur — bu şifre kurtarılamaz", "Создайте хранилище — этот пароль нельзя восстановить", "创建新保险库 — 此密码无法找回"],
  "lock.master": ["Master password", "Master şifre", "Мастер-пароль", "主密码"],
  "lock.masterRepeat": ["Master password (again)", "Master şifre (tekrar)", "Мастер-пароль (ещё раз)", "再次输入主密码"],
  "lock.mismatch": ["Passwords do not match", "Şifreler eşleşmiyor", "Пароли не совпадают", "两次输入的密码不一致"],
  "lock.unlock": ["Unlock", "Kilidi aç", "Разблокировать", "解锁"],
  "lock.create": ["Create vault", "Kasayı oluştur", "Создать хранилище", "创建保险库"],
  "lock.footer": [
    "Argon2id + AES-256-GCM · your data stays on this device, encrypted",
    "Argon2id + AES-256-GCM · veriler yalnızca bu cihazda, şifreli olarak saklanır",
    "Argon2id + AES-256-GCM · данные хранятся только на этом устройстве в зашифрованном виде",
    "Argon2id + AES-256-GCM · 数据仅以加密形式保存在本设备上",
  ],

  // ---------- terminal ----------
  "term.connecting": ["Connecting: {name} ...", "Bağlanılıyor: {name} ...", "Подключение: {name} ...", "正在连接：{name} ..."],
  "term.closed": ["[connection closed]", "[bağlantı kapandı]", "[соединение закрыто]", "[连接已关闭]"],

  // ---------- servers ----------
  "hosts.sub": ["Open an SSH terminal in one click", "Tek tıkla SSH terminali aç", "SSH-терминал в один клик", "一键打开 SSH 终端"],
  "hosts.import": ["Import ssh config", "ssh config'den al", "Импорт ssh config", "导入 ssh config"],
  "hosts.importTitle": [
    "Import Host entries from ~/.ssh/config together with their keys",
    "~/.ssh/config içindeki Host kayıtlarını anahtarlarıyla birlikte al",
    "Импортировать записи Host из ~/.ssh/config вместе с ключами",
    "从 ~/.ssh/config 导入 Host 条目及其密钥",
  ],
  "hosts.new": ["New server", "Yeni sunucu", "Новый сервер", "新建服务器"],
  "hosts.empty": ["No servers yet", "Henüz sunucu yok", "Серверов пока нет", "还没有服务器"],
  "hosts.emptyText": [
    "Add a server, pick a key or password and connect in one click.",
    "Sunucu ekle, bir anahtar ya da şifre seç ve tek tıkla bağlan.",
    "Добавьте сервер, выберите ключ или пароль и подключайтесь в один клик.",
    "添加服务器，选择密钥或密码，一键连接。",
  ],
  "hosts.add": ["Add server", "Sunucu ekle", "Добавить сервер", "添加服务器"],
  "hosts.testOk": ["connection successful", "bağlantı başarılı", "подключение успешно", "连接成功"],
  "hosts.deleteTitle": ["Delete server", "Sunucuyu sil", "Удалить сервер", "删除服务器"],
  "hosts.noKey": ["no key", "anahtar yok", "нет ключа", "无密钥"],
  "hosts.passwordAuth": ["password", "şifre", "пароль", "密码"],
  "hosts.unverified": ["unverified", "doğrulanmadı", "не проверен", "未验证"],
  "hosts.connect": ["Connect", "Bağlan", "Подключиться", "连接"],
  "hosts.installKey": ["Upload key to server", "Anahtarı sunucuya yükle", "Загрузить ключ на сервер", "上传密钥到服务器"],
  "hostForm.edit": ["Edit server", "Sunucuyu düzenle", "Изменить сервер", "编辑服务器"],
  "hostForm.saved": ["Server saved", "Sunucu kaydedildi", "Сервер сохранён", "服务器已保存"],
  "hostForm.groupPh": ["Production", "Üretim", "Продакшн", "生产"],
  "hostForm.address": ["Address (IP / domain)", "Adres (IP / alan adı)", "Адрес (IP / домен)", "地址（IP / 域名）"],
  "hostForm.auth": ["Authentication", "Kimlik doğrulama", "Аутентификация", "身份验证"],
  "hostForm.sshKey": ["SSH key", "SSH anahtarı", "SSH-ключ", "SSH 密钥"],
  "hostForm.addKeyFirst": ["Add a key on the Keys page first", "Önce Anahtarlar sekmesinden bir anahtar ekle", "Сначала добавьте ключ на странице «Ключи»", "请先在“密钥”页面添加密钥"],
  "hostForm.keepPassword": ["Leave empty to keep the saved password", "Boş bırakırsan kayıtlı şifre korunur", "Оставьте пустым, чтобы сохранить текущий пароль", "留空则保留已保存的密码"],
  "install.done": ["Public key added to authorized_keys", "Public key authorized_keys dosyasına eklendi", "Открытый ключ добавлен в authorized_keys", "公钥已添加到 authorized_keys"],
  "install.title": ["Upload key → {name}", "Anahtarı yükle → {name}", "Загрузить ключ → {name}", "上传密钥 → {name}"],
  "install.body": [
    "The public half of the selected key is appended to {file} on the server (like ssh-copy-id), using the server's current authentication.",
    "Seçilen anahtarın public kısmı sunucudaki {file} dosyasına eklenir (ssh-copy-id gibi). Bağlantı için sunucunun mevcut kimlik doğrulaması kullanılır.",
    "Открытая часть выбранного ключа добавляется в {file} на сервере (как ssh-copy-id) с текущей аутентификацией сервера.",
    "所选密钥的公钥部分将追加到服务器上的 {file}（类似 ssh-copy-id），连接时使用服务器当前的认证方式。",
  ],
  "install.upload": ["Upload", "Yükle", "Загрузить", "上传"],

  // ---------- tunnels ----------
  "tunnels.sub": ["Bring server ports to your computer (ssh -L)", "Sunucudaki portları bilgisayarına getir (ssh -L)", "Порты сервера на вашем компьютере (ssh -L)", "将服务器端口转发到本机（ssh -L）"],
  "tunnels.new": ["New tunnel", "Yeni tünel", "Новый туннель", "新建隧道"],
  "tunnels.empty": ["No tunnels yet", "Henüz tünel yok", "Туннелей пока нет", "还没有隧道"],
  "tunnels.emptyText": [
    "For example, map the server's port 9090 to localhost:9090.",
    "Örneğin sunucudaki 9090 portunu localhost:9090'a bağla.",
    "Например, пробросьте порт 9090 сервера на localhost:9090.",
    "例如，把服务器的 9090 端口映射到 localhost:9090。",
  ],
  "tunnels.addHostFirst": ["Add a server first.", "Önce bir sunucu ekle.", "Сначала добавьте сервер.", "请先添加服务器。"],
  "tunnels.add": ["Add tunnel", "Tünel ekle", "Добавить туннель", "添加隧道"],
  "tunnels.deleteTitle": ["Delete tunnel", "Tüneli sil", "Удалить туннель", "删除隧道"],
  "tunnels.active": ["active · {n} {n:connection|connections}", "aktif · {n} bağlantı", "активен · подключений: {n}", "运行中 · {n} 个连接"],
  "tunnels.auto": ["auto", "otomatik", "авто", "自动"],
  "tunnels.openBrowser": ["Open in browser", "Tarayıcıda aç", "Открыть в браузере", "在浏览器中打开"],
  "tf.edit": ["Edit tunnel", "Tüneli düzenle", "Изменить туннель", "编辑隧道"],
  "tf.opened": ["Tunnel open: localhost:{port}", "Tünel açık: localhost:{port}", "Туннель открыт: localhost:{port}", "隧道已开启：localhost:{port}"],
  "tf.tabPorts": ["Server ports", "Sunucudaki portlar", "Порты сервера", "服务器端口"],
  "tf.tabInner": ["Internal network", "İç ağ", "Внутренняя сеть", "内部网络"],
  "tf.searchPh": ["port, service...", "port, servis...", "порт, сервис...", "端口、服务…"],
  "tf.scanFailed": ["Could not read ports:", "Portlar alınamadı:", "Не удалось получить порты:", "无法读取端口："],
  "tf.manualHint": ["You can also enter the target manually on the right.", "Hedefi sağdan elle de girebilirsin.", "Цель можно ввести вручную справа.", "也可以在右侧手动输入目标。"],
  "tf.scanning": ["Connecting to the server, reading listening ports…", "Sunucuya bağlanılıyor, dinlenen portlar okunuyor…", "Подключение к серверу, чтение открытых портов…", "正在连接服务器并读取监听端口…"],
  "tf.pickHost": ["Select a server", "Bir sunucu seç", "Выберите сервер", "请选择服务器"],
  "tf.limited": [
    "Connected as a non-root user; some service names may be missing.",
    "Root olmayan kullanıcıyla bağlanıldı; bazı servis adları görünmeyebilir.",
    "Подключение без root: некоторые имена сервисов могут не отображаться.",
    "以非 root 用户连接，部分服务名称可能无法显示。",
  ],
  "tf.namePh": ["Pick from the list or type", "Listeden seç ya da yaz", "Выберите из списка или введите", "从列表选择或手动输入"],
  "tf.remote": ["Target on the server", "Sunucu tarafında hedef", "Цель на сервере", "服务器端目标"],
  "tf.address": ["Address", "Adres", "Адрес", "地址"],
  "tf.addressHint": ["The server itself: 127.0.0.1", "Sunucunun kendisi: 127.0.0.1", "Сам сервер: 127.0.0.1", "服务器本机：127.0.0.1"],
  "tf.probe": ["Test reachability", "Erişimi dene", "Проверить доступ", "测试连通性"],
  "tf.probeOk": ["The server can reach this target", "Sunucu bu hedefe ulaşabiliyor", "Сервер может достучаться до цели", "服务器可以访问此目标"],
  "tf.local": ["This computer", "Bu bilgisayar", "Этот компьютер", "本机"],
  "tf.bind": ["Listen address", "Dinlenecek adres", "Адрес прослушивания", "监听地址"],
  "tf.bindHint": ["127.0.0.1 = this PC only", "127.0.0.1 = sadece bu PC", "127.0.0.1 = только этот ПК", "127.0.0.1 = 仅本机"],
  "tf.localPort": ["Local port", "Yerel port", "Локальный порт", "本地端口"],
  "tf.free": ["{port} is free", "{port} boş", "{port} свободен", "{port} 可用"],
  "tf.usedBy": ["The “{name}” tunnel uses this port", "“{name}” tüneli bu portu kullanıyor", "Этот порт занят туннелем «{name}»", "隧道“{name}”正在使用此端口"],
  "tf.busy": ["{port} is in use on this PC", "{port} bu PC'de dolu", "{port} занят на этом ПК", "{port} 在本机已被占用"],
  "tf.useSuggest": ["use {port}", "{port} kullan", "использовать {port}", "使用 {port}"],
  "tf.autoStart": ["Start automatically when the vault unlocks", "Kasa açılınca otomatik başlat", "Запускать при разблокировке хранилища", "保险库解锁时自动启动"],
  "tf.autoStartHint": ["The tunnel is ready the moment you unlock", "Kilidi açtığın an tünel hazır olur", "Туннель готов сразу после разблокировки", "解锁后隧道立即可用"],
  "tf.saveStart": ["Save and start", "Kaydet ve başlat", "Сохранить и запустить", "保存并启动"],
  "pl.noMatch": ["No matching ports", "Eşleşen port yok", "Нет подходящих портов", "没有匹配的端口"],
  "pl.unknown": ["unknown", "bilinmiyor", "неизвестно", "未知"],
  "pl.tunneled": ["tunnel exists", "tünel var", "туннель есть", "已有隧道"],
  "pl.public": ["public", "dışa açık", "открыт наружу", "对外开放"],
  "pl.publicTitle": [
    "Listening on all interfaces (a firewall may still restrict it)",
    "Tüm arayüzlerde dinliyor (güvenlik duvarı ayrıca kısıtlayabilir)",
    "Слушает на всех интерфейсах (файрвол всё ещё может ограничивать)",
    "在所有网卡上监听（防火墙仍可能限制访问）",
  ],
  "pl.local": ["server only", "sunucu içi", "только сервер", "仅服务器内"],
  "pl.localTitle": ["Only reachable from inside the server", "Yalnızca sunucunun içinden erişilebilir", "Доступен только изнутри сервера", "只能从服务器内部访问"],
  "inner.noMatch": ["No matching containers", "Eşleşen konteyner yok", "Нет подходящих контейнеров", "没有匹配的容器"],
  "inner.none": ["No Docker / Incus containers found", "Docker / Incus konteyneri bulunamadı", "Контейнеры Docker / Incus не найдены", "未找到 Docker / Incus 容器"],
  "inner.hint": [
    "Tunnels go to the container's internal IP, so unpublished ports work too. If a port isn't listed, pick the IP and type the port on the right.",
    "Konteynerin iç IP'sine tünel açılır; yayınlanmamış portlara da erişilir. Port listede yoksa IP'yi seçip portu sağdan yaz.",
    "Туннель идёт на внутренний IP контейнера, поэтому доступны и неопубликованные порты. Если порта нет в списке, выберите IP и введите порт справа.",
    "隧道直接连到容器的内部 IP，因此未发布的端口也能访问。若端口不在列表中，请选择 IP 并在右侧输入端口。",
  ],
  "inner.useIp": ["Use this IP as the target", "Bu IP'yi hedef yap", "Сделать этот IP целью", "将此 IP 设为目标"],

  // ---------- ssh config import ----------
  "imp.title": ["Import from ~/.ssh/config", "~/.ssh/config'den içe aktar", "Импорт из ~/.ssh/config", "从 ~/.ssh/config 导入"],
  "imp.done": ["Imported {h} {h:server|servers}, {k} {k:key|keys}, {t} {t:tunnel|tunnels}", "{h} sunucu, {k} anahtar, {t} tünel içe aktarıldı", "Импортировано: серверов {h}, ключей {k}, туннелей {t}", "已导入 {h} 台服务器、{k} 个密钥、{t} 个隧道"],
  "imp.reading": ["Reading…", "Okunuyor…", "Чтение…", "正在读取…"],
  "imp.none": ["No Host entries to import in {path}.", "{path} içinde içe aktarılacak Host kaydı yok.", "В {path} нет записей Host для импорта.", "{path} 中没有可导入的 Host 条目。"],
  "imp.desc": [
    "The IdentityFile key of each selected entry is copied into the vault and LocalForward lines become tunnels. The files stay on disk; you can delete them afterwards.",
    "Seçilen kayıtların IdentityFile anahtarı kasaya kopyalanır, LocalForward satırları tünel olur. Dosyalar diskte kalır; istersen sonra silebilirsin.",
    "Ключ IdentityFile каждой выбранной записи копируется в хранилище, строки LocalForward становятся туннелями. Файлы остаются на диске, их можно удалить позже.",
    "所选条目的 IdentityFile 密钥会复制到保险库，LocalForward 行会变成隧道。文件仍保留在磁盘上，之后可以删除。",
  ],
  "imp.inVault": ["already in vault", "zaten kasada", "уже в хранилище", "已在保险库中"],
  "imp.proxyJump": ["ProxyJump not supported", "ProxyJump desteklenmiyor", "ProxyJump не поддерживается", "不支持 ProxyJump"],
  "imp.gitHost": ["git host — the Git page fits better", "git sunucusu — Git sayfası daha uygun", "git-хост — лучше страница Git", "git 主机 — 更适合在 Git 页面添加"],
  "imp.tunnels": ["{n} {n:tunnel|tunnels}", "{n} tünel", "туннелей: {n}", "{n} 个隧道"],
  "imp.importN": ["Import {n} {n:entry|entries}", "{n} kaydı içe aktar", "Импортировать ({n})", "导入 {n} 项"],
  "imp.keyInVault": ["{file} (in vault)", "{file} (kasada)", "{file} (в хранилище)", "{file}（已在保险库）"],
  "imp.keyLocked": [
    "⚠ {file} unreadable (may have a passphrase) — added with password login",
    "⚠ {file} okunamadı (parolalı olabilir) — şifreyle eklenir",
    "⚠ {file} не читается (возможно, с паролем) — будет добавлен вход по паролю",
    "⚠ 无法读取 {file}（可能有口令）— 将以密码登录方式添加",
  ],
  "imp.keyMissing": ["⚠ key file missing — added with password login", "⚠ anahtar dosyası yok — şifreyle eklenir", "⚠ файл ключа не найден — будет добавлен вход по паролю", "⚠ 密钥文件不存在 — 将以密码登录方式添加"],
  "imp.keyNone": ["no key — added with password login", "anahtar yok — şifreyle eklenir", "нет ключа — будет добавлен вход по паролю", "无密钥 — 将以密码登录方式添加"],

  // ---------- keys ----------
  "keys.sub": [
    "Private keys stay in the encrypted vault; the UI only sees the public half",
    "Private key'ler şifreli kasada; arayüz yalnızca public kısmı görür",
    "Закрытые ключи хранятся в зашифрованном хранилище; интерфейс видит только открытую часть",
    "私钥保存在加密保险库中，界面只能看到公钥",
  ],
  "keys.generate": ["Generate new", "Yeni üret", "Создать новый", "生成新密钥"],
  "keys.empty": ["No keys yet", "Henüz anahtar yok", "Ключей пока нет", "还没有密钥"],
  "keys.emptyText": [
    "Import your existing id_ed25519 / .pem / .ppk file or generate a new Ed25519 key.",
    "Mevcut id_ed25519 / .pem / .ppk dosyanı içe aktar ya da yeni bir Ed25519 anahtar üret.",
    "Импортируйте существующий файл id_ed25519 / .pem / .ppk или создайте новый ключ Ed25519.",
    "导入已有的 id_ed25519 / .pem / .ppk 文件，或生成新的 Ed25519 密钥。",
  ],
  "keys.copied": ["Public key copied to clipboard", "Public key panoya kopyalandı", "Открытый ключ скопирован", "公钥已复制到剪贴板"],
  "keys.deleteTitle": ["Delete key", "Anahtarı sil", "Удалить ключ", "删除密钥"],
  "keys.deleteBody": [
    "Permanently delete “{name}”? Without a backup it cannot be recovered.",
    "“{name}” kalıcı olarak silinsin mi? Yedeğin yoksa geri getirilemez.",
    "Удалить «{name}» навсегда? Без резервной копии восстановить нельзя.",
    "永久删除“{name}”？如果没有备份将无法恢复。",
  ],
  "keys.usedOn": ["used on {n} {n:server|servers}", "{n} sunucuda kullanılıyor", "используется на серверах: {n}", "用于 {n} 台服务器"],
  "keys.withPassphrase": ["passphrase", "parolalı", "с паролем", "有口令"],
  "keys.publicKey": ["Public key", "Public key", "Открытый ключ", "公钥"],
  "keys.agentTitle": ["git / ssh can use this key through the agent", "git / ssh bu anahtarı agent üzerinden kullanabilir", "git / ssh могут использовать ключ через агент", "git / ssh 可通过 agent 使用此密钥"],
  "keys.rename": ["Rename", "Yeniden adlandır", "Переименовать", "重命名"],
  "keys.newName": ["New name", "Yeni ad", "Новое имя", "新名称"],
  "importKey.title": ["Import key", "Anahtar içe aktar", "Импорт ключа", "导入密钥"],
  "importKey.pick": ["Choose private key", "Private key seç", "Выберите закрытый ключ", "选择私钥"],
  "importKey.added": ["Key added to the vault", "Anahtar kasaya eklendi", "Ключ добавлен в хранилище", "密钥已添加到保险库"],
  "importKey.fromFile": ["From file", "Dosyadan", "Из файла", "从文件"],
  "importKey.fromFileHint": [
    "OpenSSH, PEM (RSA/EC) and PuTTY .ppk are supported. The file is read by the Rust side and never reaches the UI.",
    "OpenSSH, PEM (RSA/EC) ve PuTTY .ppk desteklenir. Dosyayı Rust tarafı okur, arayüze gelmez.",
    "Поддерживаются OpenSSH, PEM (RSA/EC) и PuTTY .ppk. Файл читает ядро на Rust, в интерфейс он не попадает.",
    "支持 OpenSSH、PEM（RSA/EC）和 PuTTY .ppk。文件由 Rust 端读取，不会进入界面。",
  ],
  "importKey.noFile": ["No file selected", "Dosya seçilmedi", "Файл не выбран", "未选择文件"],
  "importKey.choose": ["Choose", "Seç", "Выбрать", "选择"],
  "importKey.paste": ["...or paste", "...ya da yapıştır", "...или вставьте", "…或粘贴"],
  "importKey.passphrase": ["Key passphrase (if any)", "Anahtar parolası (varsa)", "Пароль ключа (если есть)", "密钥口令（如有）"],
  "importKey.deleteHint": [
    "Consider deleting the original file from disk after importing — the vault is what protects it.",
    "İçe aktardıktan sonra diskteki orijinal dosyayı silmeyi düşün — asıl korumayı kasa sağlar.",
    "После импорта стоит удалить исходный файл с диска — защищает его именно хранилище.",
    "导入后建议删除磁盘上的原文件 — 真正的保护来自保险库。",
  ],
  "genKey.title": ["New Ed25519 key", "Yeni Ed25519 anahtar", "Новый ключ Ed25519", "新建 Ed25519 密钥"],
  "genKey.done": ["Ed25519 key generated", "Ed25519 anahtar üretildi", "Ключ Ed25519 создан", "已生成 Ed25519 密钥"],
  "genKey.hint": ["After generating, upload it to a server via Servers → ⬆", "Üretildikten sonra Sunucular → ⬆ ile sunucuya yükleyebilirsin", "После создания загрузите его на сервер: «Серверы» → ⬆", "生成后可在“服务器” → ⬆ 上传到服务器"],

  // ---------- settings ----------
  "settings.sub": ["Security and vault", "Güvenlik ve kasa", "Безопасность и хранилище", "安全与保险库"],
  "settings.language": ["Language", "Dil", "Язык", "语言"],
  "settings.languageHint": ["Interface language", "Arayüz dili", "Язык интерфейса", "界面语言"],
  "settings.autoLock": ["Auto-lock", "Otomatik kilit", "Автоблокировка", "自动锁定"],
  "settings.lockAfter": ["Lock after inactivity", "Hareketsizlikten sonra kilitle", "Блокировать после бездействия", "闲置后锁定"],
  "settings.minutes": ["{n} minutes", "{n} dakika", "{n} мин", "{n} 分钟"],
  "settings.closeTunnels": ["Also stop tunnels on lock", "Kilitlenince tünelleri de kapat", "Останавливать туннели при блокировке", "锁定时同时关闭隧道"],
  "settings.closeTunnelsHint": [
    "Terminals always close; if this is off, tunnels keep running while locked",
    "Terminaller her zaman kapanır; bu kapalıysa tüneller kilitliyken de çalışır",
    "Терминалы закрываются всегда; если выключено, туннели работают и при блокировке",
    "终端总会关闭；关闭此项时，锁定期间隧道继续运行",
  ],
  "settings.clipboard": ["Clear copied passwords from the clipboard", "Kopyalanan şifreyi panodan sil", "Очищать скопированные пароли из буфера", "从剪贴板清除已复制的密码"],
  "settings.afterSecs": ["after {n} s", "{n} sn sonra", "через {n} с", "{n} 秒后"],
  "settings.never": ["never", "silme", "никогда", "不清除"],
  "settings.agentCard": ["SSH agent (git, ssh, VS Code)", "SSH agent (git, ssh, VS Code)", "SSH-агент (git, ssh, VS Code)", "SSH agent（git、ssh、VS Code）"],
  "settings.agent": ["Built-in ssh-agent", "Dahili ssh-agent", "Встроенный ssh-agent", "内置 ssh-agent"],
  "settings.agentHint": ["Serves vault keys over the Windows OpenSSH agent pipe", "Kasadaki anahtarları Windows OpenSSH agent pipe'ı üzerinden sunar", "Отдаёт ключи хранилища через канал агента Windows OpenSSH", "通过 Windows OpenSSH agent 管道提供保险库中的密钥"],
  "settings.confirm": ["Ask on every use", "Her kullanımda onay iste", "Спрашивать при каждом использовании", "每次使用都询问"],
  "settings.confirmHint": [
    "Asks whenever a program wants to use a key (remembered for 5 min), so even malware on this PC cannot use it without you knowing.",
    "Bir program anahtarı kullanmak istediğinde sorar (onay 5 dk hatırlanır). PC'de zararlı yazılım olsa bile habersiz kullanılamaz.",
    "Спрашивает, когда программа хочет использовать ключ (ответ помнится 5 мин), поэтому даже вредоносное ПО не сможет воспользоваться им незаметно.",
    "程序要使用密钥时会询问（5 分钟内记住选择），即使本机有恶意软件也无法悄悄使用。",
  ],
  "settings.changeMaster": ["Change master password", "Master şifreyi değiştir", "Сменить мастер-пароль", "修改主密码"],
  "settings.current": ["Current password", "Mevcut şifre", "Текущий пароль", "当前密码"],
  "settings.new": ["New password (min 10)", "Yeni şifre (min 10)", "Новый пароль (мин. 10)", "新密码（至少 10 位）"],
  "settings.newRepeat": ["New password (again)", "Yeni şifre (tekrar)", "Новый пароль (ещё раз)", "再次输入新密码"],
  "settings.change": ["Change", "Değiştir", "Сменить", "修改"],
  "settings.mismatch": ["New passwords do not match", "Yeni şifreler eşleşmiyor", "Новые пароли не совпадают", "两次输入的新密码不一致"],
  "settings.changed": ["Master password changed", "Master şifre değiştirildi", "Мастер-пароль изменён", "主密码已修改"],
  "settings.vaultFile": ["Vault file", "Kasa dosyası", "Файл хранилища", "保险库文件"],
  "settings.vaultFileHint": [
    "You can back up this file or move it to another device; it cannot be read without the master password. Each save keeps the previous version as .bak.",
    "Bu dosyayı yedekleyebilir ya da başka cihaza taşıyabilirsin; master şifre olmadan okunamaz. Her kayıtta bir önceki sürüm .bak olarak tutulur.",
    "Этот файл можно сохранить в резервную копию или перенести на другое устройство; без мастер-пароля его не прочитать. При каждом сохранении предыдущая версия хранится как .bak.",
    "可以备份此文件或将其移到其他设备；没有主密码无法读取。每次保存时上一版本会保留为 .bak。",
  ],

  // ---------- passwords ----------
  "secrets.sub": ["Panel, database, API and account passwords — encrypted in the vault", "Panel, veritabanı, API ve hesap şifreleri — kasada şifreli", "Пароли панелей, баз данных, API и аккаунтов — в зашифрованном хранилище", "面板、数据库、API 和账户密码 — 加密存储在保险库中"],
  "secrets.new": ["New entry", "Yeni kayıt", "Новая запись", "新建条目"],
  "secrets.empty": ["No entries yet", "Henüz kayıt yok", "Записей пока нет", "还没有条目"],
  "secrets.emptyText": [
    "Admin panels, database passwords, API keys... all protected by your master password.",
    "Yönetim panelleri, veritabanı şifreleri, API anahtarları... hepsi master şifrenle korunur.",
    "Панели управления, пароли баз данных, API-ключи... всё защищено мастер-паролем.",
    "管理面板、数据库密码、API 密钥……全部由主密码保护。",
  ],
  "secrets.add": ["Add entry", "Kayıt ekle", "Добавить запись", "添加条目"],
  "secrets.copiedPassword": ["Password copied", "Şifre kopyalandı", "Пароль скопирован", "密码已复制"],
  "secrets.copiedUser": ["Username copied", "Kullanıcı adı kopyalandı", "Имя пользователя скопировано", "用户名已复制"],
  "secrets.clearIn": [" · cleared from the clipboard in {n} s", " · {n} sn sonra panodan silinecek", " · буфер очистится через {n} с", " · {n} 秒后从剪贴板清除"],
  "secrets.deleteTitle": ["Delete entry", "Kaydı sil", "Удалить запись", "删除条目"],
  "secrets.copyUser": ["Copy username", "Kullanıcı adını kopyala", "Копировать имя пользователя", "复制用户名"],
  "secrets.reveal": ["Show (15 s)", "Göster (15 sn)", "Показать (15 с)", "显示（15 秒）"],
  "secrets.copyPassword": ["Copy password", "Şifreyi kopyala", "Копировать пароль", "复制密码"],
  "secrets.editTitle": ["Edit entry", "Kaydı düzenle", "Изменить запись", "编辑条目"],
  "secrets.newTitle": ["New password entry", "Yeni şifre kaydı", "Новая запись пароля", "新建密码条目"],
  "secrets.titleField": ["Title", "Başlık", "Название", "标题"],
  "secrets.titlePh": ["Admin panel", "Yönetim paneli", "Панель управления", "管理面板"],
  "secrets.username": ["Username", "Kullanıcı adı", "Имя пользователя", "用户名"],
  "secrets.showHide": ["Show/hide", "Göster/gizle", "Показать/скрыть", "显示/隐藏"],
  "secrets.symbols": ["symbols", "sembol", "символы", "符号"],

  // ---------- notes ----------
  "notes.sub": ["Setup notes, commands, recovery codes — encrypted", "Kurulum notları, komutlar, kurtarma kodları — şifreli", "Заметки по настройке, команды, коды восстановления — зашифровано", "部署笔记、命令、恢复码 — 已加密"],
  "notes.new": ["New note", "Yeni not", "Новая заметка", "新建笔记"],
  "notes.deleteTitle": ["Delete note", "Notu sil", "Удалить заметку", "删除笔记"],
  "notes.search": ["Search notes...", "Notlarda ara...", "Поиск по заметкам...", "搜索笔记…"],
  "notes.none": ["No notes", "Not yok", "Нет заметок", "没有笔记"],
  "notes.saved": ["saved", "kaydedildi", "сохранено", "已保存"],
  "notes.saving": ["saving...", "kaydediliyor...", "сохранение...", "正在保存…"],
  "notes.editing": ["editing", "düzenleniyor", "редактируется", "编辑中"],
  "notes.bodyPh": ["Start writing...", "Yazmaya başla...", "Начните писать...", "开始输入…"],
  "notes.pick": ["Select a note or create a new one", "Bir not seç ya da yeni not oluştur", "Выберите заметку или создайте новую", "选择一条笔记或新建笔记"],

  // ---------- git ----------
  "git.sub": ["git push/pull without writing keys to disk — via the built-in ssh-agent", "Anahtarlar diske yazılmadan git push/pull — dahili ssh-agent ile", "git push/pull без записи ключей на диск — через встроенный ssh-agent", "无需把密钥写入磁盘即可 git push/pull — 通过内置 ssh-agent"],
  "git.account": ["Git account", "Git hesabı", "Аккаунт Git", "Git 账户"],
  "git.cmdEmpty": ["Command cannot be empty", "Komut boş olamaz", "Команда не может быть пустой", "命令不能为空"],
  "git.changeTitle": ["Change git ssh setting", "Git ssh ayarını değiştir", "Изменить настройку ssh для git", "修改 git 的 ssh 设置"],
  "git.apply": ["Apply", "Uygula", "Применить", "应用"],
  "git.applied": ["Applied", "Uygulandı", "Применено", "已应用"],
  "git.willRun": ["This command will be run:", "Şu komut çalıştırılacak:", "Будет выполнена команда:", "将执行以下命令："],
  "git.currentValue": ["Current value: {v}", "Şu anki değer: {v}", "Текущее значение: {v}", "当前值：{v}"],
  "git.notSet": ["(not set)", "(ayarlı değil)", "(не задано)", "（未设置）"],
  "git.noAgentWarn": ["With this setting git may not be able to use the SkyVault agent.", "Bu ayarla git SkyVault agent'ını kullanamayabilir.", "С этой настройкой git может не видеть агент SkyVault.", "使用此设置时 git 可能无法使用 SkyVault agent。"],
  "git.nowWindows": ["Git now uses Windows OpenSSH + the SkyVault agent", "Git artık Windows OpenSSH + SkyVault agent kullanıyor", "Теперь git использует Windows OpenSSH и агент SkyVault", "Git 现在使用 Windows OpenSSH + SkyVault agent"],
  "git.updated": ["Git ssh setting updated", "Git ssh ayarı güncellendi", "Настройка ssh для git обновлена", "已更新 git 的 ssh 设置"],
  "git.modeBundled": ["Git's own ssh", "Git'in kendi ssh'ı", "Встроенный ssh Git", "Git 自带 ssh"],
  "git.modeCustom": ["Custom", "Özel", "Свой", "自定义"],
  "git.config": ["Git configuration", "Git yapılandırması", "Настройка Git", "Git 配置"],
  "git.notFound": ["git not found (not on PATH). Git for Windows must be installed.", "git bulunamadı (PATH'te yok). Git for Windows kurulu olmalı.", "git не найден (нет в PATH). Нужен Git for Windows.", "未找到 git（不在 PATH 中），需要安装 Git for Windows。"],
  "git.windowsHint": ["Recommended: git uses the keys in the SkyVault agent ({path}).", "Önerilen: git, SkyVault agent'ındaki anahtarları kullanır ({path}).", "Рекомендуется: git использует ключи из агента SkyVault ({path}).", "推荐：git 使用 SkyVault agent 中的密钥（{path}）。"],
  "git.windowsMissing": ["{path} not found. Enable the “OpenSSH Client” feature in Windows.", "{path} bulunamadı. Windows'ta “OpenSSH İstemcisi” özelliğini aç.", "{path} не найден. Включите компонент Windows «Клиент OpenSSH».", "未找到 {path}。请在 Windows 中启用“OpenSSH 客户端”功能。"],
  "git.bundledHint": [
    "The setting is removed; git uses its own ssh and the files in ~/.ssh, and cannot reach the agent.",
    "Ayar kaldırılır; git kendi ssh'ını ve ~/.ssh altındaki dosyaları kullanır, agent'a erişemez.",
    "Настройка удаляется; git использует свой ssh и файлы в ~/.ssh и не видит агент.",
    "将移除该设置；git 使用自带 ssh 和 ~/.ssh 中的文件，无法访问 agent。",
  ],
  "git.agentRunning": ["running on {pipe} · offering {n} {n:key|keys}", "{pipe} üzerinde çalışıyor · {n} anahtar sunuluyor", "работает на {pipe} · ключей: {n}", "运行于 {pipe} · 提供 {n} 个密钥"],
  "git.agentFallback": [
    "The standard pipe is taken (the Windows ssh-agent service may be running). ssh needs SSH_AUTH_SOCK={pipe}; git aliases get it automatically.",
    "Standart pipe dolu (Windows ssh-agent servisi açık olabilir). ssh için SSH_AUTH_SOCK={pipe} gerekir; git alias'larına otomatik eklenir.",
    "Стандартный канал занят (возможно, работает служба Windows ssh-agent). Для ssh нужен SSH_AUTH_SOCK={pipe}; git-алиасы получают его автоматически.",
    "标准管道已被占用（可能 Windows ssh-agent 服务正在运行）。ssh 需要 SSH_AUTH_SOCK={pipe}；git 别名会自动设置。",
  ],
  "git.agentOff": ["Off — enable it in Settings", "Kapalı — Ayarlar'dan açabilirsin", "Выключен — включите в настройках", "已关闭 — 可在设置中开启"],
  "git.conflicts": ["These aliases are also defined by hand in ~/.ssh/config, and those take precedence:", "Bu alias'lar ~/.ssh/config içinde elle de tanımlı, onlarınki geçerli olur:", "Эти алиасы также заданы вручную в ~/.ssh/config, и действуют именно они:", "这些别名也在 ~/.ssh/config 中手动定义，且优先生效："],
  "git.empty": ["No git accounts", "Git hesabı yok", "Аккаунтов Git нет", "没有 Git 账户"],
  "git.emptyText": [
    "Create an alias per account (e.g. github-work). Cloning with git@github-work:user/repo.git then uses the right key.",
    "Her hesap için bir alias oluştur (örn. github-is). git@github-is:kullanici/repo.git ile klonladığında doğru anahtar kullanılır.",
    "Создайте алиас для каждого аккаунта (например, github-work). При клонировании git@github-work:user/repo.git будет использован нужный ключ.",
    "为每个账户创建别名（如 github-work）。使用 git@github-work:user/repo.git 克隆时会自动使用正确的密钥。",
  ],
  "git.deleteTitle": ["Delete git account", "Git hesabını sil", "Удалить аккаунт Git", "删除 Git 账户"],
  "git.deleteBody": ["Delete “{name}” and its alias in ~/.ssh/config?", "“{name}” ve ~/.ssh/config içindeki alias'ı silinsin mi?", "Удалить «{name}» и его алиас в ~/.ssh/config?", "删除“{name}”及其在 ~/.ssh/config 中的别名？"],
  "git.copyPub": ["Copy public key", "Public key'i kopyala", "Копировать открытый ключ", "复制公钥"],
  "git.pubCopied": ["Public key copied — add it under GitHub → Settings → SSH keys", "Public key kopyalandı — GitHub → Settings → SSH keys'e ekle", "Открытый ключ скопирован — добавьте его в GitHub → Settings → SSH keys", "公钥已复制 — 请添加到 GitHub → Settings → SSH keys"],
  "git.footer": ["Aliases are written to the “SkyVault” block in {path}; only public keys go into the file.", "Alias'lar {path} içinde “SkyVault” bloğuna yazılır; dosyaya yalnızca public key'ler konur.", "Алиасы пишутся в блок «SkyVault» файла {path}; в файл попадают только открытые ключи.", "别名写入 {path} 中的“SkyVault”区块；文件中只包含公钥。"],
  "git.repo": ["user/repo.git", "kullanici/repo.git", "user/repo.git", "user/repo.git"],
  "gitForm.saved": ["Saved, ~/.ssh/config updated", "Kaydedildi, ~/.ssh/config güncellendi", "Сохранено, ~/.ssh/config обновлён", "已保存，~/.ssh/config 已更新"],
  "gitForm.edit": ["Edit git account", "Git hesabını düzenle", "Изменить аккаунт Git", "编辑 Git 账户"],
  "gitForm.new": ["New git account", "Yeni git hesabı", "Новый аккаунт Git", "新建 Git 账户"],
  "gitForm.namePh": ["GitHub work", "GitHub iş", "GitHub работа", "GitHub 工作"],
  "gitForm.aliasHint": ["Used instead of the host in repo URLs", "Repo URL'inde host yerine kullanılır", "Используется вместо хоста в URL репозитория", "在仓库 URL 中代替主机名"],
  "gitForm.host": ["Host", "Sunucu", "Хост", "主机"],
  "agentSettings.running": ["Running: {pipe} · {n} {n:key|keys}", "Çalışıyor: {pipe} · {n} anahtar", "Работает: {pipe} · ключей: {n}", "运行中：{pipe} · {n} 个密钥"],
  "agentSettings.off": ["Off", "Kapalı", "Выключен", "已关闭"],

  // ---------- backend messages (codes sent by msg!() in src-tauri) ----------
  "err.host_not_found": ["Server not found", "Sunucu bulunamadı", "Сервер не найден", "未找到服务器"],
  "err.host_no_key": ["No key selected for this server", "Sunucuya anahtar seçilmemiş", "Для сервера не выбран ключ", "此服务器未选择密钥"],
  "err.master_too_short": ["The master password must be at least 10 characters", "Master şifre en az 10 karakter olmalı", "Мастер-пароль должен быть не короче 10 символов", "主密码至少需要 10 个字符"],
  "err.autostart_hostkey": ["server key not verified; start it from the Tunnels page and confirm", "sunucu anahtarı doğrulanmadı, Tüneller sayfasından elle başlatıp onayla", "ключ сервера не подтверждён — запустите вручную на странице «Туннели» и подтвердите", "服务器密钥未验证，请在“隧道”页面手动启动并确认"],
  "err.autostart_failed": ["“{0}” could not be started", "“{0}” başlatılamadı", "Не удалось запустить «{0}»", "无法启动“{0}”"],
  "err.new_password_too_short": ["The new password must be at least 10 characters", "Yeni şifre en az 10 karakter olmalı", "Новый пароль должен быть не короче 10 символов", "新密码至少需要 10 个字符"],
  "err.current_password_wrong": ["The current password is wrong", "Mevcut şifre yanlış", "Неверный текущий пароль", "当前密码错误"],
  "err.host_required_fields": ["Address and username are required", "Adres ve kullanıcı adı zorunlu", "Адрес и имя пользователя обязательны", "地址和用户名为必填项"],
  "err.host_has_tunnels": ["Tunnels use this server; delete them first", "Bu sunucuyu kullanan tüneller var, önce onları silin", "Сервер используется туннелями — сначала удалите их", "有隧道正在使用此服务器，请先删除它们"],
  "err.pubkey_invalid": ["Invalid public key", "Geçersiz public key", "Неверный открытый ключ", "公钥无效"],
  "err.remote_command_failed": ["Remote command failed ({0})", "Uzak komut başarısız ({0})", "Удалённая команда завершилась ошибкой ({0})", "远程命令执行失败（{0}）"],
  "err.file_unreadable": ["Could not read the file", "Dosya okunamadı", "Не удалось прочитать файл", "无法读取文件"],
  "err.key_input_required": ["Key text or a key file is required", "Anahtar metni ya da dosyası gerekli", "Нужен текст ключа или файл", "需要提供密钥文本或密钥文件"],
  "err.key_exists": ["This key is already in the vault", "Bu anahtar zaten kasada", "Этот ключ уже в хранилище", "此密钥已在保险库中"],
  "err.key_in_use": ["Servers use this key", "Bu anahtarı kullanan sunucular var", "Этот ключ используется серверами", "有服务器正在使用此密钥"],
  "err.ports_range": ["Ports must be between 1 and 65535", "Portlar 1-65535 arasında olmalı", "Порты должны быть в диапазоне 1–65535", "端口必须在 1-65535 之间"],
  "err.select_host": ["Select a server", "Sunucu seçin", "Выберите сервер", "请选择服务器"],
  "err.tunnel_not_found": ["Tunnel not found", "Tünel bulunamadı", "Туннель не найден", "未找到隧道"],
  "err.agent_wants_unlock": ["An app wants an SSH key — unlock the vault", "Bir uygulama SSH anahtarı istiyor — kasanın kilidini aç", "Приложению нужен SSH-ключ — разблокируйте хранилище", "有应用请求 SSH 密钥 — 请解锁保险库"],
  "err.agent_start_failed": ["Could not start the agent", "Agent başlatılamadı", "Не удалось запустить агент", "无法启动 agent"],
  "err.title_required": ["A title is required", "Başlık gerekli", "Нужно название", "标题为必填项"],
  "err.unknown_field": ["Unknown field", "Bilinmeyen alan", "Неизвестное поле", "未知字段"],
  "err.note_not_found": ["Note not found", "Not bulunamadı", "Заметка не найдена", "未找到笔记"],
  "err.alias_invalid_chars": ["Aliases may only contain letters, digits and - _ .", "Alias sadece harf, rakam, - _ . içerebilir", "Алиас может содержать только буквы, цифры и - _ .", "别名只能包含字母、数字和 - _ ."],
  "err.alias_taken": ["This alias is already in use", "Bu alias zaten kullanılıyor", "Этот алиас уже используется", "此别名已被使用"],
  "err.select_key": ["Select a key", "Anahtar seçin", "Выберите ключ", "请选择密钥"],
  "err.account_not_found": ["Account not found", "Hesap bulunamadı", "Аккаунт не найден", "未找到账户"],
  "err.auth_ok": ["Authentication succeeded", "Kimlik doğrulama başarılı", "Аутентификация успешна", "认证成功"],
  "err.probe_timeout": ["{0}:{1} timed out", "{0}:{1} zaman aşımına uğradı", "{0}:{1} — превышено время ожидания", "{0}:{1} 连接超时"],
  "err.probe_failed": ["The server could not connect to {0}:{1}", "Sunucu {0}:{1} adresine bağlanamadı", "Сервер не смог подключиться к {0}:{1}", "服务器无法连接到 {0}:{1}"],
  "err.import_proxyjump": ["{0}: ProxyJump is not supported yet, skipped", "{0}: ProxyJump henüz desteklenmiyor, atlandı", "{0}: ProxyJump пока не поддерживается, пропущено", "{0}：暂不支持 ProxyJump，已跳过"],
  "err.import_exists": ["{0}: already in the vault", "{0}: zaten kasada", "{0}: уже в хранилище", "{0}：已在保险库中"],
  "err.import_key_unreadable": ["{0}: could not read {1} (it may have a passphrase); import it on the Keys page", "{0}: {1} okunamadı (parolalı olabilir), Anahtarlar'dan elle içe aktar", "{0}: не удалось прочитать {1} (возможно, есть пароль) — импортируйте на странице «Ключи»", "{0}：无法读取 {1}（可能有口令），请在“密钥”页面手动导入"],
  "err.home_not_found": ["Home directory not found", "home dizini bulunamadı", "Домашний каталог не найден", "未找到主目录"],
  "err.alias_invalid": ["Invalid alias: {0}", "Geçersiz alias: {0}", "Неверный алиас: {0}", "别名无效：{0}"],
  "err.command_invalid": ["Invalid command", "Geçersiz komut", "Неверная команда", "命令无效"],
  "err.git_not_found": ["git not found", "git bulunamadı", "git не найден", "未找到 git"],
  "err.git_config_failed": ["git config failed", "git config başarısız", "git config завершился ошибкой", "git config 执行失败"],
  "err.key_unreadable": ["Could not read the key (a passphrase may be needed)", "Anahtar okunamadı (parola gerekebilir)", "Не удалось прочитать ключ (возможно, нужен пароль)", "无法读取密钥（可能需要口令）"],
  "err.key_decode_failed": ["Could not decode the key", "Anahtar çözülemedi", "Не удалось расшифровать ключ", "无法解析密钥"],
  "err.conn_timeout": ["Connection timed out ({0}:{1})", "Bağlantı zaman aşımına uğradı ({0}:{1})", "Время подключения истекло ({0}:{1})", "连接超时（{0}:{1}）"],
  "err.conn_failed": ["Could not connect", "Bağlanılamadı", "Не удалось подключиться", "无法连接"],
  "err.auth_failed": ["Authentication failed ({0}@{1})", "Kimlik doğrulama başarısız ({0}@{1})", "Ошибка аутентификации ({0}@{1})", "认证失败（{0}@{1}）"],
  "err.listen_failed": ["Could not listen on {0}:{1} (the port may be in use)", "{0}:{1} dinlenemedi (port kullanımda olabilir)", "Не удалось слушать {0}:{1} (порт может быть занят)", "无法监听 {0}:{1}（端口可能已被占用）"],
  "err.vault_exists": ["A vault already exists", "Kasa zaten mevcut", "Хранилище уже существует", "保险库已存在"],
  "err.vault_read": ["Could not read the vault file", "Kasa dosyası okunamadı", "Не удалось прочитать файл хранилища", "无法读取保险库文件"],
  "err.vault_corrupt": ["The vault file is corrupted", "Kasa dosyası bozuk", "Файл хранилища повреждён", "保险库文件已损坏"],
  "err.vault_version": ["Unsupported vault version: {0}", "Desteklenmeyen kasa sürümü: {0}", "Неподдерживаемая версия хранилища: {0}", "不支持的保险库版本：{0}"],
  "err.wrong_password": ["Wrong password", "Şifre yanlış", "Неверный пароль", "密码错误"],
  "err.vault_decrypt": ["Could not decode the vault contents", "Kasa içeriği çözülemedi", "Не удалось расшифровать содержимое хранилища", "无法解析保险库内容"],
  "err.encrypt_failed": ["Encryption error", "Şifreleme hatası", "Ошибка шифрования", "加密错误"],
  "err.key_not_found": ["Key not found", "Anahtar bulunamadı", "Ключ не найден", "未找到密钥"],
  "err.record_not_found": ["Entry not found", "Kayıt bulunamadı", "Запись не найдена", "未找到条目"],
} satisfies Record<string, readonly [string, string, string, string]>;

export type MsgKey = keyof typeof S;
type Vars = Record<string, string | number>;

const STORE = "skyvault.lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORE) as Lang | null;
    if (saved && saved in IDX) return saved;
  } catch {
    /* storage unavailable */
  }
  const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
  return (nav in IDX ? nav : "en") as Lang;
}

let current: Lang = detect();

/** `{name}` inserts a value; `{n:one|many}` picks a word by count (used by English). */
function fill(s: string, vars?: Vars) {
  if (!vars) return s;
  return s
    .replace(/\{(\w+):([^|}]*)\|([^}]*)\}/g, (m, k, one, many) => (k in vars ? (Number(vars[k]) === 1 ? one : many) : m))
    .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Translates with the current language; usable outside React (errText, terminal). */
export function translate(key: MsgKey, vars?: Vars): string {
  return fill(S[key][IDX[current]], vars);
}

/** Replaces backend message segments (`\x1f code \x1f arg... \x1e`) with translated text. */
export function localize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1f([\w.]+)((?:\x1f[^\x1f\x1e]*)*)\x1e/g, (_, code: string, rest: string) => {
    const key = `err.${code}` as MsgKey;
    if (!(key in S)) return code;
    const args = rest.split("\x1f").slice(1);
    return fill(S[key][IDX[current]], Object.fromEntries(args.map((a, i) => [String(i), a])));
  });
}

type Ctx = {
  lang: Lang;
  locale: string;
  setLang: (l: Lang) => void;
  t: (key: MsgKey, vars?: Vars) => string;
  /** Like t, but placeholders may be React nodes (e.g. bold names). */
  tn: (key: MsgKey, vars: Record<string, ReactNode>) => ReactNode;
};
const I18n = createContext<Ctx>(null!);
export const useT = () => useContext(I18n);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  current = lang;

  const setLang = useCallback((l: Lang) => {
    current = l;
    try {
      localStorage.setItem(STORE, l);
    } catch {
      /* storage unavailable */
    }
    setLangState(l);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    invoke("tray_labels", { labels: [translate("tray.show"), translate("tray.lock"), translate("tray.quit")] }).catch(() => {});
  }, [lang]);

  const value = useMemo<Ctx>(
    () => ({
      lang,
      locale: LANGS.find((l) => l.id === lang)!.locale,
      setLang,
      t: (key, vars) => fill(S[key][IDX[lang]], vars),
      tn: (key, vars) =>
        S[key][IDX[lang]].split(/\{(\w+)\}/g).map((part, i) => <Fragment key={i}>{i % 2 ? (vars[part] ?? `{${part}}`) : part}</Fragment>),
    }),
    [lang, setLang],
  );
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export function LangSelect({ className }: { className?: string }) {
  const { lang, setLang, t } = useT();
  return (
    <label className={`inline-flex items-center ${className ?? ""}`} title={t("settings.language")}>
      <span className="relative inline-flex items-center">
        <Languages size={14} className="pointer-events-none absolute left-2.5 text-zinc-500" />
        <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        className="h-8 cursor-pointer appearance-none rounded-lg border border-white/[0.08] bg-black/30 pl-8 pr-3 text-xs text-zinc-300 outline-none transition hover:border-white/[0.15] focus:border-sky-500/60"
      >
        {LANGS.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
        </select>
      </span>
    </label>
  );
}
