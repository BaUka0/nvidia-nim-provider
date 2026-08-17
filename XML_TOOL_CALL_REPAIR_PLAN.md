# 🛡️ Комплексный план: Защита от всех типов утечек и универсальный перехват XML/JSON инструментов

Данный документ представляет собой детальный технический проект полной изоляции чата от утечек служебной информации, универсального перехвата текстовых и XML-инструментов, бесшовного слияния разделенных параметров (`Argument Fusion`) и защиты от ложных срабатываний на исходный код.

---

## 🎯 1. Описание проблемы и цели

В ходе тестирования моделей NVIDIA NIM (`Nemotron 3 Ultra 550B`, `DeepSeek V4 Flash`, `Qwen`, `Kimi`, `Llama`) было выявлено, что модели при различных условиях (длинный контекст, рассуждения, вызовы инструментов) допускают **8 различных типов утечек** в чат:

```
                      ┌───────────────────────────────────────────────┐
                      │             Входящий SSE Стрим                │
                      └──────────────────────┬────────────────────────┘
                                             │
      ┌──────────────────────────────────────┴──────────────────────────────────────┐
      ▼                                                                             ▼
[Текстовый поток (content)]                                           [Нативные вызовы (tool_calls)]
      │                                                                             │
      ├─► 1. XML-теги инструментов (<tool_call>, <function...>)                     │
      ├─► 2. Разделенные параметры (<parameter=filePath>...)                        │
      ├─► 3. JSON Markdown блоки (```json {"name": "read_file"}```)                 │
      ├─► 4. Control-токены (<|python_tag|>, <|im_start|>, [gMASK])                 │
      ├─► 5. Теги рассуждений (<think>, <thought>, [THINK])                         │
      ├─► 6. Разорванные токены на стыке чанков (<tool_...call>)                    │
      ├─► 7. Ложные срабатывания на исходный код (const x = "<tool_call>")          │
      │                                                                             │
      ▼                                                                             ▼
┌──────────────────────────────────────────────┐              ┌─────────────────────────────────────┐
│  Multi-Format Leak Filter & Extractor        │──(Params)───►│  Argument Fusion & Repair Engine    │
└──────────────────────┬───────────────────────┘              └──────────────────┬──────────────────┘
                       │                                                         │
                       ▼                                                         ▼
            [Чистый ответ в Чат UI]                                   [Валидный Tool Call в VS Code]
```

---

## 🔍 2. Каталог всех 8 типов утечек и стратегии их нейтрализации

