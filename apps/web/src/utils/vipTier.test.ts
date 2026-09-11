import { describe, it, expect } from 'vitest';
import { resolveVipTier, vipBadgeLabel } from './vipTier';

/**
 * 会员等级判定回归测试。
 *
 * 这些用例锁住两件事：
 * 1) 位掩码语义（bit0=音乐包/VIP，bit1=黑胶VIP/SVIP）不要被后续改动破坏；
 * 2) 「保守判定」策略 —— 认不出的值一律不显示标识，避免错标会员。
 *
 * 现实背景：`login_status` 不返回 vipRights，只能靠 profile.vipType。
 */
describe('resolveVipTier（vipType 位掩码 → 会员等级）', () => {
  it('vipType = 0 且无兜底 → none（真实普通账号）', () => {
    expect(resolveVipTier({ vipType: 0 })).toBe('none');
    expect(resolveVipTier({ vipType: 0, vip: false })).toBe('none');
  });

  it('bit0（音乐包）→ vip', () => {
    expect(resolveVipTier({ vipType: 1 })).toBe('vip');
  });

  it('bit1（黑胶VIP）→ svip', () => {
    expect(resolveVipTier({ vipType: 2 })).toBe('svip');
  });

  it('两位同时命中 → 取高等级 svip', () => {
    expect(resolveVipTier({ vipType: 3 })).toBe('svip');
  });

  it('高位黑胶等级标记（如 11 = bit0+bit1+8）仍判为 svip', () => {
    expect(resolveVipTier({ vipType: 11 })).toBe('svip');
    expect(resolveVipTier({ vipType: 10 })).toBe('svip');
  });

  it('只有高位标记、两位都没命中 → 依据兜底 vip 决定', () => {
    expect(resolveVipTier({ vipType: 8 })).toBe('none');
    expect(resolveVipTier({ vipType: 8, vip: true })).toBe('vip');
  });

  it('负数 / 非法值 → none（不当作会员）', () => {
    expect(resolveVipTier({ vipType: -1 })).toBe('none');
    expect(resolveVipTier({ vipType: NaN })).toBe('none');
    expect(resolveVipTier({ vipType: undefined })).toBe('none');
  });

  it('缺字段 / 空输入 → none', () => {
    expect(resolveVipTier(null)).toBe('none');
    expect(resolveVipTier(undefined)).toBe('none');
    expect(resolveVipTier({})).toBe('none');
  });

  it('只有兜底 vip=true（后端标记为会员但无位数）→ vip', () => {
    expect(resolveVipTier({ vip: true })).toBe('vip');
    expect(resolveVipTier({ vipType: 0, vip: true })).toBe('vip');
  });

  it('小数 vipType 先取整再判位', () => {
    expect(resolveVipTier({ vipType: 2.9 })).toBe('svip');
    expect(resolveVipTier({ vipType: 1.4 })).toBe('vip');
  });
});

describe('vipBadgeLabel（角标文案）', () => {
  it('none 返回空串 → 调用方据此不渲染角标', () => {
    expect(vipBadgeLabel('none')).toBe('');
  });

  it('vip / svip 返回大写文案', () => {
    expect(vipBadgeLabel('vip')).toBe('VIP');
    expect(vipBadgeLabel('svip')).toBe('SVIP');
  });
});
