import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import App from './App';

const container = document.getElementById('root');
if (!container) throw new Error('缺少应用挂载节点');

createRoot(container).render(<App />);
