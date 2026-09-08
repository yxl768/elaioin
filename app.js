const api = require('./utils/api');

App({
  globalData: {
    loginPromise: null
  },

  // 由用户勾选协议并主动点击“微信快捷登录”后调用。
  getWechatLoginCode() {
    if (this.globalData.loginPromise) return this.globalData.loginPromise;

    this.globalData.loginPromise = new Promise((resolve, reject) => {
      wx.login({
        timeout: 10000,
        success(res) {
          if (res.code) resolve(res.code);
          else reject(new Error('微信未返回登录凭证，请稍后重试'));
        },
        fail(error) {
          reject(new Error(error.errMsg || '微信登录失败，请检查网络后重试'));
        }
      });
    });

    return this.globalData.loginPromise.then(
      code => { this.globalData.loginPromise = null; return code; },
      error => { this.globalData.loginPromise = null; throw error; }
    );
  },

  loginByWechat() {
    return this.getWechatLoginCode().then(code => {
      // AppSecret、OpenID 和 session_key 只在服务端处理。
      return api.request('/api/auth/wechat', 'POST', { code, agreed:true });
    });
  }
});
