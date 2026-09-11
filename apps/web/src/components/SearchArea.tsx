import { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../stores/useUIStore';
import { useSearchStore } from '../stores/useSearchStore';
import { playSearchResult, playTrack } from '../services/playService';
import { registerBlobUrl } from '../utils/blobUrls';
import type { AudioTrack } from '../audio/AudioEngine';

/** 顶部搜索区：搜索框 + 模式切换 + 结果列表 + 本地音乐导入（对应桌面版 #search-area）
 *  悬停唤起：鼠标移到屏幕最上方 10px 热区滑出，移开搜索区（含结果下拉）后收回 */
export default function SearchArea() {
  const splashActive = useUIStore((s) => s.splashActive);
  const searchMode = useUIStore((s) => s.searchMode);
  const setSearchMode = useUIStore((s) => s.setSearchMode);
  const showToast = useUIStore((s) => s.showToast);

  const query = useSearchStore((s) => s.query);
  const results = useSearchStore((s) => s.results);
  const loading = useSearchStore((s) => s.loading);
  const error = useSearchStore((s) => s.error);
  const history = useSearchStore((s) => s.searchHistory);
  const setQuery = useSearchStore((s) => s.setQuery);
  const search = useSearchStore((s) => s.search);
  const clearHistory = useSearchStore((s) => s.clearHistory);

  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // focused 的 ref 镜像：hoverLeave 闭包里读最新值
  const focusedRef = useRef(false);
  const setInputFocused = (v: boolean) => {
    focusedRef.current = v;
    setFocused(v);
    // 失焦后若鼠标已不在搜索区，直接收回
    if (!v && !pointerInsideRef.current) setRevealed(false);
  };

  // 悬停意图：热区/搜索区之间与下拉空隙用 250ms 延迟收起弥合
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerInsideRef = useRef(false);
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  const hoverEnter = () => {
    pointerInsideRef.current = true;
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setRevealed(true);
  };
  const hoverLeave = () => {
    pointerInsideRef.current = false;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // 正在输入时不收起：鼠标移开也要保住输入焦点
    if (focusedRef.current) return;
    hoverTimer.current = setTimeout(() => {
      setRevealed(false);
      hoverTimer.current = null;
    }, 250);
  };

  const showHistory = focused && !query.trim() && history.length > 0;
  // 下拉列表仅聚焦时显示：失焦/选中歌曲后自动收起
  const showResults = showHistory || (focused && (loading || !!error || results.length > 0));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && query.trim()) {
      search(query);
    }
    if (e.key === 'Escape') {
      (e.target as HTMLInputElement).blur();
    }
  };

  // 本地音乐导入：objectURL 直接播放
  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const audioFiles = Array.from(files).filter((f) => f.type.startsWith('audio/') || /\.(mp3|flac|wav|ogg|m4a)$/i.test(f.name));
    if (!audioFiles.length) {
      showToast('未识别到音频文件');
      return;
    }
    const tracks: AudioTrack[] = audioFiles.map((f) => ({
      id: `local_${f.name}_${f.size}`,
      name: f.name.replace(/\.[^.]+$/, ''),
      artist: '本地音乐',
      album: '本地导入',
      duration: 0,
      url: URL.createObjectURL(f),
      cover: '',
      source: 'local'
    }));
    // 登记 blob URL：换歌单/清队列时按引用回收（utils/blobUrls.ts），不再永久持有文件字节
    for (const t of tracks) registerBlobUrl(t.id, t.url);
    await playTrack(tracks[0], tracks, 0);
  };

  return (
    <>
      {/* 顶部悬停热区：鼠标移到最上方 10px 唤起搜索框 */}
      <div
        style={{ position: 'fixed', left: 0, right: 0, top: 0, height: 10, zIndex: 11 }}
        onMouseEnter={hoverEnter}
        onMouseLeave={hoverLeave}
        aria-hidden="true"
      />
      <div
        id="search-area"
        className={`${revealed ? 'peek' : ''}${query || results.length ? ' has-results' : ''}`}
        onMouseEnter={hoverEnter}
        onMouseLeave={hoverLeave}
      >
      <div id="search-stack">
        <div id="search-box">
          <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            id="search-input"
            type="text"
            placeholder="搜索歌曲、歌手..."
            autoComplete="off"
            spellCheck="false"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setTimeout(() => setInputFocused(false), 180)}
            disabled={splashActive}
          />
        </div>

        <div id="search-mode-tabs" className="search-mode-tabs" role="tablist" aria-label="Search mode">
          <button className={searchMode === 'song' ? 'active' : ''} onClick={() => setSearchMode('song')} aria-selected={searchMode === 'song'}>All</button>
          <button className={searchMode === 'netease' ? 'active' : ''} onClick={() => setSearchMode('netease')} aria-selected={searchMode === 'netease'}>NE</button>
        </div>

        <div id="search-results" className={showResults ? 'show' : ''}>
          {loading && <div className="search-empty">正在搜索…</div>}
          {!loading && error && <div className="search-empty">{error}</div>}
          {!loading && !error && showHistory && (
            <>
              <div className="search-empty" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>搜索历史</span>
                <button
                  className="fx-mini-btn ghost"
                  style={{ height: '24px', padding: '0 8px', fontSize: '11px' }}
                  onMouseDown={(e) => { e.preventDefault(); clearHistory(); }}
                >
                  清空
                </button>
              </div>
              {history.map((h) => (
                <div
                  key={h}
                  className="search-result"
                  onMouseDown={(e) => { e.preventDefault(); search(h); }}
                >
                  <div className="search-result-info">
                    <div className="search-result-title">{h}</div>
                    <div className="search-result-meta">历史记录</div>
                  </div>
                </div>
              ))}
            </>
          )}
          {!loading && !error && !showHistory && results.length === 0 && (
            <div className="search-empty">输入关键词搜索网易云音乐</div>
          )}
          {!loading && !error && !showHistory && results.map((song, index) => (
            <div
              key={`${song.id}_${index}`}
              className="search-result"
              onMouseDown={() => {
                playSearchResult(results, index);
                setFocused(false); // 选中后立即收起下拉
              }}
            >
              {song.cover ? (
                <img src={song.cover} alt="" loading="lazy" width={40} height={40} style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
              ) : (
                <div style={{ width: 40, height: 40, borderRadius: 6, background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} />
              )}
              <div className="search-result-info">
                <div className="search-result-title">{song.name}</div>
                <div className="search-result-meta">
                  {song.artist}{song.album ? ` · ${song.album}` : ''}
                </div>
              </div>
              <button
                className="add-btn"
                title="播放"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  playSearchResult(results, index);
                  setFocused(false);
                }}
              >
                ▶
              </button>
            </div>
          ))}
        </div>
      </div>

      <div id="upload-actions">
        <button
          id="upload-btn"
          className="icon-btn"
          title="导入本地音乐"
          onClick={() => fileInputRef.current?.click()}
        >
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp3,.flac,.wav,.ogg,.m4a,audio/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      </div>
    </>
  );
}
