import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore } from '../stores/useUIStore';
import { useUserStore } from '../stores/useUserStore';
import { userApi } from '../api/user';
import { resolveVipTier, vipBadgeLabel } from '../utils/vipTier';

type QrPhase = 'creating' | 'waiting' | 'scanned' | 'success' | 'expired' | 'error';

const PHASE_TEXT: Record<QrPhase, string> = {
  creating: '正在生成二维码…',
  waiting: '请使用网易云音乐 App 扫码',
  scanned: '已扫码，请在手机上确认登录',
  success: '登录成功，正在同步歌单…',
  expired: '二维码已过期，请点击刷新',
  error: '二维码生成失败，请稍后刷新'
};

/** 网易云扫码登录模态（对应桌面版 #login-modal 的网易云部分） */
export default function LoginModal() {
  const open = useUIStore((s) => s.loginModalOpen);
  const setOpen = useUIStore((s) => s.setLoginModalOpen);
  const showToast = useUIStore((s) => s.showToast);
  const loginSuccess = useUserStore((s) => s.loginSuccess);
  const loggedIn = useUserStore((s) => s.loggedIn);
  const user = useUserStore((s) => s.user);
  const logout = useUserStore((s) => s.logout);
  const refreshPlaylists = useUserStore((s) => s.refreshPlaylists);

  const [qrImg, setQrImg] = useState('');
  const [phase, setPhase] = useState<QrPhase>('creating');
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRunRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // 生成二维码并轮询扫码状态
  const startQr = useCallback(async () => {
    stopPolling();
    const runId = ++pollRunRef.current;
    setPhase('creating');
    setQrImg('');

    try {
      const res = await userApi.createQr();
      if (runId !== pollRunRef.current) return;
      if (!res.success || !res.data?.key) {
        setPhase('error');
        return;
      }
      setQrImg(res.data.qrimg || '');
      setPhase('waiting');

      const key = res.data.key;
      const poll = async (attempt: number) => {
        if (runId !== pollRunRef.current) return;
        if (attempt > 120) { // 约 4 分钟
          setPhase('expired');
          return;
        }
        try {
          const check = await userApi.checkQr(key);
          if (runId !== pollRunRef.current) return;
          if (check.success) {
            const { code, user: u } = check.data;
            if (code === 803) {
              // 803 即登录成功（后端 cookie 已生效），不再依赖 user 是否拉取到
              setPhase('success');
              loginSuccess(u || null);
              showToast(`欢迎，${u?.nickname || '音乐人'}`);
              setTimeout(() => setOpen(false), 1200);
              return;
            }
            if (code === 802) setPhase('scanned');
            else if (code === 800) { setPhase('expired'); return; }
            else if (code === 801) setPhase('waiting');
          }
        } catch {
          // 网络抖动，继续轮询
        }
        if (runId !== pollRunRef.current) return;
        pollTimerRef.current = setTimeout(() => poll(attempt + 1), 2000);
      };
      poll(0);
    } catch {
      if (runId === pollRunRef.current) setPhase('error');
    }
  }, [loginSuccess, setOpen, showToast, stopPolling]);

  // 打开模态时启动 / 关闭时停止
  useEffect(() => {
    if (open && !loggedIn) startQr();
    return stopPolling;
  }, [open, loggedIn, startQr, stopPolling]);

  // 点击遮罩关闭
  const handleMaskClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) setOpen(false);
  };

  if (!open) return null;

  // 已登录：展示账号信息
  if (loggedIn) {
    // 与顶栏角标共用同一套判定，避免两处显示不一致
    const vipTier = resolveVipTier(user);
    const vipLabel = vipBadgeLabel(vipTier);
    return (
      <div className="modal-mask show" onClick={handleMaskClick}>
        <div className="modal dual-user-modal">
          <h2>账号信息</h2>
          <img
            src={user?.avatar || ''}
            alt=""
            style={{ width: 72, height: 72, borderRadius: '50%', margin: '0 auto 12px', objectFit: 'cover', background: 'rgba(255,255,255,0.1)', display: 'block' }}
          />
          <div style={{ fontSize: 15, marginBottom: 4 }}>{user?.nickname || '我'}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 20, letterSpacing: '.5px' }}>
            {vipLabel ? `网易云音乐 · ${vipLabel} 会员` : '网易云音乐 · 普通账号'}
          </div>
          <div className="btn-row">
            <button className="modal-btn" onClick={() => refreshPlaylists()}>刷新歌单</button>
            <button className="modal-btn" onClick={() => setOpen(false)}>关闭</button>
            <button
              className="modal-btn primary"
              onClick={async () => {
                await logout();
                showToast('已退出登录');
                setOpen(false);
              }}
            >
              退出登录
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 未登录：扫码登录
  return (
    <div className="modal-mask show" onClick={handleMaskClick}>
      <div className="modal dual-login-modal">
        <h2>扫码登录网易云音乐</h2>
        <div className="desc">
          使用 <b>网易云音乐 App</b> 扫码，可同步歌单、红心与每日推荐。
        </div>

        <div className="qr-shell">
          {qrImg ? (
            <img id="qr-img" src={qrImg} alt="登录二维码" />
          ) : (
            <div style={{ width: 200, height: 200, margin: '0 auto 16px', borderRadius: 14, background: 'rgba(255,255,255,.04)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,.35)', fontSize: 12 }}>
              {phase === 'creating' ? '生成中…' : '—'}
            </div>
          )}
        </div>

        <div
          id="qr-status"
          className={phase === 'scanned' || phase === 'success' ? 'scan' : phase === 'expired' || phase === 'error' ? 'fail' : ''}
        >
          {PHASE_TEXT[phase]}
        </div>

        <div className="btn-row">
          <button className="modal-btn" onClick={() => setOpen(false)}>取消</button>
          <button
            className="modal-btn"
            onClick={() => {
              setOpen(false);
              document.getElementById('search-input')?.focus();
            }}
          >
            先搜索一首歌
          </button>
          <button
            className="modal-btn primary"
            onClick={startQr}
            disabled={phase === 'creating' || phase === 'scanned' || phase === 'success'}
          >
            刷新二维码
          </button>
        </div>
      </div>
    </div>
  );
}
