# 部署指南：腾讯云 / 阿里云免费额度

gptchat 是一个普通的 Node.js 长驻进程（HTTP + WebSocket + SQLite 文件），
任何能跑 Node 20+ 的主机都能部署。下面以免费/低价额度最方便的两家为例。

> 免费额度随厂商活动变化，请以官方页面为准：
> - 腾讯云：云服务器 Lighthouse 新用户免费试用 / 轻量应用服务器优惠
> - 阿里云：ECS 免费试用（新用户）/ 轻量应用服务器

## 0. 机型与系统要求

| 项 | 要求 |
| --- | --- |
| 系统 | Ubuntu 22.04 LTS（推荐）/ Debian 12 |
| 配置 | 2 核 2G 起步即可（SQLite 单机，小团队足够） |
| 磁盘 | 20G+（消息存本地 SQLite，增长很慢） |
| 网络 | 需要域名才能自动 HTTPS（推荐）；纯 IP 也能用（无 TLS） |

## 1. 方式一：Docker Compose（推荐）

```bash
# 1) 安装 docker（腾讯云/阿里云的 Ubuntu 镜像可用）
curl -fsSL https://get.docker.com | sh

# 2) 拉取代码
git clone https://github.com/yinkesi/gptchat.git && cd gptchat/deploy

# 3) 准备环境变量
cat > .env <<'EOF'
JWT_SECRET=把这里替换成强随机串
PUBLIC_URL=https://chat.example.com
EOF
# 生成强随机串：
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# 4) 修改 Caddyfile 里的域名，然后启动
docker compose up -d --build
```

把域名的 A 记录指向服务器公网 IP，Caddy 会自动签发 Let's Encrypt 证书。
安全组/防火墙放行 80、443（腾讯云「防火墙」页签、阿里云「安全组」规则）。

## 2. 方式二：systemd 裸跑 Node

```bash
# 1) 安装 Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2) 构建与安装
sudo mkdir -p /opt/gptchat && sudo chown $USER /opt/gptchat
git clone https://github.com/yinkesi/gptchat.git /opt/gptchat
cd /opt/gptchat
npm ci --no-audit --no-fund
npm run build -w @gptchat/shared && npm run build -w @gptchat/server && npm run build -w web
mkdir -p data

# 3) 安装 systemd 服务
sudo cp deploy/gptchat.service /etc/systemd/system/
#    编辑 /etc/systemd/system/gptchat.service：替换 JWT_SECRET、PUBLIC_URL、ALLOWED_ORIGINS
sudo systemctl daemon-reload
sudo systemctl enable --now gptchat
curl http://127.0.0.1:8780/healthz   # 应返回 {"ok":true,...}
```

对外暴露建议前置 Nginx/Caddy 做 TLS（应用只监听 127.0.0.1）：

```nginx
server {
    listen 443 ssl http2;
    server_name chat.example.com;
    # ssl_certificate ... （或使用 certbot 自动配置）
    location / {
        proxy_pass http://127.0.0.1:8780;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket 升级
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }
}
```

## 3. 部署后自检清单

- [ ] `https://你的域名/healthz` 返回 `{"ok":true}`
- [ ] 浏览器打开首页能注册登录（地址栏是 HTTPS 锁标）
- [ ] `echo $JWT_SECRET` 不为空且 ≥32 字符（服务器上检查进程环境）
- [ ] 数据目录（`/data` 或 `/opt/gptchat/data`）已被纳入备份计划
- [ ] 安全组只开放 80/443（SSH 仅限自己的 IP）

## 4. 升级

```bash
cd /opt/gptchat && git pull
npm ci --no-audit --no-fund
npm run build -w @gptchat/shared && npm run build -w @gptchat/server && npm run build -w web
sudo systemctl restart gptchat
```

数据库迁移自动执行（schema_migrations 版本表），升级前建议冷备一份 `gptchat.db`。

## 5. 备份

SQLite 单文件即全部业务数据：

```bash
sqlite3 /opt/gptchat/data/gptchat.db ".backup '/backup/gptchat-$(date +%F).db'"
```

（或直接停服后拷贝文件；WAL 模式下务必使用 `.backup` 或停服拷贝。）
