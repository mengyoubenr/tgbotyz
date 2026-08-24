# tgbotyz
使用cf works来实现tg的入群审核bot（即强制5秒盾的人机检测）

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


