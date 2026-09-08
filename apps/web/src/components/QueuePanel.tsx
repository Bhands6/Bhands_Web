import { useEffect, useRef } from 'react';
import { useUIStore } from '../stores/useUIStore';
import { usePlayerStore } from '../stores/usePlayerStore';
import { useUserStore } from '../stores/useUserStore';
import { playTrack, playPlaylist } from '../services/playService';

const MODE_LABELS: Record<string, string> = {
  sequence: '顺序循环',
  loop: '单曲循环',
  shuffle: '随机播放'
};

/** 左侧歌单/队列面板（对应桌面版 #playlist-panel，左缘悬停或底部队列按钮唤起） */
export default function QueuePanel() {
  const open = useUIStore((s) => s.queuePanelOpen);
  const peek = useUIStore((s) => s.queuePanelPeek);
  const pinned = useUIStore((s) => s.queuePanelPinned);
  const tab = useUIStore((s) => s.queueTab);
  const setTab = useUIStore((s) => s.setQueueTab);
  const togglePinned = useUIStore((s) => s.toggleQueuePanelPinned);
  const showToast = useUIStore((s) => s.showToast);
  const setLoginModalOpen = useUIStore((s) => s.setLoginModalOpen);

  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const playMode = usePlayerStore((s) => s.playMode);
  const setPlayMode = usePlayerStore((s) => s.setPlayMode);
  const clearPlaylist = usePlayerStore((s) => s.clearPlaylist);

  const loggedIn = useUserStore((s) => s.loggedIn);
  const userPlaylists = useUserStore((s) => s.playlists);
  const playlistsLoading = useUserStore((s) => s.playlistsLoading);
  const refreshPlaylists = useUserStore((s) => s.refreshPlaylists);

  const cls = [
    open || peek ? (open ? 'show' : 'peek') : '',
    pinned ? 'pinned' : ''
  ].filter(Boolean).join(' ');

  // 悬停意图管理：热区与面板之间的空隙用延迟收起弥合，
  // 鼠标移入任一区域取消收起，全部离开 250ms 后收回面板
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  const hoverIntentEnter = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    useUIStore.getState().setQueuePanelPeek(true);
  };

  const hoverIntentLeave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      useUIStore.getState().setQueuePanelPeek(false);
      hoverTimer.current = null;
    }, 250);
  };

  const cycleMode = () => {
    const order: Array<'sequence' | 'loop' | 'shuffle'> = ['sequence', 'loop', 'shuffle'];
    const next = order[(order.indexOf(playMode) + 1) % order.length];
    setPlayMode(next);
    showToast(`播放模式：${MODE_LABELS[next]}`);
  };

  const shuffleQueue = () => {
    if (playlist.length < 2) return;
    const shuffled = [...playlist].sort(() => Math.random() - 0.5);
    const player = usePlayerStore.getState();
    player.setPlaylist(shuffled);
    player.setCurrentIndex(0);
    playTrack(shuffled[0], shuffled, 0);
  };

  return (
    <>
      {/* 左缘悬停热区，唤起面板 */}
      <div
        style={{ position: 'fixed', left: 0, top: 0, bottom: 0, width: 18, zIndex: 16 }}
        onMouseEnter={hoverIntentEnter}
        onMouseLeave={hoverIntentLeave}
        aria-hidden="true"
      />

      <div
        id="playlist-panel"
        className={cls}
        onMouseEnter={hoverIntentEnter}
        onMouseLeave={hoverIntentLeave}
      >
        <div className="queue-head">
          <div>
            <div className="fx-title">歌单 / 队列</div>
            <div className="fx-sub">QUEUE · 鼠标移开自动隐藏</div>
          </div>
          <div className="queue-head-act">
            <button
              className={`fx-mini-btn ghost playlist-pin-btn${pinned ? ' active' : ''}`}
              onClick={togglePinned}
              title={pinned ? '取消常开' : '常开歌单'}
              style={pinned ? { color: 'var(--fc-accent)' } : undefined}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 4l6 6" /><path d="M5 15l4 4" /><path d="M14 4l-2 5-4 4-3 2 4 4 2-3 4-4 5-2z" /><path d="M9 19l-4 4" />
              </svg>
            </button>
            <button className="fx-mini-btn ghost" onClick={shuffleQueue}>随机</button>
          </div>
        </div>

        <div className="panel-tabs">
          <button className={`panel-tab${tab === 'queue' ? ' active' : ''}`} onClick={() => setTab('queue')}>当前队列</button>
          <button className={`panel-tab${tab === 'playlists' ? ' active' : ''}`} onClick={() => setTab('playlists')}>我的歌单</button>
        </div>

        {tab === 'queue' && (
          <div id="queue-pane">
            <div className="queue-toolbar">
              <div id="play-mode-chip" className="queue-chip">{MODE_LABELS[playMode]}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="fx-mini-btn ghost" onClick={cycleMode} style={{ height: 26, padding: '0 10px', fontSize: 11 }}>切换模式</button>
                <button
                  className="fx-mini-btn ghost"
                  onClick={() => { clearPlaylist(); showToast('队列已清空'); }}
                  style={{ height: 26, padding: '0 10px', fontSize: 11 }}
                >
                  清空
                </button>
              </div>
            </div>
            <div id="queue-list" className="queue-list">
              {playlist.length === 0 && <div className="queue-empty">队列为空，搜索或从首页开始播放</div>}
              {playlist.map((track, i) => (
                <div
                  key={`${track.id}_${i}`}
                  className={`queue-item${i === currentIndex ? ' now' : ''}`}
                  onClick={() => playTrack(track, playlist, i)}
                >
                  {track.cover ? (
                    <img src={track.cover} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: 'cover', flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: 34, height: 34, borderRadius: 7, background: 'rgba(255,255,255,.05)', flexShrink: 0 }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,.9)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.name}</div>
                    <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,.38)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.artist}</div>
                  </div>
                  {i === currentIndex && (
                    <span style={{ fontSize: 10, color: 'var(--fc-accent)', flexShrink: 0 }}>播放中</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'playlists' && (
          <div id="pl-pane">
            <div className="queue-toolbar">
              <div className="queue-chip">
                {loggedIn ? `网易云歌单 · ${userPlaylists.length} 个` : '登录后显示网易云歌单'}
              </div>
              <button
                className="fx-mini-btn ghost"
                onClick={() => (loggedIn ? refreshPlaylists() : setLoginModalOpen(true))}
                style={{ height: 26, padding: '0 10px', fontSize: 11 }}
              >
                {loggedIn ? '刷新' : '登录'}
              </button>
            </div>
            <div id="pl-list" style={{ marginTop: 6 }}>
              {playlistsLoading && <div className="queue-empty">加载歌单中…</div>}
              {!loggedIn && <div className="queue-empty">登录网易云音乐后，这里会显示你的歌单</div>}
              {loggedIn && !playlistsLoading && userPlaylists.length === 0 && (
                <div className="queue-empty">暂无歌单</div>
              )}
              {userPlaylists.map((pl) => (
                <div
                  key={pl.id}
                  className="pl-card"
                  onClick={async () => {
                    // 整单入队并播放，成功后切到「当前队列」tab 展示歌单内容
                    const ok = await playPlaylist(pl.id, pl.name);
                    if (ok) setTab('queue');
                  }}
                  title={`播放歌单：${pl.name}`}
                >
                  {pl.cover ? (
                    <img className="pl-card-cover" src={pl.cover} alt="" loading="lazy" />
                  ) : (
                    <div className="pl-card-cover" />
                  )}
                  <div className="pl-card-info">
                    <div className="pl-card-name">{pl.name}</div>
                    <div className="pl-card-meta">{pl.trackCount} 首</div>
                  </div>
                  <span className="pl-card-count">▶</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
