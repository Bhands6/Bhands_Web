/**
 * 部署/本地行为开关（配合 loadEnv 在启动时加载 .env / compose 注入）。
 *
 * 两个开关的**默认值都取部署安全侧**：镜像/裸部署什么都不配时 ——
 *  ① 不在磁盘落任何网易云登录凭据（cookie 只存内存，重启即失效）；
 *  ② 不信任 X-Forwarded-*（直连部署时该头可伪造，trustProxy=true 会让按 IP 限流整体失效）。
 * 本地生产测试想保留旧行为，在 .env 里显式打开（见 .env.example）。
 */

/** 登录 cookie 是否持久化到 data/ncm-cookies.json（默认关）。
 *  本地测试想要「重启后免重新扫码」时在 .env 设 SESSION_PERSIST=on。 */
export function sessionPersistEnabled(): boolean {
  const v = (process.env.SESSION_PERSIST || '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}

/** 是否信任反向代理头（默认关）。
 *  仅在 Caddy/nginx 反代后面部署时于 .env 设 TRUST_PROXY=1 ——
 *  这样 request.protocol（cookie Secure）与 request.ip（限流）才取到真实客户端值。 */
export function trustProxyEnabled(): boolean {
  const v = (process.env.TRUST_PROXY || '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}
