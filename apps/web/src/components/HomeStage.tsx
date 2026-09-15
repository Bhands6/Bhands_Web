import { useEffect, useMemo, useRef, useState } from 'react';
import { musicApi, SongItem, AlbumItem } from '../api/music';
import { weatherApi, WeatherInfo } from '../api/weather';
import { useUIStore } from '../stores/useUIStore';
import { useUserStore } from '../stores/useUserStore';
import { useHistoryStore } from '../stores/useHistoryStore';
import { playTrack, playPlaylist, songItemToTrack } from '../services/playService';
import { readString, writeString } from '../utils/safeStorage';

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
  const setQueuePanelAwaitHover = useUIStore((s) => s.setQueuePanelAwaitHover);
  const setQueueTab = useUIStore((s) => s.setQueueTab);

  const loggedIn = useUserStore((s) => s.loggedIn);
  const guestUnlocked = useUserStore((s) => s.guestUnlocked);
  // 免登录模式总开关：登录 或 点过「不登录听歌」——之后才拉取榜单/新碟并解锁播放
  const unlocked = loggedIn || guestUnlocked;
  const userPlaylists = useUserStore((s) => s.playlists);
  const history = useHistoryStore((s) => s.history);

  const [recommend, setRecommend] = useState<SongItem[]>([]);

  // 榜单横栏：预加载 5 大榜单（封面 + 前 12 首，展示前 8）
  const [toplistTiles, setToplistTiles] = useState<ToplistTile[]>(
    () => TOPLISTS.map((t) => ({ ...t, cover: '', tracks: [], loading: true }))
  );
  const toplistLoadedRef = useRef(false);

  useEffect(() => {
    // 首访（未登录且未激活免登录）保持锁定样式，不拉数据；
    // 登录 或 点「不登录听歌」后才开始预载（ref 防重，登录态切换不重复拉）
    const unlockedNow = loggedIn || guestUnlocked;
    if (!unlockedNow) return;
    let cancelled = false;
    const preload = () => {
      if (toplistLoadedRef.current) return;
      toplistLoadedRef.current = true;
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
  }, [loggedIn, guestUnlocked]);

  // 天气（城市记忆在本地，默认上海）
  const [city, setCity] = useState(() => readString(WEATHER_CITY_KEY) || '上海');
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

  // 免登录模式：热门新碟（网易云「新碟上架」，游客可用）——每日推荐位的数据源
  // 激活免登录模式（点「不登录听歌」）后才开始拉取
  const [guestAlbums, setGuestAlbums] = useState<AlbumItem[]>([]);
  const [guestAlbumLoading, setGuestAlbumLoading] = useState(false);
  useEffect(() => {
    if (loggedIn || !guestUnlocked) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await musicApi.getTopAlbums();
        if (!cancelled && res.success) setGuestAlbums(res.data || []);
      } catch {
        // 静默，新碟横栏不显示
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

  // 封面统一受登录态控制：登录显示真实图片；激活免登录模式后 Hero/Daily 用热门新碟封面
  const heroCover = loggedIn
    ? (recommend.find((s) => s.cover)?.cover || '')
    : (guestUnlocked ? (guestAlbums.find((a) => a.cover)?.cover || '') : '');

  // 各功能卡片封面：取对应内容的第一张图，无封面时回退 CSS 装饰圆盘
  const playlistCover = userPlaylists.find((p) => p.cover)?.cover || '';
  const dailyCover = heroCover;
  // 私人电台从推荐里随机挑一张（推荐加载后固定，不随重渲染抖动）
  const radioCover = useMemo(() => {
    if (loggedIn) {
      const withCovers = recommend.filter((s) => s.cover);
      return withCovers.length
        ? withCovers[Math.floor(Math.random() * withCovers.length)].cover
        : '';
    }
    // 免登录模式：从热门新碟随机挑一张（新碟列表拉取后固定）
    if (!guestUnlocked) return '';
    const withCovers = guestAlbums.filter((a) => a.cover);
    return withCovers.length
      ? withCovers[Math.floor(Math.random() * withCovers.length)].cover
      : '';
  }, [recommend, guestAlbums, loggedIn, guestUnlocked]);
  const continueCover = loggedIn ? (history.find((t) => t.cover)?.cover || '') : '';
  // 天气电台封面：预取歌单的第一张封面
  const weatherCover = loggedIn ? (radioSongs.find((s) => s.cover)?.cover || '') : '';
  const artistCover = useMemo(() => {
    if (!loggedIn || !topArtist) return '';
    return history.find((t) => (t.artist || '').includes(topArtist) && t.cover)?.cover || '';
  }, [history, topArtist, loggedIn]);

  // 每日推荐 / 私人电台：推荐歌曲整单播放（免登录模式改用热门新碟；未激活则引导登录弹窗）
  const playRecommend = (shuffle = false) => {
    if (!loggedIn && !guestUnlocked) {
      showToast('登录，或点「不登录听歌」开始');
      setLoginModalOpen(true);
      return;
    }
    if (!loggedIn) {
      playGuestAlbumPick(shuffle);
      return;
    }
    if (!recommend.length) {
      showToast('推荐加载中，稍后再试');
      return;
    }
    let list = recommend;
    if (shuffle) list = [...recommend].sort(() => Math.random() - 0.5);
    const queue = list.map(songItemToTrack);
    playTrack(queue[0], queue, 0);
  };

  // 免登录：播放一张热门新碟（专辑全部歌曲入队）
  const playGuestAlbum = async (album: AlbumItem) => {
    if (guestAlbumLoading) return;
    setGuestAlbumLoading(true);
    try {
      const res = await musicApi.getAlbumDetail(album.id);
      const tracks = res.success ? res.data?.tracks || [] : [];
      if (!tracks.length) {
        showToast('这张专辑暂时没有可播放的歌曲');
        return;
      }
      const queue = tracks.map(songItemToTrack);
      playTrack(queue[0], queue, 0);
      showToast(`正在播放专辑「${album.name}」`);
    } catch {
      showToast('专辑加载失败，请稍后再试');
    } finally {
      setGuestAlbumLoading(false);
    }
  };

  // 免登录：从热门新碟选一张（默认最新一张，shuffle = 随机）
  const playGuestAlbumPick = (random = false) => {
    if (!guestAlbums.length) {
      showToast('热门新碟加载中，稍后再试');
      return;
    }
    const pick = random
      ? guestAlbums[Math.floor(Math.random() * guestAlbums.length)]
      : guestAlbums[0];
    playGuestAlbum(pick);
  };

  const openMyPlaylists = () => {
    if (!loggedIn) {
      showToast('登录后可查看网易云歌单');
      setLoginModalOpen(true);
      return;
    }
    setQueueTab('playlists');
    setQueuePanelOpen(true);
    // 主页打开属于「顺带看一眼」：5s 内鼠标没移到面板上就自动收起，不挡住主页
    setQueuePanelAwaitHover(true);
  };

  // 榜单卡片：整单入队直接播放，不弹队列面板（免登录模式解锁；未激活引导登录弹窗）
  const playToplist = async (t: ToplistTile) => {
    if (!unlocked) {
      showToast('登录，或点「不登录听歌」开始');
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
    writeString(WEATHER_CITY_KEY, next);
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
          {!loggedIn && !guestUnlocked && <div className="home-hero-login-hint">请登录获取详细体验</div>}
          <div className="home-hero-bottom">
            <div className="home-card-label">{loggedIn ? 'Daily Mix' : guestUnlocked ? 'New Albums' : 'Daily Mix'}</div>
            <div className="home-card-title">{loggedIn || !guestUnlocked ? '每日推荐' : '热门新碟'}</div>
            <div className="home-card-sub">
              {loggedIn
                ? `已登录，为你准备了 ${recommend.length || '…'} 首歌曲`
                : guestUnlocked
                  ? (guestAlbums.length
                      ? `网易云最新专辑 · ${guestAlbums[0].name}`
                      : '网易云最新专辑加载中…')
                  : '登录后同步你的今日歌曲'}
            </div>
            <div className="home-hero-actions">
              <button
                className="home-play-btn"
                type="button"
                onClick={(e) => { e.stopPropagation(); playRecommend(false); }}
                title={loggedIn ? '播放每日推荐' : guestUnlocked ? '播放最新新碟' : '登录后播放每日推荐'}
                disabled={!loggedIn && guestUnlocked && guestAlbumLoading}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                <span>{loggedIn ? '立即播放' : guestUnlocked ? '播放最新碟' : '立即播放'}</span>
              </button>
              <button
                className="home-chip home-console-chip"
                type="button"
                onClick={(e) => { e.stopPropagation(); playRecommend(true); }}
                disabled={!loggedIn && guestUnlocked && guestAlbumLoading}
              >
                {loggedIn ? '私人电台' : guestUnlocked ? '随机新碟' : '私人电台'}
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
            <div className="home-card-title">{loggedIn || !guestUnlocked ? '每日推荐' : '热门新碟'}</div>
            <div className="home-card-sub">
              {loggedIn
                ? '今日 30 首 · 点击播放'
                : guestUnlocked
                  ? (guestAlbums.length ? '网易云最新专辑 · 点击播放' : '最新专辑加载中…')
                  : '登录后同步你的今日歌曲'}
            </div>
            <div
              className={`home-card-art${dailyCover ? ' has-cover' : ''}`}
              style={dailyCover ? { backgroundImage: `url(${dailyCover})` } : undefined}
            />
          </button>

          <button className="home-card" data-home-tone="playlist" type="button" onClick={() => playRecommend(true)}>
            <div className="home-card-label">Song</div>
            <div className="home-card-title">私人电台</div>
            <div className="home-card-sub">
              {loggedIn ? '从你的推荐里随机开播' : guestUnlocked ? '从热门新碟随机开播' : '登录后按推荐随机开播'}
            </div>
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

        {/* 免登录模式：热门新碟横栏（网易云新碟上架，点卡片整张播放） */}
        {!loggedIn && guestUnlocked && guestAlbums.length > 0 && (
          <div className="home-rail">
            <div className="home-section-head">
              <div className="home-section-title">热门新碟</div>
              <div className="home-section-note">
                {guestAlbumLoading ? '正在打开专辑…' : '网易云最新专辑 · 点击整张播放'}
              </div>
            </div>
            <div id="home-tile-row" className="home-tile-row">
              {guestAlbums.map((a) => (
                <button
                  key={a.id}
                  className="home-tile home-tile--queue"
                  data-home-tone="playlist"
                  type="button"
                  onClick={() => playGuestAlbum(a)}
                  disabled={guestAlbumLoading}
                  title={`${a.name} · ${a.artist}`}
                >
                  <div
                    className={`home-tile-cover${a.cover ? ' has-cover' : ''}`}
                    style={a.cover ? { backgroundImage: `url(${a.cover})` } : undefined}
                  />
                  <div className="home-tile-title">{a.name}</div>
                  <div className="home-tile-queue">
                    <div className="home-tile-queue-item">
                      <span className="home-tile-queue-num">♪</span>
                      <span className="home-tile-queue-name">{a.artist}</span>
                      <span className="home-tile-queue-artist">{a.size} 首</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 榜单横栏（桌面版同款：5 大榜单队列式卡片） */}
        <div className="home-rail">
          <div className="home-section-head">
            <div className="home-section-title">
              {history.length ? '接着听' : loggedIn ? '你的歌单与推荐' : '先从这里开始'}
            </div>
            <div className="home-section-note">
              {!unlocked
                ? '登录或点「不登录听歌」解锁'
                : toplistTiles.some((t) => t.loading)
                  ? '正在整理推荐'
                  : toplistTiles.some((t) => t.tracks.length)
                    ? '点击即可播放'
                    : '离线精选'}
            </div>
          </div>
          <div id="home-tile-row" className="home-tile-row">
            {toplistTiles.map((t) => (
              <button
                key={t.id}
                className={`home-tile home-tile--queue${t.loading && unlocked && !t.cover ? ' home-skeleton' : ''}`}
                data-home-tone="playlist"
                type="button"
                onClick={() => playToplist(t)}
                title={`${t.title} · ${t.sub}`}
              >
                <div
                  className={`home-tile-cover${unlocked && t.cover ? ' has-cover' : ''}`}
                  style={unlocked && t.cover ? { backgroundImage: `url(${t.cover})` } : undefined}
                />
                <div className="home-tile-title">{t.title}</div>
                <div className="home-tile-queue">
                  {!unlocked
                    ? <div className="home-tile-queue-empty">登录后查看榜单歌曲</div>
                    : t.loading && !t.tracks.length
                      ? null
                      : t.tracks.slice(0, 8).map((s, si) => (
                          <div className="home-tile-queue-item" key={si}>
                            <span className="home-tile-queue-num">{si + 1}</span>
                            <span className="home-tile-queue-name">{s.name}</span>
                            <span className="home-tile-queue-artist">{s.artist}</span>
                          </div>
                        ))}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
