const API_BASE = 'http://127.0.0.1:3000';
const tokenKey = 'oliveToken';

function request(path, method = 'GET', data) {
  return new Promise((resolve, reject) => {
    wx.request({ url: `${API_BASE}${path}`, method, data, timeout:20000, header: { authorization: `Bearer ${wx.getStorageSync(tokenKey) || ''}` }, success: response => {
      const result = response.data || {}; if (response.statusCode >= 200 && response.statusCode < 300 && result.ok !== false) resolve(result); else { const error=new Error(result.message || '请求失败'); error.statusCode=response.statusCode; reject(error); }
    }, fail: () => reject(new Error('无法连接服务，请确认后端已启动')) });
  });
}

function imageUrl(url) { return url ? `${API_BASE}${url}` : ''; }
function uploadAvatar(filePath) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath, encoding: 'base64', success: result => {
    request('/api/me/avatar', 'POST', { fileName: filePath.split('/').pop(), data: `data:image/jpeg;base64,${result.data}` }).then(resolve).catch(reject);
  }, fail: () => reject(new Error('头像读取失败')) }));
}
module.exports = { request, uploadAvatar, imageUrl, tokenKey };
