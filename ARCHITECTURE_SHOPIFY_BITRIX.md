# Архитектура API-сервисов: Shopify ↔ Bitrix24

**Дата создания:** 2025-01-17  
**Версия:** 1.0.0  
**Проект:** API Services MVP

---

## 📋 Содержание

1. [Обзор системы](#обзор-системы)
2. [Архитектура компонентов](#архитектура-компонентов)
3. [API Endpoints](#api-endpoints)
4. [Потоки данных](#потоки-данных)
5. [Модули и библиотеки](#модули-и-библиотеки)
6. [Конфигурация](#конфигурация)
7. [Структура файлов](#структура-файлов)
8. [Основные функции](#основные-функции)

---

## 🎯 Обзор системы

Система представляет собой интеграционный слой между **Shopify** (e-commerce платформа) и **Bitrix24** (CRM система), реализованный на базе **Next.js**.

### Основные возможности:

- ✅ **Двусторонняя синхронизация** заказов между Shopify и Bitrix24
- ✅ **Webhook обработка** событий от Bitrix24
- ✅ **Fulfillment управление** в Shopify при изменении статусов в Bitrix24
- ✅ **Refund операции** (создание возвратов)
- ✅ **Address updates** (обновление адресов доставки)
- ✅ **Hold orders** (создание заказов-резервов)
- ✅ **Provenance tracking** (отслеживание происхождения операций через метаполя)

### Технологический стек:

- **Framework:** Next.js 14.2.3
- **Runtime:** Node.js (Vercel/Serverless)
- **API:** REST (Shopify Admin API, Bitrix24 REST API)
- **Storage:** In-memory (BitrixAdapter для событий)

---

## 🏗️ Архитектура компонентов

### Высокоуровневая схема

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   Bitrix24  │◄───────►│  API Services│◄───────►│   Shopify   │
│  (Webhooks) │         │   (Next.js)  │         │ (Admin API) │
└─────────────┘         └──────────────┘         └─────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │   UI (React) │
                       │  (Monitoring)│
                       └──────────────┘
```

### Основные компоненты

#### 1. **Webhook Handler** (`/api/webhook/bitrix.js`)
   - Принимает события от Bitrix24
   - Обрабатывает обновления сделок (Deal Update)
   - Триггерит операции в Shopify

#### 2. **Shopify Client** (`src/lib/shopify/adminClient.js`)
   - REST API клиент для Shopify Admin API
   - GraphQL поддержка
   - Аутентификация через `X-Shopify-Access-Token`

#### 3. **Bitrix Client** (`src/lib/bitrix/client.js`)
   - REST API клиент для Bitrix24
   - Webhook-based вызовы
   - Управление сделками, контактами, продуктами

#### 4. **Adapters** (`src/lib/adapters/`)
   - **BitrixAdapter:** In-memory хранилище событий
   - **ShopifyAdapter:** (если требуется)

#### 5. **Business Logic Modules**
   - **Fulfillment** (`src/lib/shopify/fulfillment.js`)
   - **Refund** (`src/lib/shopify/refund.js`)
   - **Address** (`src/lib/shopify/address.js`)
   - **Hold** (`src/lib/shopify/hold.js`)
   - **Metafields** (`src/lib/shopify/metafields.js`)

---

## 🔌 API Endpoints

### Webhook Endpoints

#### `POST /api/webhook/bitrix`
**Назначение:** Прием webhook событий от Bitrix24

**Обрабатываемые события:**
- `ONCRMDEALUPDATE` - обновление сделки
- `ONCRMDEALADD` - создание сделки

**Логика обработки:**

1. **MW Actions** (приоритет 1):
   - Парсинг поля `UF_MW_SHOPIFY_ACTION` из сделки
   - Поддерживаемые действия:
     - `hold_create` - создание заказа-резерва
     - `refund_create` - создание возврата
     - `address_update` - обновление адреса доставки

2. **Delivery Trigger** (приоритет 2):
   - Условия: `CATEGORY_ID == 2` И `STAGE_ID == "C2:EXECUTING"`
   - Действие: создание fulfillment в Shopify

**Параметры запроса:**
```json
{
  "event": "ONCRMDEALUPDATE",
  "data[FIELDS][ID]": "12345",
  "auth[application_token]": "token"
}
```

**Ответ:**
```json
{
  "success": true,
  "message": "Event processed",
  "requestId": "...",
  "dealId": "12345",
  "triggerMatch": true
}
```

#### `POST /api/webhook/shopify`
**Назначение:** Прием webhook событий от Shopify (создание заказов)

#### `POST /api/webhook/order/crt`
**Назначение:** Обработка создания заказа в Shopify

#### `POST /api/webhook/order/upd`
**Назначение:** Обработка обновления заказа в Shopify

### Manual Action Endpoints

#### `POST /api/send-to-shopify`
**Назначение:** Ручная отправка выбранных событий в Shopify

**Тело запроса:**
```json
{
  "selectedEvents": [
    {
      "id": "event-id",
      "dealId": "12345",
      "shopifyOrderId": "67890",
      "rawDealData": {...}
    }
  ]
}
```

**Поддерживаемые операции:**
- Проверка fulfillment статуса
- Создание refund (если указано в `UF_MW_SHOPIFY_ACTION`)
- Обновление адреса (если указано в `UF_MW_SHOPIFY_ACTION`)

#### `POST /api/send-to-bitrix`
**Назначение:** Отправка данных из Shopify в Bitrix24

### Monitoring Endpoints

#### `GET /api/events/bitrix`
**Назначение:** Получение списка всех событий от Bitrix24

#### `GET /api/events/latest`
**Назначение:** Получение последнего события

#### `GET /api/logs/download`
**Назначение:** Скачивание логов

---

## 🔄 Потоки данных

### Поток 1: Bitrix24 → Shopify (Fulfillment)

```
Bitrix24 Deal Update
    │
    ├─► CATEGORY_ID == 2
    ├─► STAGE_ID == "C2:EXECUTING"
    └─► shopifyOrderId присутствует
        │
        ▼
[Webhook Handler]
    │
    ├─► Получение полных данных сделки
    ├─► Проверка условий триггера
    └─► Создание fulfillment в Shopify
        │
        ├─► Проверка статуса заказа
        ├─► Получение line items для fulfillment
        ├─► Создание fulfillment через Admin API
        ├─► Установка provenance marker
        └─► Логирование результата
```

### Поток 2: Bitrix24 → Shopify (MW Actions)

```
Bitrix24 Deal Update
    │
    └─► UF_MW_SHOPIFY_ACTION содержит JSON
        │
        ├─► Парсинг JSON
        ├─► Нормализация payload
        ├─► Вычисление payloadHash
        └─► Выполнение действия:
            │
            ├─► hold_create
            │   └─► Создание draft order в Shopify
            │
            ├─► refund_create
            │   ├─► Расчет суммы возврата
            │   ├─► Создание refund
            │   └─► Установка provenance marker
            │
            └─► address_update
                ├─► Обновление shipping address
                └─► Установка provenance marker
```

### Поток 3: Shopify → Bitrix24 (Order Creation)

```
Shopify Order Created
    │
    ▼
[Webhook Handler]
    │
    ├─► Парсинг данных заказа
    ├─► Маппинг в формат Bitrix24
    ├─► Создание контакта (если нужно)
    ├─► Создание сделки
    └─► Создание продуктовых строк
```

---

## 📦 Модули и библиотеки

### Shopify Modules

#### `src/lib/shopify/adminClient.js`
**Функции:**
- `callShopifyAdmin(endpoint, options)` - REST API вызовы
- `callShopifyGraphQL(query, variables)` - GraphQL вызовы
- `getOrder(orderId)` - получение заказа
- `updateOrder(orderId, orderData)` - обновление заказа

**Конфигурация:**
- `SHOPIFY_24_DOMAIN` - домен магазина
- `SHOPIFY_24_ADMIN` - Admin API токен
- `SHOPIFY_API_VERSION` - версия API (по умолчанию: 2024-01)

#### `src/lib/shopify/fulfillment.js`
**Функции:**
- `getFulfillmentOrders(orderId)` - получение fulfillments
- `getOrderForFulfillment(orderId)` - подготовка данных для fulfillment
- `createFulfillment(orderId, items, options)` - создание fulfillment
- `getPostFulfillmentState(orderId)` - проверка статуса после fulfillment

#### `src/lib/shopify/refund.js`
**Функции:**
- `calculateRefund(orderId, refundData)` - расчет суммы возврата
- `createRefund(orderId, refundData, correlationId, hash)` - создание возврата
- `normalizeCalculatedRefund(calculatedRefund)` - нормализация данных

#### `src/lib/shopify/address.js`
**Функции:**
- `updateShippingAddress(orderId, payload, correlationId, hash)` - обновление адреса

#### `src/lib/shopify/hold.js`
**Функции:**
- `createHoldOrder(items, correlationId, hash)` - создание заказа-резерва

#### `src/lib/shopify/metafields.js`
**Функции:**
- `setProvenanceMarker(orderId, correlationId, action, hash)` - установка метаполя для отслеживания

### Bitrix Modules

#### `src/lib/bitrix/client.js`
**Функции:**
- `callBitrix(method, payload)` - вызов REST API метода
- `getBitrixWebhookBase()` - получение базового URL webhook

**Конфигурация:**
- `BITRIX_WEBHOOK_BASE` - базовый URL webhook
- Fallback: legacy env `BITRIX_WEBHOOK_URL` (avoid hardcoding URLs in code)

#### `src/lib/bitrix/config.js`
**Константы:**
- `CATEGORY_STOCK` - ID категории "Склад" (2)
- `STAGES_CAT_2.EXECUTING` - ID стадии "Исполнение" ("C2:EXECUTING")
- `SHIPPING_PRODUCT_ID` - ID продукта для доставки (3000)

#### `src/lib/bitrix/webhookParser.js`
**Функции:**
- `extractDealId(body)` - извлечение ID сделки из webhook payload
- `extractAuthToken(body)` - извлечение токена аутентификации
- `getPayloadKeys(body)` - получение ключей payload

#### `src/lib/bitrix/orderMapper.js`
**Назначение:** Маппинг данных заказа Shopify → Bitrix24

#### `src/lib/bitrix/dealMapper.js`
**Назначение:** Маппинг данных сделки Bitrix24 ↔ Shopify

#### `src/lib/bitrix/productRows.js`
**Назначение:** Создание продуктовых строк в Bitrix24

### Adapters

#### `src/lib/adapters/bitrix/index.js`
**Класс:** `BitrixAdapter`

**Методы:**
- `storeEvent(payload)` - сохранение события
- `getAllEvents()` - получение всех событий (новые первыми)
- `getLatestEvent()` - получение последнего события
- `getEventsCount()` - количество событий
- `clearEvents()` - очистка хранилища

**Хранение:** In-memory массив (сброс при перезапуске)

### Utilities

#### `src/lib/utils/hash.js`
**Функции:**
- `payloadHash(payload)` - вычисление хеша payload для идемпотентности
- `normalizePayload(action, rawPayload)` - нормализация payload
- `cleanEmptyFields(obj)` - очистка пустых полей

---

## ⚙️ Конфигурация

### Environment Variables

#### Shopify
```bash
SHOPIFY_24_DOMAIN=83bfa8-c4.myshopify.com
SHOPIFY_24_ADMIN=<admin-api-token>
SHOPIFY_API_VERSION=2024-01
```

#### Bitrix24
```bash
BITRIX_WEBHOOK_BASE=https://your-domain.bitrix24.eu/rest/USER_ID/WEBHOOK_TOKEN/
BITRIX_AUTH_TOKEN=<random-token>
```

### Bitrix24 Configuration

**Категория сделок:**
- `CATEGORY_STOCK = 2` (Склад)

**Стадии категории 2:**
- `EXECUTING = "C2:EXECUTING"` (Исполнение)

**Пользовательские поля:**
- `UF_CRM_1742556489` - Shopify Order ID
- `UF_MW_SHOPIFY_ACTION` - JSON с действием для Shopify

---

## 📁 Структура файлов

```
api-services/
├── pages/
│   ├── api/
│   │   ├── webhook/
│   │   │   ├── bitrix.js          # Основной webhook от Bitrix24
│   │   │   ├── shopify.js          # Webhook от Shopify
│   │   │   ├── order/
│   │   │   │   ├── crt.js          # Создание заказа
│   │   │   │   └── upd.js          # Обновление заказа
│   │   │   └── product/
│   │   │       └── upd.js          # Обновление продукта
│   │   ├── send-to-shopify.js      # Ручная отправка в Shopify
│   │   ├── send-to-bitrix.js       # Отправка в Bitrix24
│   │   ├── events/
│   │   │   ├── bitrix.js           # Список событий Bitrix
│   │   │   └── latest.js           # Последнее событие
│   │   └── logs/
│   │       └── download.js         # Скачивание логов
│   └── index.js                    # Главная страница
│
├── src/
│   ├── lib/
│   │   ├── shopify/
│   │   │   ├── adminClient.js      # REST/GraphQL клиент
│   │   │   ├── fulfillment.js      # Fulfillment операции
│   │   │   ├── refund.js           # Refund операции
│   │   │   ├── address.js          # Address update
│   │   │   ├── hold.js             # Hold orders
│   │   │   └── metafields.js       # Provenance tracking
│   │   │
│   │   ├── bitrix/
│   │   │   ├── client.js           # REST API клиент
│   │   │   ├── config.js           # Конфигурация
│   │   │   ├── webhookParser.js    # Парсинг webhook
│   │   │   ├── orderMapper.js      # Маппинг заказов
│   │   │   ├── dealMapper.js       # Маппинг сделок
│   │   │   ├── productRows.js      # Продуктовые строки
│   │   │   ├── contact.js           # Работа с контактами
│   │   │   ├── responsible.js       # Ответственные
│   │   │   └── *.json              # Маппинг файлы (SKU, бренды)
│   │   │
│   │   ├── adapters/
│   │   │   └── bitrix/
│   │   │       └── index.js        # In-memory хранилище событий
│   │   │
│   │   └── utils/
│   │       └── hash.js             # Хеширование и нормализация
│   │
│   ├── components/
│   │   ├── bitrix/
│   │   │   └── EventsList.js       # UI компонент для событий
│   │   └── shopify/
│   │       ├── EventsList.js
│   │       ├── EventDetails.js
│   │       └── WebhookInfo.js
│   │
│   └── styles/
│       └── global.css
│
├── package.json
├── next.config.js
├── vercel.json
└── README.md
```

---

## 🔧 Основные функции

### 1. Fulfillment Creation

**Триггер:** Bitrix24 Deal Update с условиями:
- `CATEGORY_ID == 2`
- `STAGE_ID == "C2:EXECUTING"`
- Присутствует `shopifyOrderId`

**Процесс:**
1. Получение данных заказа из Shopify
2. Проверка fulfillable quantity
3. Создание fulfillment через Admin API
4. Установка provenance marker
5. Проверка post-fulfillment состояния

### 2. Refund Creation

**Триггер:** Поле `UF_MW_SHOPIFY_ACTION` содержит:
```json
{
  "action": "refund_create",
  "mode": "partial|full",
  "items": [...],
  "restock_type": "cancel|return|legacy_restock",
  "refund_shipping_full": true|false,
  "note": "..."
}
```

**Процесс:**
1. Нормализация payload
2. Вычисление hash для идемпотентности
3. Расчет суммы возврата через Shopify API
4. Создание refund
5. Установка provenance marker

### 3. Address Update

**Триггер:** Поле `UF_MW_SHOPIFY_ACTION` содержит:
```json
{
  "action": "address_update",
  "shipping_address": {
    "address1": "...",
    "city": "...",
    "country": "...",
    ...
  }
}
```

**Процесс:**
1. Нормализация адреса
2. Обновление через Admin API
3. Установка provenance marker

### 4. Hold Order Creation

**Триггер:** Поле `UF_MW_SHOPIFY_ACTION` содержит:
```json
{
  "action": "hold_create",
  "items": [
    {"sku": "...", "qty": 1}
  ]
}
```

**Процесс:**
1. Создание draft order в Shopify
2. Добавление line items
3. Установка provenance marker

### 5. Provenance Tracking

**Назначение:** Отслеживание происхождения операций через метаполя Shopify

**Формат метаполя:**
```json
{
  "namespace": "bitrix_integration",
  "key": "provenance",
  "value": {
    "correlationId": "dealId:hash",
    "action": "fulfillment|refund_create|address_update|hold_create",
    "payloadHash": "...",
    "timestamp": "..."
  }
}
```

---

## 📊 Логирование

Система использует структурированное JSON логирование для всех операций.

### Типы событий:

- `BITRIX_WEBHOOK_RECEIVED` - получен webhook от Bitrix24
- `DEAL_DATA_RECEIVED` - получены данные сделки
- `MW_ACTION_PARSE_OK` - успешно распарсен MW action
- `MW_ACTION_PARSE_ERROR` - ошибка парсинга MW action
- `DELIVERY_TRIGGER_MATCH` - сработал триггер доставки
- `SHOPIFY_FULFILLMENT_CREATE_ATTEMPT` - попытка создания fulfillment
- `SHOPIFY_FULFILLMENT_CREATE_SUCCESS` - успешное создание fulfillment
- `SHOPIFY_FULFILLMENT_CREATE_ERROR` - ошибка создания fulfillment
- `SHOPIFY_PROVENANCE_SET` - установлен provenance marker
- `REFUND_CREATE_SUCCESS` - успешное создание refund
- `ADDRESS_UPDATE_SUCCESS` - успешное обновление адреса
- `HOLD_CREATE_SUCCESS` - успешное создание hold order

### Формат лога:

```json
{
  "event": "EVENT_NAME",
  "requestId": "timestamp-random",
  "dealId": "12345",
  "shopifyOrderId": "67890",
  "correlationId": "dealId:hash",
  "payloadHash": "...",
  "timestamp": "2025-01-17T12:00:00.000Z",
  ...
}
```

---

## 🔐 Безопасность

### Аутентификация

1. **Bitrix24 Webhook:**
   - Проверка токена через `BITRIX_AUTH_TOKEN`
   - Параметр: `auth[application_token]` или `auth_token`

2. **Shopify Admin API:**
   - Bearer token через `X-Shopify-Access-Token`
   - Переменная: `SHOPIFY_24_ADMIN`

### Идемпотентность

- Использование `payloadHash` для предотвращения дублирования операций
- `correlationId` для связи операций с исходными событиями
- Provenance markers для отслеживания выполненных операций

---

## 🚀 Развертывание

### Vercel Deployment

1. Установить environment variables в Vercel Dashboard
2. Deploy через Git или Vercel CLI
3. Настроить webhook URL в Bitrix24:
   ```
   https://your-app.vercel.app/api/webhook/bitrix
   ```

### Локальная разработка

```bash
npm install
npm run dev
```

Приложение доступно на `http://localhost:3000`

---

## 📝 Примечания

- Система использует **in-memory хранилище** для событий (сброс при перезапуске)
- Для production рекомендуется использовать внешнее хранилище (Redis, Database)
- Все операции логируются в структурированном JSON формате
- Provenance tracking позволяет отслеживать все операции в Shopify

---

**Документ создан:** 2025-01-17  
**Последнее обновление:** 2025-01-17


