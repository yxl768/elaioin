# 橄榄树微信小程序

小程序界面入口为 `pages/index/index`。已接入微信登录、站内消息、演示订单、头像与昵称保存、预约意向及收藏管理。手机号权限、实名认证、真实微信支付及内容服务的未开通状态在页面标注，详见 [功能交付说明](backend/DELIVERY.md)。

## 启动后端

需要 Node.js 22 或更高版本。将 `.env.example` 复制为本机 `.env` 并配置新的微信凭证，然后在项目根目录运行：

```powershell
node backend/server.js
```

开发环境 API 默认是 `http://127.0.0.1:3000`，配置在 `utils/api.js`。小程序开发者工具可直接联调；真机或生产部署前，须将该地址改成已备案的 HTTPS API 域名并添加到微信小程序的合法域名列表。

未配置短信服务时禁用验证码发送。生产环境禁止演示订单操作；真实支付需另行接入，详细说明见 [backend/README.md](backend/README.md)。

数据会自动存储在 `backend/data/db.json`，上传头像保存在 `backend/uploads/`。
