import fs from 'fs';
import path from 'path';
import cheerio from 'cheerio';

function htmlFromNodes($, nodes) {
  return (nodes || []).map((n) => $.html(n)).join('');
}

/**
 * Reads an HTML doc from `public/docs/*` and returns structured sections.
 * We intentionally ignore any inline CSS from the doc and render it using the app UI styles.
 */
export function readPublicDoc(fileName) {
  const filePath = path.join(process.cwd(), 'public', 'docs', fileName);
  const rawHtml = fs.readFileSync(filePath, 'utf-8');

  const $ = cheerio.load(rawHtml);

  // Prefer .container (our generated docs), fallback to <body>
  const root = $('.container').first().length ? $('.container').first() : $('body').first();

  // Remove inline CSS/scripts – we style via app CSS
  root.find('style, script, noscript').remove();

  // Title: first h1 inside content, otherwise <title>
  const title =
    (root.find('h1').first().text() || '').trim() ||
    (($('title').first().text() || '').trim()) ||
    'Документ';

  // Remove the first H1 from content (we render title in page header)
  const h1 = root.find('h1').first();
  if (h1.length) h1.remove();

  const nodes = root.children().toArray();

  const introNodes = [];
  const sections = [];

  let current = null; // { heading, nodes: [] }

  for (const node of nodes) {
    const tagName = (node && node.tagName ? String(node.tagName).toLowerCase() : '');
    const isH2 = tagName === 'h2';

    if (isH2) {
      if (current) {
        sections.push({
          heading: current.heading,
          html: htmlFromNodes($, current.nodes)
        });
      }

      current = {
        heading: $(node).text().trim(),
        nodes: []
      };
      continue;
    }

    if (current) current.nodes.push(node);
    else introNodes.push(node);
  }

  if (current) {
    sections.push({
      heading: current.heading,
      html: htmlFromNodes($, current.nodes)
    });
  }

  const introHtml = htmlFromNodes($, introNodes).trim();

  return {
    title,
    introHtml,
    sections
  };
}


