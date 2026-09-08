# 橄榄树 API

在项目根目录运行 `node backend/server.js`，默认监听 `http://127.0.0.1:3000`。数据会保存于 `backend/data/db.json`，头像会保存于 `backend/uploads/`。

完整启动、功能状态和验收说明见 [DELIVERY.md](DELIVERY.md)。未配置短信服务时不会发送或返回演示验证码。


## 微信登录与沙箱支付演示

服务器从环境变量或项目根目录本机 `.env` 读取 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`，需要 Node.js 22+。微信快捷登录会将 `wx.login()` 的一次性 code 传到 `/api/auth/wechat`，由服务端换取 OpenID 并保存自定义登录态；不会向客户端返回 `session_key`。

真机联调时，`utils/api.js` 的 `API_BASE` 不能使用 `127.0.0.1`，必须替换为已经配置到小程序「request 合法域名」的 HTTPS 服务端地址。开发者工具本地调试可暂时勾选「不校验合法域名」。

演示订单提供创建、取消、模拟付款和模拟退款；不是微信官方沙箱，不发生真实资金交易。真实微信支付尚未接入。
