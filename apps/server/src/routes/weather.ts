import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import NcmApiDefault from 'NeteaseCloudMusicApi';
import { getNeteaseCookie } from '../neteaseSession';

// NCM 自带类型过于严格，路由层按宽松类型调用（与 music.ts 保持一致）
const NcmApi = NcmApiDefault as unknown as Record<string, (query?: any) => Promise<any>>;

const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

const WEATHER_DEFAULT_LOCATION = {
  name: '上海',
  country: 'China',
  admin1: '',
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: 'Asia/Shanghai'
};

interface WeatherMood {
  key: string;
  title: string;
  tagline: string;
  energy: number;
  warmth: number;
  focus: number;
  melancholy: number;
  keywords: string[];
}

interface WeatherInfo {
  provider: 'open-meteo';
  location: {
    name: string;
    country: string;
    admin1: string;
    latitude: number | null;
    longitude: number | null;
    timezone: string;
    fallback?: boolean;
  };
  label: string;
  weatherCode: number | null;
  temperature: number | null;
  apparentTemperature: number | null;
  humidity: number | null;
  precipitation: number | null;
  cloudCover: number | null;
  windSpeed: number | null;
  windGusts: number | null;
  isDay: number | null;
  time: string;
  updatedAt: number;
  mood: WeatherMood;
}

interface SongItem {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  cover: string;
  source?: string;
}

