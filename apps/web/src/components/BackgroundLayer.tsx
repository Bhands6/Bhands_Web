import { usePlayerStore } from '../stores/usePlayerStore';

/** 背景层：纯色底 + 专辑封面模糊背景（对应桌面版 #custom-bg / #album-bg） */
export default function BackgroundLayer() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const hasCover = !!currentTrack?.cover;

  return (
    <>
      <div id="custom-bg" />
      <div
        id="album-bg"
        className={hasCover ? 'visible' : ''}
        style={hasCover ? { backgroundImage: `url(${currentTrack!.cover})` } : undefined}
      />
    </>
  );
}
