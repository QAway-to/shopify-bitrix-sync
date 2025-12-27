import Head from 'next/head';
import fs from 'fs';
import path from 'path';

export default function TechDocPage({ htmlContent }) {
  return (
    <>
      <Head>
        <title>Техническая документация UI - Middleware сервис</title>
        <meta name="description" content="Техническая документация UI для разработчиков" />
      </Head>
      <div dangerouslySetInnerHTML={{ __html: htmlContent }} />
    </>
  );
}

export async function getServerSideProps({ res }) {
  // Read from public/docs to match what is deployed as static assets.
  const filePath = path.join(process.cwd(), 'public', 'docs', '03_TEKHNICHESKAYA_DOKUMENTATSIYA_UI.html');
  let htmlContent = '';
  
  try {
    htmlContent = fs.readFileSync(filePath, 'utf-8');
    // Extract body content
    const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) {
      htmlContent = bodyMatch[1];
    }
  } catch (error) {
    console.error('Error reading tech doc HTML:', error);
    htmlContent = '<p>Ошибка загрузки документа</p>';
  }

  // Avoid stale caching of docs pages
  if (res) {
    res.setHeader('Cache-Control', 'no-store');
  }

  return {
    props: {
      htmlContent
    }
  };
}

