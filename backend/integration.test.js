const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('登录、双用户消息隔离、演示订单状态与账户功能', async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'olive-api-test-'));
  process.env.DATA_DIR=directory;
  process.env.WECHAT_APP_ID='test-app'; process.env.WECHAT_APP_SECRET='test-secret';
  process.env.NODE_ENV='test'; delete process.env.WECHAT_PHONE_ENABLED;
  const originalFetch=global.fetch;
  global.fetch=async (url, options)=> {
    if(String(url).startsWith('https://api.weixin.qq.com/')) {
      const code=new URL(url).searchParams.get('js_code');
      return {ok:true,json:async()=> code==='invalid' ? {errcode:40029} : {openid:'test-openid-'+code,session_key:'test-private-key'}};
    }
    return originalFetch(url,options);
  };
  const {server,boot}=require('./server');
  await boot(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(route,method='GET',data,token='') {
    const response=await originalFetch(base+route,{method,headers:{'content-type':'application/json',authorization:'Bearer '+token},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:response.status,...await response.json()};
  }
  try {
    assert.equal((await call('/api/messages')).status,401);
    assert.equal((await call('/api/auth/wechat','POST',{code:'a'})).status,400);
    const a=await call('/api/auth/wechat','POST',{code:'a',agreed:true});
    const b=await call('/api/auth/wechat','POST',{code:'b',agreed:true});
    const c=await call('/api/auth/wechat','POST',{code:'c',agreed:true});
    assert.ok(a.token); assert.equal(a.user.wechatOpenId,undefined); assert.equal(a.session_key,undefined);
    assert.equal((await call('/api/auth/wechat','POST',{code:'invalid',agreed:true})).ok,false);
    const data={recipientId:b.user.id,text:'你好，约个时间交流',clientId:'message-one'};
    const first=await call('/api/messages','POST',data,a.token);
    assert.equal((await call('/api/messages','POST',data,a.token)).item.id,first.item.id);
    assert.equal((await call('/api/messages','GET',undefined,b.token)).items.length,1);
    assert.equal((await call('/api/messages','GET',undefined,c.token)).items.length,0);
    assert.ok((await call('/api/messages','GET',undefined,a.token)).items[0].readAt);
    assert.equal((await call('/api/messages','POST',{...data,clientId:'two',recipientId:'missing'},a.token)).status,400);
    const order=await call('/api/orders','POST',{clientId:'order-one',amount:0.01},a.token);
    assert.equal(order.item.amountFen,100);
    assert.equal((await call('/api/orders','POST',{clientId:'order-one'},a.token)).item.id,order.item.id);
    const endpoint='/api/orders/'+order.item.id;
    assert.equal((await call(endpoint+'/pay','POST',{},b.token)).status,404);
    assert.equal((await call(endpoint+'/pay','POST',{},a.token)).item.status,'演示已支付');
    assert.equal((await call(endpoint+'/pay','POST',{},a.token)).item.status,'演示已支付');
    assert.equal((await call(endpoint+'/cancel','POST',{},a.token)).status,409);
    assert.equal((await call(endpoint+'/refund','POST',{},a.token)).item.status,'演示已退款');
    assert.equal((await call('/api/payments','GET',undefined,b.token)).items.length,0);
    const appointment=await call('/api/appointments','POST',{teacherName:'示例'},a.token);
    assert.equal((await call('/api/appointments/cancel','POST',{id:appointment.item.id},b.token)).status,404);
    assert.equal((await call('/api/appointments/cancel','POST',{id:appointment.item.id},a.token)).item.status,'已取消');
    await call('/api/favorites/toggle','POST',{teacherName:'示例'},a.token);
    const favorites=await call('/api/favorites','GET',undefined,a.token);
    await call('/api/favorites/remove','POST',{id:favorites.items[0].id},a.token);
    assert.equal((await call('/api/favorites','GET',undefined,a.token)).items.length,0);
    assert.equal((await call('/api/auth/phone','POST',{code:'test'})).status,403);
    assert.equal((await call('/api/exchangers','POST',{},a.token)).status,403);
    process.env.NODE_ENV='production';
    assert.equal((await call('/api/orders','POST',{clientId:'prod'},a.token)).status,403);
    await call('/api/auth/logout','POST',{},a.token);
    assert.equal((await call('/api/me','GET',undefined,a.token)).status,401);
    const saved=JSON.parse(await fs.readFile(path.join(directory,'db.json'),'utf8'));
    assert.equal(saved.messages.length,1);
    assert.equal(JSON.stringify(saved).includes('test-private-key'),false);
  } finally {
    global.fetch=originalFetch; server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    // 保留临时测试目录便于排查；从不接触项目中的真实数据。
  }
});
