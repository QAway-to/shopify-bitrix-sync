# Техническая документация UI
## Описание функций интерфейса для технических специалистов

---

## Архитектура UI

### Технологический стек:
- **Framework:** Next.js (React)
- **Стили:** CSS Modules + глобальные стили
- **Состояние:** React Hooks (useState, useEffect)
- **API:** Next.js API Routes

### Структура файлов:
```
pages/
├── index.js                    # Главная страница UI
└── api/                        # API endpoints
    ├── events.js               # Получение событий Shopify
    ├── events/bitrix.js        # Получение событий Bitrix
    ├── events/success.js       # Получение успешных операций
    ├── send-to-bitrix.js      # Ручная отправка в Bitrix
    ├── send-to-shopify.js      # Ручная отправка в Shopify
    ├── sync/                   # Синхронизация товаров
    └── logs/download.js        # Скачивание логов

src/components/
├── shopify/
│   ├── EventsList.js           # Список событий Shopify
│   ├── WebhookInfo.js          # Информация о webhook
│   └── DataPreview.js           # Превью данных
├── bitrix/
│   └── EventsList.js           # Список событий Bitrix
└── success/
    └── SuccessOperationsList.js # Список успешных операций
```

---

## Основные компоненты UI

### 1. Главная страница (`pages/index.js`)

**Назначение:** Центральный интерфейс для управления всеми операциями синхронизации.

**Основные функции:**

#### 1.1. Отображение событий Shopify → Bitrix

**Компонент:** `EventsList` (Shopify)

**Функциональность:**
- Отображение списка всех заказов из Shopify
- Фильтрация и поиск по заказам
- Выбор заказов для ручной отправки
- Превью деталей заказа
- Автоматическое обновление списка (polling)

**Ключевые состояния:**
```javascript
const [events, setEvents] = useState([]);           // Список событий
const [selectedEvents, setSelectedEvents] = useState([]); // Выбранные события
const [isLoading, setIsLoading] = useState(false);  // Состояние загрузки
const [previewEvent, setPreviewEvent] = useState(null); // Событие для превью
```

**API endpoints:**
- `GET /api/events` - получение списка событий Shopify
- `POST /api/send-to-bitrix` - отправка выбранных событий в Bitrix
- `POST /api/transform-to-bitrix` - трансформация данных Shopify → Bitrix

**Особенности:**
- Автоматическое обновление каждые 30 секунд
- Умное слияние новых событий (не дублирует существующие)
- Подсчёт активных товаров в заказе
- Отображение статусов оплаты и выполнения

#### 1.2. Отображение событий Bitrix → Shopify

**Компонент:** `BitrixEventsList`

**Функциональность:**
- Отображение списка всех событий из Bitrix24
- Выбор событий для ручной отправки
- Превью деталей события
- Отображение статусов fulfillment

**Ключевые состояния:**
```javascript
const [bitrixEvents, setBitrixEvents] = useState([]);
const [selectedBitrixEvents, setSelectedBitrixEvents] = useState([]);
const [isBitrixLoading, setIsBitrixLoading] = useState(false);
```

**API endpoints:**
- `GET /api/events/bitrix` - получение списка событий Bitrix
- `POST /api/send-to-shopify` - отправка выбранных событий в Shopify

**Особенности:**
- Отображение Deal ID, Shopify Order ID
- Статусы fulfillment (fulfilled, partial, unfulfilled)
- Категории и стадии сделок

#### 1.3. Успешные операции

**Компонент:** `SuccessOperationsList`

**Функциональность:**
- Отображение истории успешно выполненных операций
- Фильтрация по типу операции
- Превью деталей операции

**API endpoints:**
- `GET /api/events/success` - получение списка успешных операций

---

### 2. Управление товарами

#### 2.1. Синхронизация по категориям

**Функциональность:**
- Массовое создание товаров в Bitrix24 из каталога Shopify
- Синхронизация остатков товаров
- Работа с категориями: A-F, G-M, N-S, T-Z

**UI элементы:**
- Выпадающий список выбора категории
- Кнопка "Создать продукты {категория}"
- Индикатор прогресса синхронизации
- Отображение статистики (создано, обновлено, ошибок)

