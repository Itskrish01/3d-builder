import { createRoot } from 'react-dom/client';
import App from './App.jsx';

import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/controls.css';
import './styles/overlays.css';

/* No StrictMode here, deliberately: it double-invokes effects in development,
   which would build two WebGL contexts and two copies of a 260,000-blade
   world. The engine is a singleton by nature, so the check StrictMode performs
   is not one this app can satisfy. */
createRoot(document.getElementById('root')).render(<App />);
