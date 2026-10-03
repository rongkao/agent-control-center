import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 埠從配置讀取（與服務端一致）：ACC_PORT 為服務端埠，ACC_WEB_PORT 為本開發伺服器埠。
// 服務端在開發模式下只放行 ACC_WEB_PORT 這個 Origin，所以埠被佔用時直接失敗（strictPort），不悄悄換埠。
const serverPort = Number(process.env.ACC_PORT || 8788);
const webPort = Number(process.env.ACC_WEB_PORT || 5174);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true,
    // 代理保留瀏覽器發來的 Host（changeOrigin 預設為 false）：服務端據此判斷請求與頁面同源
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
      '/health': `http://127.0.0.1:${serverPort}`,
      '/ws': {
        target: `ws://127.0.0.1:${serverPort}`,
        ws: true,
      },
    },
  },
});
