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

export async function getStaticProps() {
  const filePath = path.join(process.cwd(), 'docs', '02_INSTRUKTSIYA_DLYA_MENEDZHEROV.html');
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

  return {
    props: {
      htmlContent
    }
  };
}

