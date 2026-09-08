const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
test('页面事件、模板结构与协议优先登录',async()=>{
  let definition;
  global.Page=value=>{definition=value;};
  global.wx={showToast(){},showModal(){}};
  require('../pages/index/index');
  const template=fs.readFileSync(path.join(__dirname,'../pages/index/index.wxml'),'utf8');
  for(const match of template.matchAll(/(?:bind\w+|catch\w+)="([A-Za-z]\w*)"/g)) assert.equal(typeof definition[match[1]],'function',match[1]);
  const stack=[];
  for(const match of template.matchAll(/<(\/?)([a-z][\w-]*)\b[^>]*>/g)) {
    if(match[1]) assert.equal(stack.pop(),match[2]);
    else if(!match[0].endsWith('/>')) stack.push(match[2]);
  }
  assert.equal(stack.length,0);
  let calls=0,complete;
  global.getApp=()=>({loginByWechat(){calls++;return new Promise(resolve=>{complete=resolve;});}});
  const page={...definition,data:{...definition.data},setData(value){Object.assign(this.data,value);},finishLogin(){this.finished=true;}};
  await page.wechatQuickLogin(); assert.equal(calls,0);
  page.data.agreementAccepted=true;
  const first=page.wechatQuickLogin(); const second=page.wechatQuickLogin();
  assert.equal(calls,1); assert.equal(page.data.loginBusy,true);
  complete({token:'test',user:{id:'one'}});await Promise.all([first,second]);
  assert.equal(page.finished,true);assert.equal(page.data.loginBusy,false);
});
