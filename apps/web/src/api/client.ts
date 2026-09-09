import axios from 'axios';

// 开发环境走 Vite 代理（/api → localhost:3001），生产环境同源部署
const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 15000,
  // 携带 bhands_sid 会话 cookie（多账号登录隔离依赖它）
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json'
  }
});

apiClient.interceptors.response.use(
  (response) => response.data,
  (error) => {
    console.error('API Error:', error?.response?.data || error.message);
    return Promise.reject(error);
  }
);

export default apiClient;
