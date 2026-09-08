declare module '@unblockneteasemusic/server' {
  /** 从 migu/kugou/kuwo/pyncmd 等平台匹配灰色歌曲播放源 */
  const match: (
    id: number,
    platforms: string[],
    song: { name: string; artists: { name: string }[]; album: { name: string } }
  ) => Promise<{ url: string; br?: number; size?: number; platform?: string } | null>;
  export default match;
}
