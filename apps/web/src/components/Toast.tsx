import { useUIStore } from '../stores/useUIStore';

/** 全局轻提示（对应桌面版 #toast） */
export default function Toast() {
  const toastMessage = useUIStore((s) => s.toastMessage);
  const toastVisible = useUIStore((s) => s.toastVisible);

  if (!toastMessage) return null;

  return <div id="toast" className={toastVisible ? 'show' : ''}>{toastMessage}</div>;
}