**Ключевые состояния:**
```javascript
const [selectedCategory, setSelectedCategory] = useState('category-a-f');
const [syncProgress, setSyncProgress] = useState(null);
const [isCreatingCategory, setIsCreatingCategory] = useState(false);
```

**API endpoints:**
- `POST /api/sync/category-optimized` - запуск синхронизации категории
- `GET /api/sync/progress?requestId={id}` - получение прогресса

**Особенности:**
- Фоновая обработка (не блокирует UI)
- Отображение прогресса в реальном времени
- Параллельная обработка товаров (8 воркеров)
- Фильтрация товаров с количеством > 0

**Процесс синхронизации:**
1. Пользователь выбирает категорию
2. Нажимает "Создать продукты"
3. Система возвращает `requestId` и начинает обработку в фоне
4. UI опрашивает `/api/sync/progress` каждые 2 секунды
5. Отображается прогресс: "Обработка товаров: 150/3000"
6. По завершении показывается статистика

#### 2.2. Синхронизация сертификатов

**Функциональность:**
- Создание и обновление подарочных сертификатов
- Синхронизация остатков сертификатов

**UI элементы:**
- Кнопка "Синхронизировать сертификаты"
- Кнопка "Создать сертификаты"
- Кнопка "Обновить E-Cert 500$" (ручное обновление конкретного сертификата)

**API endpoints:**
- `POST /api/sync/certificates?action=sync` - синхронизация
- `POST /api/sync/certificates?action=create` - создание
- `POST /api/bitrix/update-certificate-500` - обновление конкретного сертификата

---

### 3. Превью данных

**Компонент:** `DataPreview`

**Функциональность:**
- Отображение детальной информации о событии
- Показ исходных данных из Shopify/Bitrix
- Показ преобразованных данных для Bitrix/Shopify

**Режимы:**
- **Shopify → Bitrix:** Показывает заказ из Shopify и как он будет выглядеть в Bitrix
- **Bitrix → Shopify:** Показывает сделку из Bitrix и как она будет выглядеть в Shopify

**Данные в превью:**
- Все поля сделки/заказа
- Список товаров с ценами и количествами
- Данные контакта
- Адрес доставки
- Статусы и метаданные

---

### 4. Логирование и отладка

#### 4.1. Скачивание логов

**Функциональность:**
- Единая точка скачивания всех логов
- Объединение логов Shopify → Bitrix и Bitrix → Shopify
- Формат: текстовый файл с временными метками

**UI элемент:**
- Кнопка "Скачать логи"

**API endpoint:**
- `GET /api/logs/download` - скачивание объединённых логов

**Формат логов:**
```
================================================================================
SHOPIFY → BITRIX LOGS
================================================================================
[2025-12-24T10:30:15.123Z] [SHOPIFY WEBHOOK] Order #1234 received
[2025-12-24T10:30:16.456Z] [BITRIX] Deal created: ID=5678
...

================================================================================
BITRIX → SHOPIFY LOGS
================================================================================
[2025-12-24T10:35:20.789Z] [BITRIX WEBHOOK] Deal updated: ID=5678
[2025-12-24T10:35:21.012Z] [SHOPIFY] Fulfillment created for order #1234
...
```

---

## API Endpoints (для UI)

### События

#### `GET /api/events`
**Назначение:** Получение списка событий Shopify

**Параметры:**
- `limit` (query, optional) - количество событий (по умолчанию 100)

**Ответ:**
```json
{
  "success": true,
  "events": [
    {
      "id": "event-id",
      "orderId": "1234",
      "topic": "orders/create",
      "timestamp": "2025-12-24T10:30:15Z",
      "data": { /* Shopify order data */ }
    }
  ]
}
```

#### `GET /api/events/bitrix`
**Назначение:** Получение списка событий Bitrix

**Ответ:** Аналогично `/api/events`, но для Bitrix событий

#### `GET /api/events/success`
**Назначение:** Получение списка успешных операций

**Ответ:**
```json
{
  "success": true,
  "operations": [
    {
      "id": "op-id",
      "type": "shopify_to_bitrix",
      "timestamp": "2025-12-24T10:30:15Z",
      "result": { /* Operation result */ }
    }
  ]
}
```

