
# Paymark Insights Daily Reporter (Vercel + Puppeteer)

## 部署步骤
1. 新建 Vercel 项目，上传本项目代码。
2. 在 Vercel -> Settings -> Environment Variables 设置：
   - `PAYMARK_USER`：你的 Paymark Insights 用户名（邮箱）
   - `PAYMARK_PASS`：你的 Paymark Insights 密码
   - `MAIL_TO`：收件人邮箱（多个用英文逗号分隔）
   - `MAIL_FROM`：发件人邮箱（与 SMTP 账户匹配）
   - `SMTP_HOST`，`SMTP_PORT`，`SMTP_USER`，`SMTP_PASS`
3. 部署后，`vercel.json` 的 cron 会在 **UTC 07:30** 触发（约等于新西兰每天 19:30，夏令时会变化）。
4. 你也可以在浏览器访问 `https://<your-deployment>/api/paymark-report` 手动触发一次测试。

## 注意
- 首次运行若登录表单或表格选择器不同，请根据实际页面调整 `api/paymark-report.js` 内的选择器。
- 如站点要求 MFA，请先手动完成一次验证，并尽量复用会话；必要时可以把已登录 cookie 落地存储。
- 为安全起见，建议为邮箱/SMTP 使用**应用专用密码**，并启用 2FA。
