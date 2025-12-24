import Head from 'next/head';
import fs from 'fs';
import path from 'path';

export default function ReportPage({ htmlContent }) {
  return (
    <>
      <Head>
        <title>Отчёт для заказчика - Middleware сервис</title>
        <meta name="description" content="Отчёт о функциональности Middleware сервиса для заказчика" />
      </Head>
      <div dangerouslySetInnerHTML={{ __html: htmlContent }} />
    </>
  );
}

export async function getStaticProps() {
  const filePath = path.join(process.cwd(), 'docs', '01_OTCHET_DLYA_ZAKAZCHIKA.html');
  let htmlContent = '';
  
  try {
    htmlContent = fs.readFileSync(filePath, 'utf-8');
    // Extract body content
    const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) {
      htmlContent = bodyMatch[1];
    }
  } catch (error) {
    console.error('Error reading report HTML:', error);
    htmlContent = '<p>Ошибка загрузки документа</p>';
  }

  return {
    props: {
      htmlContent
    }
  };
}