/** 网易云歌曲对象 → 前端 SongItem */
function mapNcmSong(s: any): SongItem {
  const artists = s.ar || s.artists || [];
  const album = s.al || s.album || {};
  return {
    id: String(s.id),
    name: s.name || '',
    artist: artists.map((a: any) => a.name).filter(Boolean).join(' / '),
    album: album.name || '',
    duration: Math.round((s.dt || s.duration || 0) / 1000),
    cover: album.picUrl || s.picUrl || '',
    source: 'netease'
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Open-Meteo weather_code → 中文标签（移植桌面版 server.js） */
function openMeteoWeatherLabel(code: unknown): string {
  const c = Number(code);
  if (c === 0) return '晴';
  if (c === 1 || c === 2) return '少云';
  if (c === 3) return '阴';
  if (c === 45 || c === 48) return '雾';
  if (c === 51 || c === 53 || c === 55) return '毛毛雨';
  if (c === 56 || c === 57) return '冻雨';
  if (c === 61 || c === 63 || c === 65) return '雨';
  if (c === 66 || c === 67) return '冻雨';
  if (c === 71 || c === 73 || c === 75 || c === 77) return '雪';
  if (c === 80 || c === 81 || c === 82) return '阵雨';
  if (c === 85 || c === 86) return '阵雪';
  if (c === 95 || c === 96 || c === 99) return '雷雨';
  return '天气';
}

/** 天气 → 电台心情（能量/温暖度/专注度/忧郁度 + 选歌关键词），移植桌面版 buildWeatherMood */
export function buildWeatherMood(weather: Partial<WeatherInfo>, date = new Date()): WeatherMood {
  const hour = date.getHours();
  const code = Number(weather.weatherCode);
  const temp = Number(weather.temperature);
  const apparent = Number(weather.apparentTemperature);
  const rain = Number(weather.precipitation) || 0;
  const humidity = Number(weather.humidity) || 0;
  const wind = Number(weather.windSpeed) || 0;
  const isNight = (weather.isDay === 0) || hour < 6 || hour >= 20;
  const isMorning = hour >= 5 && hour < 11;
  const isDusk = hour >= 17 && hour < 20;
  const isRain = rain > 0 || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code);
  const isSnow = [71, 73, 75, 77, 85, 86].includes(code);
  const isCloud = [2, 3, 45, 48].includes(code);
  const isStorm = [95, 96, 99].includes(code);
  const feels = Number.isFinite(apparent) ? apparent : temp;

  let mood: WeatherMood = {
    key: 'clear',
    title: '晴朗电台',
    tagline: '让节奏亮一点，像窗边的光',
    energy: 0.62,
    warmth: 0.58,
    focus: 0.48,
    melancholy: 0.24,
    keywords: ['轻快 华语', 'city pop', 'indie pop', 'chill pop', '阳光 歌单']
  };
  if (isStorm) {
    mood = {
      key: 'storm',
      title: '雷雨电台',
      tagline: '低频更厚，适合把世界关小一点',
      energy: 0.46,
      warmth: 0.34,
      focus: 0.66,
      melancholy: 0.62,
      keywords: ['暗色 R&B', 'trip hop', '夜晚 电子', '氛围 摇滚', '雨夜 歌单']
    };
  } else if (isRain) {
    mood = {
      key: 'rain',
      title: '雨天电台',
      tagline: '留一点潮湿的空间给旋律',
      energy: 0.38,
      warmth: 0.42,
      focus: 0.64,
      melancholy: 0.66,
      keywords: ['雨天 R&B', 'lofi rainy', '华语 慢歌', 'dream pop', '雨夜 歌单']
    };
  } else if (isSnow || feels <= 3) {
    mood = {
      key: 'snow',
      title: '冷空气电台',
      tagline: '干净、慢速、带一点冬天的颗粒感',
      energy: 0.34,
      warmth: 0.28,
      focus: 0.72,
      melancholy: 0.54,
      keywords: ['冬天 民谣', 'ambient piano', '日系 冬天', 'indie folk', '安静 歌单']
    };
  } else if (feels >= 31 || humidity >= 78) {
    mood = {
      key: 'humid',
      title: '闷热电台',
      tagline: '降低密度，留出一点呼吸',
      energy: 0.48,
      warmth: 0.76,
      focus: 0.46,
      melancholy: 0.30,
      keywords: ['夏日 chill', 'bossa nova', 'city pop 夏天', '轻电子', '海边 歌单']
    };
  } else if (isCloud) {
    mood = {
      key: 'cloudy',
      title: '阴天电台',
      tagline: '不急着明亮，先让声音变软',
      energy: 0.40,
      warmth: 0.46,
      focus: 0.58,
      melancholy: 0.52,
      keywords: ['阴天 华语', 'indie rock mellow', 'neo soul', 'chillhop', '独立 民谣']
    };
  }

  if (isNight) {
    mood.key += '-night';
    mood.title = mood.key.startsWith('clear') ? '夜色电台' : mood.title.replace('电台', '夜听');
    mood.tagline = '音量放低一点，让夜色参与编曲';
    mood.energy = Math.min(mood.energy, 0.42);
    mood.focus = Math.max(mood.focus, 0.68);
    mood.melancholy = Math.max(mood.melancholy, 0.52);
    mood.keywords = ['夜晚 R&B', 'late night jazz', 'ambient', 'lofi sleep', '夜跑 歌单'].concat(mood.keywords.slice(0, 3));
  } else if (isMorning) {
    mood.title = mood.key.startsWith('rain') ? '雨晨电台' : '早晨电台';
    mood.energy = Math.max(mood.energy, 0.52);
    mood.keywords = ['早晨 通勤', 'morning acoustic', '清晨 indie', '轻快 华语'].concat(mood.keywords.slice(0, 3));
  } else if (isDusk) {
    mood.title = mood.key.startsWith('rain') ? '黄昏雨声' : '黄昏电台';
    mood.melancholy = Math.max(mood.melancholy, 0.48);
    mood.keywords = ['黄昏 city pop', '日落 歌单', '落日飞车', 'soul pop'].concat(mood.keywords.slice(0, 3));
  }

  if (wind >= 28) {
    mood.energy = Math.max(mood.energy, 0.56);
    mood.keywords = ['公路 摇滚', 'windy day playlist'].concat(mood.keywords.slice(0, 4));
  }
  mood.keywords = Array.from(new Set(mood.keywords)).slice(0, 7);
  return mood;
}

/** 城市名 → 经纬度（Open-Meteo 地理编码，失败回落默认城市） */
async function resolveOpenMeteoLocation(query: unknown): Promise<WeatherInfo['location']> {
  const raw = String(query || '').trim();
  if (!raw) return { ...WEATHER_DEFAULT_LOCATION };

  const u = new URL(OPEN_METEO_GEOCODE_URL);
  u.searchParams.set('name', raw);
  u.searchParams.set('count', '1');
  u.searchParams.set('language', 'zh');
  u.searchParams.set('format', 'json');

  const body: any = await fetch(u.toString()).then((r) => r.json());
  const first = body?.results?.[0];
  if (!first) {
    return { ...WEATHER_DEFAULT_LOCATION, fallback: true };
  }
  return {
    name: first.name || raw,
    country: first.country || '',
    admin1: first.admin1 || '',
    latitude: first.latitude,
    longitude: first.longitude,
    timezone: first.timezone || 'auto'
  };
}

/** 拉取当前天气 + 心情（移植桌面版 fetchOpenMeteoWeather） */
async function fetchOpenMeteoWeather(params: {
  city?: string;
  lat?: string;
  lon?: string;
}): Promise<WeatherInfo> {
  const lat = clampNumber(params.lat, -90, 90, NaN);
  const lon = clampNumber(params.lon, -180, 180, NaN);

  let location: WeatherInfo['location'];
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    location = {
      name: String(params.city || '当前位置').trim() || '当前位置',
      country: '',
      admin1: '',
      latitude: lat,
      longitude: lon,
      timezone: 'auto'
    };
  } else {
    location = await resolveOpenMeteoLocation(params.city);
  }

  const u = new URL(OPEN_METEO_FORECAST_URL);
  u.searchParams.set('latitude', String(location.latitude));
  u.searchParams.set('longitude', String(location.longitude));
  u.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m');
  u.searchParams.set('forecast_days', '1');
  u.searchParams.set('timezone', location.timezone || 'auto');

  const body: any = await fetch(u.toString()).then((r) => r.json());
  const cur = body?.current || {};

  const weather: WeatherInfo = {
    provider: 'open-meteo',
    location,
    label: openMeteoWeatherLabel(cur.weather_code),
    weatherCode: Number(cur.weather_code),
    temperature: Number(cur.temperature_2m),
    apparentTemperature: Number(cur.apparent_temperature),
    humidity: Number(cur.relative_humidity_2m),
    precipitation: Number(cur.precipitation || cur.rain || cur.showers || cur.snowfall || 0),
    cloudCover: Number(cur.cloud_cover),
    windSpeed: Number(cur.wind_speed_10m),
    windGusts: Number(cur.wind_gusts_10m),
    isDay: Number(cur.is_day),
    time: cur.time || '',
    updatedAt: Date.now(),
    mood: buildWeatherMood({})
  };
  weather.mood = buildWeatherMood(weather);
  return weather;
}