| № | Тип утечки | Пример того, что шлёт модель | Риск / Последствие | Стратегия решения |
| :-: | :--- | :--- | :--- | :--- |
| **1** | **XML-разметка инструментов** | `<tool_call><function=create_file><parameter=content>...</parameter></function></tool_call>` | В чат вываливается сырой XML, инструмент не запускается. | Парсинг и полное вырезание всех XML-тегов с конвертацией в реальный `LanguageModelToolCallPart`. |
| **2** | **Разделенные параметры (Split Params)** | В тексте: `<parameter=filePath>src/file.ts</parameter>`, в JSON: `{"content": "..."}` | Инструмент отклоняется (`missing filePath`), путь к файлу утерян и напечатан в чате. | **Argument Fusion:** Извлечение параметров из XML и слияние с нативным JSON-вызовом `create_file`. |
| **3** | **JSON Markdown дамп вместо tool_calls** | Текст: `Я вызову инструмент: \`\`\`json\n{"name": "read_file", "arguments": {"filePath": "a.ts"}}\n\`\`\`` | Пользователь видит кусок JSON, но инструмент не выполняется. | Автоматический перехват JSON-блоков инструментов из Markdown с конвертацией в Tool Call. |
| **4** | **Спец-токены моделей (Control Tokens)** | `<|python_tag|>`, `<|start_header_id|>`, `<|im_start|>`, `<|im_end|>`, `[gMASK]`, `sop`, `eop` | Мусорные артефакты и битые теги в тексте чата. | Единый санитайзер `stripAllKnownControlTokens` с расширенным словарем маркеров. |
| **5** | **Утечка размышлений (Thinking Leaks)** | `<think>...</think>`, `<thought>...</thought>`, `[THINK]...[/THINK]`, осиротевший `</think>` | Мысли модели отображаются в основном тексте ответа. | Универсальный `ThinkTagFilter` с поддержкой пар `<think>`, `<thought>`, `[THINK]`, `<mm:think>`. |
| **6** | **Разорванные токены на стыке чанков** | Чанк 1: `текст <param`, Чанк 2: `eter=filePath>path</parameter>` | Чанк 1 выводится в чат как `<param`, нарушая парсинг. | Буферизация суффиксов `findTrailingPrefixStartAny` для всех XML, control и think-тегов. |
| **7** | **Ложные срабатывания на исходный код** | Модель пишет код: `const tag = "<tool_call>"; const name = "...";` | Парсер считает код за инструмент и отклоняет (`invalid tool name`). | 1. Игнорирование маркеров внутри Markdown code blocks (```` ```...``` ````).<br>2. Проверка имени инструмента по RegExp `/^[a-zA-Z0-9_.-]{1,64}$/`. |
| **8** | **Несоответствие имен полей (Aliases)** | Модель шлёт `path` вместо `filePath`, `targetFile` вместо `filePath`, `code` вместо `content` | Инструмент отклоняется валидатором VS Code. | Расширенная таблица алиасов в `repairToolArguments` + fallback на `requestContext.filePath`. |

---

## 🏗️ 3. Архитектура решения

### Компонент 1: `StreamSanitizer & XmlToolParser` ([`src/tools/parser.ts`](file:///C:/Users/bauir/source/project/nvidia-nim-provider/src/tools/parser.ts))
1. **Поддержка форматов XML:**
   * **Hermes / Nemotron:** `<tool_call><function=name><parameter=key>value</parameter></function></tool_call>`
   * **Anthropic / Standard XML:** `<tool_call name="name"><parameter name="key">value</parameter></tool_call>`
   * **Qwen / ChatML:** `<tool_call>\n{"name": "...", "arguments": {...}}\n</tool_call>`
   * **Simple Invoke:** `<invoke name="name"><parameter name="key">value</parameter></invoke>`
2. **Очистка от одиночных тегов:** Вырезание любых осиротевших закрывающих тегов (`</tool_call>`, `</function>`, `</parameter>`, `</tool_calls>`).
3. **Буфер извлеченных параметров (`pendingExtractedParameters`):** Параметры, обнаруженные в тексте, сохраняются в контексте текущего стрима для последующего объединения.

### Компонент 2: `Argument Fusion Engine` ([`src/tools/parser.ts`](file:///C:/Users/bauir/source/project/nvidia-nim-provider/src/tools/parser.ts))
В функции `repairToolArguments`:
```typescript
// 1. Нормализация и починка JSON
// 2. Алиасы полей:
//    filePath <= path, targetFile, file, filename, uri
//    content  <= code, text, data, body
//    startLine <= start, fromLine
//    endLine   <= end, toLine
// 3. Слияние с параметрами из XML-буфера (если в JSON поле отсутствует)
// 4. Fallback на requestContext (если filePath отсутствует, берем активный файл из контекста)
```

