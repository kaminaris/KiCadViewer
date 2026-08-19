/** Typed `createElement`/`setAttribute`/`append` shorthand — cuts DOM-builder
 *  boilerplate without introducing a templating layer (no innerHTML, so no
 *  XSS surface; every node is a real typed Element, so `el('input', ...)`
 *  still gives you an `HTMLInputElement`). This is the same DOM-building
 *  style `PropertyPanel`/`PropertiesDialog` already use one call at a time
 *  (`document.createElement` + manual property assignment) — `el()` just
 *  collapses that into one expression per node. Prefer this for any new
 *  component's markup instead of cloning existing DOM or building via
 *  innerHTML strings. */

type ElProps<K extends keyof HTMLElementTagNameMap> =
	Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'dataset'>>
	& { class?: string; style?: Partial<CSSStyleDeclaration>; dataset?: Record<string, string> };

type ElChild = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K, props?: ElProps<K>, children?: ElChild | ElChild[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (props) {
		const { class: className, style, dataset, ...rest } = props;
		if (className !== undefined) {
			node.className = className;
		}
		if (style) {
			Object.assign(node.style, style);
		}
		if (dataset) {
			Object.assign(node.dataset, dataset);
		}
		Object.assign(node, rest);
	}
	if (children !== undefined) {
		append(node, children);
	}
	return node;
}

export function append(parent: Node, children: ElChild | ElChild[]): void {
	for (const child of Array.isArray(children) ? children : [children]) {
		if (child === null || child === undefined || child === false) {
			continue;
		}
		parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
	}
}

/** The ⌕-icon + `<input type="search">` filter box used by every library
 *  list in this app — `SymbolChooser`/`FootprintChooser`'s modals and the
 *  Symbol Editor's always-visible Libraries pane. One real builder instead
 *  of the same `.symbol-chooser-search` markup hand-copied at each call
 *  site (previously: static HTML in `index.html` twice, plus a third,
 *  independently-JS-built copy in `SymbolEditorScreen.ts`). */
export function buildFilterSearch(placeholder: string): { root: HTMLDivElement; input: HTMLInputElement } {
	const icon = el('span', {});
	icon.setAttribute('aria-hidden', 'true');
	icon.textContent = '⌕';
	const input = el('input', { type: 'search', placeholder, autocomplete: 'off' });
	const root = el('div', { class: 'symbol-chooser-search' }, [icon, input]);
	return { root, input };
}

/** Inline SVG icon from a viewBox + path `d` list — mirrors the literal
 *  `<svg viewBox="0 0 24 24"><path d="..."/></svg>` markup already used
 *  throughout `index.html`/`icons.ts`, as a reusable builder instead of a
 *  string template. */
export function svgIcon(paths: string | string[], viewBox = '0 0 24 24'): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', viewBox);
	svg.setAttribute('aria-hidden', 'true');
	for (const d of Array.isArray(paths) ? paths : [paths]) {
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	return svg;
}
