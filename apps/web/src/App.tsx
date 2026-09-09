import { lazy, Suspense, useEffect } from 'react';

// 舞台式 UI 组件（对应桌面版单页结构，无路由）
import Splash from './components/Splash';
import BackgroundLayer from './components/BackgroundLayer';
import HomeStage from './components/HomeStage';
import SearchArea from './components/SearchArea';
import TopCorners from './components/TopCorners';
import QueuePanel from './components/QueuePanel';
import StageLyrics from './components/StageLyrics';
import ControlBar from './components/ControlBar';
import LoginModal from './components/LoginModal';
import SettingsPanel from './components/SettingsPanel';
import Toast from './components/Toast';

// Three.js 体积大，懒加载（启动页期间并行拉取，不阻塞首屏）
const ParticleStage = lazy(() => import('./components/ParticleStage'));

import { useUIStore } from './stores/useUIStore';
import { usePlayerStore } from './stores/usePlayerStore';
import { useUserStore } from './stores/useUserStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { audioEngine } from './audio/AudioEngine';
// 副作用导入：注册切歌委托（next/prev → URL 解析后播放）
import { restoreSession } from './services/playService';

export default function App() {
  const splashActive = useUIStore((s) => s.splashActive);
  const splashRevealing = useUIStore((s) => s.splashRevealing);
  const immersive = useUIStore((s) => s.immersive);

  // 启动时恢复登录态（后端 cookie 会话）+ 恢复上次播放现场（刷新保留：队列/曲目/进度，暂停态）
  useEffect(() => {
    useUserStore.getState().init();
    restoreSession();
  }, []);

  // 网络状态提示：断网/恢复（已加载的音频可继续播放，搜索等在线功能不可用）
  useEffect(() => {
    const notify = () => {
      const { showToast } = useUIStore.getState();
      showToast(navigator.onLine ? '网络已恢复' : '网络连接已断开，在线功能暂不可用');
    };
    window.addEventListener('online', notify);
    window.addEventListener('offline', notify);
    return () => {
      window.removeEventListener('online', notify);
      window.removeEventListener('offline', notify);
    };
  }, []);

  // body 根类联动：启动页 / Home 态 / 沉浸模式
  useEffect(() => {
    document.body.classList.toggle('splash-active', splashActive);
  }, [splashActive]);

  // Home 显隐：独立视图开关（点空白处收起/点 Home 按钮展开），与播放状态解耦
  const homeVisible = useUIStore((s) => s.homeVisible);
  useEffect(() => {
    document.body.classList.toggle('empty-home-active', homeVisible);
  }, [homeVisible]);

  // 点击任意空白处收起 Home（document 级监听，覆盖页面边缘与 Home 内部 gap）
  useEffect(() => {
    // 交互组件白名单：点这些区域不收起
    const INTERACTIVE = [
      'button', 'a', 'input', 'select', 'textarea', 'label',
      '#bottom-bar', '#bottom-handle',          // 控制栏
      '#search-area',                            // 搜索框
      '#top-right', '#top-left-brand',           // 顶栏
      '#playlist-panel',                         // 队列/歌单面板
      '#fx-panel', '#fx-fab',                    // 视觉控制台
      '.modal-mask',                             // 登录弹窗
      '#splash',                                 // 启动页
      '#toast',                                  // 提示
      '#stage-lyrics',                           // 舞台歌词（点击跳播）
      '.home-hero', '.home-rail',                // Home 内容区（hero 整块可播放、横栏密集）
      '.mini-queue-popover', '.volume-popover', '.quality-popover',
      '#gesture-hud', '#hand-canvas'
    ].join(',');

    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || !useUIStore.getState().homeVisible) return;
      if (target.closest(INTERACTIVE)) return;
      useUIStore.getState().setHomeVisible(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('immersive-mode', immersive);
  }, [immersive]);

  // 节拍脉冲 → 歌词发光（仅切换 class，不触发 React 渲染）
  // Home 页可见时暂停：歌词已隐藏，无需驱动 beat-pulse 样式
  useEffect(() => {
    let last = false;
    const unsub = usePlayerStore.subscribe((state) => {
      if (useUIStore.getState().homeVisible) return;
      const beat = !!state.analyserData?.beatPulse;
      if (beat !== last) {
        last = beat;
        document.body.classList.toggle('beat-pulse', beat);
      }
    });
    return unsub;
  }, []);

  // 键盘快捷键：空格播放/暂停、←→ 进度、↑↓ 音量、L 歌词、Esc 关闭弹层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      const player = usePlayerStore.getState();
      const ui = useUIStore.getState();

      if (e.key === 'Escape') {
        if (ui.loginModalOpen) ui.setLoginModalOpen(false);
        else if (ui.queuePanelOpen) ui.setQueuePanelOpen(false);
        else if (useSettingsStore.getState().panelOpen) useSettingsStore.getState().setPanelOpen(false);
        return;
      }
      if (typing || ui.splashActive || ui.loginModalOpen) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          audioEngine.unlock();
          player.togglePlay();
          break;
        case 'ArrowRight':
          e.preventDefault();
          player.seek(player.currentTime + 5);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          player.seek(Math.max(0, player.currentTime - 5));
          break;
        case 'ArrowUp':
          e.preventDefault();
          player.setVolume(Math.min(1, player.volume + 0.05));
          break;
        case 'ArrowDown':
          e.preventDefault();
          player.setVolume(Math.max(0, player.volume - 0.05));
          break;
        case 'l':
        case 'L':
          ui.toggleLyrics();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div id="app-stage">
      {/* 背景层：专辑封面模糊 / 渐变氛围 */}
      <BackgroundLayer />
      {/* Three.js 粒子星河：启动页退场时才挂载，521KB 分块与场景构建不与启动动画抢主线程 */}
      {(splashRevealing || !splashActive) && (
        <Suspense fallback={null}>
          <ParticleStage />
        </Suspense>
      )}
      {/* Home 舞台（未播放时展示） */}
      <HomeStage />
      {/* 顶部品牌角标 + Home/登录按钮 */}
      <TopCorners />
      {/* 搜索区 */}
      <SearchArea />
      {/* 舞台歌词 */}
      <StageLyrics />
      {/* 左侧队列/歌单面板 */}
      <QueuePanel />
      {/* 底部控制台 + 唤起手柄 */}
      <ControlBar />
      {/* 登录模态 */}
      <LoginModal />
      {/* 视觉控制台（右下角 FAB + 面板） */}
      <SettingsPanel />
      {/* 全局提示 */}
      <Toast />
      {/* 启动页（最上层，退出后卸载） */}
      <Splash />
    </div>
  );
}
