// The news board's posts, from the website (toonvalley.net/news.json, made
// from website/src/content/news/). The board shows the news built into the
// launcher's configuration until these arrive, and keeps it if they can't
// be fetched.
const https = require('https');

const MAX_BYTES = 256 * 1024;
const MAX_ITEMS = 10;

function text(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

// A post's own page, if it's on the same website as the news (so the
// board's "Read more" only ever opens the news site).
function postUrl(value, origin) {
  if (typeof value !== 'string' || !origin) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

// The website's reply, cut down to what the board shows; null if it isn't
// usable. `origin` is the news site's, for the posts' links.
function parseNews(data, origin = '') {
  const items = data && Array.isArray(data.news) ? data.news : null;
  if (!items) return null;
  const news = items
    .map((item) => ({
      title: text(item && item.title, 120),
      body: text(item && item.body, 600),
      date: text(item && item.date, 40),
      url: postUrl(item && item.url, origin),
    }))
    .filter((item) => item.title)
    .slice(0, MAX_ITEMS);
  return news.length ? news : null;
}

function fetchNews(newsUrl, { timeoutMs = 10000 } = {}, request = https.request) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(newsUrl);
    } catch {
      resolve(null);
      return;
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const req = request(url, { method: 'GET', timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(null);
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          finish(parseNews(JSON.parse(Buffer.concat(chunks).toString('utf8')), url.origin));
        } catch {
          finish(null);
        }
      });
      res.on('error', () => finish(null));
    });
    req.once('timeout', () => {
      req.destroy();
      finish(null);
    });
    req.once('error', () => finish(null));
    req.end();
  });
}

module.exports = { fetchNews, parseNews };
