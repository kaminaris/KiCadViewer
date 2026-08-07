import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';

// The viewer is developed inside BOMManager2, where shared libraries are two
// levels above this app. GitHub Pages checks out the viewer as its own repo,
// so the deployment workflow places those same libraries in ./shared.
const monorepoShared = path.resolve(__dirname, '../../shared');
const standaloneShared = path.resolve(__dirname, 'shared');
const shared = fs.existsSync(monorepoShared) ? monorepoShared : standaloneShared;

// Production (GitHub Pages): https://kaminaris.github.io/KiCadViewer/
// Dev server keeps base '/' so localhost:5173 still works.
export default defineConfig(({ command }) => ({
	base: command === 'build' ? '/KiCadViewer/' : '/',
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
}));
