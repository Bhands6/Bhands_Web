import path from 'node:path';
import fs from 'node:fs';

/**
 * 统一的运行时数据目录（LX 脚本存档、网易云 cookie 存档等）。
 * 优先级：DATA_DIR 环境变量 → 从已知位置向上定位仓库根（含 package.json 且有 apps/ 子目录）→ cwd/data。
 * 之前 cookie 与 LX 脚本各自解析出不同目录（apps/server/data 与 apps/data），
 * 且 Docker 镜像内两者都不在挂载点上，容器重建即丢数据，这里统一收敛到 <仓库根>/data。
 *
 * 模块系统兼容：dev 由 tsx 按 ESM 运行（无 __dirname），生产编译为 CJS（有 __dirname），
 * 故用 typeof 探测后再取位置；ESM 下退化为从 cwd 向上找（npm workspace 脚本的 cwd 在 apps/server，
 * 向上一步即仓库根）。Docker 运行镜像里没有 package.json，向上定位必然失败，由 cwd/data 兜底（WORKDIR=/app）。
 */
function locateRepoRoot(): string | null {
  const starts = [
    // 生产 CJS：从编译产物位置向上找
    ...(typeof __dirname !== 'undefined' ? [__dirname] : []),
    // dev ESM：npm workspace 脚本的 cwd 在 apps/server 或仓库根
    process.cwd()
  ];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'apps'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function resolveDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const root = locateRepoRoot();
  return root ? path.join(root, 'data') : path.resolve(process.cwd(), 'data');
}

/** 确保数据目录存在并返回其路径 */
export function ensureDataDir(): string {
  const dir = resolveDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
