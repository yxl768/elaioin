// 所有业务查询均由服务端登录态确定用户，不能由客户端指定 owner。
const limits = new Map();
module.exports = async function features(c) {
  const {req,res,url,db,save,send,fail,body,requireUser,id,now} = c;
  const route = url.pathname;
  const ok = data => { send(res, 200, {ok:true,...data}); return true; };
  const deny = (status, message) => { fail(res,status,message); return true; };
  if (route.startsWith('/api/auth/') && req.method === 'POST') {
    const key = req.socket.remoteAddress;
    const entry = limits.get(key);
    const value = entry && entry.until > Date.now() ? entry : {count:0,until:Date.now()+60000};
    if (++value.count > 30) return deny(429,'登录请求过于频繁，请一分钟后重试');
    limits.set(key,value);
    if (limits.size > 10000) for (const [k,v] of limits) if (v.until < Date.now()) limits.delete(k);
  }
  if (route === '/api/capabilities' && req.method === 'GET') return ok({
    wechatLogin:!!(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET),
    phoneLogin:process.env.WECHAT_PHONE_ENABLED === 'true',
    demoPayment:process.env.NODE_ENV !== 'production',
    paymentNotice:'真实微信支付未开通：需合格主体、认证小程序、绑定商户号及支付密钥。当前仅本地演示，不扣款。',
    verificationNotice:'实名认证服务和审核后台尚未接入，暂不收集证件材料。',
    contentNotice:'课程、视频、群组和 AI 服务尚未接入内容及服务商，暂未开放。'
  });
  if (route === '/api/auth/phone' && process.env.WECHAT_PHONE_ENABLED !== 'true') return deny(403,'手机号一键登录未开通：请确认平台权限后配置，当前可使用微信快捷登录');
  if (route === '/api/exchangers') return deny(403,'实名认证服务与审核后台未接入，暂不能提交证件或提供认证服务');
  if (route === '/api/payments' && req.method === 'POST') return deny(403,'请从演示订单入口创建订单；真实微信支付尚未开通');
  const handled = ['/api/messages','/api/orders','/api/appointments/cancel','/api/favorites/remove'];
  if (!handled.includes(route) && !/^\/api\/orders\/[^/]+\/(pay|cancel|refund)$/.test(route)) return false;
  const user = requireUser(req,res); if (!user) return true;
  if (route === '/api/messages' && req.method === 'GET') {
    const items = db.messages.filter(m => m.from === user.id || m.to === user.id);
    let changed = false;
    for (const item of items) if (item.to === user.id && !item.readAt) { item.readAt=now(); changed=true; }
    if (changed) await save();
    return ok({items:items.slice(-200).map(m => ({...m, mine:m.from===user.id,
      peerId:m.from===user.id?m.to:m.from,
      peerName:db.users.find(u=>u.id===(m.from===user.id?m.to:m.from))?.nickname || '用户'}))});
  }
  if (route === '/api/messages' && req.method === 'POST') {
    const {recipientId,text,clientId} = await body(req);
    if (typeof text !== 'string' || !text.trim() || text.trim().length > 1000) return deny(400,'消息需为1至1000字');
    if (typeof clientId !== 'string' || clientId.length > 100 || !clientId) return deny(400,'缺少消息请求标识');
    if (recipientId === user.id || !db.users.some(u=>u.id===recipientId)) return deny(400,'接收人不存在或是你自己，请核对对方账户编号');
    const old = db.messages.find(m=>m.from===user.id && m.clientId===clientId);
    if (old) return ok({item:old});
    if (db.messages.filter(m=>m.from===user.id && Date.parse(m.createdAt)>Date.now()-60000).length>=20) return deny(429,'发送过于频繁，请稍后再试');
    const item={id:id('msg'),from:user.id,to:recipientId,text:text.trim(),clientId,createdAt:now(),readAt:null};
    db.messages.push(item); await save(); return ok({item});
  }
  if (route === '/api/appointments/cancel' && req.method === 'POST') {
    const input=await body(req); const item=db.appointments.find(a=>a.id===input.id && a.userId===user.id);
    if (!item) return deny(404,'预约不存在');
    if (!['待确认','已取消'].includes(item.status)) return deny(409,'当前预约不可取消');
    item.status='已取消'; await save(); return ok({item});
  }
  if (route === '/api/favorites/remove' && req.method === 'POST') {
    const input=await body(req); db.favorites=db.favorites.filter(a=>!(a.id===input.id && a.userId===user.id)); await save(); return ok({});
  }
  if (route === '/api/orders' && req.method === 'POST') {
    if (process.env.NODE_ENV === 'production') return deny(403,'正式环境禁止模拟付款，真实支付尚未开通');
    const {clientId}=await body(req);
    if (typeof clientId !== 'string' || !clientId || clientId.length>100) return deny(400,'缺少订单请求标识');
    const old=db.payments.find(p=>p.userId===user.id && p.clientId===clientId);
    if (old) return ok({item:old});
    // 商品和价格固定在服务端；禁止相信客户端传来的金额。
    const item={id:id('order'),userId:user.id,clientId,title:'交流体验（演示商品）',amount:1,amountFen:100,mode:'demo',status:'待支付',createdAt:now()};
    db.payments.unshift(item); await save(); return ok({item});
  }
  const match=route.match(/^\/api\/orders\/([^/]+)\/(pay|cancel|refund)$/);
  if (match && req.method==='POST') {
    if (process.env.NODE_ENV === 'production') return deny(403,'正式环境禁止模拟支付操作');
    const item=db.payments.find(p=>p.id===match[1] && p.userId===user.id && p.mode==='demo');
    if (!item) return deny(404,'演示订单不存在');
    const target={pay:'演示已支付',cancel:'已取消',refund:'演示已退款'}[match[2]];
    if (item.status===target) return ok({item});
    if (item.status !== (match[2]==='refund'?'演示已支付':'待支付')) return deny(409,'订单状态已改变，请刷新');
    item.status=target; item.updatedAt=now(); await save(); return ok({item});
  }
  return deny(405,'该接口不支持此操作');
};
