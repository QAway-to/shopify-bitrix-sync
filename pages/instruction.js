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

export default function InstructionPage() {
  return (
    <>
      <Head>
        <title>Инструкция - Middleware сервис</title>
        <meta
          name="description"
          content="Короткие сценарии: что сделать и что увидеть в Bitrix и Shopify."
        />
      </Head>

      <DocsLayout
        title="Инструкция"
        subtitle="Короткие сценарии “что сделать” и “что увидеть” в Bitrix и Shopify."
        active="instruction"
      >
        <section className="card doc-card">
          <div className="doc-prose">
            <p>
              Ниже — практические тест‑сценарии. Делайте действие в одной системе и сразу
              проверяйте результат в другой.
            </p>
          </div>
        </section>

        <div className="doc-sections">
          <SectionCard title="Shopify → Bitrix (автоматически)">
            <p>
              <strong>Тест:</strong> создайте заказ в Shopify (сайт или POS) → сделка появится в
              Bitrix.
            </p>
            <ul>
              <li>
                <strong>В Bitrix вы увидите:</strong> новую сделку с товарами и суммой заказа.
              </li>
              <li>
                <strong>Название сделки:</strong> соответствует номеру заказа Shopify (например,
                <strong> #2448</strong>).
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Bitrix → Shopify (основные сценарии)">
            <p>
              Здесь перечислены действия менеджера в Bitrix и то, что автоматически изменится в
              Shopify.
            </p>
          </SectionCard>

          <SectionCard title="1) Тест: создать сделку с товарами → появится заказ в Shopify">
            <p>
              <strong>Действие в Bitrix:</strong> создайте сделку и добавьте товары.
            </p>
            <p>
              <strong>Что вы увидите в Shopify:</strong> появится новый заказ (резерв товара) с
              теми же товарами и количествами.
            </p>
            <ul>
              <li>
                <strong>Деталь:</strong> у заказа в Shopify появятся метки (например,
                <code> BITRIX:1234</code>).
              </li>
              <li>
                <strong>Деталь:</strong> название сделки в Bitrix обновится и станет номером
                заказа Shopify (например, <strong>#2513</strong>).
              </li>
            </ul>
            <p>
              <strong>Как протестировать:</strong>
            </p>
            <ol>
              <li>Создайте новую сделку в Bitrix и добавьте 1–2 товара</li>
              <li>Подождите 10–60 секунд</li>
              <li>Откройте Shopify → Orders → найдите новый заказ</li>
            </ol>
          </SectionCard>

          <SectionCard title="1.1) Тест: создать сделку БЕЗ товаров → появится заглушка в Shopify">
            <p>
              <strong>Действие в Bitrix:</strong> создайте сделку, но <strong>не добавляйте товары</strong> (или добавьте товары без SKU/XML_ID).
            </p>
            <p>
              <strong>Что вы увидите в Shopify:</strong> появится заказ-заглушка с дефолтным товаром.
            </p>
            <ul>
              <li>
                <strong>Визуальная маркировка:</strong> у заказа будет тег <code>BITRIX_STUB</code> и note с пометкой "STUB ORDER".
              </li>
              <li>
                <strong>Автоматическая очистка:</strong> если позже в Bitrix добавятся реальные товары, заглушка автоматически очистится:
                <ul>
                  <li>Дефолтный товар будет удалён</li>
                  <li>Тег <code>BITRIX_STUB</code> будет убран</li>
                  <li>Note обновится на обычный формат</li>
                </ul>
              </li>
              <li>
                <strong>Деталь:</strong> название сделки в Bitrix обновится и станет номером заказа Shopify.
              </li>
            </ul>
            <p>
              <strong>Как протестировать:</strong>
            </p>
            <ol>
              <li>Создайте новую сделку в Bitrix <strong>без товаров</strong></li>
              <li>Подождите 10–60 секунд</li>
              <li>Откройте Shopify → Orders → найдите заказ с тегом <code>BITRIX_STUB</code></li>
              <li>Добавьте товары в сделку в Bitrix</li>
              <li>Подождите ещё 10–60 секунд</li>
              <li>Проверьте, что тег <code>BITRIX_STUB</code> исчез, а дефолтный товар удалён</li>
            </ol>
          </SectionCard>

          <SectionCard title="2) Тест: изменить адрес в Bitrix → адрес обновится в Shopify">
            <p>
              <strong>Действие в Bitrix:</strong> измените адрес доставки в сделке.
            </p>
            <p>
              <strong>Что вы увидите в Shopify:</strong> в заказе обновится адрес доставки.
            </p>
            <ul>
              <li>
                <strong>Деталь:</strong> после обновления из Bitrix заказ в Shopify получает
                метку <code>BitrixUpdated</code> (защита от повторных “кругов” синхронизации).
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="3) Тест: перевести сделку в “Delivery” → в Shopify обновится доставка">
            <p>
              <strong>Действие в Bitrix:</strong> переведите сделку в стадию “Delivery”.
            </p>
            <p>
              <strong>Что вы увидите в Shopify:</strong> у заказа появится/обновится информация о
              доставке (fulfillment), чтобы было видно, что заказ “в доставке”.
            </p>
          </SectionCard>

          <SectionCard title="4) Тест: перевести сделку в LOSE → заказ отменится в Shopify">
            <p>
              <strong>Действие в Bitrix:</strong> переведите сделку в LOSE.
            </p>
            <p>
              <strong>Что вы увидите в Shopify:</strong> связанный заказ будет отменён, товар
              вернётся в остатки (restock).
            </p>
            <ul>
              <li>
                <strong>Деталь:</strong> заказ в Shopify получает метку <code>BitrixUpdated</code>{' '}
                после отмены из Bitrix.
              </li>
            </ul>
          </SectionCard>

          <SectionCard title="Как НЕ нужно (чтобы не было путаницы)">
            <ul>
              <li>
                Не меняйте одно и то же в двух местах одновременно (например: адрес и в Bitrix, и
                в Shopify)
              </li>
              <li>
                Не дублируйте вручную заказ в Shopify, если вы уже ведёте его через Bitrix
              </li>
            </ul>
          </SectionCard>
        </div>
      </DocsLayout>
    </>
  );
}