/** 心情 → 电台种子曲目（移植桌面版 weatherRadioSeedQueries） */
export function weatherRadioSeedQueries(mood: WeatherMood): string[] {
  const key = String(mood?.key || '');
  if (key.includes('rain') || key.includes('storm')) {
    return ['陈奕迅 阴天快乐', '周杰伦 雨下一整晚', '孙燕姿 遇见', '林宥嘉 说谎', '毛不易 消愁'];
  }
  if (key.includes('snow') || key.includes('cloudy')) {
    return ['陈奕迅 好久不见', '莫文蔚 阴天', '李健 贝加尔湖畔', '朴树 平凡之路', '蔡健雅 达尔文'];
  }
  if (key.includes('humid')) {
    return ['落日飞车 My Jinji', '告五人 爱人错过', '夏日入侵企画 想去海边', '陈绮贞 旅行的意义', '王若琳 Lost in Paradise'];
  }
  if (key.includes('night')) {
    return ['方大同 特别的人', '陶喆 爱很简单', 'Frank Ocean Pink + White', '林忆莲 夜太黑', "Norah Jones Don't Know Why"];
  }
  return ['孙燕姿 天黑黑', '周杰伦 晴天', '五月天 温柔', '陈奕迅 稳稳的幸福', '王菲'];
}

export async function weatherRoutes(fastify: FastifyInstance) {
  // 当前天气 + 心情
  fastify.get('/current', async (request: FastifyRequest, reply: FastifyReply) => {
    const { city, lat, lon } = request.query as { city?: string; lat?: string; lon?: string };

    try {
      const weather = await fetchOpenMeteoWeather({ city, lat, lon });
      return { success: true, data: weather };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '获取天气失败，请稍后重试' });
    }
  });

  // 天气电台：天气心情 → 种子关键词搜索 → 去重合并队列
  fastify.get('/radio', async (request: FastifyRequest, reply: FastifyReply) => {
    const { city, lat, lon } = request.query as { city?: string; lat?: string; lon?: string };

    try {
      const weather = await fetchOpenMeteoWeather({ city, lat, lon });
      const seeds = weatherRadioSeedQueries(weather.mood);

      const searches = await Promise.allSettled(
        seeds.map((keyword) =>
          NcmApi.cloudsearch({ keywords: keyword, type: 1, limit: 6, cookie: getNeteaseCookie(request) })
        )
      );

      const seen = new Set<string>();
      const songs: SongItem[] = [];
      for (const result of searches) {
        if (result.status !== 'fulfilled') continue;
        const raw = result.value?.body?.result?.songs || [];
        for (const s of raw) {
          const item = mapNcmSong(s);
          if (!item.id || !item.name || seen.has(item.id)) continue;
          seen.add(item.id);
          songs.push(item);
          if (songs.length >= 30) break;
        }
        if (songs.length >= 30) break;
      }

      return {
        success: true,
        data: {
          weather,
          mood: weather.mood,
          songs
        }
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ success: false, error: '天气电台开台失败，请稍后重试' });
    }
  });
}