### Компонент 3: `CodeBlock-Aware Guard & Valid Identifier Filter`
1. Защита от срабатывания внутри блоков кода (строки между \`\`\` не парсятся как вызовы инструментов).
2. Валидация извлеченного имени инструмента:
   ```typescript
   export function isValidToolIdentifier(name: string): boolean {
     return /^[a-zA-Z0-9_.-]{1,64}$/.test(name.trim());
   }
   ```

### Компонент 4: `Extended Think Filter` ([`src/messages/think-filter.ts`](file:///C:/Users/bauir/source/project/nvidia-nim-provider/src/messages/think-filter.ts))
Расширение списка пар тегов рассуждений:
```typescript
const THINK_TAG_PAIRS: ThinkTagPair[] = [
  { open: "<think>", close: "</think>" },
  { open: "<mm:think>", close: "</mm:think>" },
  { open: "<thought>", close: "</thought>" },
  { open: "[THINK]", close: "[/THINK]" },
  { open: "<reasoning>", close: "</reasoning>" },
];
```

---

## 📋 4. Детали изменений по файлам

### 1. [`src/tools/parser.ts`](file:///C:/Users/bauir/source/project/nvidia-nim-provider/src/tools/parser.ts)
* Добавить парсер XML-инструментов `parseXmlEmbeddedToolCalls(text: string)`.
* Добавить парсер JSON Markdown блоков `parseMarkdownJsonToolCalls(text: string)`.
* Обновить `parseTextEmbeddedToolCalls(text: string)`:
  * Поддержка всех форматов (OpenAI, DeepSeek, Hermes XML, Anthropic XML, Markdown JSON).
  * Вырезание служебных тегов из текстовых сегментов.
  * Буферизация неполных тегов на границах чанков.
* Обновить `repairToolArguments`:
  * Интеграция таблицы алиасов для всех распространенных инструментов (`read_file`, `create_file`, `write_file`, `edit_file`, `list_dir`, `grep_search`).
  * Слияние аргументов из XML-буфера.
  * Контекстный fallback для `filePath`, `cwd`, `startLine`, `endLine`.
* Обновить `getIncompleteTextToolCallName`:
  * Проверка через `isValidToolIdentifier`.

### 2. [`src/messages/think-filter.ts`](file:///C:/Users/bauir/source/project/nvidia-nim-provider/src/messages/think-filter.ts) & [`src/messages/reasoning-router.ts`](file:///C:/Users/bauir/source/project/nvidia-nim-provider/src/messages/reasoning-router.ts)
* Добавить поддержку `<thought>`, `[THINK]`, `<reasoning>`.
* Добавить фильтрацию осиротевших закрывающих тегов (`[/THINK]`, `</thought>`).

### 3. [`src/provider/chat-provider.ts`](file:///C:/Users/bauir/source/project/nvidia-nim-provider/src/provider/chat-provider.ts)
* Передавать извлеченные XML-параметры в `ToolCallStreamAggregator` для обеспечения слияния аргументов при нативных вызовах `delta.tool_calls`.

---

## 🧪 5. План верификации и тестов

### Автоматические тесты (`tests/tools-parser.test.ts` & `tests/think-filter.test.ts`):
1. **Тест XML Hermes:** Парсинг `<tool_call><function=create_file><parameter=filePath>a.ts</parameter><parameter=content>code</parameter></function></tool_call>`.
2. **Тест XML Anthropic:** Парсинг `<tool_call name="read_file"><parameter name="filePath">b.ts</parameter></tool_call>`.
3. **Тест Argument Fusion:** Текст содержит `<parameter=filePath>c.ts</parameter>`, а нативный JSON присылает `{ "content": "hello" }` $\to$ результат: `{ filePath: "c.ts", content: "hello" }`.
4. **Тест Markdown JSON:** Перехват вызова инструмента, оформленного как \`\`\`json { "name": "edit_file", ... } \`\`\`.
5. **Тест защиты от ложных срабатываний:** Генерация исходного кода TypeScript со строкой `const token = "<tool_call>";` $\to$ не считается инструментом, выводится как чистый текст.
6. **Тест разорванных чанков:** Передача `<tool_` в первом чанке и `call name="x">...` во втором чанке $\to$ отсутствие утечки `<tool_` в чат.
7. **Тест тегов рассуждений:** Корректная изоляция `<thought>...</thought>` и `[THINK]...[/THINK]`.

### Запуск проверок:
```bash
npm test
npm run lint
npm run compile
```
