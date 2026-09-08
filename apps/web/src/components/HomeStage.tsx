import { useEffect, useMemo, useState } from 'react';
import { musicApi, SongItem } from '../api/music';
import { weatherApi, WeatherInfo } from '../api/weather';
import { useUIStore } from '../stores/useUIStore';
import { useUserStore } from '../stores/useUserStore';
import { useHistoryStore } from '../stores/useHistoryStore';
import { playTrack, playPlaylist, songItemToTrack } from '../services/playService';

const WEATHER_CITY_KEY = 'weatherCity';

/** 桌面版同款榜单横栏：网易云 5 大榜单（公开歌单） */
const TOPLISTS = [
  { id: '19723756', title: '飙升榜', sub: '网易云音乐 · 实时更新' },
  { id: '3778678', title: '热歌榜', sub: '网易云音乐 · 每周更新' },
  { id: '3779629', title: '新歌榜', sub: '网易云音乐 · 每日更新' },
  { id: '2884035', title: '原创榜', sub: '网易云音乐 · 每周更新' },
  { id: '991319590', title: '中文说唱榜', sub: '网易云音乐 · 每周更新' }
] as const;

/** 榜单卡片数据：封面 + 前若干首（桌面版队列式卡片） */
interface ToplistTile {
  id: string;
  title: string;
  sub: string;
  cover: string;
  tracks: { name: string; artist: string }[];
  loading: boolean;
}

