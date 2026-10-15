import { Component, lazy, Suspense, useState } from 'react';
import { RobotDog } from '../RobotDog.jsx';

// 3D 运行时（three.js）单独分包，只有支持 WebGL2 的浏览器才下载。
const Pet3D = lazy(() => import('./Pet3D.jsx'));

export function supportsWebGL2() {
  try {
    const context = document.createElement('canvas').getContext('webgl2');
    return Boolean(context && typeof context.getParameter === 'function');
  } catch { return false; }
}

/** 3D 出错（如显卡上下文丢失）时退回 2D 精灵版，聊天不受影响。 */
class Fallback extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.warn('3D 宠物加载失败，已切换为 2D 版本', error); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** 宠物舞台：默认 3D，?pet=2d 或不支持 WebGL2 时使用原 2D 精灵版。 */
export function PetStage(props) {
  const [use3d] = useState(() => new URLSearchParams(window.location.search).get('pet') !== '2d' && supportsWebGL2());
  const fallback = <RobotDog {...props} />;
  if (!use3d) return fallback;
  return <Fallback fallback={fallback}>
    <Suspense fallback={<div className="panda-stage"><div className="asset-loading" role="status">{props.name}正在醒来…</div></div>}>
      <Pet3D {...props} />
    </Suspense>
  </Fallback>;
}
