// Which links the launcher's page may open, and the "Report an Issue" email.

// The configured links, the forgotten-password page, and posts on the
// website the news comes from. Only https:// pages and mailto: links.
function linkAllowed(url, settings) {
  if (typeof url !== 'string') return false;
  const listed = (settings.links || []).map((link) => link && link.url).filter(Boolean);
  if (settings.forgotPasswordUrl) listed.push(settings.forgotPasswordUrl);
  if (settings.accountUrl) listed.push(settings.accountUrl);
  if (listed.includes(url)) return url.startsWith('https://') || url.startsWith('mailto:');
  try {
    const target = new URL(url);
    return target.protocol === 'https:' && !target.username && !target.password &&
      Boolean(settings.newsUrl) && target.origin === new URL(settings.newsUrl).origin;
  } catch {
    return false;
  }
}

// A mailto: link with a subject, and a body asking what happened, with the
// versions filled in.
function reportEmailUrl(mailto, { launcherVersion, gameVersion, system }) {
  const body = [
    'What happened?', '', '',
    'What were you doing when it happened?', '', '',
    '---',
    `Launcher: v${launcherVersion}`,
    `Game: ${gameVersion ? `v${gameVersion}` : 'not installed'}`,
    `System: ${system}`,
    'Please attach your newest game log: in the launcher, open Settings and press "Open logs folder".',
  ].join('\n');
  const address = mailto.split('?')[0];
  return `${address}?subject=${encodeURIComponent('Toon Valley problem report')}&body=${encodeURIComponent(body)}`;
}

module.exports = { linkAllowed, reportEmailUrl };
