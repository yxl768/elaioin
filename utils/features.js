const api = require('./api');
const requestId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
module.exports = {
  initialData:{capabilities:{},loginBusy:false,messageItems:[],messageText:'',recipientId:'',messageBusy:false,orderBusy:false},
  methods:{
    async logout() {
      try { await api.request('/api/auth/logout','POST',{}); }
      catch(error) { this.notice('退出未完成，请检查网络后重试'); return; }
      wx.removeStorageSync(api.tokenKey); this.messageClientId=null; this.orderClientId=null;
      this.setData({loggedIn:false,user:{},avatarSrc:'',accountMode:'',page:'profile',messageItems:[],messageText:'',recipientId:'',accountItems:[]});
      wx.showToast({title:'已退出登录',icon:'success'});
    },
    async initFeatures() { try { const result=await api.request('/api/capabilities'); this.setData({capabilities:result}); } catch(error) { this.notice(error); } },
    onShow() { this.initFeatures(); clearInterval(this.messageTimer); this.messageTimer=setInterval(()=>{if(this.data.page==='messages' && this.data.loggedIn) this.loadMessages();},5000); },
    onHide() { clearInterval(this.messageTimer); },
    onUnload() { clearInterval(this.messageTimer); clearInterval(this.codeTimer); },
    switchPage(event) { const page=event.currentTarget.dataset.page; this.setData({page,accountMode:''}); if(page==='messages' && this.data.loggedIn) this.loadMessages(); },
    async loadMe() { try { const result=await api.request('/api/me'); this.applyUser(result.user); if(this.data.page==='messages') this.loadMessages(); } catch(error) { if(error.statusCode===401) { wx.removeStorageSync(api.tokenKey); this.setData({loggedIn:false,user:{},avatarSrc:''}); } else this.notice(error); } },
    async wechatQuickLogin() {
      if (!this.requireAgreement() || this.data.loginBusy) return;
      this.setData({loginBusy:true});
      try { this.finishLogin(await getApp().loginByWechat()); if(this.data.page==='messages') this.loadMessages(); }
      catch(error) { wx.showModal({title:'登录未完成',content:error.message || '请稍后重试',showCancel:false}); }
      finally { this.setData({loginBusy:false}); }
    },
    async onPhoneQuickLogin(event) {
      if(!this.requireAgreement() || this.data.loginBusy) return;
      if(!event.detail.code) return this.notice('未授权手机号');
      this.setData({loginBusy:true});
      try { this.finishLogin(await api.request('/api/auth/phone','POST',{code:event.detail.code,agreed:true})); }
      catch(error) { this.notice(error); } finally { this.setData({loginBusy:false}); }
    },
    showPermission(event) {
      const notes={phone:'手机号一键登录尚未确认平台权限，请先使用微信快捷登录。',verification:'实名认证服务与审核后台尚未接入，暂不能提交证件。',content:'此服务尚未接入内容或服务商，暂未开放。',payment:'真实微信支付尚未开通。需要认证小程序、合格主体、绑定商户号、支付密钥与回调服务。演示订单不会扣款。'};
      wx.showModal({title:'功能开通说明',content:notes[event.currentTarget.dataset.kind] || notes.content,showCancel:false});
    },
    showRegister() { this.showPermission({currentTarget:{dataset:{kind:'verification'}}}); },
    showAgreement(event) {
      const privacy=event.currentTarget.dataset.kind==='privacy';
      wx.showModal({title:privacy?'商家隐私政策（演示版）':'用户协议（演示版）',content:privacy?'本演示服务保存微信账户标识、昵称、头像、站内消息、预约、收藏及演示订单，用于提供对应功能。不会获取微信好友或聊天记录。证件认证暂未开放。正式上线前需由运营方补全主体、联系方式、保存期限及注销删除流程，并配置微信隐私保护指引。':'本版本用于功能联调。首页交流者为示例资料，预约仅保存意向，不代表对方确认。站内消息仅发送给已有账户，勿发送违法或骚扰内容。演示订单不发生扣款或真实退款。正式服务条款待运营方确认。',showCancel:false});
    },
    copyAccountId() { wx.setClipboardData({data:this.data.user.id}); },
    onRecipient(event) { this.setData({recipientId:event.detail.value.trim()}); },
    onMessageText(event) { this.messageClientId=null; this.setData({messageText:event.detail.value}); },
    replyMessage(event) { this.messageClientId=null; this.setData({recipientId:event.currentTarget.dataset.peer}); },
    async loadMessages() {
      if(this.loadingMessages || !this.data.loggedIn) return;
      this.loadingMessages=true;
      try { const result=await api.request('/api/messages'); if(this.data.loggedIn) this.setData({messageItems:result.items}); }
      catch(error) { if(error.statusCode===401) { this.setData({loggedIn:false,messageItems:[]}); wx.removeStorageSync(api.tokenKey); } }
      finally { this.loadingMessages=false; }
    },
    async sendMessage() {
      if(!this.data.loggedIn) return this.showLogin();
      if(this.data.messageBusy) return;
      if(!this.data.recipientId || !this.data.messageText.trim()) return this.notice('请填写接收人账户编号和消息');
      this.setData({messageBusy:true});
      this.messageClientId=this.messageClientId || requestId();
      try { await api.request('/api/messages','POST',{recipientId:this.data.recipientId,text:this.data.messageText,clientId:this.messageClientId}); this.setData({messageText:''}); this.messageClientId=null; await this.loadMessages(); }
      catch(error) { this.notice(error); } finally { this.setData({messageBusy:false}); }
    },
    async cancelAppointment(event) { try { await api.request('/api/appointments/cancel','POST',{id:event.currentTarget.dataset.id}); await this.loadAccountItems(); } catch(error) { this.notice(error); } },
    async removeFavorite(event) { try { await api.request('/api/favorites/remove','POST',{id:event.currentTarget.dataset.id}); await this.loadAccountItems(); } catch(error) { this.notice(error); } },
    async addPayment() {
      if(this.data.orderBusy) return;
      this.setData({orderBusy:true}); this.orderClientId=this.orderClientId || requestId();
      try { await api.request('/api/orders','POST',{clientId:this.orderClientId}); this.orderClientId=null; await this.loadAccountItems('payments'); }
      catch(error) { this.notice(error); } finally { this.setData({orderBusy:false}); }
    },
    orderAction(event) {
      if(this.data.orderBusy) return;
      const {id,action}=event.currentTarget.dataset;
      wx.showModal({title:'演示订单',content:{pay:'确认模拟付款？不会真实扣款。',refund:'确认模拟退款？不会发生资金退回。',cancel:'确认取消此订单？'}[action],success:async result=>{
        if(!result.confirm || this.data.orderBusy) return;
        this.setData({orderBusy:true});
        try { await api.request(`/api/orders/${id}/${action}`,'POST',{}); await this.loadAccountItems('payments'); }
        catch(error) { this.notice(error); } finally { this.setData({orderBusy:false}); }
      }});
    }
  }
};
