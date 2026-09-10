/**
 * 启动时加载 .env（存在时）。
 * dev（tsx watch，cwd=apps/server）与 npm start（cwd 可能是仓库根）都覆盖：
 * 依次尝试 cwd/.env → 仓库根/.env；Docker 由 compose 直接注入环境变量（镜像内无 .env）。
 * 已存在的环境变量优先级高于文件值（Node loadEnvFile 语义），组合自定义变量不受影响。
 */
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch { /* 无 .env */ }
  try { process.loadEnvFile('../../.env'); } catch { /* 无仓库根 .env */ }
}