/** Home 首页：每日推荐 Hero + 快捷卡片 + 推荐横栏（对应桌面版 #empty-home） */
export default function HomeStage() {
  const showToast = useUIStore((s) => s.showToast);
  const setLoginModalOpen = useUIStore((s) => s.setLoginModalOpen);
  const setQueuePanelOpen = useUIStore((s) => s.setQueuePanelOpen);
  const setQueueTab = useUIStore((s) => s.setQueueTab);

  const loggedIn = useUserStore((s) => s.loggedIn);
  const userPlaylists = useUserStore((s) => s.playlists);
  const history = useHistoryStore((s) => s.history);

  const [recommend, setRecommend] = useState<SongItem[]>([]);

  // 榜单横栏：预加载 5 大榜单（封面 + 前 12 首，展示前 8）
  const [toplistTiles, setToplistTiles] = useState<ToplistTile[]>(
    () => TOPLISTS.map((t) => ({ ...t, cover: '', tracks: [], loading: true }))
  );

  useEffect(() => {
    let cancelled = false;
    const preload = () => {
      TOPLISTS.forEach(async (t) => {
        try {
          const res = await musicApi.getPlaylistDetail(t.id);
          if (cancelled) return;
          const d = res.success ? res.data : null;
          setToplistTiles((prev) =>
            prev.map((tile) =>
              tile.id === t.id
                ? {
                    ...tile,
                    cover: d?.cover || d?.tracks?.find((s) => s.cover)?.cover || '',
                    tracks: (d?.tracks || []).slice(0, 12).map((s) => ({ name: s.name, artist: s.artist })),
                    loading: false
                  }
                : tile
            )
          );
        } catch {
          if (!cancelled) {
            setToplistTiles((prev) => prev.map((tile) => (tile.id === t.id ? { ...tile, loading: false } : tile)));
          }
        }
      });
    };

    // 启动页品牌动画期间不打 API：网络回包触发的 setState 重渲染会抢主线程，
    // 等启动页退场（splashActive → false）后再预载榜单
    if (!useUIStore.getState().splashActive) {
      preload();
      return () => { cancelled = true; };
    }
    const unsub = useUIStore.subscribe((s, prev) => {
      if (prev.splashActive && !s.splashActive) {
        unsub();
        preload();
      }
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  // 天气（城市记忆在本地，默认上海）
  const [city, setCity] = useState(() => localStorage.getItem(WEATHER_CITY_KEY) || '上海');
  const [weather, setWeather] = useState<WeatherInfo | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [radioStarting, setRadioStarting] = useState(false);
  // 天气电台歌单：随城市预取（供卡片封面 + 开台秒开）
  const [radioSongs, setRadioSongs] = useState<SongItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await musicApi.getRecommendSongs();
        if (!cancelled && res.success) setRecommend(res.data || []);
      } catch {
        // 静默，Hero 显示占位文案
      }
    })();
    return () => { cancelled = true; };
  }, [loggedIn]);

  // 拉取当前城市天气
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setWeatherLoading(true);
      try {
        const res = await weatherApi.getCurrent(city);
        if (!cancelled && res.success) setWeather(res.data);
      } catch {
        // 静默，pills 显示城市兜底
      } finally {
        if (!cancelled) setWeatherLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [city]);

  // 随城市预取天气电台歌单（封面展示 + 开台无需等待）
  useEffect(() => {
    let cancelled = false;
    setRadioSongs([]);
    (async () => {
      try {
        const res = await weatherApi.getRadio(city);
        if (!cancelled && res.success && res.data?.songs?.length) {
          setRadioSongs(res.data.songs);
        }
      } catch {
        // 静默，封面回退装饰圆盘，开台时再现场拉取
      }
    })();
    return () => { cancelled = true; };
  }, [city]);

  // 常听歌手：从最近播放统计
  const topArtist = useMemo(() => {
    const counts = new Map<string, number>();
    history.forEach((t) => {
      (t.artist || '').split(' / ').forEach((name) => {
        const a = name.trim();
        if (a) counts.set(a, (counts.get(a) || 0) + 1);
      });
    });
    return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || '';
  }, [history]);

  // 封面统一受登录态控制：未登录显示 CSS 装饰圆盘，登录后显示真实图片
  const heroCover = loggedIn ? (recommend.find((s) => s.cover)?.cover || '') : '';

  // 各功能卡片封面：取对应内容的第一张图，无封面时回退 CSS 装饰圆盘
  const playlistCover = userPlaylists.find((p) => p.cover)?.cover || '';
  const dailyCover = heroCover;
  // 私人电台从推荐里随机挑一张（推荐加载后固定，不随重渲染抖动）
  const radioCover = useMemo(() => {
    if (!loggedIn) return '';
    const withCovers = recommend.filter((s) => s.cover);
    return withCovers.length
      ? withCovers[Math.floor(Math.random() * withCovers.length)].cover
      : '';
  }, [recommend, loggedIn]);
  const continueCover = loggedIn ? (history.find((t) => t.cover)?.cover || '') : '';
  // 天气电台封面：预取歌单的第一张封面
  const weatherCover = loggedIn ? (radioSongs.find((s) => s.cover)?.cover || '') : '';
  const artistCover = useMemo(() => {
    if (!loggedIn || !topArtist) return '';
    return history.find((t) => (t.artist || '').includes(topArtist) && t.cover)?.cover || '';
  }, [history, topArtist, loggedIn]);

  // 每日推荐 / 私人电台：推荐歌曲整单播放
  const playRecommend = (shuffle = false) => {
    if (!recommend.length) {
      showToast(loggedIn ? '推荐加载中，稍后再试' : '登录后可同步每日推荐');
      if (!loggedIn) setLoginModalOpen(true);
      return;
    }
    let list = recommend;
    if (shuffle) list = [...recommend].sort(() => Math.random() - 0.5);
    const queue = list.map(songItemToTrack);
    playTrack(queue[0], queue, 0);
  };

  const openMyPlaylists = () => {
    if (!loggedIn) {
      showToast('登录后可查看网易云歌单');
      setLoginModalOpen(true);
      return;
    }
    setQueueTab('playlists');
    setQueuePanelOpen(true);
  };

  // 榜单卡片：整单入队直接播放，不弹队列面板
  const playToplist = async (t: ToplistTile) => {
    if (!loggedIn) {
      showToast('登录后可打开榜单');
      setLoginModalOpen(true);
      return;
    }
    await playPlaylist(t.id, t.title);
  };

  const playContinue = () => {
    if (!history.length) {
      showToast('最近播放会出现在这里');
      return;
    }
    const queue = [...history];
    playTrack(queue[0], queue, 0);
  };

  // 天气电台：按当前心情开台（优先用预取歌单，未就绪时现场拉取）
  const startWeatherRadio = async () => {
    if (radioStarting) return;
    setRadioStarting(true);
    try {
      let songs = radioSongs;
      let moodTitle = weather?.mood.title;
      if (!songs.length) {
        const res = await weatherApi.getRadio(city);
        if (res.success && res.data?.songs?.length) {
          songs = res.data.songs;
          moodTitle = res.data.mood.title;
        }
      }
      if (songs.length) {
        const queue = songs.map(songItemToTrack);
        playTrack(queue[0], queue, 0);
        showToast(`${moodTitle || '天气电台'} · 已开台`);
      } else {
        showToast('天气电台暂时没有找到歌，稍后再试');
      }
    } catch {
      showToast('天气电台开台失败，请检查网络');
    } finally {
      setRadioStarting(false);
    }
  };

  // 切换城市
  const changeCity = () => {
    const next = (window.prompt('输入城市名（如：北京 / Tokyo）', city) || '').trim();
    if (!next || next === city) return;
    localStorage.setItem(WEATHER_CITY_KEY, next);
    setCity(next);
  };

  // 常听歌手：搜索热播歌手并播放
  const playTopArtist = async () => {
    if (!topArtist) {
      showToast('播放几首后为你总结常听歌手');
      return;
    }
    try {
      const res = await musicApi.search(topArtist, 20);
      if (res.success && res.data?.length) {
        const queue = res.data.map(songItemToTrack);
        playTrack(queue[0], queue, 0);
        showToast(`正在听 ${topArtist} 的歌`);
      } else {
        showToast('没有找到相关歌曲');
      }
    } catch {
      showToast('搜索失败，请稍后再试');
    }
  };

  // 天气 pills（城市可点击更换）
  const weatherPills: string[] = weather
    ? [
        weather.location.name,
        `${weather.label} ${Math.round(weather.temperature || 0)}°`,
        `体感 ${Math.round(weather.apparentTemperature ?? weather.temperature ?? 0)}°`,
        ...(weather.humidity != null && Number.isFinite(weather.humidity)
          ? [`湿度 ${Math.round(weather.humidity)}%`]
          : [])
      ]
    : [city];

  return (
    <section id="empty-home" aria-label="BhandsMusic home">
      <div className="empty-home-shell">
        {/* Hero：每日推荐 */}
        <div
          className="home-hero"
          id="hero-daily-bg"
          onClick={() => playRecommend(false)}
          style={{ cursor: 'pointer' }}
        >
          <div
            className={`home-hero-cover-full${heroCover ? ' has-cover' : ''}`}
            id="hero-daily-art"
            style={heroCover ? { backgroundImage: `url(${heroCover})` } : undefined}
          />
          <div className="home-hero-cover-overlay" />
          {!loggedIn && <div className="home-hero-login-hint">请登录获取详细体验</div>}
          <div className="home-hero-bottom">
            <div className="home-card-label">Daily Mix</div>
            <div className="home-card-title">每日推荐</div>
            <div className="home-card-sub">
              {loggedIn ? `已登录，为你准备了 ${recommend.length || '…'} 首歌曲` : '登录后同步你的今日歌曲'}
            </div>
            <div className="home-hero-actions">
              <button
                className="home-play-btn"
                type="button"
                onClick={(e) => { e.stopPropagation(); playRecommend(false); }}
                title="播放每日推荐"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                <span>立即播放</span>
              </button>
              <button
                className="home-chip home-console-chip"
                type="button"
                onClick={(e) => { e.stopPropagation(); playRecommend(true); }}
              >
                私人电台
              </button>
            </div>
            {/* 天气 pills */}
            <div className="home-weather-meta" onClick={(e) => e.stopPropagation()}>
              {weatherPills.map((text, i) => (
                <button
                  key={text + i}
                  className="home-weather-pill"
                  type="button"
                  onClick={changeCity}
                  title={i === 0 ? '点击更换城市' : undefined}
                  style={i === 0 ? { cursor: 'pointer' } : undefined}
                >
                  {text}
                  {i === 0 && weatherLoading ? '…' : ''}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 快捷卡片 */}
        <div className="home-grid">
          <button className="home-card" data-home-tone="library" type="button" onClick={openMyPlaylists}>
            <div className="home-card-label">Library</div>
            <div className="home-card-title">我的歌单</div>
            <div className="home-card-sub">{loggedIn ? '打开左侧歌单库' : '登录后查看网易云歌单'}</div>
            <div
              className={`home-card-art${playlistCover ? ' has-cover' : ''}`}
              style={playlistCover ? { backgroundImage: `url(${playlistCover})` } : undefined}
            />
          </button>

          <button className="home-card" data-home-tone="mix" type="button" onClick={() => playRecommend(false)}>
            <div className="home-card-label">Daily</div>
            <div className="home-card-title">每日推荐</div>
            <div className="home-card-sub">{loggedIn ? '今日 30 首 · 点击播放' : '登录后同步你的今日歌曲'}</div>
            <div
              className={`home-card-art${dailyCover ? ' has-cover' : ''}`}
              style={dailyCover ? { backgroundImage: `url(${dailyCover})` } : undefined}
            />
          </button>

          <button className="home-card" data-home-tone="playlist" type="button" onClick={() => playRecommend(true)}>
            <div className="home-card-label">Song</div>
            <div className="home-card-title">私人电台</div>
            <div className="home-card-sub">从你的推荐里随机开播</div>
            <div
              className={`home-card-art${radioCover ? ' has-cover' : ''}`}
              style={radioCover ? { backgroundImage: `url(${radioCover})` } : undefined}
            />
          </button>

          <button className="home-card" data-home-tone="mix" type="button" onClick={playContinue}>
            <div className="home-card-label">Continue</div>
            <div className="home-card-title">继续听</div>
            <div className="home-card-sub">{history.length ? `上次听到「${history[0].name}」` : '最近播放会出现在这里'}</div>
            <div
              className={`home-card-art${continueCover ? ' has-cover' : ''}`}
              style={continueCover ? { backgroundImage: `url(${continueCover})` } : undefined}
            />
          </button>

          <button
            className="home-card"
            data-home-tone="weather"
            type="button"
            onClick={startWeatherRadio}
            disabled={radioStarting}
          >
            <div className="home-card-label">Weather</div>
            <div className="home-card-title">{weather ? weather.mood.title : '天气电台'}</div>
            <div className="home-card-sub">
              {radioStarting ? '正在开台…' : weather ? weather.mood.tagline : `${city} · 点击开台`}
            </div>
            <div
              className={`home-card-art${weatherCover ? ' has-cover' : ''}`}
              style={weatherCover ? { backgroundImage: `url(${weatherCover})` } : undefined}
            />
          </button>

          <button className="home-card" data-home-tone="local" type="button" onClick={playTopArtist}>
            <div className="home-card-label">Song</div>
            <div className="home-card-title">常听歌手</div>
            <div className="home-card-sub">{topArtist ? `最近常听 ${topArtist}` : '播放几首后为你总结'}</div>
            <div
              className={`home-card-art${artistCover ? ' has-cover' : ''}`}
              style={artistCover ? { backgroundImage: `url(${artistCover})` } : undefined}
            />
          </button>
        </div>

        {/* 榜单横栏（桌面版同款：5 大榜单队列式卡片） */}
        <div className="home-rail">
          <div className="home-section-head">
            <div className="home-section-title">
              {history.length ? '接着听' : loggedIn ? '你的歌单与推荐' : '先从这里开始'}
            </div>
            <div className="home-section-note">
              {toplistTiles.some((t) => t.loading)
                ? '正在整理推荐'
                : toplistTiles.some((t) => t.tracks.length)
                  ? '点击即可播放'
                  : '离线精选'}
            </div>
          </div>
          <div id="home-tile-row" className="home-tile-row">
            {toplistTiles.map((t) => {
              // 封面与其他卡片一致：未登录显示装饰圆盘
              const cover = loggedIn ? t.cover : '';
              return (
                <button
                  key={t.id}
                  className={`home-tile home-tile--queue${t.loading && !cover ? ' home-skeleton' : ''}`}
                  data-home-tone="playlist"
                  type="button"
                  onClick={() => playToplist(t)}
                  title={`${t.title} · ${t.sub}`}
                >
                  <div
                    className={`home-tile-cover${cover ? ' has-cover' : ''}`}
                    style={cover ? { backgroundImage: `url(${cover})` } : undefined}
                  />
                  <div className="home-tile-title">{t.title}</div>
                  <div className="home-tile-queue">
                    {loggedIn
                      ? t.tracks.slice(0, 8).map((s, si) => (
                          <div className="home-tile-queue-item" key={si}>
                            <span className="home-tile-queue-num">{si + 1}</span>
                            <span className="home-tile-queue-name">{s.name}</span>
                            <span className="home-tile-queue-artist">{s.artist}</span>
                          </div>
                        ))
                      : t.loading
                        ? null
                        : <div className="home-tile-queue-empty">登录后查看榜单歌曲</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
