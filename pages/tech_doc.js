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

export async function getStaticProps() {
  const filePath = path.join(process.cwd(), 'docs', '03_TEKHNICHESKAYA_DOKUMENTATSIYA_UI.html');
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

  return {
    props: {
      htmlContent
    }
  };
}

