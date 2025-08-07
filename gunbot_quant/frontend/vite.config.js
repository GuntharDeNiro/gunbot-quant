import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: [
      '@mantine/core',
      '@mantine/hooks',
      '@mantine/dates',
      'mantine-datatable',
      '@mantine/notifications',
      '@tabler/icons-react',
      'recharts',
      'dayjs',
      'axios',
      '@tanstack/react-query'
    ],
  },
});