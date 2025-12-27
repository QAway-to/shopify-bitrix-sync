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

export default function ReportPage() {
  return (
    <>
      <Head>
        <title>Отчёт - Middleware сервис</title>
        <meta name="description" content="Отчёт о функциональности Middleware сервиса" />
      </Head>

      <DocsLayout
        title="Отчёт"
        subtitle="Что реализовано, что работает частично, и известные ограничения."
        active="report"
      >
        <section className="card doc-card">
          <div className="doc-prose">
            <p>
              Этот отчёт описывает текущие возможности Middleware (Shopify ↔ Bitrix) простым языком:
              что происходит автоматически и где есть ограничения.
            </p>
          </div>
        </section>

        <div className="doc-sections">
          <SectionCard title="Что реализовано">
            <ul>
              <li>
                <strong>Shopify → Bitrix:</strong> создание/обновление сделок по заказам, перенос товаров и сумм,
                обновление статусов оплаты/возвратов.
              </li>
              <li>
                <strong>Bitrix → Shopify:</strong> создание заказа в Shopify из сделки Bitrix (резерв товара),
                обновление адреса доставки, доставка (fulfillment), отмена при LOSE.
              </li>
              <li>
                <strong>Loop guard:</strong> при изменениях из Bitrix заказ в Shopify получает метку <code>BitrixUpdated</code>
                и/или provenance‑метку <code>middleware.last_write</code>, чтобы избежать “кругов” синхронизации.
              </li>
              <li>
                <strong>Теги для связки:</strong> ордера из Bitrix помечаются <code>BITRIX:{'{dealId}'}</code>.
              </li>
              <li>
                <strong>UI и логи:</strong> есть веб‑интерфейс и кнопка “Скачать логи”, в файле есть серверный вывод
                (captured <code>stdout/stderr</code>).
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Что работает частично / ограничения">
            <ul>
              <li>
                <strong>Инвентаризация:</strong> сейчас обработка товаров идёт только для <code>qty &gt; 0</code> в Shopify.
                Товары с нулевым остатком не попадают в автоматические операции.
              </li>
              <li>
                <strong>Размер (Size) в Bitrix:</strong> список значений Size настроен не полностью (есть значения только до{' '}
                <strong>32</strong>), поэтому размеры выше могут не проставляться автоматически.
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Как менеджеру быстро проверить, что всё работает">
            <ol>
              <li>Создать заказ в Shopify → убедиться, что сделка появилась в Bitrix (и название сделки = <code>#XXXX</code>)</li>
              <li>Изменить адрес в Bitrix → проверить, что адрес обновился в Shopify</li>
              <li>Перевести сделку в “Delivery” → проверить обновление доставки в Shopify</li>
              <li>Перевести сделку в LOSE → проверить отмену заказа в Shopify</li>
            </ol>
          </SectionCard>
        </div>
      </DocsLayout>
    </>
  );
}
