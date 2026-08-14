import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

// The viewer is developed inside BOMManager2, where shared libraries are two
// levels above this app. GitHub Pages checks out the viewer as its own repo,
// so the deployment workflow places those same libraries in ./shared.
const monorepoShared = path.resolve(__dirname, '../../shared');
const standaloneShared = path.resolve(__dirname, 'shared');
const shared = fs.existsSync(monorepoShared) ? monorepoShared : standaloneShared;

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

/** Best-effort — a shallow/archive checkout (or git missing from the deploy
 *  image) shouldn't fail the build over a version label. */
function gitShortHash(): string {
	try {
		return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
	}
	catch {
		return 'unknown';
	}
}

// Production (GitHub Pages): https://kaminaris.github.io/KiCadViewer/
// Dev server keeps base '/' so localhost:5173 still works.
export default defineConfig(({ command }) => ({
	base: command === 'build' ? '/KiCadViewer/' : '/',
	root: '.',
	publicDir: 'public',
	server: { port: 5173 },
	// Read by StatusBar to show which build a user is actually running —
	// see src/env.d.ts for the ambient type declarations.
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__APP_COMMIT__: JSON.stringify(gitShortHash()),
		__APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
	},
	resolve: {
		alias: {
			'@kicad-io': path.join(shared, 'kicad-io/src'),
			'@kicad-render': path.join(shared, 'kicad-render'),
			'@kicad-layout': path.join(shared, 'kicad-layout'),
			'@clipper2-ts': path.join(shared, 'clipper2-ts/src'),
		},
	},
	optimizeDeps: {
		exclude: ['@kicad-io', '@kicad-render', '@kicad-layout', '@clipper2-ts'],
	},
}));
