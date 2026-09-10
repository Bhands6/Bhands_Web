import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore, QUEUE_PANEL_AWAIT_HOVER_MS } from './useUIStore';

/**
 * 左侧歌单/队列面板的「等待鼠标移入」契约。
 *
 * 需求：从主页「我的歌单」卡片打开面板后，如果 5s 内鼠标没有移到面板上，面板自动收起，
 * 免得它一直挂在左侧挡住主页。
 * 关键不变量：**底部「队列」按钮打开时不能置位** —— 那条路径要保持常驻，
 * 否则用户点开队列、没动鼠标读一会儿就会被强行关掉。
 */
describe('队列面板 · 等待移入自动收起', () => {
  const reset = () => {
    useUIStore.setState({
      queuePanelOpen: false,
      queuePanelPeek: false,
      queuePanelPinned: false,
      queuePanelAwaitHover: false,
      queueTab: 'queue'
    });
  };

  beforeEach(reset);

  it('时间窗为 5 秒', () => {
    expect(QUEUE_PANEL_AWAIT_HOVER_MS).toBe(5000);
  });

  it('默认不处于等待移入状态', () => {
    expect(useUIStore.getState().queuePanelAwaitHover).toBe(false);
  });

  it('底部「队列」按钮路径（只 setQueuePanelOpen）不置位 → 不会被自动收起', () => {
    useUIStore.getState().setQueuePanelOpen(true);
    const s = useUIStore.getState();
    expect(s.queuePanelOpen).toBe(true);
    expect(s.queuePanelAwaitHover).toBe(false);
  });

  it('主页「我的歌单」路径置位 → 进入 5s 等待窗口', () => {
    const ui = useUIStore.getState();
    ui.setQueueTab('playlists');
    ui.setQueuePanelOpen(true);
    ui.setQueuePanelAwaitHover(true);
    const s = useUIStore.getState();
    expect(s.queuePanelOpen).toBe(true);
    expect(s.queuePanelAwaitHover).toBe(true);
    expect(s.queueTab).toBe('playlists');
  });

  it('鼠标移入（清标志）后面板保持常驻', () => {
    const ui = useUIStore.getState();
    ui.setQueuePanelOpen(true);
    ui.setQueuePanelAwaitHover(true);
    useUIStore.getState().setQueuePanelAwaitHover(false);
    const s = useUIStore.getState();
    expect(s.queuePanelAwaitHover).toBe(false);
    expect(s.queuePanelOpen).toBe(true); // 面板没被关掉
  });

  it('关闭面板会顺带清掉等待标志（避免残留影响下次打开）', () => {
    const ui = useUIStore.getState();
    ui.setQueuePanelOpen(true);
    ui.setQueuePanelAwaitHover(true);
    useUIStore.getState().setQueuePanelOpen(false);
    const s = useUIStore.getState();
    expect(s.queuePanelOpen).toBe(false);
    expect(s.queuePanelAwaitHover).toBe(false);
  });

  it('固定（pinned）可独立切换，用于豁免自动收起', () => {
    const ui = useUIStore.getState();
    ui.setQueuePanelOpen(true);
    ui.setQueuePanelAwaitHover(true);
    useUIStore.getState().toggleQueuePanelPinned();
    const s = useUIStore.getState();
    expect(s.queuePanelPinned).toBe(true);
    expect(s.queuePanelAwaitHover).toBe(true); // 置位仍在，但组件会因 pinned 跳过计时
  });
});
