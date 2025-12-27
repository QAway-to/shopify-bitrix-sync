import Head from 'next/head';
import DocsLayout from '../src/components/docs/DocsLayout';

function SectionCard({ title, children }) {
  return (
    <section className="card doc-card">
      <div className="card-header">
        <h2>{title}</h2>
      </div>
      <div className="doc-prose">{children}</div>
    </section>
  );
}

export default function TechDocPage() {
  return (
    <>
      <Head>
        <title>Тех.док - Middleware сервис</title>
        <meta name="description" content="Техническая справка по UI и правилам интеграции" />
      </Head>

      <DocsLayout
        title="Тех.док"
        subtitle="Короткая техническая справка: теги, loop guard, логи и UI."
        active="tech_doc"
      >
        <section className="card doc-card">
          <div className="doc-prose">
            <p>
              Эта страница — компактная техническая справка: что означает в интерфейсе, какие маркеры
              используются для связки и защиты от циклов, и где брать логи.
            </p>
          </div>
        </section>

        <div className="doc-sections">
          <SectionCard title="Основной UI">
            <ul>
              <li>
                Главная страница: мониторинг событий <strong>Shopify → Bitrix</strong> и <strong>Bitrix → Shopify</strong>
              </li>
              <li>
                Есть ручная отправка событий (на случай если автоматическая обработка не сработала)
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Теги и связка заказов">
            <ul>
              <li>
                <strong>BITRIX:{'{dealId}'}</strong> — тег на Shopify‑ордере, который связывает его со сделкой Bitrix (и
                помогает не создавать дубликаты).
              </li>
              <li>
                <strong>Название сделки в Bitrix:</strong> обновляется до номера Shopify‑заказа (например, <code>#2494</code>),
                чтобы менеджеру было проще сопоставлять.
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Loop guard (защита от циклов)">
            <ul>
              <li>
                При изменениях из Bitrix Shopify‑ордер получает тег <code>BitrixUpdated</code>.
              </li>
              <li>
                Дополнительно может ставиться provenance‑маркер (metafield) <code>middleware.last_write=bitrix</code>.
              </li>
              <li>
                Shopify‑webhook, увидев эти маркеры, пропускает событие, чтобы не было цепочки{' '}
                <code>Shopify → Middleware → Bitrix → Middleware → Shopify</code>.
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Логи">
            <ul>
              <li>
                Кнопка <strong>“Скачать логи”</strong> отдаёт полный файл, включая серверный вывод
                (captured <code>stdout/stderr</code>).
              </li>
              <li>
                В логах можно увидеть payload/ответы Shopify и Bitrix для диагностики (ошибки 4xx/5xx, валидация адреса и т.д.).
              </li>
            </ul>
          </SectionCard>
        </div>
      </DocsLayout>
    </>
  );
}

