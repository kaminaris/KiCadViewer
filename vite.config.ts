import { defineConfig } from 'vite';
import path from 'node:path';

 const shared = path.resolve(__dirname, '../../shared');

export default defineConfig({
	root: '.',
	publicDir: 'public',
	server: { port: 5173 },
	resolve: {
		alias: {
			'@kicad-io': path.join(shared, 'kicad-io/src'),
			'@kicad-render': path.join(shared, 'kicad-render'),
			'@kicad-layout': path.join(shared, 'kicad-layout'),
		},
	},
	optimizeDeps: {
		exclude: ['@kicad-io', '@kicad-render', '@kicad-layout'],
	},
});
