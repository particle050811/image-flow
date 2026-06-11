import { createRoot } from 'react-dom/client';
import { App } from './App';
import { clearResourceCaches } from './resourceCache';

// 先清掉历史会话累积的资源缓存，再渲染（清理异步进行，不阻塞首屏）
void clearResourceCaches();

const container = document.getElementById('app');
if (container) {
	createRoot(container).render(<App />);
}
