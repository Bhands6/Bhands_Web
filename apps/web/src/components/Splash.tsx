import { useEffect, useState } from 'react';
import { useUIStore } from '../stores/useUIStore';
import { audioEngine } from '../audio/AudioEngine';
import SplashCanvas from './SplashCanvas';

/** 启动页：品牌动画 + 桌面版同款 WebGL 背景动画 + 点击进入（同时解锁 AudioContext） */
export default function Splash() {
  const splashActive = useUIStore((s) => s.splashActive);
  const splashRevealing = useUIStore((s) => s.splashRevealing);
  const dismissSplash = useUIStore((s) => s.dismissSplash);
  const [ready, setReady] = useState(false);
  const [exiting, setExiting] = useState(false);

  // 桌面版时序：品牌字动画 5.2s，5s 后开放点击进入
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 5000);
    return () => clearTimeout(t);
  }, []);

  // 桌面版退出序列：revealing → exiting → 彻底隐藏
  useEffect(() => {
    if (splashRevealing && !exiting) setExiting(true);
  }, [splashRevealing, exiting]);

  if (!splashActive) return null;

  const handleClick = () => {
    if (exiting) return;
    audioEngine.unlock(); // 用户手势解锁音频
    dismissSplash();
  };

  return (
    <div
      id="splash"
      className={`${ready ? 'ready' : ''} ${exiting ? 'exiting' : ''}`.trim()}
      onClick={handleClick}
    >
      <SplashCanvas />
      <div className="splash-bg-noise" />
      <div className="splash-content">
        <div className="splash-wordmark" aria-label="BhandsMusic">
          <span className="splash-word-mine">Bhands</span>
          <span className="splash-word-radio">
            Mus<span className="splash-word-i" aria-hidden="true" />
            <span className="splash-word-o">c</span>
          </span>
        </div>
        <div className="splash-signal-line" />
        <div className="splash-sub">private music player</div>
        <div className="splash-enter" aria-hidden="true">点击进入</div>
      </div>
    </div>
  );
}
