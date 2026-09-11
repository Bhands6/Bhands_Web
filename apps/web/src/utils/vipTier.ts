/**
 * 网易云会员等级判定。
 *
 * 背景：`profile.vipType` 是一个**位掩码**（网易云 Web 端就是这么解析的），
 * 不是「等级数字」。已知的位含义：
 *   bit0 (1)  音乐包（VIP）
 *   bit1 (2)  黑胶VIP（SVIP）
 *   高位      黑胶等级标记（例如 11 = 黑胶VIP7级、10 = 黑胶VIP5级……）
 *
 * ⚠️ 这里刻意做**保守判定**：
 * 网易云没有公开权威的位表，网上流传的说法互相矛盾（有说「非零即VIP」，
 * 有说「11 才是」）。所以我们只在能明确解释时给出等级，
 * 认不出来的值一律当作「无等级」→ 不显示标识（宁可少显示，不要错显示）。
 *
 * 另外注意：`login_status` 接口**不返回 `vipRights`**（那是评论/用户详情接口才有的），
 * 所以这里只能依赖 `vipType`。
 */

export type VipTier = 'none' | 'vip' | 'svip';

export interface VipInput {
  /** 后端透传的 profile.vipType（可能缺失或为 0） */
  vipType?: number | null;
  /** 后端已算好的布尔值，作为兜底线索 */
  vip?: boolean;
}

const BIT_MUSIC_PACKAGE = 1; // 音乐包
const BIT_BLACK_VINYL = 2; // 黑胶VIP

/**
 * 解析会员等级。
 * - 同时命中黑胶位 → svip
 * - 只命中音乐包位（或后端标记 vip 为真）→ vip
 * - 其余（含 vipType=0、负数、无法解释的值）→ none
 */
export function resolveVipTier(input: VipInput | null | undefined): VipTier {
  if (!input) return 'none';
  const raw = input.vipType;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 0;

  // 负数在网易云的语义里表示「从未开通」等特殊状态，不当作会员
  if (n <= 0) {
    // 兜底：后端若明确说 vip=true 但我们解析不出位数，按 vip 处理
    return input.vip === true ? 'vip' : 'none';
  }

  const hasBlackVinyl = (n & BIT_BLACK_VINYL) !== 0;
  const hasMusicPackage = (n & BIT_MUSIC_PACKAGE) !== 0;

  if (hasBlackVinyl) return 'svip';
  if (hasMusicPackage) return 'vip';

  // 有值但两位都没命中：只在后端也认为是 vip 时才显示 vip
  return input.vip === true ? 'vip' : 'none';
}

/** 标识文案：none 返回空串（调用方据此决定不渲染） */
export function vipBadgeLabel(tier: VipTier): string {
  if (tier === 'svip') return 'SVIP';
  if (tier === 'vip') return 'VIP';
  return '';
}
