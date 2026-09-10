import { describe, it, expect } from 'vitest';
import { parseLyrics, parseYrc } from './useLyricsStore';

/**
 * 回归测试：对应桌面版 parseLyricText。
 * 重点覆盖 Web 版早期实现的缺陷 —— 一行多时间标签（重复段落）会丢行/把标签当正文。
 */
describe('parseLyrics（LRC 解析，对齐桌面版 parseLyricText）', () => {
  it('一行多个时间标签：展开成多条并剔除全部标签', () => {
    const lines = parseLyrics('[01:23.45][03:45.67]同一句副歌');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text)).toEqual(['同一句副歌', '同一句副歌']);
    expect(lines[0].time).toBeCloseTo(83.45, 3);
    expect(lines[1].time).toBeCloseTo(225.67, 3);
  });

  it('小数部分可选，且接受厘秒/毫秒', () => {
    const lines = parseLyrics(['[00:12]无小数', '[00:13.5]一位', '[00:14.25]两位', '[00:15.125]三位'].join('\n'));
    expect(lines.map((l) => l.time)).toEqual([12, 13.5, 14.25, 15.125]);
  });

  it('分钟/秒允许 1~2 位', () => {
    const lines = parseLyrics('[1:23.45]短格式');
    expect(lines).toHaveLength(1);
    expect(lines[0].time).toBeCloseTo(83.45, 3);
  });

  it('过滤空正文与非时间行，并按时间升序', () => {
    const lines = parseLyrics(['[00:10.00]后一句', '[00:05.00]前一句', '[00:05.00]', '[by:xxx]', '无标签行'].join('\n'));
    expect(lines.map((l) => l.text)).toEqual(['前一句', '后一句']);
    expect(lines[0].time).toBe(5);
    expect(lines[1].time).toBe(10);
  });
});

/**
 * YRC 兜底：部分歌曲网易云不返回 LRC 时间轴，只有逐字歌词（klyric）。
 * 解析失败会表现为「这首歌没有歌词」。
 */
describe('parseYrc（YRC 逐字歌词兜底，对齐桌面版 parseYrcText）', () => {
  it('行起始时间取毫秒首字段，正文由逐字拼接', () => {
    const yrc = [
      '[12000,3000](12000,300,0)你(12300,300,0)好(12600,400,0)世界',
      '[15000,2000](15000,400,0)第(15400,500,0)二句'
    ].join('\n');
    const lines = parseYrc(yrc);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text)).toEqual(['你好世界', '第二句']);
    expect(lines[0].time).toBe(12);
    expect(lines[1].time).toBe(15);
    expect(lines[0].words?.map((w) => w.time)).toEqual([12, 12.3, 12.6]);
  });

  it('逐字时间远小于行首时按相对毫秒处理', () => {
    const lines = parseYrc('[12000,3000](100,300,0)你好');
    expect(lines[0].words?.[0].time).toBeCloseTo(12.1, 3);
  });

  it('无逐字标签 / 空行时跳过或退化为整行文本', () => {
    const lines = parseYrc(['[5000,2000]整行文本', '[8000,2000]', '非法行'].join('\n'));
    expect(lines).toHaveLength(1);
    expect(lines[0].time).toBe(5);
    expect(lines[0].text).toBe('整行文本');
  });
});
