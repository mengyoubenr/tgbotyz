# tgbotyz
使用cf works来实现tg的入群审核bot（即强制5秒盾的人机检测）

tg群设置：拉bot给管理员权限+打开新成员入群审核

创建 KV
名字： TELEGRAM_VERIFY
works绑定也是同名

Turnstile
创建（有自己域名的可以用，没有的就用works自带的）
小组件（懒的可以用spin设置，需要自命名的用手动）
复制域名（比如： AAAA.BBBB.workers.dev）
粘贴到域名框里 回车！

works项目设置里
Runtime variables and secrets
增加：
BOT_TOKEN
TURNSTILE_SECRET_KEY（密钥）
TURNSTILE_SITE_KEY（站点密钥）
WEBHOOK_SECRET（随机生成，不会就ai）

两个密钥不要搞混

直接用浏览器访问
https://AAAA.BBBB.workers.dev/setup

成功示例：{"webhook":"https://AAAA.BBBB.workers.dev/telegram/webhook/WEBHOOK_SECRET的值","telegram":{"ok":true,"result":true,"description":"Webhook was set"}}

PS：如果你的域名做了waf安全规则，别忘记放行tg的asn（62041）别到时候tg回调请求你自己服务端拒绝了（本人吃了这个教训）


这个版本包含：

✅ Telegram chat_join_request

✅ Telegram chat_member

✅ 用户退出后记录状态

✅ 再次申请必须重新 Turnstile

✅ KV 防重复验证

✅ Token 10 分钟过期

✅ 验证成功立即删除 Token

✅ IP 10 分钟最多 10 次

✅ Turnstile 服务端验证

✅ Telegram 自动批准入群

✅ 自动创建“需要管理员批准”的邀请链接

✅ /setup 自动设置 Webhook

✅ /invite 获取验证入群链接

✅ 不需要 VPS / Node.js / Wrangler

