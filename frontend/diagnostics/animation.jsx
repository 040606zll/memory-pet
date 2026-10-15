import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Panda } from '../src/Panda.jsx';
import { ACTION_LABELS } from '../src/petMachine.js';
import '../src/styles.css';
/** 独立诊断页只驱动实际动画组件，不发送聊天、不修改记忆或用户会话。 */
function Diagnostic() {
  const [actions, setActions] = useState([]), [paused, setPaused] = useState(false), [metrics, setMetrics] = useState({});
  useEffect(() => { const timer = setInterval(() => setMetrics({ ...document.querySelector('.panda-stage')?.dataset }), 1000); return () => clearInterval(timer); }, []);
  return <main style={{ maxWidth: 600, margin: '20px auto', padding: 16 }}>
    <h1>熊猫动画诊断</h1>
    <div style={{ position: 'relative', height: 470, background: 'url(/assets/panda-room.png) center / cover', borderRadius: 30 }}>
      <Panda actions={actions} preview={false} mode="chat" reducedMotion={paused} />
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>{Object.entries(ACTION_LABELS).map(([name, label]) => <button key={name} onClick={() => setActions([{ name, trigger: 'explicit', duration_ms: 1800 }])}>{label}</button>)}
      <button onClick={() => setPaused(!paused)}>{paused ? '恢复动画' : '暂停动画'}</button>
    </div>
    <pre aria-label="动画指标">{JSON.stringify(metrics, null, 2)}</pre>
  </main>;
}
const root = createRoot(document.getElementById('root'));
root.render(<Diagnostic />);
// 开发热更新时释放旧组件及动画回调，诊断页避免挂载第二个 React 根。
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
