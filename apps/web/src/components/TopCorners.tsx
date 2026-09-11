import { useUIStore } from '../stores/useUIStore';
import { useUserStore } from '../stores/useUserStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { resolveVipTier, vipBadgeLabel } from '../utils/vipTier';

const BRAND = 'Bhands Music'.split('');

/** 左上品牌文字 + 右上 视觉控制台/Home/登录按钮（对应桌面版 #top-left-brand / #top-right） */
export default function TopCorners() {
  const setLoginModalOpen = useUIStore((s) => s.setLoginModalOpen);
  const user = useUserStore((s) => s.user);
  const loggedIn = useUserStore((s) => s.loggedIn);
  const panelOpen = useSettingsStore((s) => s.panelOpen);
  const togglePanel = useSettingsStore((s) => s.togglePanel);

  // 会员标识：只有登录且解析出等级时才渲染（非会员保持原样式，不占位）
  const vipTier = loggedIn ? resolveVipTier(user) : 'none';
  const vipLabel = vipBadgeLabel(vipTier);

  // 回到 Home 视图：不打断播放（音乐继续、控制栏保持）
  const goHome = () => {
    useUIStore.getState().setHomeVisible(true);
  };

  return (
    <>
      <div id="top-left-brand" aria-hidden="true">
        <span className="brand-text">
          {BRAND.map((ch, i) =>
            ch === ' ' ? (
              <span key={i} className="brand-space"> </span>
            ) : (
              <span key={i} className="brand-char" style={{ animationDelay: `${i * 0.08}s` }}>{ch}</span>
            )
          )}
        </span>
      </div>

      <div id="top-right">
        <button
          id="fx-fab"
          type="button"
          className={`icon-btn ${panelOpen ? 'active' : ''}`}
          onClick={togglePanel}
          title="视觉控制台"
          aria-label="打开视觉控制台"
        >
          <svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" viewBox="0 0 24 24">
            <path d="M4 7h8" /><path d="M16 7h4" /><circle cx="14" cy="7" r="2" />
            <path d="M4 17h4" /><path d="M12 17h8" /><circle cx="10" cy="17" r="2" />
          </svg>
        </button>
        <button
          id="home-btn"
          className="icon-btn"
          onClick={goHome}
          title="回到 Home"
          aria-label="回到 Home"
        >
          <svg width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.9" viewBox="0 0 24 24">
            <path d="M3 10.8 12 3l9 7.8" />
            <path d="M5 10v10h14V10" />
            <path d="M9.5 20v-5h5v5" />
          </svg>
        </button>
        <button
          id="user-btn"
          className={`icon-btn ${loggedIn ? 'logged-in' : 'logged-out'}${vipTier !== 'none' ? ` vip-${vipTier}` : ''}`}
          onClick={() => setLoginModalOpen(true)}
          title={
            loggedIn
              ? `已登录：${user?.nickname || ''}${vipLabel ? ` · ${vipLabel} 会员` : ''}`
              : '登录账号'
          }
        >
          {vipLabel && (
            <span className={`vip-badge vip-${vipTier}`} aria-label={`${vipLabel} 会员`}>
              {vipLabel}
            </span>
          )}
          {loggedIn ? (
            user?.avatar ? (
              <img src={user.avatar} alt="" className="user-avatar" />
            ) : (
              <span className="login-word">{(user?.nickname || '我').slice(0, 4)}</span>
            )
          ) : (
            <span className="login-word">登录</span>
          )}
        </button>
      </div>
    </>
  );
}
