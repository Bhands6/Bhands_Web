/**
 * 网易云登录会话（单用户本地应用：内存保存 cookie）
 * 扫码成功后由 user 路由写入，进程重启后需重新登录
 */
let neteaseCookie = '';

export function setNeteaseCookie(cookie: string): void {
  neteaseCookie = cookie;
}

export function getNeteaseCookie(): string {
  return neteaseCookie;
}

export function clearNeteaseCookie(): void {
  neteaseCookie = '';
}