### Отправка данных

#### `POST /api/send-to-bitrix`
**Назначение:** Ручная отправка выбранных событий Shopify в Bitrix

**Тело запроса:**
```json
{
  "events": [
    {
      "id": "event-id",
      "orderId": "1234",
      "data": { /* Shopify order */ }
    }
  ]
}
```

**Ответ:**
```json
{
  "success": true,
  "results": [
    {
      "eventId": "event-id",
      "success": true,
      "dealId": 5678,
      "message": "Deal created successfully"
    }
  ],
  "errors": []
}
```

#### `POST /api/send-to-shopify`
**Назначение:** Ручная отправка выбранных событий Bitrix в Shopify

**Тело запроса:** Аналогично `/api/send-to-bitrix`, но для Bitrix событий

**Ответ:** Аналогично `/api/send-to-bitrix`

### Синхронизация товаров

#### `POST /api/sync/category-optimized`
**Назначение:** Запуск синхронизации товаров категории

**Тело запроса:**
```json
{
  "category": "category-a-f",
  "action": "create" // или "sync"
}
```

**Ответ:**
```json
{
  "success": true,
  "requestId": "req-123",
  "message": "Processing started",
  "progressUrl": "/api/sync/progress?requestId=req-123"
}
```

#### `GET /api/sync/progress?requestId={id}`
**Назначение:** Получение прогресса синхронизации

**Ответ:**
```json
{
  "status": "processing", // "fetching", "processing", "completed", "error"
  "message": "Обработка товаров: 150/3000",
  "processed": 150,
  "total": 3000,
  "created": 120,
  "updated": 30,
  "errors": 0,
  "lastUpdate": "2025-12-24T10:30:15Z"
}
```

### Трансформация данных

#### `POST /api/transform-to-bitrix`
**Назначение:** Преобразование данных Shopify в формат Bitrix (для превью)

**Тело запроса:**
```json
{
  "shopifyOrder": { /* Shopify order data */ }
}
```

**Ответ:**
```json
{
  "success": true,
  "bitrixDeal": {
    "fields": { /* Bitrix deal fields */ },
    "productRows": [ /* Product rows */ ]
  }
}
```

---

## Состояния и жизненный цикл

### Загрузка событий

```javascript
// Инициализация
useEffect(() => {
  fetchEvents(); // Первая загрузка
  const interval = setInterval(fetchEvents, 30000); // Обновление каждые 30 сек
  return () => clearInterval(interval);
}, []);
```

### Обработка выбора событий

```javascript
const handleSelectEvent = (event, checked) => {
  if (checked) {
    setSelectedEvents([...selectedEvents, event]);
  } else {
    setSelectedEvents(selectedEvents.filter(e => e.id !== event.id));
  }
};
```

### Отправка в Bitrix

```javascript
const handleSendToBitrix = async () => {
  setIsSending(true);
  try {
    const response = await fetch('/api/send-to-bitrix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: selectedEvents })
    });
    const result = await response.json();
    setSendResult(result);
  } finally {
    setIsSending(false);
  }
};
```

### Отслеживание прогресса синхронизации

```javascript
useEffect(() => {
  if (!syncProgress?.requestId) return;
  
  const interval = setInterval(async () => {
    const response = await fetch(`/api/sync/progress?requestId=${syncProgress.requestId}`);
    const data = await response.json();
    setSyncProgress(data);
    
    if (data.status === 'completed' || data.status === 'error') {
      clearInterval(interval);
    }
  }, 2000);
  
  return () => clearInterval(interval);
}, [syncProgress?.requestId]);
```

---

## Обработка ошибок

### Отображение ошибок

```javascript
{error && (
  <div className="alert alert-error">
    <strong>Ошибка:</strong> {error.message}
    {error.details && (
      <ul>
        {error.details.map((detail, i) => (
          <li key={i}>{detail.error || detail.message}</li>
        ))}
      </ul>
    )}
  </div>
)}
```

### Обработка ошибок API

