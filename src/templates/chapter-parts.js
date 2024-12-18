const config = require('../book-config');
const Chapter = require('../lib/chapter');
const {filenameForUrl, escape} = require('../lib/utils');

function genSystemChapterHeader(chapter, config = {}) {
	const {
		stats
	} = chapter;

	return `<header class="chapter-header chapter-meta system-page">
		<h1 id="page-title">${escape(stats.title || stats.pageName)}</h1>
	</header>`;
}

/**
 *
 * @param {import('../lib/chapter')} chapter
 * @param {{url: string, title: string}[]} audioAdaptations
 * @param {import('../..').BookOptions} options
 */
function genChapterHeader(chapter, audioAdaptations = [], options = {}) {
	const {
		stats,
		url,
		forwardLinks: links = []
	} = chapter;

	if (chapter.isSystemPage) {
		return genSystemChapterHeader(chapter, options);
	}

	/** @type {Date | undefined} */
	let date = stats.date ? new Date(stats.date) : undefined;

	if (date && isNaN(date.getTime())) {
		console.warn(`Failed processing posted date for ${chapter.title} - value is ${JSON.stringify(stats.date)}`);
		date = undefined;
	}

	const {
		showRating = true,
		includeAudioAdaptations = true,
		includeReferences = false,
        showTags = true
	} = options;

	const rows = [];

	if (stats.author) {
		rows.push(['By', escape(stats.author)]);
	}
	if (date) {
		rows.push(['Posted', `<time datetime="${date.toISOString()}">${date.toDateString()}</time>`]);
	}

	if (stats.rating && showRating) {
		rows.push(['Rating', escape(stats.rating)]);
	}
	if (stats.score && showRating) {
		rows.push(['Wilson Score', escape(stats.score)]);
	}

	if (stats.isHeritage) {
		rows.push(['', '(Heritage Collection)']);
	}

	// TODO fix References ....
	// if (links && (links.length > 0) && includeReferences) {
	// 	rows.push(['Referenced By', `<ul id="internal-references" style="list-style-type: none;">${
	// 		links.map(link => {
	// 			if (typeof link === 'string') {
	// 				const u = new URL(link, defaultOrigin);
	// 				link = {
	// 					url: u.pathname,
	// 					title: u.pathname.slice(1)
	// 				};
	// 			}
	// 			return `<li><a href="${link.url}">Back to ${link.titleHTML}</a></li>`
	// 		})
	// 		.join('')
	// 	}</ul>`]);
	// }

	const {altTitle = ''} = stats;
	const title = stats.title || stats.pageName || '';

	return `<header class="chapter-header chapter-meta">
		<p><br /></p>
		<h1 id="page-title">${escape(title)}</h1>
		<p role="doc-subtitle">${escape(altTitle)}</p>
		<aside class="chapter-meta-list">
			<ul>${
				rows
					.map(([key, value]) => `<li>${key ? `<b>${escape(key)}:</b>` : ''} ${value}</li>`)
					.join('')
			}<li><cite><a href="${url}" data-external="true">Original Version</a></cite></li>
			</ul>${
				(
					audioAdaptations &&
					(audioAdaptations.length > 0) &&
					includeAudioAdaptations
				) ? `<h3 class="align-center">Audio Adaptations</h3><ul>${
					audioAdaptations.map(x => {
						return `<li><a href="${escape(x.url)}">${escape(x.title)}</a>&#160;</li>`;
					}).join('')
				}</ul>` : ''
			}
		</aside>
	</header>`;
}

/**
 * 
 * @param {Chapter} chapter 
 * @param {Array<{title: string, url: string}>} bookLinks 
 * @param {Array<{title: string, url: string}>} externalLinks 
 * @param {import('../..').BookMakerConfig} options 
 * @returns 
 */
function genChapterFooter(chapter, bookLinks = [], externalLinks = [], options = {}) {
    const {
		stats,
		url,
		forwardLinks: links = []
	} = chapter;

    const refText = bookLinks.length && `<nav>
        <h3>Referenced By:</h3>
        <ol>${
            bookLinks
                .map(({title, url}) => `<li><a href="${url}">${escape(title)}</a></li>`)
                .join('')
        }</ol>
    </nav>`;
    const extLinks = externalLinks.length && `<aside>
        <h3>External Links:</h3>
        <ul>${
            externalLinks
                .map(({title, url}) => `<li><a href="${url}">${escape(title)}</a></li>`)
                .join('')
        }</ul>
    </aside>`;

    // const licText = stats.licenseInfo && `<aside>
    //     <h3>Licensing / Citation</h3>
    //     <p class="license-info">${escape(stats.licenseInfo).replace(/\n+/g, '<br/>')}</p>
    // </aside>`;

    const tagsText = (stats.tags && options.showTags)
        ? `<aside class="tags"><small>${escape(stats.tags)}</small></aside>`
        : '';

	return `<footer class="chapter-footer chapter-meta">
        ${refText || ''}
        ${extLinks || ''}
        ${tagsText || ''}
	</footer>`;
}

module.exports = {
	genChapterHeader,
	genChapterFooter
};
