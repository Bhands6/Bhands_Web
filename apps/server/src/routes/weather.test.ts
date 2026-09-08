import { describe, it, expect } from 'vitest';
import { buildWeatherMood, weatherRadioSeedQueries } from './weather';

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
