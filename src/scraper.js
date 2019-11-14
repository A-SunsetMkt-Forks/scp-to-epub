const path = require('path');
const mime = require('mime');
const urlLib = require('url');
const config = require('./book-config');
const StaticServer = require('./lib/serve-file');
const Resource = require('./lib/resource');
const Chapter = require('./lib/chapter');
const Link = require('./lib/link');
const {safeFilename, filenameForUrl} = require('./lib/utils');

/** @typedef {import("puppeteer").Browser} Browser */
/** @typedef {import("puppeteer").Page} Page */
/** @typedef {import("puppeteer").Request} Request */
/** @typedef {import("puppeteer").Response} Response */

class Scraper {
	/**
	 *
	 * @param {import('./book-maker')} app
	 * @param {import('..').BookMakerConfig} opts
	 */
	constructor(app, opts = {}) {
		const {
			browser, cache, wikiLookup
		} = app;

		this.totalRequests = 0;

		this.initialize(opts);

		this.server = new StaticServer();

		/** @type {import("puppeteer").Browser} */
		this.browser = browser;

		/** @type {import("./lib/resource-cache")} */
		this.cache = cache;

		/** @type {import("./info-database")} */
		this.wikiLookup = wikiLookup;

		this._frontPromise = Promise.resolve();
	}
	initialize(opts = {}) {
		this.options = config.util.extendDeep({
			browser: {
				headless: false,
				debug: false,
				timeout: 10 * 60 * 1000,
				ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Googlebot Chrome/76.0.3809.132 Safari/537.36'
			},
			static: {
				prefix: '__epub__',
				root: path.join(__dirname, '..'),
				cache: true
			},
			preProcess: {
				concurrency: 1,
				useWikiDotUrls: false,
				backlinks: false,
				tags: true,
				closeTabs: true
			},
			// basically just a placeholder to allow for more advanced overrides in the future?
			hooks: {
				// run on new tab opened
				newDocument() {},
				// run before page is formatted
				beforeFormat() {},
				// run after page is formatted
				afterFormat() {},
				request: req => {
					const requestUrl = req.url();
					this.totalRequests += 1;
					// these are removed just because they hijack DOM prototypes or significantly slow down page loading
					if (
						/(nitropay|onesignal|doubleclick).*\.js.*/.test(requestUrl) &&
						(typeof req.respond === 'function')
					) {
						/** @type {Request} */(req).respond({
							// body: 'console.log("noload");',
							body: 'window.nads={createAd(){}}',
							contentType: 'application/x-javascript',
							status: 200
						});
						return true;
					}
					// loading favicon is surprisingly slow
					if (/favicon.gif/.test(requestUrl) &&
					(typeof req.respond === 'function')) {
						/** @type {Request} */(req)
							.abort('blockedbyclient')
							.catch(err => {
								console.warn('Failed to abort request', err);
							});
						return true;
					}
				},
				response() {

				}
			}
		},
		this.options,
		{
			browser: config.get('browser'),
			preProcess: config.get('preProcess'),
			static: config.get('static'),
			hooks: config.get('hooks')
		},
		opts);
	}
	/**
	 *
	 * @param {Request} request
	 */
	async interceptRequest(request) {
		const url = request.url();
		const urlObj = urlLib.parse(url);

		try {
			const isHandled = this.options.hooks.request(request);
			if (isHandled) {
				// QUESTION should this just return, and let hook do continue?
				// request.continue();
				return;
			}
		} catch (err) {
			console.warn('failure on request hook', err);
		}
		try {
			// HACK FIXME THIS IS BAD idea!!!! what if a content is dynamic? use a static file server or something instead? or maybe just let the browser use its own caching
			const cachedResponse = this.cache.getBookCache(path.posix.normalize(`./${urlObj.pathname}`));
			if (cachedResponse) {
				request.respond({
					body: cachedResponse.content,
					contentType: cachedResponse.mimeType,
					status: 200
				});
				return;
			}

			// get local content if exists
			const payload = await this.server.getFileForUrl(urlObj);
			if (payload) {
				request.respond(payload);
				return;
			}
		} catch (err) {
			console.warn('unable to intercept request', err);
		}
		if (this.options.preProcess.useWikiDotUrls && url.startsWith('http://www.scp-wiki.net')) {
			request.continue({
				url: url.replace('http://www.scp-wiki.net', 'http://scp-wiki.wikidot.com')
			});
		} else {
			request.continue();
		}
	}
	/**
	 * @param {import("puppeteer").Response} res
	 */
	async interceptResponse(res) {
		// ignore invalid
		if (!res.ok() && !res.fromCache()) {
			return;
		}

		try {
			// create as response
			const resource = Resource.fromResponse(res);

			try {
				// allow reading the response before it gets added
				this.options.hooks.response(resource, res);
			} catch (err) {
				console.warn('failure on response hook', err);
			}

			// already got it, don't care about result
			if (this.cache.get(resource)) {
				return;
			}

			// only downloading images at this time
			if (resource.isImage || resource.isDataUrl) {
				try {
					resource.content = await res.buffer();
				} catch (err) {
					// already gone, don't care about it
					if (/No resource with given identifier/.test(err.message)) {
						return;
					}
					console.warn(`Unable to read resource ${res.url()} - ${err}`)
				}
				// COMBAK this could take up A LOT of RAM...maybe store to disk or just wait?
			}

			this.cache.set(resource);
		} catch (err) {
			console.error(`Unable to load response body for ${res.url()}`, err);
		}
	}
	cleanCacheForPage(url, options) {
		return this.cache.cleanCacheForPage(url, options);
	}
	async loadPage(url, depth = 0) {
		const {closeTabs} = this.options.preProcess;
		const {
			page,
			response,
			error
		} = await this.createPage(url);

		// throw error if 404 response
		if (error) {
			await page.close();
			return error;
		}

		// QUESTION does this need to happen?
		await this.bringToFront(page);

		const forwardLinks = new Map();
		await page.exposeFunction('registerLink', async payload => {
			const existing = this.cache.get(payload.url);
			if (existing) {
				existing.addBacklinks(url);
				forwardLinks.set(Resource.asCanononical(payload.url), payload.title);
				return;
			}
			const mimeType = mime.getType(payload.url) || mime.getType('xhtml');

			// not a chapter, but content.
			// TODO COMBAK save these as resource? maybe....
			if (/image|video|audio/.test(mimeType)) {
				console.debug(`Ignoring non-html content ${payload.url}`);
				return;
			}

			const linkResource = new Link({
				url: payload.url,
				from: [url],
				depth: depth + 1,
				// TODO no need for redundancy
				id: filenameForUrl(payload.url),
				filename: filenameForUrl(payload.url, '.xhtml'),
				// hardcode as doc link
				mimeType,
				save: false
			});
			this.cache.set(linkResource);
			forwardLinks.set(Resource.asCanononical(payload.url), payload.title);
		});

		// get backlinks before formatting page
		const backlinks = this.options.preProcess.backlinks ? await this.getBacklinks(page) : [];
		const tags = this.options.preProcess.tags ? await this.getTags(page) : [];

		if (await this.shouldSkip(page, depth, tags)) {
			console.log(`Skipping page ${url} due to tags`);
			return;
		}

		// console.log('Formatting page');
		// run client-side javascript
		await this.formatPage(page);
		// replace remaining images with local paths
		await this.switchImagesToLocal(page);

		const stats = await this.getStats(page);
		const content = await this.serializePage(page);
		const chapter = new Chapter({
			title: this._formatTitle(stats),
			author: stats.author,
			stats,
			tags,
			id: safeFilename(stats.pageName),
			depth,
			url,
			save: true,
			content,
			links: forwardLinks,
			from: backlinks,
			filename: safeFilename(`${stats.pageName}`, 'xhtml'),
			mimeType: mime.getType('xhtml')
		});
		// chapter.addLinks(...forwardLinks.keys());
		// chapter.addBacklinks(backlinks);
		this.cache.set(chapter);

		// close window
		if (closeTabs && !this.options.browser.headless) {
			await page.close();
		}
		return chapter;
	}
	async createPage(url) {
		const page = await this.browser.newPage();
		page.setUserAgent(this.options.browser.ua);
		await page.setRequestInterception(true);
		page.on('request', request => this.interceptRequest(request));
		page.on('response', response => this.interceptResponse(response));
		if (this.options.browser.debug) {
			page.on('console', msg => {
				let type = `${msg.type()}`;
				if (type === 'warning') {
					type = 'warn';
				}
				const isForiegn = msg.location().url && !/__epub__/.test(msg.location().url);
				if (isForiegn && type !== 'error') {
					return;
				}
				const text = msg.text();
				// ignore these errors
				if (text.includes('ERR_BLOCKED_BY_CLIENT')) {
					return;
				}
				let fn = console[type];
				if (!fn) {
					console.debug(`invalid console msg type ${type}`);
					fn = console.log;
				}
				fn.call(console, msg.text());
			});
		}

		if (this.options.hooks.newDocument) {
			try {
				await page.evaluateOnNewDocument(this.options.hooks.newDocument);
			} catch (err) {
				console.error('Failed to add newDocument hook', err);
			}
		}

		const response = await page.goto(url, {
			waitUntil: ['load', 'domcontentloaded', 'networkidle2'],
			timeout: this.options.browser.timeout
		});

		const out = {
			page,
			response
		};

		if (response && !response.ok() && !response.fromCache()) {
			out.error = new Error(`${response.status()} ${response.statusText()}`);
			Object.assign(out.error, {
				isError: true,
				url,
				code: response.status(),
				statusCode: response.status(),
				statusText: response.statusText()
			});
		}

		return out;
	}
	async bringToFront(page) {
		// HACK dirty semaphore
		this._frontPromise = Promise.resolve(this._frontPromise)
			.then(async () => {
				try {
					await page.bringToFront();
					// sleep a tiny amount, just for sanity's sake
					await new Promise(done => setTimeout(() => done(), 10));
				} catch (err) {
					console.warn('failed to bring to front', err);
				}
			});
		return this._frontPromise;
	}
	async formatPage(page) {
		if (!page._pageBindings || !page._pageBindings.has('keepResource')) {
			await page.exposeFunction('keepResource', async (absUrl) => {
				const resource = this.cache.get(absUrl);
				if (!resource) {
					return false;
				}
				resource.save = true;

				// moved compression to here to make sure filetype conversion gets handled
				try {
					// COMBAK TODO allow for different options
					await resource.compress();
				} catch (err) {
					console.warn(`Failed to compress response - ${err}`);
				}

				return resource.bookPath;
			});
		}

		if (!page._pageBindings || !page._pageBindings.has('frameEvaluate')) {
			await page.exposeFunction('frameEvaluate', async (framePath, fnSource) => {
				try {
					const frame = page.frames().find(frame => (frame.url() || '').includes(framePath));
					if (!frame) {
						throw new Error(`Frame ${framePath} not found`);
					}
					const result = await frame.evaluate(async fnSource => {
						console.log('prerun');
						const result = await eval(`(${fnSource})()`);
						await new Promise(done => requestAnimationFrame(done));
						console.log('postrun');
						return result;
					}, fnSource);
					return result;
				} catch (err) {
					console.log('Error!', err);
					return undefined;
				}
			});
		}

		if (!page._pageBindings || !page._pageBindings.has('inlineFrameContents')) {
			await page.exposeFunction('inlineFrameContents', async (framePath, selector = 'body') => {
				const frame = page.frames().find(frame => (frame.url() || '').includes(framePath));
				if (!frame) {
					throw new Error(`Frame ${framePath} not found`);
				}
				const contents = await frame.evaluate(selector => {
					const el = document.querySelector(selector || 'body');
					if (!el) {
						throw new Error(`Element not found ${selector}`);
					}
					return el.innerHTML;
				}, selector);

				await page.evaluate((framePath, contents) => {
					/** @type {HTMLElement} */
					let frame = [...document.getElementsByTagName('iframe')].find(el => {
						return el.src && el.src.includes(framePath);
					});
					if (!frame) {
						throw new Error(`Frame ${framePath} not found`);
					}
					// replace wrapper p
					if (frame.parentElement && frame.parentElement.matches('p')) {
						frame = frame.parentElement;
					}
					frame.insertAdjacentHTML('beforebegin', contents);
					frame.remove();
				}, framePath, contents);
			});
		}

		// TODO this may timeout becaues the page is waiting for an animation frame
		// @ts-ignore
		const whenFormatted = page.waitForFunction(() => window.__epubFormattingComplete === true, {
			timeout: this.options.browser.timeout || 60 * 1000
		});

		if (this.options.hooks.beforeFormat) {
			try {
				await page.evaluate(this.options.hooks.beforeFormat);
			} catch (err) {
				console.error('beforeFormat hook failed', err);
			}
		}

		// actually run the processing
		await page.addScriptTag({
			url: await this.server.getUrlForFile('/client/epub-formatter.js', urlLib.parse(page.url())),
			type: 'module'
		});

		await whenFormatted;

		if (this.options.hooks.afterFormat) {
			try {
				await page.evaluate(this.options.hooks.afterFormat);
			} catch (err) {
				console.error('afterFormat hook failed', err);
			}
		}
	}
	async switchImagesToLocal(page) {
		if (!page._pageBindings || !page._pageBindings.has('keepThisImage')) {
			await page.exposeFunction('keepThisImage', async url => {
				let response = this.cache.get(url);
				if (!response) {
					// force image to download, response handler should catch it and put in cache
					await page.evaluateHandle(async src => {
						return new Promise((resolve, reject) => {
							const img = new Image();
							img.onload = () => {
								if (img.naturalWidth === 0) {
									return reject(new Error('Image unreadable'));
								}
								resolve();
							};
							img.onerror = reject;
							img.src = src;
						});
					}, url);

					// this is not a good guarantee...maybe use Canvas to directly create new resource?
					response = (
						this.cache.get(url) ||
						this.cache.get(url.replace('www.scp-wiki.net', 'scp-wiki.wdfiles.com'))
					);

					if (!response) {
						// throw new Error(`No asset found for ${url}`);
						console.warn(`No asset found for ${url}`);
						return url;
					}
				}
				response.save = true;

				// moved compression to here to make sure filetype conversion gets handled
				try {
					// COMBAK TODO allow for different options
					await response.compress();
				} catch (err) {
					console.warn(`Failed to compress response - ${err}`);
				}

				return response.bookPath;
			});
		}

		await page.$$eval('img', async images => {
			const out = [];
			await Promise.all(images.map(async el => {
				// ignore invalid images
				// @ts-ignore
				if (!el.src) {
					return;
				}
				try {
					// @ts-ignore
					const urlObj = new URL(el.src, window.location.href);
					const absUrl = urlObj.toString();
					// tell puppeteer to keep
					// @ts-ignore
					const newSrc = await window.keepThisImage(absUrl);
					// NOTE may cause 404, hope that's okay!
					// @ts-ignore
					el.src = newSrc;
				} catch (err) {
					console.error('Error handling image', err);
				}
			}));
		});
	}
	async getTags(page) {
		const tags = await page.$$eval('#page-content ~ .page-tags a', anchors => {
			return [...anchors]
				.map(el => `${el.textContent || ''}`.trim())
				.filter(x => x);
		});
		return tags;
	}
	async serializePage(page) {
		return page.evaluate(() => {
			const serializer = new XMLSerializer();
			return serializer.serializeToString(document);
		});
	}
	_formatTitle(stats = {}) {
		return [stats.title || stats.pageName, stats.altTitle]
			.filter(s => s)
			.join(' - ')
			.trim();
	}
	async getStats(page) {
		// COMBAK the checks for adding the site prefix havne't been tested and may not work. Especially changing the default site.
		let defaultSite = 'scp-wiki';
		// @ts-ignore
		const {defaultOrigin} = this.options;
		if (defaultOrigin && !/\/\/(www\.|)scp-wiki(\.net|\.wikidot\.com)$/.test(defaultOrigin)) {
			defaultSite = (urlLib.parse(defaultOrigin).hostname || '').replace(/www\.|\.com|\.wikidot|\.net|\.org)/g, '');
		}
		const {pageName, pageId, siteName} = await page.evaluate(defaultSite => {
			// @ts-ignore
			const info = window.WIKIREQUEST && window.WIKIREQUEST.info;
			let pageName = info && info.pageUnixName;

			if (!pageName) {
				pageName = location.pathname.slice(1).replace(/[\/\\() +&:]/g, '_');
			}
			const pageId = info && info.pageId;
			const siteName = (info && info.siteUnixName) || defaultSite;
			return { pageName, pageId, siteName };
		}, defaultSite);
		// handle tags separately
		if (/^system:page-tags/.test(pageName)) {
			const tag = page.url().split('/').slice(-1)[0];
			return {
				id: pageId,
				title: `All pages tagged "${tag}"`,
				kind: 'System',
				date: new Date('2008-07-19'),
				site: defaultOrigin,
				siteName: defaultSite,
				pageName: `tagged_${tag}`
			};
		} else if (pageName === 'forum:thread') {
			const forumFor = (new URL(page.url())).pathname.replace(/.*\//, '');
			return {
				id: pageId,
				title: `${forumFor} / Discussion`,
				kind: 'System',
				date: new Date('2008-07-19'),
				site: defaultOrigin,
				siteName: defaultSite,
				pageName: `forum_${forumFor}`
			};
		}
		const stats = await this.wikiLookup.getStats(pageName, pageId);
		stats.siteName = siteName;

		if (/^(fragment:|system:|forum:)/.test(stats.pageName)) {
			console.warn('Possibly invalid pagename', stats.pageName);
			stats.pageName = stats.pageName.replace(':', '_');
		}
		if (/\/offset\//.test(page.url())) {
			console.warn(`Offset page loaded (${stats.pageName}), this may overwrite parent`, stats);
		}
		if (siteName !== defaultSite) {
			stats.pageName = `${siteName.replace(/\./g, '_')}${stats.pageName}`;
		}
		return stats;
	}
	/**
	 * @param {Page} page
	 */
	async getBacklinks(page) {
		const backlinks = await page.evaluate(async () => {
			const timeout = 1000 * 15;
			try {
				const response = await new Promise((resolve, reject) => {
					const err = new Error('Timeout');
					err.name = 'TimeoutError';
					// @ts-ignore
					err.isTimeout = true;
					const timer = setTimeout(() => reject(err), timeout);
					// @ts-ignore
					WIKIDOT.page.callbacks.backlinksClick = res => {
						clearTimeout(timer);
						if (res.status !== 'ok') {
							reject(new Error(`Error response: ${res.status} ${res.body.slice(0, 1000)}`));
						}
						resolve(res.body);
					};
					// @ts-ignore
					WIKIDOT.page.listeners.backlinksClick();
				});
				const el = document.createElement('div');
				el.innerHTML = response;
				const backlinks = [...el.querySelectorAll('li a')]
					.map(el => el.getAttribute('href'))
					.filter(x => x && x.startsWith('/'));
				return backlinks;
			} catch (err) {
				if (err.isTimeout) {
					console.debug('No backlinks callback, likely because no session token');
				} else {
					console.warn(`Error in getting backlinks for ${document.location.href} ${err}`);
				}
				return [];
			}
		});
		return backlinks;
	}
	async shouldSkip(page, depth, tags) {
		const {
			skipMetaDepth = 1
		} = this.options.preProcess;

		if (!depth || depth < skipMetaDepth) {
			return false;
		}
		return this.wikiLookup.hasMetaTag(tags);
	}
	// TODO this is crap...remove
	async coverFromHtml(html, width = 768, height = 1024) {
		const page = await this.browser.newPage();
		await page.setViewport({ width, height, deviceScaleFactor: 1});
		await page.setContent(html, {
			waitUntil: ['load', 'domcontentloaded', 'networkidle2']
		});
		// COMBAK set size? set format as jpeg/png omitBackground?
		const imageData = await page.screenshot({
			type: 'png',
			fullPage: true,
			omitBackground: true,
			// clip: { x: 0, y: 0, width, height }
		});

		const resource = new Resource({
			id: 'cover-image',
			url: `http://localhost/cover.png`,
			content: imageData,
			filename: 'cover-image.png',
			save: true
		});
		this.cache.set(resource);
		await page.close();
	}
	// TODO remove in favor of wiki lookup
	async getLinksFromUrl(url, selector = 'body', sameDomain = true) {
		const page = await this.browser.newPage();
		await page.goto(url, { waitUntil: 'load', timeout: this.options.browser.timeout });
		const result = await this.getLinksFromPage(page, selector);
		await page.close();
		return result;
	}
	// TODO remove in favor of wiki lookup
	async getLinksFromPage(page, selector = 'body', sameDomain = true) {
		const results = await page.$eval(selector, (el, sameDomain) => {
			const base = document.location;
			const links = el.querySelectorAll('a[href]');
			return [...links]
				.map(e => {
					const href = e.href;
					console.log('checking link', href);
					if (/^javascript:/.test(href)) {
						return false;
					}
					try {
						const u = new URL(href, base.href);
						// skip invalid
						if (!/http/.test(u.protocol)) {
							return false;
						}

						const isSame = u.origin === base.origin;
						// go ahead and return local links as local
						if (isSame) {
							// why search? why not?
							//return `${u.pathname}${u.search}${u.hash}`;
						}

						// don't include if restricting to same domain only
						if (sameDomain && !isSame) {
							return false;
						}

						return href;
					} catch (err) {
						console.warn(`Unable to parse URL ${href}`, err);
						return false;
					}
				})
				// clear out nulls
				.filter(x => x);
		}, sameDomain);
		return results;
	}
	getResources() {
		return this.cache.getSaved();
	}
}

module.exports = Scraper;
