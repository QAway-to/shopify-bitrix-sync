import Head from 'next/head';
import fs from 'fs';
import path from 'path';

export default function InstructionPage({ htmlContent }) {
  return (
    <>
      <Head>
        <title>Инструкция для менеджеров - Middleware сервис</title>
        <meta name="description" content="Инструкция для менеджеров по работе с Bitrix24" />
      </Head>
      <div dangerouslySetInnerHTML={{ __html: htmlContent }} />
    </>
  );
}

export async function getServerSideProps({ res }) {
  // Read from public/docs to match what is deployed as static assets.
  const filePath = path.join(process.cwd(), 'public', 'docs', '02_INSTRUKTSIYA_DLYA_MENEDZHEROV.html');
  let htmlContent = '';
  
  try {
    htmlContent = fs.readFileSync(filePath, 'utf-8');
    // Extract body content
    const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) {
      htmlContent = bodyMatch[1];
    }
  } catch (error) {
    console.error('Error reading instruction HTML:', error);
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