```javascript
try {
  const response = await fetch('/api/endpoint');
  const data = await response.json();
  
  if (!data.success) {
    setError({
      message: data.error || 'Unknown error',
      details: data.errors || []
    });
  }
} catch (err) {
  setError({
    message: err.message || 'Network error',
    details: []
  });
}
```

---

## Стилизация

### Тема
- Тёмная тема (background: #0f172a, text: #f1f5f9)
- Акцентные цвета: синий (#3b82f6), зелёный (#10b981), красный (#ef4444)

### Компоненты
- Карточки (`.card`) для группировки контента
- Таблицы для списков событий
- Кнопки с состояниями (loading, disabled)
- Алерты для сообщений (info, success, error, warning)

---

## Производительность

### Оптимизации:
1. **Ленивая загрузка:** События загружаются порциями
2. **Умное слияние:** Новые события добавляются без дублирования
3. **Debouncing:** Поиск и фильтрация с задержкой
4. **Мемоизация:** Результаты трансформации кэшируются
5. **Фоновая обработка:** Долгие операции не блокируют UI

### Рекомендации:
- Не загружать более 1000 событий за раз
- Использовать пагинацию для больших списков
- Кэшировать результаты трансформации
- Оптимизировать рендеринг больших списков (виртуализация)

---

## Расширение функциональности

### Добавление нового типа событий:

1. Создать компонент списка в `src/components/{type}/EventsList.js`
2. Добавить состояние в `pages/index.js`
3. Создать API endpoint в `pages/api/events/{type}.js`
4. Добавить секцию в UI

### Добавление новой операции синхронизации:

1. Создать API endpoint в `pages/api/sync/{operation}.js`
2. Добавить кнопку в UI
3. Реализовать обработку прогресса (если нужно)
4. Добавить обработку ошибок

---

## Известные ограничения и технические проблемы

### ⚠️ Инвентаризация товаров

**Текущая реализация:**
- Система обрабатывает только товары с `qty > 0` (количество на складе больше нуля)
- Товары с нулевым остатком исключаются из автоматической синхронизации

**Где это реализовано:**
```javascript
// pages/api/sync/category-optimized.js
const productsToProcess = isCreateAction 
  ? products.filter(p => p.qty && p.qty > 0)  // Только товары с qty > 0
  : products;
```

**Причина:**
- Оптимизация производительности
- Избежание обработки неактуальных товаров
- Фокус на товарах, которые реально есть на складе

**Ограничения:**
- Товары с `qty = 0` не будут созданы/обновлены автоматически
- Для полной инвентаризации требуется дополнительная логика

**Планируемые улучшения:**
- Добавить опцию для синхронизации всех товаров (включая с qty = 0)
- Реализовать отдельный режим "полная инвентаризация"

### ⚠️ Обновление полей товаров (Size и другие)

**Известная проблема:**
- При обновлении товаров в Bitrix24 возникают проблемы с обновлением некоторых полей:
  - **PROPERTY_98 (Size)** - требует поиска ID значения, а не текста
  - **PROPERTY_106 (Color)** - может не обновляться при массовых операциях
  - Другие пользовательские свойства могут требовать специальной обработки

**Технические детали:**

**Проблема с Size (PROPERTY_98):**
```javascript
// src/lib/bitrix/products.js
// Функция getSizeValueId пытается найти ID для текстового значения
async function getSizeValueId(sizeString) {
  // Проблема: если значение не найдено в Bitrix, возвращается null
  // И поле не обновляется
}
```

**Где возникает:**
- В функции `syncProductVariantOptimized` при обновлении существующих товаров
- В функции `updateExistingProductWithVariantId` при миграции товаров
- При массовом создании товаров через `/api/sync/category-optimized`

**Причины:**
1. **Size требует ID значения:** Bitrix24 хранит Size как список значений с ID, а не как текст
2. **Поиск по тексту может не найти:** Если текст размера не совпадает точно с вариантами в Bitrix
3. **Массовые операции:** При обработке большого количества товаров некоторые запросы могут не успевать

**Текущая реализация:**
```javascript
// src/lib/bitrix/products.js:815
if (variant_title) {
  const sizeValueId = await getSizeValueId(variant_title);
  if (sizeValueId) {
    fields.PROPERTY_98 = sizeValueId;
  } else {
    // ⚠️ Проблема: если sizeValueId не найден, поле не обновляется
    console.warn(`Size value not found for: ${variant_title}`);
  }
}
```

**Временные решения:**
1. **Ручное обновление:** Для критически важных товаров обновлять поля вручную через Bitrix24
2. **Предварительная настройка:** Убедиться, что все варианты Size существуют в Bitrix24
3. **Повторная синхронизация:** Запускать синхронизацию повторно для товаров, где поля не обновились

**Планируемые исправления:**
1. **Улучшение поиска Size:**
   - Более гибкий поиск (частичное совпадение)
   - Создание значений Size автоматически, если не найдено
   - Кэширование соответствий Size → ID

2. **Надёжное обновление полей:**
   - Retry логика при ошибках обновления
   - Валидация перед обновлением
   - Логирование всех случаев, когда поле не обновилось

3. **Массовые операции:**
   - Батчинг обновлений полей
   - Приоритизация критических полей
   - Отдельная очередь для обновления полей

**Рекомендации для разработчиков:**
- При работе с полями товаров всегда проверяйте результат обновления
- Логируйте случаи, когда поле не удалось обновить
- Используйте retry механизм для критических обновлений
- Кэшируйте соответствия текстовых значений → ID для производительности

---

## Технические ордера (Technical Orders)

### Обзор

Технические ордера - это специальные ордера в Shopify, создаваемые автоматически из Bitrix24 для резервирования товаров на складе.

### Механизм работы

#### Создание технического ордера

**Триггер:** Событие `ONCRMDEALADD` или `ONCRMDEALUPDATE` из Bitrix24, когда:
- У сделки нет связанного Shopify Order ID (поле `UF_CRM_1742556489` пустое)
- В сделке есть товары (product rows)

**Процесс:**
1. Middleware получает webhook от Bitrix24
2. Проверяется наличие Shopify Order ID в сделке
3. Проверяется наличие товаров в сделке
4. Для каждого товара извлекается SKU (CODE) или variant_id (XML_ID)
5. Создаётся ордер в Shopify через GraphQL API (`orderCreate`)
6. Ордер помечается тегами: **TECH**, **BITRIX:{dealId}**
7. Shopify Order ID сохраняется обратно в Bitrix сделку

**Файлы:**
- `pages/api/webhook/bitrix.js` - функция `handleDealCreate` и `handleDealUpdate`
- `src/lib/shopify/order.js` - функция `createOrderFromBitrix`

#### Отмена технического ордера

**Триггер:** Событие `ONCRMDEALUPDATE` из Bitrix24, когда:
- Стадия сделки изменяется на **LOSE** (или любую стадию, заканчивающуюся на `:LOSE`, например `C6:LOSE`)

**Процесс:**
1. Middleware получает webhook от Bitrix24
2. Проверяется стадия сделки (должна быть LOSE или заканчиваться на `:LOSE`)
3. Ищется существующий технический ордер по тегу `BITRIX:{dealId}`
4. Ордер отменяется через GraphQL API (`orderCancel`)
5. Товары возвращаются в инвентарь (`restock: true`)

**Файлы:**
- `pages/api/webhook/bitrix.js` - функция `handleDealUpdate` (проверка стадии LOSE)
- `src/lib/shopify/order.js` - функция `cancelOrderByDealId`

### Теги ордера

Технические ордера используют два обязательных тега:

1. **`TECH`** - указывает, что это технический ордер
   - Используется в Shopify webhook для фильтрации (технические ордера не отправляются обратно в Bitrix)
   - Файл: `pages/api/webhook/shopify.js`

2. **`BITRIX:{dealId}`** - связывает ордер с конкретной сделкой в Bitrix
   - Используется для поиска дубликатов (`findExistingOrderByDealId`)
   - Используется для отмены ордера при переводе сделки в LOSE
   - Показывает принадлежность визуально

**Пример тегов:** `TECH`, `BITRIX:6624`

### Предотвращение дубликатов

Система использует многоуровневую защиту от создания дубликатов:

1. **Блокировка по dealId** - in-memory lock предотвращает одновременное создание ордеров для одной сделки
2. **Проверка в Bitrix** - проверяется наличие Shopify Order ID в сделке (с повторной проверкой через 200ms)
3. **Поиск по тегам** - поиск существующего ордера по тегу `BITRIX:{dealId}` в Shopify
4. **Задержки и повторные проверки** - множественные проверки с задержками перед созданием ордера

**Файлы:**
- `src/lib/shopify/order.js` - функции `acquireLock`, `releaseLock`, `findExistingOrderByDealId`

### GraphQL мутации

#### Создание ордера

```graphql
mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    userErrors {
      field
      message
    }
    order {
      id
      legacyResourceId
      name
      tags
      note
    }
  }
}
```

**Параметры:**
- `order.lineItems` - массив товаров с variantId и quantity
- `order.tags` - теги: `["TECH", "BITRIX:{dealId}"]`
- `order.note` - примечание: "Технический ордер из Bitrix. Сделка: {dealId}"
- `order.email` - email: "hold@bfcshoes.local"
- `options.inventoryBehaviour` - "DECREMENT_OBEYING_POLICY" (резервирует товары)
- `options.sendReceipt` - false
- `options.sendFulfillmentReceipt` - false

#### Отмена ордера

```graphql
mutation orderCancel($orderId: ID!) {
  orderCancel(
    orderId: $orderId,
    reason: OTHER,
    restock: true,
    refund: false
  ) {
    userErrors {
      field
      message
    }
    job {
      id
    }
  }
}
```

**Параметры:**
- `orderId` - GraphQL ID ордера (формат: `gid://shopify/Order/{numericId}`)
- `reason` - "OTHER"
- `restock` - true (возвращает товары в инвентарь)
- `refund` - false (не делает возврат средств)

### Логирование

Все операции с техническими ордерами логируются:

**Создание:**
- `BITRIX_TO_SHOPIFY_ORDER_CREATE_PRE_CHECK` - предварительная проверка
- `BITRIX_TO_SHOPIFY_ORDER_CREATE_SUCCESS` - успешное создание
- `BITRIX_TO_SHOPIFY_ORDER_CREATE_DUPLICATE` - обнаружен дубликат
- `BITRIX_TO_SHOPIFY_ORDER_CREATE_ERROR` - ошибка создания

**Отмена:**
- `BITRIX_TO_SHOPIFY_ORDER_CANCEL_CHECK` - проверка необходимости отмены
- `BITRIX_TO_SHOPIFY_ORDER_CANCEL_SUCCESS` - успешная отмена
- `BITRIX_TO_SHOPIFY_ORDER_CANCEL_SKIP` - пропуск (ордер не найден)
- `BITRIX_TO_SHOPIFY_ORDER_CANCEL_ERROR` - ошибка отмены

### Тестирование

#### Создание технического ордера

1. Создайте сделку в Bitrix24 с товарами
2. Убедитесь, что у сделки нет Shopify Order ID
3. Проверьте в Shopify - должен появиться новый ордер с тегами TECH и BITRIX:{dealId}
4. Проверьте в Middleware UI - в разделе "Bitrix → Shopify Events" должно появиться событие

#### Отмена технического ордера

1. Найдите сделку с созданным техническим ордером
2. Переведите сделку в стадию LOSE
3. Проверьте в Shopify - ордер должен быть отменён
4. Проверьте инвентарь - товары должны вернуться (увеличиться количество)
5. Проверьте логи в Middleware UI

### API endpoints

#### Создание (внутренний)

Создание технического ордера происходит автоматически через webhook Bitrix24:
- Endpoint: `POST /api/webhook/bitrix`
- Событие: `ONCRMDEALADD` или `ONCRMDEALUPDATE`
- Функция: `handleDealCreate` или `handleDealUpdate`

#### Отмена (внутренний)

Отмена технического ордера происходит автоматически через webhook Bitrix24:
- Endpoint: `POST /api/webhook/bitrix`
- Событие: `ONCRMDEALUPDATE`
- Условие: `stageId === 'LOSE'` или `stageId.endsWith(':LOSE')`
- Функция: `handleDealUpdate`

---

*Документ подготовлен: 24.12.2025*
*Обновлено: 25.12.2025 (добавлена информация о технических ордерах)*

