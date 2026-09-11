import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildWeatherMood, weatherRadioSeedQueries, resolveOpenMeteoLocation } from './weather';

/** 正午晴天：不触发雨/雪/闷热/阴天分支的基准天气 */
const base = {
  weatherCode: 0,
  temperature: 22,
  apparentTemperature: 22,
  humidity: 50,
  precipitation: 0,
  windSpeed: 10,
  isDay: 1
};
const noon = new Date('2026-09-07T12:00:00');

describe('buildWeatherMood 天气 → 心情映射', () => {
  it('晴天正午 → 晴朗电台，能量偏高', () => {
    const mood = buildWeatherMood(base, noon);
    expect(mood.key).toBe('clear');
    expect(mood.title).toBe('晴朗电台');
    expect(mood.energy).toBeGreaterThan(0.5);
  });

  it('降雨 → 雨天电台，忧郁度上调', () => {
    const mood = buildWeatherMood({ ...base, weatherCode: 61, precipitation: 2 }, noon);
    expect(mood.key).toBe('rain');
    expect(mood.title).toBe('雨天电台');
    expect(mood.melancholy).toBeGreaterThan(0.5);
  });

  it('雷雨优先级高于普通降雨', () => {
    const mood = buildWeatherMood({ ...base, weatherCode: 95 }, noon);
    expect(mood.key).toBe('storm');
    expect(mood.title).toBe('雷雨电台');
  });

  it('低温/降雪 → 冷空气电台', () => {
    const mood = buildWeatherMood({ ...base, weatherCode: 73 }, noon);
    expect(mood.key).toBe('snow');
  });

  it('夜晚统一叠加 night 分支：能量受限、忧郁提升', () => {
    const night = new Date('2026-09-07T23:30:00');
    const mood = buildWeatherMood(base, night);
    expect(mood.key).toContain('night');
    expect(mood.energy).toBeLessThanOrEqual(0.42);
    expect(mood.melancholy).toBeGreaterThanOrEqual(0.52);
  });

  it('阴天 → 阴天电台', () => {
    const mood = buildWeatherMood({ ...base, weatherCode: 3 }, noon);
    expect(mood.key).toBe('cloudy');
    expect(mood.title).toBe('阴天电台');
  });
});

describe('weatherRadioSeedQueries 心情 → 电台种子', () => {
  it('各心情分支都返回非空种子列表', () => {
    for (const key of ['rain', 'storm', 'snow', 'cloudy', 'humid', 'clear-night', 'clear']) {
      const seeds = weatherRadioSeedQueries({ key } as any);
      expect(seeds.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveOpenMeteoLocation 地理编码兜底（2026-09-11 连接超时 500 的回归锁）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('网络失败（连接超时）回落默认城市并带 fallback 标记，不向上抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed: Connect Timeout Error')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loc = await resolveOpenMeteoLocation('北京');
    expect(loc.name).toBe('上海');
    expect(loc.fallback).toBe(true);
    expect(loc.latitude).toBeCloseTo(31.2304);
    expect(loc.longitude).toBeCloseTo(121.4737);
  });

  it('空城市直接返回默认城市，不发起任何请求', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const loc = await resolveOpenMeteoLocation('   ');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loc.name).toBe('上海');
    expect(loc.fallback).toBeUndefined();
  });

  it('正常响应时映射第一个结果（不带 fallback 标记）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: async () => ({
          results: [
            { name: '北京', country: 'China', admin1: '北京市', latitude: 39.9042, longitude: 116.4074, timezone: 'Asia/Shanghai' }
          ]
        })
      })
    );
    const loc = await resolveOpenMeteoLocation('北京');
    expect(loc.name).toBe('北京');
    expect(loc.admin1).toBe('北京市');
    expect(loc.latitude).toBe(39.9042);
    expect(loc.longitude).toBe(116.4074);
    expect(loc.timezone).toBe('Asia/Shanghai');
    expect(loc.fallback).toBeUndefined();
  });

  it('响应里无结果时也回落默认城市并带 fallback 标记', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ results: [] }) }));
    const loc = await resolveOpenMeteoLocation('不存在的地方xyz');
    expect(loc.name).toBe('上海');
    expect(loc.fallback).toBe(true);
  });
});
