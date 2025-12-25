import crypto from 'crypto';
import * as cheerio from 'cheerio';
import fallback from '../src/mock-data/mentions.json';

const QUERY = '("Agent B" OR "MVP automation") AND (startup OR product)';

export async function loadArticles() {
  const apiKey = process.env.NEWSAPI_KEY;

  try {
    if (!apiKey) {
      throw new Error('Missing NEWSAPI_KEY');
    }

    const response = await fetch(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(QUERY)}&language=en&sortBy=publishedAt&pageSize=12&apiKey=${apiKey}`
    );
    const json = await response.json();

    if (json.status !== 'ok') {
      throw new Error(json.message || 'NewsAPI error');
    }

    const articles = (json.articles || []).map(normalizeArticle).filter(Boolean);
    if (!articles.length) {
      throw new Error('Empty result set');
    }

    return { articles, query: QUERY };
  } catch (error) {
    return {
      articles: fallback.results.map(normalizeFallbackArticle),
      query: QUERY,
      error: error.message || String(error)
    };
  }
}

export function getArticleAtIndex(articles, index) {
  const idx = Number(index);
  if (Number.isNaN(idx) || idx < 0 || idx >= articles.length) {
    return null;
  }
  return articles[idx];
}

export function sentimentStats(articles) {
  return articles.reduce((acc, item) => {
    acc[item.sentiment.label] = (acc[item.sentiment.label] || 0) + 1;
    return acc;
  }, {});
}

export async function fetchQuoteOfTheDay() {
  try {
    const response = await fetch(process.env.QUOTES_API_URL || 'http://quotes.toscrape.com/');
    const html = await response.text();
    const $ = cheerio.load(html);
    const firstQuote = $('.quote').first();
    return {
      text: firstQuote.find('.text').text().replace(/(^“|”$)/g, '') || 'Stay hungry. Stay foolish.',
      author: firstQuote.find('.author').text() || 'Unknown'
    };
  } catch (error) {
    return {
      text: 'Stay hungry. Stay foolish.',
      author: 'Steve Jobs'
    };
  }
}

function normalizeArticle(article) {
  if (!article || !article.title) return null;
  const summary = article.description || article.content || 'No description provided';
  return {
    hash: crypto.createHash('md5').update(article.url || article.title).digest('hex'),
    title: article.title,
    url: article.url || '#',
    source: article.source?.name || 'Unknown',
    publishedAt: article.publishedAt,
    summary,
    author: article.author || 'Unknown',
    sentiment: scoreSentiment(summary)
  };
}

function normalizeFallbackArticle(item) {
  return {
    hash: crypto.createHash('md5').update(item.url || item.title).digest('hex'),
    title: item.title,
    url: item.url || '#',
    source: item.source || 'Demo',
    publishedAt: item.ts || fallback.digest_ts,
    summary: item.snippet || 'Demo snippet for PoC',
    author: item.author || 'Unknown',
    sentiment: { label: item.sentiment || 'neutral', score: 0 }
  };
}

function scoreSentiment(text) {
  const positiveWords = ['great', 'good', 'success', 'growth', 'positive', 'love'];
  const negativeWords = ['risk', 'issue', 'problem', 'crisis', 'negative', 'decline'];
  const tokens = text.toLowerCase().split(/\W+/);
  let score = 0;
  tokens.forEach((token) => {
    if (positiveWords.includes(token)) score += 1;
    if (negativeWords.includes(token)) score -= 1;
  });
  const label = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
  return { label, score };
}

